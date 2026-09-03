//! Служба proxybox: единственный владелец состояния, процесса sing-box и
//! правил брандмауэра. Клиенты (GUI, CLI) только шлют команды и читают статус.
//!
//! На Windows живёт службой SCM под LocalSystem (`mod service`): TUN и правила
//! брандмауэра требуют настоящих прав, а не «запустить от имени». Без
//! `--service` тот же бинарник работает консольным процессом — так удобнее в
//! разработке и так он работает вне Windows.

#[cfg(windows)]
mod service;

use core_ipc::{
    dir_name, t, tf, App, BrowserProfile, Conn, Endpoint, Listener, LogLine, Probe, ProfileInfo,
    Quota, Request, Response, Scope, Settings, Status, Stream, Subscription, TestRun,
    Tunnel as TunnelState, ADDR,
};
use core_tunnel::{build_config, Options, Tunnel as Process};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Как часто служба проверяет связь через туннель.
const PROBE_EVERY: Duration = Duration::from_secs(3);
/// Как часто служба проверяет, что процесс sing-box вообще жив, — и это же
/// ширина окна, в котором выбранные приложения могут уйти напрямую после его
/// падения. Отдельно от `PROBE_EVERY` потому, что стоит эта проверка одного
/// `try_wait`, а проба — похода в сеть с ожиданием ответа: связать их одним
/// периодом значит платить за окно утечки временем сетевого запроса.
///
/// ponytail: всё-таки опрос, а не ожидание на дескрипторе процесса. Нулевым
/// окно сделало бы `WaitForSingleObject` на дублированном хэндле (на Unix —
/// pidfd), но это платформенный unsafe в обмен на последние 200 мс.
const DEATH_EVERY: Duration = Duration::from_millis(200);
/// Счётчики трафика забираются не каждый круг, а раз в столько кругов, и это
/// не экономия на спичках. Clash API отдаёт итоги только в теле `/connections`,
/// вместе со всем списком живых соединений и после него — оборвать разбор на
/// полпути нельзя. Замерено на 1.13.19: около 357 байт на соединение (500
/// соединений — 178 КБ). Через туннель проходит вся машина в обоих охватах,
/// поэтому в патологии — а её и ловят, когда смотрят на ЦП, — это десятки
/// мегабайт на опрос: sing-box их сериализует, служба разбирает в дерево, и всё
/// выбрасывается ради двух чисел. Надзор превращался бы в усилитель того самого
/// симптома, который меряют.
///
/// Живость туннеля это не трогает вовсе — она на `Process::alive` и идёт своим
/// чередом. Счётчики в окне сессионные, им частота ни к чему.
/// Сторож — `the_counters_are_not_polled_every_round`.
const TRAFFIC_EVERY: u32 = 5;
/// Пауза перед повторной попыткой поднять туннель: удваивается до максимума.
/// Без неё отказ, который сам не пройдёт (нет прав, занят порт), превращается
/// в бесконечный поток одинаковых ошибок в журнале.
const RETRY_BASE: Duration = Duration::from_secs(3);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// Как часто поток сверки просыпается посмотреть на календарь. Срок считается
/// от отметки на диске, а не от сна потока, — значит спать по шесть часов
/// нельзя: проснувшись, он промахивался бы мимо срока ровно на столько же.
const REFRESH_TICK: Duration = Duration::from_secs(5 * 60);

/// Сколько соединений уезжает в окно. Список живёт секунды и читается глазами:
/// сотня строк — уже больше, чем успевают просмотреть, а в охвате «весь
/// компьютер» их бывают тысячи.
const MAX_CONNS: usize = 100;

/// Замок службы, переживающий панику в чужом потоке. Поток обслуживания клиента
/// вправе упасть — вместе со своим соединением; надзор упасть не вправе. С
/// обычным `unwrap()` первая же паника под замком отравляла бы его, надзор умер
/// бы на следующем же цикле, и ставить правила брандмауэра после смерти sing-box
/// стало бы некому: паника в разборе чужого запроса превратилась бы в утечку
/// трафика. Состояние в худшем случае применено наполовину, и это чинит
/// следующий цикл надзора.
fn lock(svc: &Mutex<Service>) -> std::sync::MutexGuard<'_, Service> {
    svc.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Прогон профилей идёт вне замка службы, но сам с собой не пересекается:
/// см. `Request::TestProfiles`.
static PROBE_LOCK: Mutex<()> = Mutex::new(());

fn dir() -> PathBuf {
    // Служба работает под LocalSystem, и её %APPDATA% — это системный профиль
    // внутри System32. Состоянию службы место в ProgramData.
    let base = std::env::var("ProgramData")
        .or_else(|_| std::env::var("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"));
    settle(base)
}

/// Каталог состояния под именем продукта — и переезд из каталога под прошлым
/// именем, если он ещё лежит рядом.
///
/// Переименование не имеет права стоить человеку профилей, подписок и списка
/// приложений: всё это лежит в одном `state.json`, и оставленный на прежнем
/// месте он выглядит как «продукт забыл всё» — при целых, никуда не девшихся
/// файлах.
///
/// Переезжаем только когда нового каталога ещё нет: иначе переезд затёр бы уже
/// нажитое на новом имени. А если переехать не вышло — каталог занят, прав не
/// хватило, — работаем там, где данные, а не там, где красивее. Пустой новый
/// каталог рядом с полным старым хуже несостоявшегося переименования.
fn settle(base: PathBuf) -> PathBuf {
    let dir = base.join("proxybox");
    let legacy = base.join("privacy-gateway");
    if !dir.exists() && legacy.exists() && std::fs::rename(&legacy, &dir).is_err() {
        return legacy;
    }
    dir
}

/// SID, а не имена групп: «Администраторы» на локализованной Windows пишется
/// по-своему, и правило, собранное из английских имён, там просто не встанет.
/// `S-1-5-18` — LocalSystem, `S-1-5-32-544` — встроенные администраторы.
const SID_SYSTEM: &str = "*S-1-5-18";
const SID_ADMINS: &str = "*S-1-5-32-544";

/// Что делается с самим каталогом состояния — и делается до первой записи в
/// него.
///
/// В `state.json` лежат пароли и ключи всех профилей, а каталог создаётся под
/// `%ProgramData%`, который раздаёт наследуемое чтение всем пользователям
/// машины. Значит одного создания каталога мало: наследование обрывается
/// (`/inheritance:r`), и внутри остаются ровно двое — SYSTEM и администраторы.
///
/// Владелец переставляется, а не проверяется. Каталог, созданный обычным
/// пользователем раньше службы, остаётся в его власти, а владелец всегда может
/// переписать DACL обратно — отчётом «каталог чужой» эту дыру закрыть нечем, а
/// `/setowner` закрывает. Порядок из-за этого обязателен: сначала владелец,
/// потом права.
fn seal_args(dir: &Path) -> Vec<Vec<String>> {
    let at = dir.display().to_string();
    vec![
        vec![at.clone(), "/setowner".into(), SID_ADMINS.into(), "/Q".into()],
        vec![
            at,
            "/inheritance:r".into(),
            "/grant:r".into(),
            format!("{SID_SYSTEM}:(OI)(CI)F"),
            format!("{SID_ADMINS}:(OI)(CI)F"),
            "/Q".into(),
        ],
    ]
}

/// …и что делается с тем, что в каталоге уже лежало. Права файла копируются от
/// родителя в момент создания, поэтому `state.json`, заведённый прошлой версией
/// продукта, остаётся читаемым всей машиной и после `seal_args`. `/reset`
/// возвращает его к наследованию, а наследовать после `seal_args` можно только
/// нас двоих.
///
/// Обход отделён от первой половины по одной причине: он идёт по каталогу
/// целиком, вместе с профилями браузера, и стоит времени. Держать на нём
/// восстановление приватного режима нельзя — до `guard` в `run()` выбранные
/// приложения ходят напрямую, и это окно нельзя расширять обходом диска.
/// `/C` — не останавливаться на файле, занятом чужим процессом.
fn reseal_args(dir: &Path) -> Vec<Vec<String>> {
    let at = dir.display().to_string();
    vec![
        vec![at.clone(), "/setowner".into(), SID_ADMINS.into(), "/T".into(), "/C".into(), "/Q".into()],
        vec![at, "/reset".into(), "/T".into(), "/C".into(), "/Q".into()],
    ]
}

/// Каталог состояния и права на него. Зовётся до `Service::load()`: журнал и
/// `singbox.json` с ключом узла пишутся уже после, а созданный файл берёт права
/// от каталога — значит каталог обязан быть заперт раньше.
fn secure_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        // Каталог без права входа закрывает и всё, что внутри: обходить его
        // содержимое, как на Windows, не нужно вовсе.
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    icacls(seal_args(dir))
}

/// То же для файлов, которые лежали в каталоге до нас. На Windows и только:
/// правами каталога `0o700` этот вопрос уже решён.
fn secure_tree(dir: &Path) -> std::io::Result<()> {
    if cfg!(unix) {
        return Ok(());
    }
    icacls(reseal_args(dir))
}

#[cfg(windows)]
fn icacls(batches: Vec<Vec<String>>) -> std::io::Result<()> {
    for args in batches {
        let out = std::process::Command::new("icacls").args(&args).output()?;
        if !out.status.success() {
            // Наружу идёт вывод самой утилиты: он говорит, на чём именно она
            // остановилась, а строка вызова в журнале только мешает.
            return Err(std::io::Error::other(String::from_utf8_lossy(&out.stdout).trim().to_string()));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn icacls(_batches: Vec<Vec<String>>) -> std::io::Result<()> {
    // Списки доступа есть только на целевой платформе.
    Ok(())
}

/// TUN — только на целевой платформе; в разработке хватает локального SOCKS.
fn tun_enabled() -> bool {
    cfg!(windows) && std::env::var("PG_TUN").as_deref() != Ok("0")
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    apps: Vec<App>,
    profiles: BTreeMap<String, Value>,
    /// Адрес подписки → имена профилей, которые с неё пришли. Без этой памяти
    /// обновление подписки не смогло бы убрать узлы, которых в ней больше нет.
    #[serde(default)]
    subscriptions: BTreeMap<String, Vec<String>>,
    /// Адрес подписки → имя, которое ей дал человек. Отдельной картой, а не
    /// полем рядом со списком узлов: имя переживает сверку, а список она
    /// заменяет целиком.
    #[serde(default)]
    sub_names: BTreeMap<String, String>,
    /// Адрес подписки → остаток, который панель прислала последней сверкой.
    /// Ключ тот же, что у `subscriptions`.
    ///
    /// Хранится на диске, а не в памяти процесса: остаток приходит только со
    /// сверкой, а сверка — раз в несколько часов. Без этого окно показывало бы
    /// пустоту от старта службы до первого круга, то есть почти всегда.
    #[serde(default)]
    quotas: BTreeMap<String, Quota>,
    profile: Option<String>,
    /// Когда подписки последний раз пришли с панели. На диске, а не в аптайме
    /// процесса: см. `refresh_due`.
    #[serde(default)]
    refreshed_at: Option<u64>,
    #[serde(default)]
    lang: core_ipc::Lang,
    /// Политика брандмауэра, какой она была до нашего замка, — непрозрачной
    /// строкой от `core_filter::policy_now()`.
    ///
    /// На диске потому, что замок переживает падение службы, а вернуть
    /// политику после него надо той же, какой взяли: в памяти процесса она
    /// умерла бы вместе с ним, и следующий старт вернул бы умолчание Windows,
    /// то есть молча снял бы чужой kill-switch или потерял чужую настройку.
    #[serde(default)]
    policy: Option<String>,
    /// Был ли включён приватный режим. Переживает перезапуск намеренно: иначе
    /// после перезагрузки машины выбранные приложения молча оказались бы в
    /// сети напрямую — ровно то, чего продукт обещает не допускать.
    #[serde(default)]
    private: bool,
    /// Охват — как есть, а не перечислением, и это не небрежность.
    ///
    /// Охватов было три, и `state.json` у людей помнит третий: `"scope":
    /// "apps"` — split-tunnel, где невыбранные ходили напрямую. Перечисление
    /// такого значения не примет, а отказ разбора здесь стоит всего файла:
    /// `unwrap_or_default()` в `load()` стёр бы разом профили, подписки и
    /// список приложений. Разбирает сохранённое `migrate_scope`.
    ///
    /// Переживает перезапуск по той же причине, что и `private`: молча сузить
    /// охват после перезагрузки значило бы выпустить наружу то, что
    /// пользователь закрыл.
    #[serde(default)]
    scope: Value,
    /// Как охват записывался до появления белого списка. Читается только ради
    /// переноса: у обновившегося `state.json` поля `scope` нет, и без этой
    /// строки «весь компьютер» молча превратился бы в «выбранные» — то есть
    /// машина, запертая человеком, вышла бы в сеть после обновления.
    #[serde(default, skip_serializing)]
    all_traffic: bool,
    /// Последнее известное про каждый профиль: страна, код, задержка, когда
    /// измерено. Переживает перезапуск намеренно — в отличие от всего
    /// остального в статусе, это не состояние службы, а свойства узла, и
    /// добывается оно секундами прогона на профиль.
    #[serde(default)]
    probes: Vec<Probe>,
    /// Браузерные профили: имя, узел и личность окна. Переживают перезапуск —
    /// в каталоге каждого лежат куки и входы человека, и потерять имя значило
    /// бы потерять вход.
    #[serde(default)]
    browser_profiles: Vec<BrowserProfile>,
    /// Настройки службы — то, что выбрал человек, без учёта переменных
    /// окружения: перебивка окружением не должна записываться на диск и
    /// переживать ту сессию, в которой переменная стояла.
    #[serde(default)]
    settings: Settings,
}

/// Секунды с эпохи. Часы могли прыгнуть назад — тогда измерение выглядит
/// сделанным только что, и это лучше паники на ровном месте.
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// То же в миллисекундах — для отметки снятия счётчиков: по разнице двух
/// отметок окно считает байты в секунду, и секундная точность на промежутке в
/// полтора десятка секунд врала бы на проценты.
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Запомнить измерение профиля. Страна остаётся от прошлого раза, если в этот
/// узнать её не вышло: узел из страны в страну не переезжает, а не ответить он
/// может по дороге — и терять из-за этого уже известное незачем.
fn remember(probes: &mut Vec<Probe>, name: &str, latency_ms: Option<u32>, exit: Option<core_tunnel::Exit>, error: Option<String>) {
    let i = match probes.iter().position(|p| p.name == name) {
        Some(i) => i,
        None => {
            probes.push(Probe { name: name.to_string(), latency_ms: None, country: None, code: None, error: None, at: 0 });
            probes.len() - 1
        }
    };
    let p = &mut probes[i];
    p.latency_ms = latency_ms;
    p.error = error;
    p.at = now();
    if let Some(exit) = exit {
        p.code = exit.code;
        p.country = Some(exit.name);
    }
}

/// Слепок применённого к брандмауэру. Структурой, а не кортежем: полей четыре,
/// два из них булевы, и перепутанные местами они означают ровно противоположное
/// тому, что задумано.
#[derive(PartialEq)]
struct Applied {
    fence: core_filter::Fence,
    killswitch: bool,
    apps: Vec<String>,
    browser: Option<String>,
}

struct Service {
    status: Status,
    profiles: BTreeMap<String, Value>,
    subscriptions: BTreeMap<String, Vec<String>>,
    /// Имена подписок: адрес → как её назвал человек.
    sub_names: BTreeMap<String, String>,
    quotas: BTreeMap<String, Quota>,
    /// Приватный режим включён пользователем. Не то же самое, что «туннель жив»:
    /// именно расхождение этих двух флагов и означает DROP.
    private: bool,
    /// Политика брандмауэра до нашего замка — её и вернём, снимая его.
    /// Спрашивается один раз за запуск и только пока замка нет: под своим
    /// замком служба прочитала бы свой же `blockoutbound`. Снимается вместе с
    /// замком, иначе следующий вернул бы политику месячной давности.
    policy: Option<String>,
    tunnel: Option<Process>,
    probe_target: (String, u16),
    retry_at: Option<Instant>,
    retry_delay: Duration,
    /// Туннель только что запущен — первую пробу надо сделать сразу.
    ///
    /// Без этого подтверждения ждали до конца круга надзора, то есть до
    /// `PROBE_EVERY`: три секунды выбранные приложения сидели без сети при уже
    /// живом туннеле. Ждать там было нечего — `Process::start` к этому моменту
    /// уже выждал `STARTUP_GRACE` и убедился, что процесс не умер сразу.
    probe_now: bool,
    /// Что уже применено к брандмауэру. Помним применённое, а не то, из чего
    /// оно выведено: без этой памяти надзор дёргал бы netsh каждые три секунды
    /// и засыпал бы журнал одинаковыми отказами. Неудачу не запоминаем
    /// намеренно — на следующей смене состояния попробуем снова.
    applied: Option<Applied>,
    /// Инстансы под окна браузера: профиль → его процесс, по одному на профиль.
    /// Сеансы независимы — портов у каждого свои (`free_port`), каталог свой
    /// (`browser/<dir_name>`), и общий режим не трогает ни один.
    ///
    /// ponytail: числа сеансов никто не ограничивает, а каждый — это отдельный
    /// sing-box со своей памятью. Потолок — сколько процессов вытерпит машина;
    /// апгрейд — предел с отказом в `browse()`, когда найдётся, из чего его
    /// выбирать.
    browsers: BTreeMap<String, Process>,
    /// Сохранённые настройки — ровно то, что выбрал человек. Действующие (с
    /// учётом переменных окружения) лежат в `status.settings`: окно показывает
    /// то, что работает, а на диск уходит то, что выбрано.
    settings: Settings,
        /// Номер поколения туннеля: растёт на каждом запуске и на каждом гашении.
    /// Проба идёт без замка и занимает секунды — за это время туннель успевают
    /// перезапустить, а порты у нас постоянные. Номер отличает ответ про
    /// нынешний процесс от ответа про прошлый.
    generation: u64,
}

impl Service {
    /// Список приложений с диска — данные, которым нельзя верить на слово:
    /// `state.json` переживает версии продукта и правится руками, а один и тот
    /// же путь встречался в нём дважды. Окно рисовало приложение двумя
    /// строками и ругалось на повторяющийся ключ React, а убрать лишнюю строку
    /// было нечем: `RemoveApp` вычищает обе разом, и приложение исчезало
    /// целиком.
    ///
    /// Чистим на входе, а не в каждой команде: `AddApp` и автообнаружение
    /// (`knows`) своих дублей не пропускают, так что войти дубль может только
    /// с диска. Через `load()` проходит всё сохранённое — как прополка
    /// `probes` живёт в одном `save()` по той же причине.
    ///
    /// Выбранность складывается, а не берётся у первой записи: из двух строк
    /// одного exe выключенная не должна отменять выбранную — это молча вынуло
    /// бы приложение из туннеля. Сторож — `a_duplicate_app_never_survives_loading`.
    fn dedup_apps(apps: Vec<App>) -> Vec<App> {
        let mut out: Vec<App> = Vec::new();
        for app in apps {
            match out.iter_mut().find(|a| same_path(&a.path, &app.path)) {
                Some(kept) => kept.enabled |= app.enabled,
                None => out.push(app),
            }
        }
        out
    }

    fn load() -> Self {
        let raw = std::fs::read_to_string(dir().join("state.json")).unwrap_or_default();
        let saved: Saved = serde_json::from_str(&raw).unwrap_or_default();
        let (scope, migrated) = migrate_scope(&saved.scope, saved.all_traffic);
        // Журнал лежит своим файлом, а не полем state.json: его переписывает
        // каждая строка, а состояние с подпиской на сотню узлов — нет.
        let log: Vec<LogLine> = std::fs::read_to_string(dir().join("journal.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        // Язык поднимается до первой строки журнала — иначе стартовые сообщения
        // выходили бы не на том языке, который выбрал пользователь.
        core_ipc::set_lang(saved.lang);
        let mut me = Self {
            status: Status {
                lang: saved.lang,
                profile: saved.profile,
                apps: Self::dedup_apps(saved.apps),
                scope,
                profiles: profiles_of(&saved.profiles),
                subscriptions: subscriptions_of(
                    &saved.subscriptions,
                    &saved.sub_names,
                    &saved.profiles,
                    &saved.quotas,
                ),
                probes: saved.probes,
                browser_profiles: saved.browser_profiles,
                refreshed_at: saved.refreshed_at,
                log,
                ..Default::default()
            },
            settings: saved.settings,
            profiles: saved.profiles,
            subscriptions: saved.subscriptions,
            sub_names: saved.sub_names,
            quotas: saved.quotas,
            private: saved.private,
            policy: saved.policy,
            tunnel: None,
            probe_target: (String::new(), 0),
            retry_at: None,
            retry_delay: RETRY_BASE,
            applied: None,
            probe_now: false,
            browsers: BTreeMap::new(),
            generation: 0,
        };
        me.apply_settings();
        if migrated {
            // Молчать тут нельзя: человек выбирал одно, а работать будет
            // другое. Строка объясняет и что сменилось, и почему именно так.
            me.log(t("охват «выбранные приложения» убран из продукта: он выпускал остальных в открытую сеть. Поставлен «весь компьютер» — он ничего не отключает; белый список включается вручную"));
        }
        me
    }

    /// Действующие настройки = сохранённые, перебитые переменными окружения.
    /// Считается один раз на старте и на каждой записи настроек: окружение под
    /// работающим процессом не меняется.
    ///
    /// Перебивку служба проговаривает в журнале. Без этой строки тумблер в
    /// окне не липнет, а почему — не видно ниоткуда: переменную ставили в
    /// скрипте запуска, который человек уже не помнит.
    fn apply_settings(&mut self) {
        let mut eff = self.settings.clone();
        let mut overridden: Vec<&str> = Vec::new();
        if std::env::var("PG_REFRESH").as_deref() == Ok("0") && eff.refresh {
            eff.refresh = false;
            overridden.push("PG_REFRESH");
        }
        if std::env::var("PG_GEO").as_deref() == Ok("0") && eff.geo {
            eff.geo = false;
            overridden.push("PG_GEO");
        }
        if let Some(v) = std::env::var("PG_PROBE").ok().filter(|v| !v.is_empty() && *v != eff.probe) {
            eff.probe = v;
            overridden.push("PG_PROBE");
        }
        if let Some(v) = std::env::var("PG_SINGBOX").ok().filter(|v| !v.is_empty() && *v != eff.singbox) {
            eff.singbox = v;
            overridden.push("PG_SINGBOX");
        }
        // Путь к бинарнику знает core-tunnel: он его и запускает, а заодно
        // именно этот путь получает разрешение брандмауэра в killswitch.
        core_tunnel::set_binary(&eff.singbox);
        if !overridden.is_empty() {
            let list = overridden.join(", ");
            self.log(tf!("настройки перебиты окружением: {}", list));
        }
        self.status.settings = eff;
    }

    fn save(&mut self) {
        self.status.profiles = profiles_of(&self.profiles);
        self.status.subscriptions =
            subscriptions_of(&self.subscriptions, &self.sub_names, &self.profiles, &self.quotas);
        // Профиля больше нет — и мерить нечего: без этой прополки кэш измерений
        // рос бы вечно, а подписка на сотню узлов переписывает их именами раз в
        // сутки. Здесь, а не в каждом месте удаления: через save() проходят все.
        self.status.probes.retain(|p| self.profiles.contains_key(&p.name));
        let saved = Saved {
            apps: self.status.apps.clone(),
            profiles: self.profiles.clone(),
            subscriptions: self.subscriptions.clone(),
            // Имя подписки, которой больше нет, на диске не нужно: отписались —
            // значит и подпись ей больше ни к чему.
            sub_names: self
                .sub_names
                .iter()
                .filter(|(url, _)| self.subscriptions.contains_key(*url))
                .map(|(url, name)| (url.clone(), name.clone()))
                .collect(),
            quotas: self.quotas.clone(),
            profile: self.status.profile.clone(),
            refreshed_at: self.status.refreshed_at,
            lang: self.status.lang,
            private: self.private,
            policy: self.policy.clone(),
            // Обратно тем же именем, каким читаем: перечисление знает своё имя
            // само, и дублировать его строкой значило бы разъехаться на первом
            // же переименовании.
            scope: serde_json::to_value(self.status.scope).unwrap_or_default(),
            all_traffic: false,
            probes: self.status.probes.clone(),
            browser_profiles: self.status.browser_profiles.clone(),
            settings: self.settings.clone(),
        };
        let _ = std::fs::create_dir_all(dir());
        if let Ok(raw) = serde_json::to_string_pretty(&saved) {
            let _ = std::fs::write(dir().join("state.json"), raw);
        }
    }

    fn log(&mut self, line: impl Into<String>) {
        self.write_log(line.into(), false);
    }

    /// То же, но про несделанное: отказ брандмауэра, упавший sing-box, узел,
    /// которого больше нет. Отдельным именем, а не флагом на месте вызова, —
    /// иначе `false` стоял бы двадцать раз ради пяти `true`.
    fn warn(&mut self, line: impl Into<String>) {
        self.write_log(line.into(), true);
    }

    fn write_log(&mut self, text: String, bad: bool) {
        // Повтор в цикле перезапуска не должен вытеснять из журнала всё остальное.
        // Время повтора при этом не обновляется намеренно: в журнале стоит,
        // когда это началось, а не когда служба сказала то же самое в сотый раз.
        if self.status.log.first().map(|l| l.text.as_str()) == Some(text.as_str()) {
            return;
        }
        eprintln!("{text}");
        self.status.log.insert(0, LogLine { at: now(), text, bad });
        self.status.log.truncate(30);
        // Журнал переживает перезапуск службы, и это не удобство: под SCM у неё
        // нет ни консоли, ни stderr, а перезапуск — это обновление, падение или
        // загрузка машины, то есть ровно те три случая, ради которых журнал и
        // открывают. Раньше он в них и пропадал.
        //
        // Файл переписывается целиком, а не дописывается: строк тридцать, и
        // файл, который всегда в точности равен показанному, не нужно ни
        // ротировать, ни читать с хвоста. Событий у службы десятки в день —
        // цена этой лени три килобайта на запись.
        let _ = std::fs::create_dir_all(dir());
        if let Ok(raw) = serde_json::to_string(&self.status.log) {
            let _ = std::fs::write(dir().join("journal.json"), raw);
        }
    }

    /// Профиль уходит из списка — и из туннеля, если был активен. Держать
    /// поднятым узел, которого больше нет, не за что: это то же самое, что
    /// выключить приватный режим руками, и приложения остаются защищёнными.
    fn forget_profile(&mut self, name: &str) {
        self.profiles.remove(name);
        // Сеансы, смотревшие на этот узел, держали бы живым то, чего больше
        // нет. Сами браузерные профили остаются: в их каталогах входы человека,
        // и починка — это выбрать им другой узел, а не завести всё заново.
        self.stop_sessions_on(name);
        if self.status.profile.as_deref() == Some(name) {
            self.stop();
            self.status.profile = None;
        }
    }

    /// Пути выбранных приложений — для sing-box и для брандмауэра сразу.
    ///
    /// Отдаём и записанный путь, и приведённый к виду файловой системы: какой
    /// из них совпадёт с тем, что Windows покажет про живой процесс, заранее не
    /// известно, а промах здесь тихий — приложение уходит мимо туннеля, не
    /// переставая считаться защищённым. Лишний путь стоит одной строки в
    /// конфиге и одного правила брандмауэра, которое просто ни с чем не совпадёт.
    fn selected(status: &Status) -> Vec<String> {
        let mut out = Vec::new();
        for app in status.apps.iter().filter(|a| a.enabled) {
            let canonical = core_apps::canonical(&app.path);
            if canonical != app.path {
                out.push(canonical);
            }
            out.push(app.path.clone());
        }
        out
    }

    /// Заперты ли сейчас выбранные приложения: приватный режим включён, а
    /// туннель не подтверждён. Отдельной функцией, потому что перепутанный знак
    /// здесь — это либо машина без сети при выключенном режиме, либо открытая
    /// сеть при включённом.
    fn blocked(&self) -> bool {
        self.private && self.status.tunnel != TunnelState::Up
    }

    /// Переставить правила брандмауэра под нынешнее состояние. Идемпотентна:
    /// `guard` сам помнит применённое и молчит, когда менять нечего.
    fn refence(&mut self) {
        let blocked = self.blocked();
        self.guard(blocked);
    }

    /// Правка списка приложений или охвата — и туннель при этом не
    /// перезапускается. Это главное, что даёт один конфиг на оба охвата: список
    /// и охват в него не входят вовсе (`final: proxy`, ни одного правила по
    /// процессу), поэтому sing-box о правке не узнаёт и узнавать ему нечего.
    /// Меняются только правила брандмауэра, а живые соединения — та же открытая
    /// SSH-сессия — правку переживают.
    ///
    /// Раньше здесь стоял перезапуск, и он был обязателен: конфиг перечислял
    /// `process_path` поимённо, и без перезапуска добавленное приложение
    /// продолжало ходить напрямую под надписью «Защищено». Вместе с матчером
    /// ушла и эта цена. Сторож — `editing_the_list_never_restarts_the_tunnel`.
    fn edit(&mut self, change: impl FnOnce(&mut Self)) {
        change(self);
        self.refence();
    }

    /// Путь к браузеру, которым оболочка открывает окна профилей, — но только
    /// пока открыт хоть один сеанс: пропуск живёт ровно столько же.
    ///
    /// Ищется один раз на жизнь службы: поиск — это обход реестра и меню
    /// «Пуск», а `guard` зовётся с каждого круга надзора при выключенном
    /// приватном режиме. Браузер за время работы службы не меняется.
    fn browser_pass(&self) -> Option<String> {
        if self.browsers.is_empty() {
            return None;
        }
        static PATH: OnceLock<Option<String>> = OnceLock::new();
        PATH.get_or_init(|| core_apps::browser().map(|b| b.path)).clone()
    }

    /// Всё, что стоит в брандмауэре: замок политикой и пропуска сквозь него.
    ///
    /// `blocked` — «приватный режим включён, а туннель не подтверждён», то есть
    /// то самое окно, в котором выбранные приложения обязаны быть без сети.
    /// Ставится и снимается всё разом: смена охвата на ходу иначе оставила бы
    /// правила прошлого режима висеть — а это либо приложения без сети
    /// навсегда, либо машина без замка.
    ///
    /// Политика теперь всегда наша: охвата, в котором мы её не трогали, больше
    /// нет. Служба, упавшая с запертым исходящим, на следующем старте видит
    /// сохранённый охват и снимает замок — сразу, если приватный режим был
    /// выключен.
    fn guard(&mut self, blocked: bool) {
        let (fence, killswitch) = fencing(self.status.scope, blocked, self.private);
        let want = Applied {
            fence,
            killswitch,
            // Пути берутся отсюда напрямую, а не из ключа перезапуска: конфигу
            // список безразличен, а брандмауэру он нужен в любом охвате.
            apps: Self::selected(&self.status),
            browser: self.browser_pass(),
        };
        if self.applied.as_ref() == Some(&want) {
            return;
        }
        let touch = touch_policy(killswitch, self.applied.as_ref().map(|a| a.killswitch), core_filter::locked_by_us);
        let before = self.policy.clone();
        let outcome =
            core_filter::set_fence(fence, self.applied.as_ref().map(|a| a.fence), core_tunnel::TUN_ADDR, &want.apps, want.browser.as_deref())
                .and_then(|()| match touch {
                    true => core_filter::set_killswitch(killswitch, &core_tunnel::binary(), before.as_deref()),
                    false => Ok(()),
                });
        match outcome {
            Ok(()) => {
                // Замок снят — сохранённая политика больше не про машину:
                // оставленная лежать, она вернулась бы в следующий раз, а
                // человек за это время мог поменять её сам.
                if touch && !killswitch && self.policy.is_some() {
                    self.policy = None;
                    self.save();
                }
                self.applied = Some(want)
            }
            Err(e) => {
                // Неудачу не запоминаем: на следующей смене состояния попробуем снова.
                self.applied = None;
                self.warn(tf!("правила брандмауэра не поставлены — {}", e));
            }
        }
    }

    fn start(&mut self, profile: &str) -> Result<(), String> {
        let node = self.profiles.get(profile).cloned().ok_or_else(|| tf!("нет профиля «{}»", profile))?;
        self.private = true;
        self.status.profile = Some(profile.to_string());
        self.save();
        // Пакет MSIX после обновления лежит уже по другому пути, а оба слоя
        // перехвата знают приложение только по пути. Переспрашиваем до
        // guard(true): иначе и правило брандмауэра, и `process_path` встанут на
        // папку, которой больше нет.
        self.rebind_packages();
        // Сначала блокируем, потом поднимаем: между командой и живым туннелем
        // выбранные приложения должны быть без сети, а не в обход него.
        // Блокировка идёт и впереди убийства старого процесса: при перезапуске
        // из-за смены списка добавленное приложение в правилах ещё не значится,
        // а TUN уже исчез бы — ровно в эту щель оно и ушло бы напрямую.
        self.guard(true);
        self.tunnel = None; // старый процесс убивается Drop'ом до запуска нового
        self.generation += 1; // всё, что проба знала о прошлом процессе, устарело

        // Ни списка, ни охвата: конфиг у обоих охватов один и тот же, и
        // держит их брандмауэр. Отсюда и то, что галочка туннель не трогает.
        let opts = Options { tun: tun_enabled(), ..Default::default() };
        let config = build_config(&node, &opts);
        self.probe_target = probe_target(&self.status.settings.probe, &node);
        match Process::start(&config, &dir()) {
            Ok(process) => {
                self.tunnel = Some(process);
                self.status.tunnel = TunnelState::Connecting;
                // Подтверждать — сразу: пока туннель не подтверждён, выбранные
                // приложения заперты, и каждая лишняя секунда здесь это просто
                // время без сети, а не запас прочности.
                self.probe_now = true;
                self.retry_at = None;
                self.retry_delay = RETRY_BASE;
                // Приложений, а не путей: в конфиг на каждое уходит до двух форм
                // пути, и `opts.apps.len()` показывал бы человеку удвоенное число.
                let count = self.status.apps.iter().filter(|a| a.enabled).count();
                let scope = match self.status.scope {
                    Scope::All => t("весь трафик компьютера"),
                    Scope::Whitelist => tf!("приложений с сетью: {}, у остальных её нет", count),
                };
                self.log(tf!("профиль «{}»: sing-box запущен, {}", profile, scope));
                Ok(())
            }
            Err(e) => {
                self.status.tunnel = TunnelState::Down;
                self.retry_at = Some(Instant::now() + self.retry_delay);
                let wait = self.retry_delay.as_secs();
                self.retry_delay = (self.retry_delay * 2).min(RETRY_MAX);
                let reason = explain(&e.to_string());
                self.warn(tf!("sing-box не запустился: {}; следующая попытка через {} с", reason, wait));
                Err(reason)
            }
        }
    }

    fn stop(&mut self) {
        self.private = false;
        self.save();
        self.tunnel = None;
        self.generation += 1; // проба, которая сейчас в полёте, — уже про прошлое
        self.status.tunnel = TunnelState::Off;
        self.status.country = None;
        self.status.latency_ms = None;
        (self.status.rx, self.status.tx) = (0, 0);
        self.guard(false);
        self.log(t("приватный режим выключен: правила сняты"));
    }

    /// Отдельный прокси под окно браузера. Тот же браузерный профиль второй раз
    /// — тот же порт: окно уже открыто, поднимать ему второй sing-box незачем.
    ///
    /// Каталог у сеанса свой, по имени браузерного профиля: `Tunnel::start`
    /// добивает процесс из `singbox.pid`, и общий каталог означал бы, что
    /// каждый новый сеанс гасит предыдущий.
    fn browse(&mut self, profile: &str) -> Result<u16, String> {
        let node_name = self
            .status
            .browser_profiles
            .iter()
            .find(|b| b.name == profile)
            .map(|b| b.node.clone())
            .ok_or_else(|| {
                tf!("нет браузерного профиля «{}»", profile)
            })?;
        // Узел могли удалить или он мог пропасть из подписки: сам браузерный
        // профиль это переживает (в его каталоге входы), а вот открыть его
        // теперь нечем — и молчать об этом нельзя.
        let node = self
            .profiles
            .get(&node_name)
            .cloned()
            .ok_or_else(|| tf!("нет узла «{}»", node_name))?;
        if let Some(proc) = self.browsers.get_mut(profile) {
            if proc.alive() {
                return Ok(proc.socks_port);
            }
        }
        // Мёртвый предшественник уходит Drop'ом до запуска нового: каталог и pid
        // у сеанса те же, и его добили бы уже изнутри Tunnel::start.
        self.browsers.remove(profile);
        let dir = dir().join("browser").join(dir_name(profile));
        let proc = core_tunnel::sidecar(&node, &dir).map_err(|e| e.to_string())?;
        let port = proc.socks_port;
        self.log(tf!("профиль «{}» поднят под браузер: 127.0.0.1:{}", profile, port));
        self.browsers.insert(profile.to_string(), proc);
        // Пропуск браузеру — на время сеанса и не дольше.
        self.refence();
        Ok(port)
    }

    /// Погасить сеансы всех браузерных профилей, смотрящих на этот узел.
    fn stop_sessions_on(&mut self, node: &str) {
        let doomed: Vec<String> = self
            .status
            .browser_profiles
            .iter()
            .filter(|b| b.node == node)
            .map(|b| b.name.clone())
            .collect();
        for name in doomed {
            self.browsers.remove(&name);
        }
        self.refence();
    }

    /// Сеанс браузера погашен. Процесс уходит Drop'ом, порт закрывается — и
    /// незакрытая вкладка остаётся без сети: прямого доступа тут не появляется
    /// ни на такт, ровно как и при падении самого sing-box.
    fn browse_stop(&mut self, profile: &str) {
        if self.browsers.remove(profile).is_none() {
            return;
        }
        self.refence();
        self.log(tf!("сеанс браузера «{}» закрыт", profile));
    }

    /// Список приложений переезжает вслед за обновившимися пакетами MSIX.
    /// Молчать тут нельзя: путь в списке меняется сам собой, и человек должен
    /// увидеть в журнале, почему.
    fn rebind_packages(&mut self) -> bool {
        let mut moved = Vec::new();
        for app in &mut self.status.apps {
            if let Some(path) = core_apps::rebind(&app.path) {
                app.path = path;
                moved.push(app.name.clone());
            }
        }
        if !moved.is_empty() {
            // Переезд — единственное место, где путь меняется у уже принятой
            // записи: все прочие проверки стоят на добавлении. Две записи
            // разных версий одного пакета были законно разными путями, а после
            // обновления читаются одной строкой — и список получал точный
            // дубль, которого больше завести неоткуда.
            self.status.apps = Self::dedup_apps(std::mem::take(&mut self.status.apps));
            let names = moved.join(", ");
            self.log(tf!("приложения обновились, пути в списке освежены: {}", names));
            self.save();
        }
        !moved.is_empty()
    }

}

/// Есть ли у службы права администратора. Без них не поднять TUN и не тронуть
/// брандмауэр — а узнать об этом лучше сразу, а не из потока отказов.
#[cfg(windows)]
fn elevated() -> bool {
    std::process::Command::new("net")
        .arg("session")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(windows))]
fn elevated() -> bool {
    true
}

/// Отказ на стадии TUN означает одно: службу запустили без прав администратора.
/// Голый FATAL из sing-box об этом не говорит, а причина всегда одна и та же.
fn explain(error: &str) -> String {
    if !error.contains("tun") {
        return error.to_string();
    }
    // «Отказано в доступе» — это всегда права. Остальные отказы TUN — почти
    // всегда чужой туннель: занятое имя адаптера или пересечение адресов.
    let denied = ["Access is denied", "denied", "elevation", "Отказано в доступе"];
    if denied.iter().any(|d| error.contains(d)) {
        return format!("{error} — нужны права администратора: без них не поднять TUN и не поставить правила брандмауэра");
    }
    format!("{error} — проверьте, не поднят ли рядом другой VPN: два TUN спорят за имя адаптера и маршруты")
}

/// `configured` — цель пробы из настроек, уже с учётом `PG_PROBE`. Мусор в ней
/// не отменяет пробу, а откатывает её к серверу пользователя: настройка, из-за
/// которой перестаёт подтверждаться туннель, — это выбранные приложения без
/// сети, и опечатка такого стоить не должна.
fn probe_target(configured: &str, node: &Value) -> (String, u16) {
    if let Some((h, p)) = configured.rsplit_once(':').and_then(|(h, p)| {
        (!h.is_empty()).then_some((h.to_string(), p.parse::<u16>().ok()?))
    }) {
        return (h, p);
    }
    // По умолчанию пробуем сам сервер пользователя: сторонних адресов не трогаем.
    let server = node["server"].as_str().or_else(|| node["peers"][0]["address"].as_str()).unwrap_or("127.0.0.1");
    let port = node["server_port"].as_u64().or_else(|| node["peers"][0]["port"].as_u64()).unwrap_or(443);
    // Порт приходит из чужого конфига и может быть любым числом; `as u16`
    // превратил бы 70000 в 4464, и проба молча пошла бы не туда.
    (server.to_string(), u16::try_from(port).unwrap_or(443))
}

/// Скачивание подписки. Живой туннель используем, если он есть: панель,
/// закрытую провайдером, напрямую не достать, да и её адрес незачем показывать
/// провайдеру — это тот же трафик пользователя, что и остальной. Первую
/// подписку импортируют ровно тогда, когда туннеля ещё нет, поэтому без него
/// идём напрямую; а не вышло через туннель — пробуем напрямую, потому что отказ
/// сервера от блокировки здесь ничем не отличается.
fn fetch(url: &str, via_tunnel: bool) -> Result<(String, Option<String>), String> {
    // Только https, и проверка здесь, а не в разборе команды: этот же fetch
    // ходит за плановым обновлением подписки, адрес которой мог приехать в
    // state.json ещё до этой проверки. Тело ответа — список серверов, через
    // которые пойдёт весь трафик выбранных приложений; по открытому каналу его
    // подменяет любой, кто на пути, и это не утечка, а подмена VPN целиком.
    if !url.starts_with("https://") {
        return Err(t("подписка только по https: по http список узлов подменит любой, кто на пути"));
    }
    let direct = || get(url, None);
    if !via_tunnel {
        return direct();
    }
    // mixed-инбаунд отвечает и на HTTP CONNECT, поэтому socks-фича ureq не нужна.
    get(url, Some(&format!("http://127.0.0.1:{}", Options::default().socks_port))).or_else(|_| direct())
}

fn get(url: &str, proxy: Option<&str>) -> Result<(String, Option<String>), String> {
    let fail = |e: &dyn std::fmt::Display| {
        tf!("подписка не скачалась: {}", e)
    };
    let proxy = match proxy.map(ureq::Proxy::new).transpose() {
        Ok(proxy) => proxy,
        Err(e) => return Err(fail(&e)),
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(proxy)
        // TLS берём у системы (на Windows это SChannel): корни те же, что у
        // остальных программ на машине, и сборка не тянет за собой C-компилятор
        // ради rustls-ring — с ним `cargo check --target …-msvc` не проходит.
        .tls_config(
            ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build(),
        )
        // Глобальный тайм-аут, а не только на соединение: молчащий сервер не
        // должен держать импорт бесконечно.
        .timeout_global(Some(Duration::from_secs(20)))
        // Панели отдают формат по User-Agent, и на незнакомое имя почти все
        // выдают список ссылок. Clash-YAML разбирается тоже, так что промах
        // с форматом здесь больше не отказ импорта.
        .user_agent(concat!("proxybox/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut response = agent.get(url).call().map_err(|e| fail(&e))?;
    // Заголовок снимаем до тела: `body_mut()` заимствует ответ изменяемо, и
    // после него заголовки уже не спросить. Имя регистронезависимо — за это
    // отвечает `HeaderMap`, а панели пишут его вразнобой.
    let userinfo =
        response.headers().get("subscription-userinfo").and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = response.body_mut().read_to_string().map_err(|e| fail(&e))?;
    Ok((body, userinfo))
}

/// Разбор заголовка `Subscription-Userinfo`.
///
/// Это де-факто стандарт панелей (v2board, sspanel и производные), а не RFC,
/// поэтому терпимость тут не небрежность: поля необязательны, порядок
/// произволен, пробелы вокруг `;` и `=` встречаются, а незнакомое поле и битое
/// число — повод пропустить их, а не отказать в импорте. Заголовка нет вовсе —
/// это норма: подписка скачалась, узлы разобраны, показывать просто нечего.
///
/// Все нули дают `None` по той же причине: понять из заголовка не удалось
/// ничего, и «0 B из 0 B» в окне было бы шумом вместо ответа. Сторож —
/// `a_panel_quota_is_read_from_the_header`.
fn parse_userinfo(header: Option<&str>) -> Option<Quota> {
    let mut quota = Quota::default();
    for part in header?.split(';') {
        let Some((key, value)) = part.split_once('=') else { continue };
        let Ok(number) = value.trim().parse::<u64>() else { continue };
        match key.trim().to_ascii_lowercase().as_str() {
            "upload" => quota.upload = number,
            "download" => quota.download = number,
            "total" => quota.total = number,
            "expire" => quota.expire = number,
            _ => {}
        }
    }
    (quota != Quota::default()).then_some(quota)
}

/// Карта «адрес → узлы» в том виде, в каком её ждёт окно. Порядок задаёт
/// `BTreeMap`: список подписок не должен переставляться сам собой между
/// опросами статуса.
///
/// Имя, которого больше нет в профилях, отсеивается: узел из подписки можно
/// удалить по одному, и до следующей сверки он остался бы висеть в её списке —
/// а окно рисует список профилей группами и показало бы строку без узла.
/// Отсеиваем здесь, а не в `forget_profile`: на диске лишнее имя безвредно,
/// сверка заменяет набор целиком.
fn subscriptions_of(
    map: &BTreeMap<String, Vec<String>>,
    names: &BTreeMap<String, String>,
    profiles: &BTreeMap<String, Value>,
    quotas: &BTreeMap<String, Quota>,
) -> Vec<Subscription> {
    map.iter()
        .map(|(url, nodes)| Subscription {
            url: url.clone(),
            name: names.get(url).cloned().unwrap_or_default(),
            nodes: nodes.iter().filter(|n| profiles.contains_key(*n)).cloned().collect(),
            quota: quotas.get(url).cloned(),
        })
        .collect()
}

/// Профили для окна: имя и то, куда узел ведёт. Имя профиля пишет чужая панель,
/// и до сих пор в окно уезжало только оно — два одинаково названных узла были
/// неразличимы, а вставленную ссылку не с чем было сверить.
///
/// Пароля и ключа здесь нет: статус окно спрашивает каждые две секунды, и всё
/// содержимое узла ездило бы туда-сюда сотнями раз в минуту. За узлом целиком
/// окно ходит отдельно и только на открытие формы правки (`Request::ProfileNode`).
fn profiles_of(profiles: &BTreeMap<String, Value>) -> Vec<ProfileInfo> {
    profiles
        .iter()
        .map(|(name, node)| {
            let (kind, server) = core_config::describe(node);
            ProfileInfo { name: name.clone(), kind, server }
        })
        .collect()
}

/// Занятое имя получает номер: в подписках узлы сплошь и рядом называются
/// одинаково, а профиль в списке — это ключ.
fn free_name(taken: &BTreeMap<String, Value>, want: &str) -> String {
    if !taken.contains_key(want) {
        return want.to_string();
    }
    (2..).map(|n| format!("{want} ({n})")).find(|name| !taken.contains_key(name)).expect("номер найдётся")
}

/// Секунды до момента `at`. Прошедшее и отсутствующее — одинаково `None`:
/// «пауза кончилась» и «паузы не было» для окна одно и то же, круг надзора в
/// обоих случаях возьмётся сам. Округление вверх, потому что «через 0 с» на
/// экране читается как «ничего не происходит» ровно тогда, когда происходит
/// ожидание. Сторож — `the_retry_countdown_never_shows_zero`.
fn retry_in(at: Option<Instant>, now: Instant) -> Option<u32> {
    let left = at?.checked_duration_since(now)?;
    if left.is_zero() {
        return None;
    }
    Some(left.as_secs() as u32 + u32::from(left.subsec_nanos() > 0))
}

/// Что вышло из вставленного: одна ссылка, пачка или отказ с причиной.
///
/// Вставляют не только одну ссылку — из канала приходит десяток строк разом, из
/// панели сохранённый base64-блоб, из чужого клиента Clash-YAML. Всё это уже
/// умеет `parse_many`, и до сих пор он был доступен только через адрес
/// подписки.
///
/// Пачка узнаётся по переносу строки, и решается это **до** `parse`, а не после
/// его отказа: отказа не будет. Перенос `parse` не замечает вовсе — всё после
/// `#` в ссылке это фрагмент, то есть имя узла, — и десяток ссылок он принимает
/// за одну, названную всеми остальными. Ровно так пачка и импортировалась:
/// молча, одним профилем с именем в три экрана.
///
/// Одна строка идёт наоборот — сначала `parse`, и только на его отказе
/// `parse_many`: на битой одиночной ссылке тот вернул бы пустой список, то есть
/// «ничего не нашлось» вместо причины, а причина — единственное, чем человек
/// чинит опечатку в один символ. Сторож — `a_pasted_batch_is_imported_whole`.
fn parse_pasted(text: &str) -> Result<core_config::Batch, String> {
    if text.lines().filter(|line| !line.trim().is_empty()).count() > 1 {
        let many = core_config::parse_many(text);
        if many.found.is_empty() {
            return Err(t("ни одной ссылки не разобрано"));
        }
        return Ok(many);
    }
    match core_config::parse(text) {
        Ok(one) => Ok(core_config::Batch { found: vec![one], skipped: Vec::new() }),
        // Одна строка, а ссылкой не оказалась: так выглядит base64-блоб
        // подписки, сохранённый в файл и вставленный телом.
        Err(why) => {
            let many = core_config::parse_many(text);
            if many.found.is_empty() {
                return Err(why);
            }
            Ok(many)
        }
    }
}

/// Вставленное разделяется на адреса подписок и всё остальное — **построчно**.
///
/// Смотреть на префикс всего текста было нельзя: вставка из двух адресов, как и
/// адрес вместе со ссылками, уезжала в `fetch` целиком, вместе с переносами
/// строк. Окно при этом обещало «строк: N — импортируются разом», а человек
/// получал «подписка не скачалась». Сторож — `a_paste_splits_into_lines`.
///
/// JSON целиком — исключение и построчно не разбирается вовсе: адрес внутри
/// конфига (транспорт, ECH, куда угодно) не адрес подписки.
fn split_paste(text: &str) -> (Vec<String>, String) {
    let text = text.trim();
    if text.starts_with('{') {
        return (Vec::new(), text.to_string());
    }
    let (mut urls, mut rest) = (Vec::new(), Vec::new());
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        if line.starts_with("http://") || line.starts_with("https://") {
            urls.push(line.to_string());
        } else {
            rest.push(line);
        }
    }
    (urls, rest.join("\n"))
}

/// Сколько причин пропуска едет в ответ. Вставляют и тысячу строк мусора, а
/// читают из объяснений первые: остальное — тот же обрезанный список, что и у
/// соединений, и число рядом.
const MAX_SKIPPED: usize = 5;

/// Что получилось из импорта. Общий счёт на вставку и на сверку: действие одно —
/// «заменить набор тем, что пришло».
#[derive(Default)]
struct Tally {
    added: usize,
    kept: usize,
    gone: usize,
    skipped: Vec<String>,
}

impl Tally {
    fn merge(&mut self, other: Tally) {
        self.added += other.added;
        self.kept += other.kept;
        self.gone += other.gone;
        self.skipped.extend(other.skipped);
    }

    /// Ничего не пришло — это отказ, а не пустой успех: так выглядит и мусор во
    /// вставке, и недоступная панель.
    fn empty(&self) -> bool {
        self.added == 0 && self.kept == 0 && self.gone == 0
    }

    fn into_response(mut self) -> Response {
        let skipped_total = self.skipped.len();
        self.skipped.truncate(MAX_SKIPPED);
        Response::Imported {
            added: self.added,
            kept: self.kept,
            gone: self.gone,
            skipped: self.skipped,
            skipped_total,
        }
    }
}

/// Импорт всего, что было во вставке: сперва адреса подписок (каждый — поход в
/// сеть, и потому до замка), следом остальные строки одним заходом под замком.
///
/// Отказ одного адреса не отменяет остальные: в пачке из пяти панелей одна
/// лежащая не повод потерять четыре живые. Причина отказа едет в тот же список
/// пропущенного, что и непонятые строки.
fn import(svc: &Mutex<Service>, urls: &[String], rest: &str) -> Response {
    let mut tally = Tally::default();
    for url in urls {
        match subscribe(svc, url, false) {
            Ok(got) => tally.merge(got),
            Err(why) => tally.skipped.push(format!("{url}: {why}")),
        }
    }
    if !rest.is_empty() {
        match parse_pasted(rest) {
            Ok(batch) => {
                let got = add_profiles(&mut lock(svc), batch);
                tally.merge(got);
            }
            Err(why) => tally.skipped.push(why),
        }
    }
    if tally.empty() {
        // Единственная причина — она же и весь ответ: «импортировано 0» в
        // красной рамке не сказало бы, чего не хватило.
        let message = match tally.skipped.first() {
            Some(first) if tally.skipped.len() == 1 => first.clone(),
            Some(first) => tf!("ни одной строки не импортировано, первая причина — {}", first),
            None => t("импортировать нечего"),
        };
        return Response::Error { message };
    }
    tally.into_response()
}

/// Завести профили из разобранной вставки. Узел, который уже заведён, вторым
/// профилем не становится: имя ему `free_name` выдал бы свободное, и в списке
/// оказались бы две неотличимые строки — а различить их нечем, имя пишет чужая
/// панель. Сторож — `the_same_node_is_never_imported_twice`.
fn add_profiles(s: &mut Service, batch: core_config::Batch) -> Tally {
    let mut tally = Tally { skipped: batch.skipped, ..Default::default() };
    let mut names: Vec<String> = Vec::new();
    for profile in batch.found {
        if s.profiles.values().any(|node| *node == profile.node) {
            tally.kept += 1;
            continue;
        }
        // Занятое имя получает номер — ровно как в подписке. Голый `insert`
        // молча заменял узел под уже существующим именем, и если это имя было
        // активным профилем, оно начинало показывать на другой сервер при живом
        // sing-box от прежнего.
        let name = free_name(&s.profiles, &profile.name);
        s.profiles.insert(name.clone(), profile.node);
        names.push(name);
        tally.added += 1;
    }
    s.log(match names.as_slice() {
        [] => t("новых профилей во вставке нет"),
        [one] => tf!("профиль «{}» импортирован", one),
        many => tf!("импортировано профилей: {}", many.len()),
    });
    s.save();
    tally
}

/// Правка профиля: имя, узел или то и другое разом. Одной командой, потому что
/// это одно действие: у профиля, заведённого из ссылки с опечаткой, чинят и то,
/// и другое — а имя из подписки («🇳🇱 vip-01 |2x») остаётся навсегда, потому что
/// сменить его было нечем.
///
/// Узел из подписки не правится вовсе: сверка заменяет её набор целиком, и
/// правка вернулась бы к прежнему виду ближайшим кругом — то же обещание,
/// которого продукт не держит, что и `✕` на таком узле. Сторож —
/// `a_subscription_node_is_never_edited`.
///
/// Новый узел принимается тем же разбором, что и импорт: JSON годится, share-link
/// годится, второй парсер тут не нужен.
fn edit_profile(s: &mut Service, name: &str, rename: &str, node: &str) -> Response {
    let Some(before) = s.profiles.get(name).cloned() else {
        return Response::Error {
            message: tf!("нет профиля «{}»", name),
        };
    };
    if s.subscriptions.values().any(|nodes| nodes.iter().any(|n| n == name)) {
        return Response::Error {
            message: t("узел пришёл из подписки: сверка вернёт его прежним. Отпишитесь или заведите свою копию"),
        };
    }
    let to = match rename.trim() {
        "" => name.to_string(),
        want => want.to_string(),
    };
    if to != name && s.profiles.contains_key(&to) {
        return Response::Error {
            message: tf!("профиль «{}» уже есть", to),
        };
    }
    // Пустой узел — это «правится только имя»: гонять текст туда-обратно ради
    // переименования незачем, а разбор пустой строки был бы отказом.
    let after = match node.trim() {
        "" => before.clone(),
        text => match core_config::parse(text) {
            Ok(parsed) => parsed.node,
            Err(why) => return Response::Error { message: why },
        },
    };
    if to != name {
        s.profiles.remove(name);
        if s.status.profile.as_deref() == Some(name) {
            s.status.profile = Some(to.clone());
        }
        // На узел по имени смотрят браузерные профили и измерения. Забыть
        // перевесить их значило бы окно браузера без узла и цифру задержки,
        // приклеенную к чужой строке.
        for b in s.status.browser_profiles.iter_mut().filter(|b| b.node == name) {
            b.node = to.clone();
        }
        for p in s.status.probes.iter_mut().filter(|p| p.name == name) {
            p.name = to.clone();
        }
    }
    s.profiles.insert(to.clone(), after.clone());
    s.log(tf!("профиль «{}» изменён", to));
    s.save();
    // Живой туннель на правленом узле обязан перечитать конфиг — ровно то же
    // решение, что принимает сверка подписки, сделанная руками.
    if s.status.profile.as_deref() == Some(to.as_str())
        && after_refresh(Some(&before), Some(&after), s.private, false) == Active::Restart
    {
        s.log(tf!("узел «{}» изменился, туннель перезапускается", to));
        let _ = s.start(&to);
    }
    Response::Done
}

/// Импорт и обновление подписки — одно и то же действие: скачать и заменить
/// набор профилей целиком. Узла, которого в подписке больше нет, не должно
/// остаться и в списке.
///
/// `scheduled` — сверка по расписанию, а не нажатие. Разница ровно одна: узел,
/// который из подписки исчез, у человека выключает приватный режим (он видит
/// это и решает сам), а в фоне — оставляет его включённым без туннеля, то есть
/// выбранные приложения без сети. Выключить приватный режим за спящего
/// пользователя значило бы вернуть его приложения в открытую сеть по чужому
/// решению — панель правит список, а не режим.
fn subscribe(svc: &Mutex<Service>, url: &str, scheduled: bool) -> Result<Tally, String> {
    // Сеть — до захвата замка. Иначе окно на все двадцать секунд перестало бы
    // получать статус, а служба — выглядеть живой.
    // Замок берём на одно поле и сразу отпускаем: знать, жив ли туннель, надо
    // до сети, а держать состояние на все двадцать секунд запроса — нельзя.
    let via_tunnel = lock(svc).status.tunnel == TunnelState::Up;
    // Заголовок остатка приезжает тем же ответом, что и список узлов. Второго
    // запроса за ним не заводим: подписки сверяются раз в несколько часов и ещё
    // по нажатию, а лишний поход к панели — лишний повод считать нас флудом.
    let (body, userinfo) = fetch(url, via_tunnel)?;
    let batch = core_config::parse_many(&body);
    let mut s = lock(svc);
    if batch.found.is_empty() {
        // Пустой ответ — это чаще всего не пустая подписка, а неверный адрес
        // или чужой формат. Старые профили в таком случае не трогаем.
        let message = t("в ответе подписки нет ни одного узла — проверьте адрес");
        s.warn(message.clone());
        return Err(message);
    }

    // Набор заменяется целиком, но живой туннель на это время не гасится:
    // между снятыми правилами и поднятым заново sing-box выбранные приложения
    // ушли бы напрямую — щель узкая, но это ровно та щель, которой продукт не
    // допускает. Поэтому профили сначала подменяются молча, а судьба активного
    // узла решается уже по готовому списку.
    let active = s.status.profile.clone();
    let before = active.as_ref().and_then(|name| s.profiles.get(name)).cloned();
    // Что было и что стало — узлами, а не именами: имена панель переставляет и
    // нумерует как ей вздумается, и по ним «пришло десять новых» вышло бы на
    // ровном месте. Сравнение перебором: узлов сотни, значений в узле десяток,
    // и стоит это заметно меньше самой закачки.
    let was: Vec<Value> = s
        .subscriptions
        .get(url)
        .map(|names| names.iter().filter_map(|n| s.profiles.get(n).cloned()).collect())
        .unwrap_or_default();
    for name in s.subscriptions.remove(url).unwrap_or_default() {
        s.profiles.remove(&name);
    }
    let mut tally = Tally { skipped: batch.skipped, ..Default::default() };
    let mut names: Vec<String> = Vec::new();
    let mut now_nodes: Vec<Value> = Vec::new();
    for p in batch.found {
        if was.contains(&p.node) {
            tally.kept += 1;
        } else {
            tally.added += 1;
        }
        now_nodes.push(p.node.clone());
        let name = free_name(&s.profiles, &p.name);
        s.profiles.insert(name.clone(), p.node);
        names.push(name);
    }
    tally.gone = was.iter().filter(|node| !now_nodes.contains(node)).count();
    s.log(tf!("подписка обновлена, узлов — {}", names.len()));
    // Отметку двигает любая удачная сверка, а не только плановая: список пришёл
    // с панели — значит он свежий, и ходить за ним снова через пять минут после
    // того, как человек нажал «обновить» руками, незачем.
    s.status.refreshed_at = Some(now());
    s.subscriptions.insert(url.to_string(), names);
    // Остаток кладём рядом с узлами и тем же ключом: пришли они одним ответом.
    // Панель заголовка не прислала — прежнее число убираем, а не оставляем: оно
    // тем более не свежее, чем список, который только что заменили целиком.
    match parse_userinfo(userinfo.as_deref()) {
        Some(quota) => {
            s.quotas.insert(url.to_string(), quota);
        }
        None => {
            s.quotas.remove(url);
        }
    }
    // Окна браузера могли висеть на узлах, которых в подписке больше нет:
    // держать их живыми не за что, ровно как и активный профиль.
    let gone: Vec<String> = s
        .status
        .browser_profiles
        .iter()
        .filter(|b| !s.profiles.contains_key(&b.node))
        .map(|b| b.name.clone())
        .collect();
    for name in gone {
        s.browsers.remove(&name);
    }
    s.save();
    if let Some(name) = active {
        let after = s.profiles.get(&name).cloned();
        if after.is_none() {
            s.status.profile = None;
        }
        match after_refresh(before.as_ref(), after.as_ref(), s.private, scheduled) {
            Active::Keep => {}
            // start() сам ставит правила впереди всего, порядок здесь безопасен.
            Active::Restart => {
                s.log(tf!("узел «{}» изменился, туннель перезапускается", name));
                let _ = s.start(&name);
            }
            Active::Stop => s.stop(),
            Active::Drop => {
                s.warn(tf!("узел «{}» пропал из подписки: приватный режим оставлен включённым, выбранные приложения без сети", name));
                s.tunnel = None; // надзор увидит отсутствие процесса и заблокирует приложения
                s.generation += 1;
                s.save();
            }
        }
    }
    Ok(tally)
}

/// Судьба активного профиля после того, как подписка заменила набор. Вынесено
/// из subscribe() ради теста: перепутать здесь ветку — значит вернуть выбранные
/// приложения в открытую сеть, а это ровно то, чего продукт не допускает.
#[derive(Debug, PartialEq)]
enum Active {
    /// Узел не изменился (или режим и так выключен) — трогать нечего.
    Keep,
    /// Узел вернулся с другими параметрами: туннель обязан перечитать конфиг.
    Restart,
    /// Узел исчез, и решение принимал человек — гасим и снимаем правила.
    Stop,
    /// Узел исчез на фоновой сверке: приватный режим остаётся, туннеля нет,
    /// выбранные приложения в DROP.
    Drop,
}

fn after_refresh(before: Option<&Value>, after: Option<&Value>, private: bool, scheduled: bool) -> Active {
    match (after, before == after, private, scheduled) {
        (_, true, _, _) => Active::Keep,
        (_, _, false, _) => Active::Keep, // приватного режима нет — и рвать нечего
        (Some(_), ..) => Active::Restart,
        (None, _, _, true) => Active::Drop,
        (None, ..) => Active::Stop,
    }
}

/// Срок сверки из настроек. Ноль часов сюда не доходит — его отбивает
/// `SetSettings`, — но `max(1)` стоит и здесь: `state.json` правят руками, а
/// нулевой срок означал бы поход по всем подпискам каждый круг потока, то есть
/// раз в пять минут. Сторож — `the_refresh_period_is_never_zero`.
fn refresh_every(settings: &Settings) -> Duration {
    Duration::from_secs(u64::from(settings.refresh_hours.max(1)) * 60 * 60)
}

/// Пора ли сверять подписки. Срок отсчитывается от последней удачной сверки, а
/// не от старта службы: домашняя машина живёт часами и уходит в сон, шесть
/// часов подряд на ней не набираются никогда — и плановая сверка при отсчёте от
/// старта не случалась бы вообще ни разу.
fn refresh_due(refreshed_at: Option<u64>, now: u64, every: Duration) -> bool {
    match refreshed_at {
        // Не сверялись ни разу: подписку завели до того, как служба научилась
        // это помнить, — сверить один раз и запомнить.
        None => true,
        // saturating: часы могли перевести назад, и отрицательного возраста у
        // отметки не бывает — «в будущем» значит «только что».
        Some(at) => now.saturating_sub(at) >= every.as_secs(),
    }
}

/// Сверка подписок по расписанию. Отдельным потоком, а не тиком надзора:
/// запрос к панели длится до двадцати секунд, и на это время присмотр за
/// туннелем встал бы — окно утечки после падения sing-box выросло бы с трёх
/// секунд до двадцати с лишним.
fn refresh_loop(svc: Arc<Mutex<Service>>) {
    // Неудачная попытка отметку на диске не двигает — и без этой памяти служба
    // ходила бы к недоступной панели каждые пять минут до самого её возвращения.
    // В памяти, а не на диске, намеренно: перезапуск службы — это как раз повод
    // попробовать снова.
    let mut tried: Option<Instant> = None;
    loop {
        std::thread::sleep(REFRESH_TICK);
        // Настройку спрашиваем каждый круг, а не при запуске потока: её
        // выключают в работающей службе, и молчать поток обязан с этого
        // момента, а не со следующего запуска.
        let urls: Vec<String> = {
            let s = lock(&svc);
            if !s.status.settings.refresh {
                continue;
            }
            let every = refresh_every(&s.status.settings);
            if tried.is_some_and(|t| t.elapsed() < every) {
                continue;
            }
            if !refresh_due(s.status.refreshed_at, now(), every) {
                continue;
            }
            s.subscriptions.keys().cloned().collect()
        };
        if urls.is_empty() {
            continue;
        }
        tried = Some(Instant::now());
        for url in urls {
            // Ошибку сверки глотаем намеренно: панель бывает недоступна, и
            // существующие профили в этом случае остаются как есть.
            let _ = subscribe(&svc, &url, true);
        }
    }
}

/// Что ставить в брандмауэр: правила на выбранных приложениях и запрет всего
/// исходящего. Выводится, а не вспоминается ветками, — по той же причине, что и
/// надобность перезапуска в `edit()`: забывают именно ветки.
///
/// `blocked` здесь означает «туннель не подтверждён», а `private` — что человек
/// включил приватный режим. Три охвата разводятся так:
///
/// - `Apps`: политика машины не наша, трогать её нельзя; выбранные запираются
///   поимённо на то время, пока туннеля нет.
/// - `All`: запирать поимённо некого — под запрет уходит вся машина, и только
///   пока туннель не подтверждён.
/// - `Whitelist`: запрет держится всё время, пока включён приватный режим, — он
///   и есть «у остальных сети нет». Выбранным при живом туннеле выдаётся
///   пропуск, а на время падения пропуск снимается, и они запираются тем же
///   запретом. Сторож — `the_whitelist_locks_the_door_and_hands_out_passes`.
/// Трогать ли политику брандмауэра машины. Ставим замок — всегда. Снимаем —
/// только если он наш: политика это состояние всей машины, и точно такой же
/// `blockoutbound` бывает у другого клиента VPN или выставлен человеком руками.
///
/// `was` — что служба применяла сама в этот запуск; `None` значит «ещё ничего»,
/// то есть первый круг после старта или круг после отказа netsh. Только там и
/// приходится спрашивать систему, поэтому ответ приходит функцией, а не
/// значением: на всех прочих кругах его считать незачем.
///
/// Когда `was` известно, трогаем политику только на смене бита. Дело не в трёх
/// лишних вызовах netsh: `set_killswitch(true)` начинается со снятия разрешения
/// для sing-box и ставит его заново уже под действующим `blockoutbound` — то
/// есть на два вызова оставляет туннель без пропуска. Приходилось это ровно на
/// подтверждении пробы (`Fence::Off` → `Fence::Allow` при неизменном замке), где
/// отбирать у sing-box сеть хуже всего.
///
/// Цена — политику, изменённую снаружи под уже стоящим нашим замком, служба
/// сама не чинит. Она и раньше её не чинила: `guard` выходит рано, когда
/// применённое совпало, и починка случалась только попутно, на смене пропусков.
///
/// Сторож — `a_foreign_killswitch_is_not_ours_to_lift`.
fn touch_policy(killswitch: bool, was: Option<bool>, ours: impl FnOnce() -> bool) -> bool {
    match was {
        Some(was) => was != killswitch,
        None => killswitch || ours(),
    }
}

/// Что делать с охватом, сохранённым прошлой версией. Возвращает охват и то,
/// был ли перенос: про перенос надо сказать в журнале — человек выбирал одно, а
/// работать будет другое.
///
/// Переносим в «весь компьютер», а не в белый список, и безопасен из двух
/// ровно один: «весь компьютер» ничего не отключает, а белый список отключил бы
/// всё неотмеченное — то есть обновление молча отрезало бы машину от сети.
/// Сторож — `an_update_never_cuts_off_a_machine_that_was_not_asked`.
fn migrate_scope(saved: &Value, all_traffic: bool) -> (Scope, bool) {
    match serde_json::from_value::<Scope>(saved.clone()) {
        Ok(scope) => (scope, false),
        // Сюда попадают три случая: «apps» (тот самый удалённый split-tunnel),
        // поля нет вовсе (`state.json` старше самих охватов) и мусор. Первые
        // два означали split-tunnel — кроме старого флага `all_traffic`,
        // который и тогда значил «весь компьютер»: там человек уже выбрал то,
        // что получит, и переносом это не считается.
        Err(_) => (Scope::All, !all_traffic),
    }
}

fn fencing(scope: Scope, blocked: bool, private: bool) -> (core_filter::Fence, bool) {
    use core_filter::Fence;
    match scope {
        // Весь компьютер: делить некого, в туннель уходит всё. Замок нужен
        // только на окно, пока туннель не подтверждён. `private &&` тут не
        // лишнее: без него `guard(true)` при выключенном приватном режиме
        // запер бы машину целиком.
        Scope::All => (Fence::Off, private && blocked),
        // Белый список: замок стоит всё время, пока включён приватный режим, а
        // пропуск выдаётся только при подтверждённом туннеле. Выдай мы его
        // раньше — выбранное приложение вышло бы в открытую сеть ровно в то
        // окно, ради которого весь этот замок и заведён. И наоборот: снимать
        // ради него замок нельзя, это открыло бы сеть всем.
        Scope::Whitelist => (if private && !blocked { Fence::Allow } else { Fence::Off }, private),
    }
}

/// Утечки помечаются и едут вперёд всего остального. Список приходит по
/// громкости и режется сотней, а утечка — это выбранное приложение, ушедшее
/// напрямую, и громкой она не бывает: пара килобайт на неудачное соединение.
/// Без этого подъёма единственное, ради чего панель открывают, тонуло бы под
/// торрентом соседа — в охвате «весь компьютер» соединений тысячи.
///
/// Пометка и порядок считаются здесь вместе и больше нигде: окно рисует
/// `Conn::leak`, а не сверяет пути заново. Своя сверка у него была бы сверкой с
/// одной формой пути — в списке приложений она одна, а в конфиге их до двух, —
/// то есть красила бы серым ровно ту утечку, ради которой заведена вторая форма.
///
/// Сортировка устойчива, поэтому внутри обеих групп порядок по громкости
/// остаётся тем, каким пришёл. Сторож — `a_leak_is_never_truncated_away`.
fn leaks_first(conns: &mut [Conn], picked: &BTreeSet<String>) {
    for c in conns.iter_mut() {
        // Путь из sing-box и путь из списка — одна строка с точностью до
        // регистра: на Windows их не различает и сама файловая система.
        c.leak = !c.tunneled && picked.contains(&c.process.to_lowercase());
    }
    conns.sort_by_key(|c| !c.leak);
}

/// Есть ли уже это приложение в списке. С точностью до регистра — как и всё
/// прочее сравнение путей у нас (`leaks_first` выше, охват в `supervise`):
/// на Windows `…\store.exe` и `…\Store.exe` — один и тот же файл.
///
/// Спрашивает автообнаружение, и только оно: остальные команды получают путь
/// из самого списка, где он совпадает побайтово по построению. А находка из
/// реестра приходит в том регистре, в каком её записал установщик, — побайтовое
/// сравнение заводило второй экземпляр того же exe, и список показывал его
/// дважды. Сторож — `discovery_knows_a_path_it_already_has`.
fn knows(apps: &[App], path: &str) -> bool {
    apps.iter().any(|a| same_path(&a.path, path))
}

/// Один ли это файл. С точностью до регистра — как `leaks_first` выше и как
/// сам `core_apps::discover()` со своими находками: на Windows регистр пути
/// не различает и файловая система.
fn same_path(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Что из найденного и правда новое. Выключенными: найдено — не значит выбрано.
///
/// Сверяется и с уже принятым в этом же заходе, а не только со списком: `found`
/// склеен из каталога, реестра, пакетов и живых процессов, и один exe приходит
/// оттуда столько раз, сколько у него процессов. Дедуп внутри `discover()` эту
/// пачку схлопывает, но снимок `status.apps` про принятое секунду назад в том
/// же цикле не знает — стоит дедупу пропустить хоть один вид пути, и в список
/// уезжает вся пачка разом, а не одна запись.
///
/// Сторож — `discovery_never_adds_one_exe_twice_in_a_single_pass`.
fn newcomers(known: &[App], found: Vec<core_apps::Found>) -> Vec<App> {
    let mut added: Vec<App> = Vec::new();
    for f in found {
        if knows(known, &f.path) || knows(&added, &f.path) {
            continue;
        }
        added.push(App { path: f.path, name: f.name, enabled: false });
    }
    added
}

/// Автообнаружение приложений: сначала обход системы, и только потом замок.
///
/// Порядок тут и есть всё содержание функции. Обход — это реестр, меню «Пуск»,
/// каталог WindowsApps и снимок живых процессов; секунды работы с диском, и ни
/// одна из них не смотрит в состояние службы. Под общим замком эти секунды
/// платит не нажавший, а все сразу: окно не получает `Status`, а `supervise` и
/// `watch_for_death` не могут взять замок, чтобы заметить смерть sing-box и
/// запереть выбранные приложения. По той же причине из-под замка вынесены
/// подписка (`subscribe`), список соединений и прогон профилей.
///
/// Список сверяется уже под замком и перечитывается там же, а не снимается до
/// обхода: за это время могли добавить приложение руками, и `newcomers` обязан
/// сравнивать с тем, что в списке сейчас, — иначе тот же путь войдёт вторым.
fn discover(svc: &Mutex<Service>, env: &BTreeMap<String, String>) -> Response {
    let found = core_apps::discover(env);
    let mut s = lock(svc);
    let added = newcomers(&s.status.apps, found);
    s.log(match added.len() {
        0 => t("автообнаружение: ничего нового не найдено"),
        n => tf!("автообнаружение: добавлено приложений — {}", n),
    });
    // Добавленное выключенным sing-box не видит: перезапуска не будет.
    s.edit(|s| {
        s.status.apps.extend(added);
        s.save();
    });
    Response::Apps(s.status.apps.clone())
}

fn handle(svc: &Mutex<Service>, req: Request) -> Response {
    // Импорт ходит в сеть за каждой подпиской, поэтому разбирается до замка —
    // остальные команды работают с состоянием и берут его сразу. Замок внутри
    // берётся сам и ненадолго: сперва на все закачки, потом на одну запись.
    if let Request::AddProfile { link } = &req {
        let (urls, rest) = split_paste(link);
        return import(svc, &urls, &rest);
    }
    // Иконку служба не хранит и не спрашивает у состояния вовсе: путь пришёл в
    // запросе, ответ достаётся из самого файла. Под общим замком этот поход по
    // диску стоял зря и стоил дорого — иконок спрашивают не одну, а по одной на
    // каждое приложение списка, залпом, как только открыли вкладку. Соединение
    // каждой из них своё (поток на подключение), так что весь залп выстраивался
    // в очередь к замку, а за ним в той же очереди стояли и статус в окне, и
    // надзор за туннелем. Один путь на отвалившейся сетевой шаре добавляет к
    // этому таймаут SMB, то есть держит службу немой десятки секунд.
    if let Request::Icon { path } = &req {
        return Response::Icon(core_apps::icon(path));
    }
    // Автообнаружение — то же самое, только дороже: обход реестра, меню «Пуск» и
    // каталога WindowsApps идёт секундами. Состояние ему нужно лишь в конце, для
    // сверки найденного с уже известным, — и берётся там же, внутри.
    if let Request::Discover { env } = &req {
        return discover(svc, env);
    }
    let mut s = lock(svc);
    match req {
        Request::Status => {
            // Прокси под окна браузера не помнятся в статусе, а спрашиваются
            // здесь: процесс мог умереть сам, и запомненное «открыто» пережило
            // бы его — ровно та же ложь, что и «туннель поднят» после падения.
            let was = s.browsers.len();
            s.browsers.retain(|_, proc| proc.alive());
            // Умерший сеанс уносит с собой и пропуск браузера: правило живёт
            // ровно столько, сколько сеанс, и последний закрывшийся обязан его
            // снять. Закрытый руками это делает сам (`browse_stop`), а за
            // умершим сам собой снимал круг надзора — тем, что переставлял
            // правила каждый раз. Он этого больше не делает, и снимает теперь
            // тот, кто смерть и заметил. Сторож — `a_dead_session_takes_its_pass_with_it`.
            if s.browsers.len() != was {
                s.refence();
            }
            s.status.browsers = s.browsers.keys().cloned().collect();
            // Здесь же, где прополка сеансов, и по той же причине: запомненное
            // число соврало бы через секунду. Пауза в службе — `Instant`, наружу
            // едут секунды.
            s.status.retry_in = retry_in(s.retry_at, Instant::now());
            Response::Status(s.status.clone())
        }
        Request::ListApps => Response::Apps(s.status.apps.clone()),
        // Обе разобраны до замка и сюда не доходят. Паника тут безопасна:
        // до `lock(svc)` управление не дошло, отравить замок нечем, а поток
        // на этом соединении свой — уронить она может только его.
        Request::Icon { .. } | Request::Discover { .. } | Request::AddProfile { .. } => {
            unreachable!("разбирается до замка")
        }
        Request::AddApp { path } => {
            if !s.status.apps.iter().any(|a| a.path == path) {
                let name = path
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or(&path)
                    .trim_end_matches(".exe")
                    .to_string();
                s.edit(|s| {
                    s.status.apps.push(App { path, name, enabled: true });
                    s.save();
                });
            }
            Response::Done
        }
        Request::SetScope { scope } => {
            if s.status.scope != scope {
                // Туннель не трогаем вовсе: конфиг у обоих охватов один, и
                // перезапуск ради переключения оборвал бы живые соединения на
                // ровном месте. Меняются только правила брандмауэра.
                s.edit(|s| {
                    s.status.scope = scope;
                    s.log(match scope {
                        Scope::All => t("охват: весь трафик компьютера"),
                        Scope::Whitelist => t("охват: только выбранные приложения, остальным сеть закрыта"),
                    });
                    s.save();
                });
            }
            Response::Done
        }
        Request::SetApp { path, enabled } => match s.status.apps.iter().any(|a| a.path == path) {
            true => {
                s.edit(|s| {
                    if let Some(app) = s.status.apps.iter_mut().find(|a| a.path == path) {
                        app.enabled = enabled;
                    }
                    s.save();
                });
                Response::Done
            }
            false => Response::Error {
                message: tf!("приложение не в списке: {}", path),
            },
        },
        Request::RemoveApp { path } => {
            s.edit(|s| {
                s.status.apps.retain(|a| a.path != path);
                s.save();
            });
            Response::Done
        }
        Request::ProfileNode { name } => match s.profiles.get(&name) {
            // С отступами: этот текст человек читает и правит руками, а
            // однострочный узел с транспортом и TLS не читается вовсе.
            Some(node) => Response::ProfileNode { json: serde_json::to_string_pretty(node).unwrap_or_default() },
            None => Response::Error {
                message: tf!("нет профиля «{}»", name),
            },
        },
        Request::EditProfile { name, rename, node } => edit_profile(&mut s, &name, &rename, &node),
        Request::SetLang { lang } => {
            // Язык переключает и журнал службы: сообщения пишет она, а читает
            // их пользователь в окне.
            s.status.lang = lang;
            core_ipc::set_lang(lang);
            s.save();
            Response::Done
        }
        Request::RemoveProfile { name } => {
            s.forget_profile(&name);
            s.save();
            Response::Done
        }
        Request::RemoveSubscription { url } => match s.subscriptions.remove(&url) {
            Some(names) => {
                // Осиротевшая запись была бы невидима (`subscriptions_of` идёт
                // по узлам), но копилась бы на диске вечно.
                s.quotas.remove(&url);
                for name in &names {
                    s.forget_profile(name);
                }
                s.log(tf!("подписка отключена, профилей убрано — {}", names.len()));
                s.save();
                Response::Done
            }
            None => Response::Error {
                message: tf!("нет подписки {}", url),
            },
        },
        Request::RenameSubscription { url, name } => {
            if !s.subscriptions.contains_key(&url) {
                return Response::Error {
                    message: tf!("нет подписки {}", url),
                };
            }
            // Пустое имя — это «показывать адрес», а не подпись из пробелов.
            match name.trim() {
                "" => s.sub_names.remove(&url),
                want => s.sub_names.insert(url, want.to_string()),
            };
            s.save();
            Response::Done
        }
        Request::On { profile } => {
            // Команда пользователя — пробуем сразу, накопленная пауза не в счёт.
            s.retry_at = None;
            s.retry_delay = RETRY_BASE;
            match s.start(&profile) {
                Ok(()) => Response::Done,
                Err(message) => Response::Error { message },
            }
        }
        Request::Off => {
            s.stop();
            Response::Done
        }
        // Инстанс под браузер живёт отдельно от приватного режима: он ничего не
        // маршрутизирует сам и не трогает ни правил, ни TUN.
        Request::Browse { profile } => match s.browse(&profile) {
            Ok(port) => Response::Proxy { port },
            Err(message) => Response::Error { message },
        },
        // Закрытие окна замечает тот, кто его и открыл: служба видит только
        // живой процесс sing-box, а он переживает окно браузера легко.
        Request::BrowseStop { profile } => {
            s.browse_stop(&profile);
            Response::Done
        }
        // Правка личности — это перезапись профиля с тем же именем: каталог с
        // куками привязан к имени и переживает её. Живой сеанс не трогаем: UA и
        // язык браузер прочитал при запуске, применятся они со следующего окна,
        // а гасить окно ради этого — потерять то, что человек в нём делает.
        Request::SetBrowserProfile { profile } => {
            match s.status.browser_profiles.iter_mut().find(|b| b.name == profile.name) {
                Some(existing) => *existing = profile,
                None => s.status.browser_profiles.push(profile),
            }
            s.save();
            Response::Done
        }
        Request::SetSettings { settings } => {
            // Клиент показывает действующие значения и присылает их обратно
            // набором. Перебитые окружением поля при этом возвращаем к
            // сохранённым: переменная живёт ровно столько, сколько выставлена,
            // и переживать себя записью в state.json не должна — иначе e2e и
            // разработка молча меняли бы настройки того, кто их запустил.
            let mut next = settings;
            if std::env::var("PG_REFRESH").as_deref() == Ok("0") {
                next.refresh = s.settings.refresh;
            }
            if std::env::var("PG_GEO").as_deref() == Ok("0") {
                next.geo = s.settings.geo;
            }
            if std::env::var("PG_PROBE").is_ok_and(|v| !v.is_empty()) {
                next.probe = s.settings.probe.clone();
            }
            if std::env::var("PG_SINGBOX").is_ok_and(|v| !v.is_empty()) {
                next.singbox = s.settings.singbox.clone();
            }
            // Ноль часов — это сверка каждый круг потока, то есть поход по всем
            // подпискам раз в пять минут: выключают её флажком выше, а не
            // сроком. Верхняя граница — про то же с другой стороны: срок в
            // тысячу лет неотличим от выключенной сверки, только молча.
            next.refresh_hours = next.refresh_hours.clamp(1, 24 * 30);
            s.settings = next;
            // Туннель не трогаем намеренно: ни одно поле не меняет судьбу уже
            // поднятого sing-box. Путь к бинарнику действует со следующего
            // запуска, проба и страна — со следующего измерения, сверка
            // подписок — со следующего круга. Перезапуск ради настройки означал
            // бы окно без сети у выбранных приложений на ровном месте.
            s.apply_settings();
            s.save();
            Response::Status(s.status.clone())
        }
        Request::RemoveBrowserProfile { name } => {
            s.browsers.remove(&name);
            s.status.browser_profiles.retain(|b| b.name != name);
            s.save();
            Response::Done
        }
        Request::Connections => {
            // Порт снимается под замком, а список качается без него: ходить в
            // сеть (пусть и по петле) под общим замком нельзя — на том конце
            // sing-box, и его молчание стоило бы окну всего статуса.
            let port = s.tunnel.as_ref().map(|t| t.api_port);
            // Выбранные приложения снимаются тем же движением: сотня самых
            // говорливых прячет тихую утечку, а ради неё панель и открывают.
            //
            // Спрашиваем ровно ту функцию, что наполняет конфиг: sing-box
            // сверяет путь процесса с её выводом, и сверять здесь что-то другое
            // значило бы звать утечкой не то, что ею является. Цена — по одному
            // `canonicalize` на выбранное приложение за запрос; это локальный
            // файл, и на фоне похода в clash-api рядом её не видно.
            let picked: BTreeSet<String> =
                Service::selected(&s.status).iter().map(|p| p.to_lowercase()).collect();
            drop(s);
            let Some(port) = port else {
                // Туннеля нет — и соединений нет. Это не ошибка: ровно так
                // выглядит выключенный приватный режим и fail-closed.
                return Response::Connections { conns: Vec::new(), total: 0 };
            };
            // Кто держит порт — снимок машины, а не туннеля, и снимается он
            // без замка по той же причине, что и сам список: обход таблицы
            // сокетов плюс открытие процессов стоит миллисекунд, а замок один
            // на состояние и на обработку команды. Раз на запрос, и только
            // пока панель открыта, — sing-box за то же платил снимком на
            // каждое соединение машины.
            let owners = core_apps::port_owners();
            match core_tunnel::connections(port, &owners) {
                Ok(mut conns) => {
                    let total = conns.len();
                    // Обрезаем осознанно: в охвате «весь компьютер» соединений
                    // бывают тысячи, а прочитать человек успевает десятки.
                    // Сколько их было всего, едет рядом — молча обрезанный
                    // список читался бы как полный.
                    leaks_first(&mut conns, &picked);
                    conns.truncate(MAX_CONNS);
                    Response::Connections { conns, total }
                }
                Err(e) => Response::Error { message: e.to_string() },
            }
        }
        Request::TestProfiles { only } => {
            // Список снимается под замком, а меряется без него: профиль тратит
            // до нескольких секунд, а под этим замком стоит весь GUI.
            let profiles: Vec<(String, Value)> = s
                .profiles
                .iter()
                .filter(|(name, _)| only.as_ref().is_none_or(|want| want == *name))
                .map(|(name, node)| (name.clone(), node.clone()))
                .collect();
            if profiles.is_empty() {
                return match only {
                    Some(name) => Response::Error {
                        message: tf!("нет профиля «{}»", name),
                    },
                    None => Response::Status(s.status.clone()),
                };
            }
            // Бегунок взводится до того, как замок отпущен: окно спрашивает
            // статус раз в две секунды, и первый же ответ обязан сказать, что
            // прогон пошёл. Прогон на сотне узлов идёт минуты, и всё это время
            // единственным его признаком была погасшая кнопка.
            s.status.testing = Some(TestRun { done: 0, total: profiles.len() });
            drop(s);
            // Свой каталог: в общем с туннелем прогон добил бы по singbox.pid
            // ровно тот процесс, который проверяет. По той же причине прогон
            // должен быть один: каталог probe/ у них общий, и два параллельных
            // прогона добивают друг друга — рабочие профили выглядели бы
            // сломанными. Второй ждёт, а не получает отказ: он всё равно шёл за
            // свежими числами и дождётся именно их.
            let _one_at_a_time = PROBE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let probe_dir = dir().join("probe");
            // Точка выхода — та же третья сторона и тот же выключатель, что у
            // живого туннеля. Прогон идёт по профилю за раз и по запросу на
            // профиль: сервис считает флудом десятки запросов в минуту, а
            // столько подряд у нас и не выходит — каждый профиль стоит секунд.
            let (geo, target) = {
                let s = lock(svc);
                (s.status.settings.geo, s.status.settings.probe.clone())
            };
            // Итог каждого узла кладётся в состояние сразу, а не копится до
            // конца прогона. Узел стоит до `measure`-таймаута, и подписка на
            // полсотни — это минуты бегунка без единой цифры: человек не знает,
            // идёт прогон или завис. Окно опрашивает статус раз в две секунды,
            // так что список сам становится указателем прогресса, и заводить
            // ради этого ни новой команды, ни события не нужно.
            //
            // Замок берётся на каждый узел отдельно и только на запись: держать
            // его через `measure` нельзя — под ним стоит весь GUI, ровно та
            // причина, по которой список и снят копией выше.
            let mut live = 0usize;
            let all = profiles.len();
            for (done, (name, node)) in profiles.iter().enumerate() {
                let (host, port) = probe_target(&target, node);
                let (latency, exit, error) = match core_tunnel::measure(node, &probe_dir, (&host, port), geo) {
                    Ok((ms, exit)) => (Some(ms), exit, None),
                    Err(e) => (None, None, Some(e.to_string())),
                };
                live += usize::from(latency.is_some());
                // Не замена списка, а обновление: прогон переписывает задержку и
                // отказ, но страну неответившего оставляет — она от того, что узел
                // сегодня молчит, не изменилась.
                let mut s = lock(svc);
                remember(&mut s.status.probes, name, latency, exit, error);
                s.status.testing = Some(TestRun { done: done + 1, total: all });
            }
            let mut s = lock(svc);
            // Бегунок гаснет здесь и только здесь: оставленный взведённым, он
            // означал бы вечный прогон — кнопка заперта, а мерить некому.
            s.status.testing = None;
            // Строка одна на весь прогон, а не на узел: журнал пишется на диск
            // каждой строкой, и логировать в цикле нельзя.
            s.log(tf!("прогон профилей: отвечают {} из {}", live, all));
            // На диск — один раз в конце: в память итоги уже легли по одному,
            // а `state.json` переписывается целиком.
            s.save();
            Response::Status(s.status.clone())
        }
    }
}

/// Пауза перед следующей пробой, во время которой служба всё-таки не спит:
/// смерть sing-box замечается за `DEATH_EVERY`, а не за `PROBE_EVERY`.
///
/// Между смертью процесса и постановкой правил выбранные приложения не заперты
/// ничем — TUN уже исчез, а `netsh` ещё не вызван. Три секунды этого окна и
/// записаны потолком в шапке `core-filter`; здесь оно сокращается в пятнадцать
/// раз тем, что уже есть, без драйвера и без подписи.
///
/// Поднимать туннель отсюда нельзя, и это не вкусовщина: перезапуском,
/// паузами и счётчиком попыток заведует одна ветка в `supervise`, и вторая
/// точка перезапуска означала бы два sing-box, спорящих за один TUN и один
/// `singbox.pid`. Здесь только запрет — то есть движение строго в сторону
/// «без сети». Сторож — `the_death_watch_only_blocks`.
fn watch_for_death(svc: &Arc<Mutex<Service>>) {
    let rounds = PROBE_EVERY.as_millis() / DEATH_EVERY.as_millis();
    for _ in 0..rounds {
        // Первая проба после запуска идёт вперёд наблюдения, и окна утечки это
        // не расширяет: живость процесса только что проверил сам запуск, а
        // выбранные приложения всё это время заперты. Флаг снимается тем же
        // движением — оставь его взведённым, и наблюдатель не отработал бы
        // больше никогда, то есть окно после смерти процесса стало бы
        // бесконечным.
        //
        // Читается он здесь, а не на входе в наблюдение, и это не вкусовщина:
        // взводит его `Service::start()` из чужого потока, а цикл занимает все
        // три секунды из трёх — то есть на входе флаг почти никогда и не
        // застать. Прочитанный только там, он сокращал не ту паузу: текущий
        // круг досыпал до конца, первая проба ждала до `PROBE_EVERY`, а флаг
        // съедался следующим входом — тем самым, который ждать как раз и
        // должен. Внутри цикла ожидание — не больше `DEATH_EVERY`.
        if std::mem::take(&mut lock(svc).probe_now) {
            return;
        }
        std::thread::sleep(DEATH_EVERY);
        let mut s = lock(svc);
        if !s.private || s.status.tunnel == TunnelState::Down {
            // Выключенный приватный режим и уже замеченная смерть — не наше
            // дело: первым занимается `supervise`, вторым он же занялся.
            continue;
        }
        if s.tunnel.as_mut().map(Process::alive).unwrap_or(false) {
            continue;
        }
        // Отмечаем смерть ровно один раз: `status.tunnel` становится `Down`, и
        // следующий круг сюда уже не зайдёт. Без этого `guard(true)` при
        // отказавшем netsh звался бы пять раз в секунду — то есть журнал в
        // цикле, ровно то, чего этот код обязан избегать.
        s.status.tunnel = TunnelState::Down;
        s.status.latency_ms = None;
        s.status.country = None;
        s.guard(true);
    }
}

/// Присмотр за туннелем: живость, проба, счётчики. Замок на время пробы не
/// держим — иначе статус в GUI замирал бы на секунды.
fn supervise(svc: &Arc<Mutex<Service>>) {
    // Круг считается здесь, а не в состоянии службы: он никому больше не нужен и
    // на диск не просится. Ноль на первом круге — чтобы счётчики появились сразу
    // после подъёма туннеля, а не через четверть минуты пустых нулей в окне.
    let mut round: u32 = 0;
    loop {
        watch_for_death(svc);
        let probe = {
            let mut s = lock(svc);
            if !s.private {
                // guard идемпотентен и молчит, когда всё уже снято. Но если при
                // выключении netsh отказал, повторить попытку больше негде:
                // без неё выбранные приложения остались бы без сети навсегда.
                s.guard(false);
                continue;
            }
            // Пакет MSIX мог обновиться прямо сейчас, под живым туннелем: exe
            // уехал в папку с новой версией, и оба слоя перехвата смотрят в
            // пустоту, пока приложение уже ходит напрямую. Переезд для нас — то
            // же самое, что смена списка: правила брандмауэра надо переставить.
            //
            // Но только на самом переезде, а не каждый круг. `refence()` тянет
            // за собой `selected()`, то есть `canonicalize` на каждое выбранное
            // приложение, и сравнить посчитанное `guard` может, только уже
            // посчитав. Ответ диска на круге надзора не обязан быть тем же:
            // exe, который прямо сейчас подменяет собственный установщик (так
            // обновляют себя Chrome, Discord, Steam), на круг-другой не
            // находится — `canonicalize` отдаёт путь как есть, запись в списке
            // из двух форм становится одной, и `applied` перестаёт совпадать с
            // посчитанным. Каждая такая мнимая смена в белом списке при
            // поднятом туннеле — это метла (`Get-NetFirewallRule` по всем
            // правилам машины) и постановка пропусков заново, а между ними
            // выбранные приложения без сети. То есть обновляющееся приложение
            // роняло сеть себе и всем соседям по списку, и так каждые три
            // секунды, пока идёт обновление.
            //
            // `applied.is_none()` — это «не знаем или прошлый netsh отказал»:
            // такую попытку повторяем, иначе повторить её было бы негде.
            // Сторож — `a_settled_list_is_not_refenced_every_round`.
            if s.rebind_packages() || s.applied.is_none() {
                s.refence();
            }
            let alive = s.tunnel.as_mut().map(Process::alive).unwrap_or(false);
            match (alive, s.tunnel.as_ref()) {
                (true, Some(t)) => Some((s.generation, t.socks_port, t.api_port, s.probe_target.clone())),
                _ => None,
            }
        };
        let Some((generation, socks_port, api_port, (host, port))) = probe else {
            // Процесса нет — значит DROP, и только потом попытка поднять заново.
            let mut s = lock(svc);
            s.status.tunnel = TunnelState::Down;
            s.status.latency_ms = None;
            s.status.country = None;
            s.guard(true);
            if s.retry_at.is_some_and(|at| Instant::now() < at) {
                continue; // ждём паузы: отказ повторяется, а не проходит сам
            }
            // Профиля нет (удалили активный) — поднимать нечего. Приложения при
            // этом остаются заблокированными, и это не сбой, а ожидаемое
            // состояние: обещать в журнале перезапуск было бы неправдой.
            let Some(profile) = s.status.profile.clone() else { continue };
            s.warn(t("sing-box не работает: выбранные приложения без сети, перезапуск"));
            let _ = s.start(&profile);
            continue;
        };

        let result = core_tunnel::probe(socks_port, (&host, port));
        // Пропущенный круг оставляет прошлые числа на месте: `None` ниже
        // разбирается тем же путём, что и отказ Clash API, — счётчики не
        // обнуляются, а просто не двигаются.
        let due = round % TRAFFIC_EVERY == 0;
        round = round.wrapping_add(1);
        let traffic = due.then(|| core_tunnel::traffic(api_port).ok()).flatten();

        let mut s = lock(svc);
        if !s.private {
            continue;
        }
        if s.generation != generation {
            // Пока шла проба, туннель успели перезапустить: сменили профиль или
            // список приложений. Ответ относится к прошлому процессу и прошлому
            // серверу — подтверждать им новый туннель нельзя, иначе guard(false)
            // снимет правила с того, что ещё не поднялось.
            continue;
        }
        let mut just_up = false;
        match result {
            Ok(latency) => {
                if s.status.tunnel != TunnelState::Up {
                    s.log(tf!("туннель поднят, задержка {} мс", latency));
                    s.guard(false); // дальше маршрутизацией занимается сам sing-box
                    // Про чужой туннель говорим уже после выдачи пропусков, а не
                    // до. Он не мешает нам подняться, но может забрать маршруты —
                    // и тогда «Защищено» окажется правдой только про нас, а не
                    // про приложения; то есть предупредить обязаны, а вот
                    // задерживать этим сеть — нет. `foreign_tunnels` — поход в
                    // PowerShell за списком адаптеров, и стоял он ровно между
                    // подтверждённой пробой и открытием сети выбранным
                    // приложениям, под общим замком: окно всё это время ждало
                    // ответа на `Status`.
                    for name in core_filter::foreign_tunnels(core_tunnel::TUN_NAME) {
                        s.warn(tf!("рядом поднят чужой туннель «{}» — выберите один: маршруты уйдут к тому, кто выиграет", name));
                    }
                    just_up = true;
                }
                s.status.tunnel = TunnelState::Up;
                s.status.latency_ms = Some(latency);
                // Живая задержка активного профиля — она же его последнее
                // измерение: строка профиля не должна показывать цифру прошлого
                // прогона, пока туннель под ней жив. На диск не пишем — надзор
                // тикает каждые три секунды, а сохранит это ближайший save().
                if let Some(name) = s.status.profile.clone() {
                    remember(&mut s.status.probes, &name, Some(latency), None, None);
                }
            }
            Err(e) => {
                if s.status.tunnel != TunnelState::Down {
                    s.warn(tf!("туннель недоступен ({}): выбранные приложения без сети", e));
                    s.guard(true);
                }
                s.status.tunnel = TunnelState::Down;
                s.status.latency_ms = None;
                s.status.country = None;
            }
        }
        if let Some((rx, tx)) = traffic {
            (s.status.rx, s.status.tx) = (rx, tx);
            // Отметка двигается на каждом удачном снятии, даже когда числа те
            // же: «по каналу молчат» и «счётчики ещё не обновляли» — разные
            // вещи, и различить их из окна больше нечем.
            s.status.traffic_at = now_ms();
        }
        // Настройку снимаем под тем же замком: ниже он уже отпущен, а брать его
        // второй раз ради одного бита незачем.
        let geo = s.status.settings.geo;
        drop(s);

        // Единственный запрос наружу за всю работу службы — и только на переходе
        // в «поднят»: дёргать чужой сервис каждые три секунды незачем, он и сам
        // считает это флудом. Замок на это время отпущен: сеть медленная, а под
        // ним стоит весь GUI.
        if just_up && geo {
            let found = core_tunnel::exit_country(socks_port);
            let mut s = lock(svc);
            match found {
                Ok(exit) => {
                    let name = &exit.name;
                    s.log(tf!("точка выхода: {}", name));
                    s.status.country = Some(exit.name.clone());
                    // Единственный раз, когда страна вообще спрашивается, —
                    // этот. Не запомнить её здесь значит потерять до следующего
                    // подключения и заставить прогонять профили ради известного.
                    if let Some(profile) = s.status.profile.clone() {
                        let latency = s.status.latency_ms;
                        remember(&mut s.status.probes, &profile, latency, Some(exit), None);
                        s.save();
                    }
                }
                // Страна — украшение статуса; не узнали, значит не показываем.
                // На fail-closed это не влияет никак.
                Err(e) => {
                    s.warn(tf!("страну выхода узнать не удалось ({})", e));
                    s.status.country = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Свой пустой каталог на каждый прогон: тесты бегут в одном процессе, и
    /// общий временный каталог давал бы им ронять друг друга через диск.
    fn settle_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pg-settle-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `state.json` — это пароли и ключи всех профилей человека, и каталог под
    /// них служба обязана запирать сама: `%ProgramData%` раздаёт наследуемое
    /// чтение всей машине, а каталог, созданный кем-то раньше службы, остаётся
    /// вдобавок в его власти.
    ///
    /// На разработке проверяется само поведение — режим каталога; на Windows
    /// проверять нечем, кроме того, что просят у `icacls`, поэтому проверяются
    /// три вещи, каждая из которых молча возвращает дыру: владелец
    /// переставляется раньше прав (иначе прежний владелец перепишет их
    /// обратно), группы названы SID-ами (по именам правило не встанет на
    /// локализованной Windows), и обход каталога снимает наследованное с
    /// файлов, которые в нём уже лежали.
    #[test]
    fn the_state_directory_is_locked_to_system_and_admins() {
        let dir = settle_dir("acl").join("proxybox");
        secure_dir(&dir).expect("каталог состояния");
        assert!(dir.is_dir(), "каталог обязан создаваться вместе с правами");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "каталог с ключами профилей открыт лишним: {mode:o}");
        }

        let seal = seal_args(&dir);
        assert!(seal[0].contains(&"/setowner".to_string()), "владелец обязан переставляться первым");
        let grant = seal[1].join(" ");
        assert!(grant.contains("/inheritance:r"), "без обрыва наследования каталог читает вся машина");
        assert!(grant.contains("/grant:r"), "права обязаны заменяться, а не добавляться к унаследованным");
        for sid in [SID_SYSTEM, SID_ADMINS] {
            assert!(grant.contains(sid), "в правах нет {sid}");
        }
        let names = seal.iter().chain(reseal_args(&dir).iter()).flatten().any(|a| {
            let low = a.to_lowercase();
            low.contains("administrators") || low.contains("system:")
        });
        assert!(!names, "группа названа именем, а не SID — на локализованной Windows правило не встанет");

        let reseal = reseal_args(&dir);
        assert!(reseal[0].contains(&"/setowner".to_string()), "чужой владелец файла перепишет права обратно");
        assert!(reseal[1].contains(&"/reset".to_string()), "файлы прошлой установки остаются с наследованным DACL");
        for batch in &reseal {
            assert!(batch.contains(&"/T".to_string()), "обход обязан идти по всему каталогу: {batch:?}");
        }
    }

    /// Переименование продукта не имеет права стоить человеку состояния.
    /// Профили, подписки и список приложений лежат в одном `state.json`, и
    /// служба, начавшая с чистого каталога, выглядит как продукт, забывший всё
    /// — при целых файлах на прежнем месте.
    ///
    /// Три случая, и каждый ломается по-своему: обычный переезд; переезд, когда
    /// новый каталог уже нажит (затереть его — та же потеря, только наоборот);
    /// и чистая установка, где переносить нечего и выдумывать каталог не надо.
    #[test]
    fn the_rename_never_loses_what_the_service_remembered() {
        let base = settle_dir("moves");
        std::fs::create_dir_all(base.join("privacy-gateway")).unwrap();
        std::fs::write(base.join("privacy-gateway").join("state.json"), "{\"profiles\":[]}").unwrap();
        let dir = settle(base.clone());
        assert_eq!(dir, base.join("proxybox"), "каталог обязан переехать под новое имя");
        assert_eq!(
            std::fs::read_to_string(dir.join("state.json")).unwrap(),
            "{\"profiles\":[]}",
            "состояние обязано доехать вместе с каталогом"
        );
        assert!(!base.join("privacy-gateway").exists(), "старый каталог обязан исчезнуть, а не раздвоиться");

        // Нажитое под новым именем сильнее старого: переезд поверх — это потеря
        // ровно того состояния, которым человек пользуется прямо сейчас.
        let base = settle_dir("keeps");
        std::fs::create_dir_all(base.join("privacy-gateway")).unwrap();
        std::fs::write(base.join("privacy-gateway").join("state.json"), "старое").unwrap();
        std::fs::create_dir_all(base.join("proxybox")).unwrap();
        std::fs::write(base.join("proxybox").join("state.json"), "новое").unwrap();
        let dir = settle(base.clone());
        assert_eq!(std::fs::read_to_string(dir.join("state.json")).unwrap(), "новое", "переезд затёр нажитое");

        // Чистая установка: каталога нет вовсе, и выдумывать переезд не из чего.
        let base = settle_dir("fresh");
        assert_eq!(settle(base.clone()), base.join("proxybox"));
    }

    fn conn(process: &str, tunneled: bool, bytes: u64) -> Conn {
        Conn {
            process: process.into(),
            host: "example.org:443".into(),
            tunneled,
            leak: false,
            rx: bytes,
            tx: 0,
        }
    }

    /// Белый список запирает дверь и раздаёт пропуска, а не наоборот.
    ///
    /// Две вещи, каждая из которых по отдельности означает дыру. Замок обязан
    /// стоять всё время, пока включён приватный режим, — иначе «у остальных
    /// сети нет» держится только при живом туннеле. И пропуск обязан
    /// выдаваться только по подтверждённой пробе — иначе выбранное приложение
    /// выходит в открытую сеть ровно в то окно, ради которого замок и заведён.
    ///
    /// Третье — что запирать нечем, кроме политики: запрещающих правил у нас не
    /// осталось вовсе (сторож `the_pass_is_bound_to_the_tunnel_address` в
    /// `core-filter` следит и за этим).
    #[test]
    fn the_whitelist_locks_the_door_and_hands_out_passes() {
        use core_filter::Fence;
        // Приватный режим включён, туннель не подтверждён.
        assert_eq!(fencing(Scope::Whitelist, true, true), (Fence::Off, true), "замок стоит, пропусков нет");
        // Проба прошла.
        assert_eq!(fencing(Scope::Whitelist, false, true), (Fence::Allow, true), "замок стоит, выбранным пропуск");
        // Приватный режим выключен — замок обязан сняться, иначе машина без сети.
        assert_eq!(fencing(Scope::Whitelist, false, false), (Fence::Off, false), "выключили — сняли всё");
        assert_eq!(fencing(Scope::Whitelist, true, false), (Fence::Off, false), "и в окне запрета тоже");

        assert_eq!(fencing(Scope::All, true, true), (Fence::Off, true), "делить некого — запирает политика");
        assert_eq!(fencing(Scope::All, false, true), (Fence::Off, false), "туннель подтверждён — замок ни к чему");
        // Выключенный приватный режим не запирает машину ни в одном охвате, и
        // это не следствие того, кто как зовёт `guard`: перепутанный здесь знак
        // оставил бы человека без сети до перезагрузки — политика её переживает.
        assert_eq!(fencing(Scope::All, true, false), (Fence::Off, false), "режим выключен — замка нет");
    }

    /// Чужой kill-switch снимать не наше дело. Политика брандмауэра — состояние
    /// всей машины, и `blockoutbound` там бывает не только наш: точно такой же
    /// ставит другой клиент VPN, и точно так же его ставят руками. Служба,
    /// которую только что установили и ни разу не включали, обязана пройти мимо
    /// — иначе первый же круг надзора молча открыл бы человеку весь исходящий,
    /// ничего взамен не включив.
    ///
    /// Своё узнаём по разрешению для sing-box: оно ставится только нами и только
    /// вместе с политикой.
    #[test]
    fn a_foreign_killswitch_is_not_ours_to_lift() {
        let never = || panic!("систему спрашиваем только на первом круге");
        // Ставим замок — вопрос не встаёт вовсе.
        assert!(touch_policy(true, None, never));
        assert!(touch_policy(true, Some(false), never));
        // Служба уже применяла своё — помнит и переспрашивать не должна.
        assert!(touch_policy(false, Some(true), never), "свой замок снять обязаны");
        assert!(
            !touch_policy(true, Some(true), never),
            "замок уже стоит: переставлять его — значит на два вызова netsh отобрать пропуск у sing-box",
        );
        assert!(!touch_policy(false, Some(false), never), "своего замка не было — и снимать нечего");
        // Первый круг после старта: решает система.
        assert!(touch_policy(false, None, || true), "наш замок пережил падение службы — снимаем");
        assert!(!touch_policy(false, None, || false), "чужой замок не наш");
    }

    /// Старый `state.json` знал только флаг «весь трафик». Прочитать его обязаны:
    /// иначе первое же обновление выпустило бы в сеть машину, которую человек
    /// запер, — молча и до первого взгляда на окно.
    #[test]
    fn the_old_scope_flag_still_means_the_whole_computer() {
        let saved: Saved =
            serde_json::from_str(r#"{"apps": [], "profiles": {}, "all_traffic": true}"#).unwrap();
        assert!(saved.scope.is_null(), "нового поля в старом файле нет");
        assert!(saved.all_traffic, "зато есть старое");
        let (scope, migrated) = migrate_scope(&saved.scope, saved.all_traffic);
        assert_eq!(scope, Scope::All);
        assert!(!migrated, "человек этот охват и выбирал — переносом это не считается");
    }

    /// Обновление не имеет права отрезать от сети машину, которую об этом не
    /// просили. Охватов было три, и сохранённый split-tunnel («apps») читать
    /// теперь нечем: перенести его надо в «весь компьютер» — тот ничего не
    /// отключает. Белый список отключил бы всё неотмеченное, а неотмеченным у
    /// человека может быть вообще всё: в split-tunnel галочки значили «завернуть
    /// в туннель», и снятая галочка не означала «этому сеть не нужна».
    ///
    /// Второе, не менее важное: неизвестное значение обязано читаться, а не
    /// ронять разбор. `state.json` — это ещё и профили с подписками, и отказ
    /// разбора стёр бы их все.
    #[test]
    fn an_update_never_cuts_off_a_machine_that_was_not_asked() {
        let saved: Saved =
            serde_json::from_str(r#"{"apps": [], "profiles": {}, "scope": "apps", "private": true}"#)
                .expect("удалённый охват обязан читаться: в файле рядом лежат профили");
        let (scope, migrated) = migrate_scope(&saved.scope, saved.all_traffic);
        assert_eq!(scope, Scope::All, "split-tunnel переносится в «весь компьютер», а не в белый список");
        assert!(migrated, "про смену охвата обязана быть строка в журнале");

        // Файл старше самих охватов — тот же split-tunnel, только неявный.
        let (scope, migrated) = migrate_scope(&Value::Null, false);
        assert_eq!(scope, Scope::All);
        assert!(migrated);

        // Мусор и будущие имена — туда же, а не в панику.
        assert_eq!(migrate_scope(&serde_json::json!("нет такого"), false).0, Scope::All);
        // А знакомое имя проходит как есть: перенос обязан быть одноразовым,
        // иначе выбранный человеком белый список сбрасывался бы каждый старт.
        assert_eq!(migrate_scope(&serde_json::json!("whitelist"), false), (Scope::Whitelist, false));
        assert_eq!(migrate_scope(&serde_json::json!("all"), false), (Scope::All, false));
        // Умолчание чистой установки — тоже «весь компьютер»: белый список
        // станет им, когда фаза 0 пройдёт на живой Windows целиком.
        assert_eq!(Scope::default(), Scope::All);
    }

    /// Тихая утечка обязана попасть в окно даже тогда, когда громких соединений
    /// больше, чем влезает: пара килобайт мимо туннеля — это ровно то, ради чего
    /// панель и открывают, а сотня самых говорливых её бы и не заметила.
    #[test]
    fn a_leak_is_never_truncated_away() {
        // Обе формы пути, как их кладёт в конфиг `selected()`: записанная и
        // каноническая. Промах по второй — это утечка, покрашенная серым.
        let picked: BTreeSet<String> = ["c:\\progra~1\\browser\\browser.exe".into(), "c:\\program files\\browser\\browser.exe".into()]
            .into_iter()
            .collect();
        let mut conns: Vec<Conn> = (0..MAX_CONNS as u64)
            .map(|i| conn("c:\\apps\\torrent.exe", true, 1_000_000 - i))
            .collect();
        // Регистр другой — на Windows это тот же файл, и утечка остаётся утечкой.
        // Форма пути другая: Windows отдаёт длинную, а записана короткая.
        conns.push(conn("C:\\Program Files\\Browser\\Browser.exe", false, 2_048));

        leaks_first(&mut conns, &picked);
        conns.truncate(MAX_CONNS);

        assert_eq!(
            conns[0].process, "C:\\Program Files\\Browser\\Browser.exe",
            "утечка идёт первой строкой",
        );
        assert!(conns[0].leak, "и помечена утечкой — окно красит по этому полю, а не по своей сверке");
        assert!(!conns[1].leak, "чужой трафик в туннеле утечкой не зовётся");
        assert_eq!(conns[1].rx, 1_000_000, "внутри групп порядок по громкости не тронут");
    }

    /// Прямое соединение невыбранного приложения — не утечка, а задуманный путь,
    /// и наверх его поднимать не за что.
    #[test]
    fn someone_elses_direct_traffic_stays_where_it_was() {
        let picked: BTreeSet<String> = ["c:\\apps\\browser.exe".into()].into_iter().collect();
        let mut conns =
            vec![conn("c:\\apps\\browser.exe", true, 9), conn("c:\\apps\\mail.exe", false, 1)];
        leaks_first(&mut conns, &picked);
        assert_eq!(conns[0].process, "c:\\apps\\browser.exe");
        assert!(conns.iter().all(|c| !c.leak), "невыбранное приложение напрямую — не утечка");
    }

    /// Прогон, в котором узел не ответил, стирает задержку, но не страну: узел
    /// стоит там же, где стоял, и потерять её значит показать пустую строку
    /// вместо известного ответа.
    #[test]
    fn a_silent_run_does_not_erase_the_country() {
        let mut probes = Vec::new();
        let nl = core_tunnel::Exit { name: "Нидерланды, Амстердам".into(), code: Some("NL".into()) };
        remember(&mut probes, "myvpn", Some(84), Some(nl), None);
        remember(&mut probes, "myvpn", None, None, Some("таймаут".into()));

        assert_eq!(probes.len(), 1, "профиль один — и запись одна");
        assert_eq!(probes[0].country.as_deref(), Some("Нидерланды, Амстердам"));
        assert_eq!(probes[0].code.as_deref(), Some("NL"));
        assert_eq!(probes[0].latency_ms, None, "а вот задержка отказ пережить не может");
        assert_eq!(probes[0].error.as_deref(), Some("таймаут"));
    }

    /// Узел из подписки удаляют по одному, а её список службе правит только
    /// сверка. Окно рисует профили группами по подпискам — и показало бы под
    /// заголовком строку, за которой больше нет узла.
    #[test]
    fn a_subscription_does_not_carry_names_of_deleted_nodes() {
        let mut subs = BTreeMap::new();
        subs.insert("https://panel/sub".to_string(), vec!["NL-01".to_string(), "NL-02".to_string()]);
        let mut profiles = BTreeMap::new();
        profiles.insert("NL-02".to_string(), json!({"type": "vless"}));

        let mut names = BTreeMap::new();
        names.insert("https://panel/sub".to_string(), "рабочая".to_string());

        let out = subscriptions_of(&subs, &names, &profiles, &BTreeMap::new());
        assert_eq!(out.len(), 1, "подписка остаётся, даже когда узлов не осталось вовсе");
        assert_eq!(out[0].nodes, vec!["NL-02".to_string()], "удалённый узел ушёл из списка подписки");
        assert_eq!(out[0].name, "рабочая", "имя подписки переживает сверку: её заменяет только человек");
    }

    #[test]
    fn tun_failures_named_correctly() {
        let denied = explain("configure tun interface: Access is denied.");
        assert!(denied.contains("права администратора"), "{denied}");
        let busy = explain("configure tun interface: file already exists");
        assert!(busy.contains("другой VPN"), "{busy}");
        assert_eq!(explain("порт занят"), "порт занят", "не про TUN — не додумываем");
    }

    /// Отказ от http обязан случиться до сети: этим же fetch ходит плановое
    /// обновление подписки, а её адрес мог сохраниться до появления проверки.
    #[test]
    fn subscription_requires_https() {
        let err = fetch("http://panel.example/sub", false).unwrap_err();
        assert!(err.contains("https"), "{err}");
        assert!(fetch("panel.example/sub", false).is_err(), "схемы нет — тоже не подписка");
    }

    #[test]
    fn probe_goes_to_own_server() {
        let vless = json!({ "type": "vless", "server": "a.com", "server_port": 8443 });
        assert_eq!(probe_target("", &vless), ("a.com".to_string(), 8443));
        // У WireGuard сервер описан узлом peers, а не полем server.
        let wg = json!({ "type": "wireguard", "peers": [{ "address": "b.com", "port": 51820 }] });
        assert_eq!(probe_target("", &wg), ("b.com".to_string(), 51820));
        // Заданная цель перебивает сервер узла — ради неё настройка и заведена.
        assert_eq!(probe_target("1.1.1.1:443", &vless), ("1.1.1.1".to_string(), 443));
        // Мусор откатывает к серверу пользователя, а не оставляет туннель без
        // подтверждения: цена опечатки — выбранные приложения без сети.
        assert_eq!(probe_target("ерунда", &vless), ("a.com".to_string(), 8443));
        assert_eq!(probe_target("a.com:70000", &vless), ("a.com".to_string(), 8443));
    }

    /// Срок сверки считается по календарю, а не по аптайму: домашняя машина
    /// шести часов подряд не живёт, и при отсчёте от старта службы плановая
    /// сверка не случалась бы вообще ни разу.
    #[test]
    fn the_refresh_clock_runs_on_the_calendar() {
        let day = 24 * 60 * 60;
        let every = refresh_every(&Settings::default());
        let period = every.as_secs();
        assert!(refresh_due(None, day, every), "не сверялись ни разу — пора");
        assert!(!refresh_due(Some(day), day + 60, every), "сверялись минуту назад — рано");
        assert!(refresh_due(Some(day), day + period, every), "срок вышел — пора, сколько бы служба ни жила");
        assert!(!refresh_due(Some(day), 0, every), "часы перевели назад — это не повод идти на панель");
    }

    /// Срок сверки стал настройкой, и ноль в нём — это поход по всем подпискам
    /// каждый круг потока, то есть раз в пять минут. Выключают сверку флажком,
    /// а не сроком; `state.json` при этом правят руками, поэтому нижнюю границу
    /// держит не только команда настроек.
    #[test]
    fn the_refresh_period_is_never_zero() {
        let broken = Settings { refresh_hours: 0, ..Default::default() };
        assert_eq!(refresh_every(&broken), Duration::from_secs(60 * 60), "нулевой срок — это час, а не круг потока");
        assert_eq!(refresh_every(&Settings::default()), Duration::from_secs(6 * 60 * 60), "умолчание — шесть часов");
    }

    /// Фоновая сверка подписки не вправе выключить приватный режим: панель
    /// правит список узлов, а не решение пользователя про его приложения.
    #[test]
    fn scheduled_refresh_never_opens_the_apps() {
        let (old, new) = (json!({ "server": "a.com" }), json!({ "server": "b.com" }));
        for scheduled in [true, false] {
            assert_eq!(after_refresh(Some(&old), Some(&old), true, scheduled), Active::Keep, "узел не менялся");
            assert_eq!(after_refresh(Some(&old), Some(&new), true, scheduled), Active::Restart, "новый конфиг узла");
            assert_eq!(after_refresh(Some(&old), None, false, scheduled), Active::Keep, "режим и так выключен");
        }
        assert_eq!(after_refresh(Some(&old), None, true, true), Active::Drop, "в фоне режим остаётся, приложения без сети");
        assert_eq!(after_refresh(Some(&old), None, true, false), Active::Stop, "нажатие человека — он видит, что узла нет");
    }

    /// Замок один на состояние и на обработку команды, поэтому команда, которая
    /// надолго уходит в систему, обязана разбираться до него.
    ///
    /// Пока он занят, окно не получает `Status`, а `supervise` и
    /// `watch_for_death` не могут его взять — то есть смерть sing-box замечается
    /// не за `DEATH_EVERY`, а когда команда закончится. Подписка ушла из-под
    /// замка сразу, список соединений и прогон профилей отпускают его руками.
    /// Иконка и автообнаружение — те же походы наружу, только по диску, и
    /// состояния им не нужно: иконку достают из файла по пути из запроса, а
    /// автообнаружение сверяется со списком уже после обхода.
    ///
    /// Иконка тут хуже прочих: её спрашивают не один раз, а по одной на каждое
    /// приложение списка и залпом, как только открыли вкладку. Соединение у
    /// каждой своё (поток на подключение), так что залп выстраивался в очередь
    /// к замку целиком, а один путь на отвалившейся сетевой шаре добавлял к
    /// этому таймаут SMB.
    ///
    /// Сверяется текстом: обе команды обязаны встретиться в `handle()` раньше,
    /// чем тот возьмёт замок.
    #[test]
    fn the_lock_is_never_held_through_a_walk_of_the_disk() {
        let handle = include_str!("main.rs").split_once("\nfn handle(").expect("handle()").1;
        let before = handle.split_once("let mut s = lock(svc);").expect("замок в handle()").0;
        for command in ["Request::Icon", "Request::Discover"] {
            assert!(before.contains(command), "{command} разбирается под общим замком");
        }
    }

    /// Устоявшийся список не переставляет правила брандмауэра каждый круг.
    ///
    /// `Service::selected()` спрашивает диск: `canonicalize` на каждое выбранное
    /// приложение, и от того, отвечает файл или нет, зависит длина списка —
    /// отвечает, и путь едет в двух формах, не отвечает, и в одной. Это и
    /// проверяется ниже на живом файле: список обязан быть разной длины, потому
    /// что именно на этом и построен весь надзор за переездом пакетов.
    ///
    /// Отсюда следует, чего делать нельзя: звать `refence()` каждый круг просто
    /// «на всякий случай». `guard` сравнивает применённое с посчитанным, а
    /// посчитать обязан до сравнения — значит мигнувший файл читается как смена
    /// списка. В белом списке при поднятом туннеле применённое — `Fence::Allow`,
    /// а метла обходится только при `Fence::Off` (`needs_sweep`): каждая мнимая
    /// смена стоит `Get-NetFirewallRule` по всем правилам машины и постановки
    /// пропусков заново, а между ними выбранные приложения без сети. Мигать
    /// файлу есть от чего — так обновляет себя всякий exe, подменяющий сам
    /// себя, — и мигал бы он каждые три секунды.
    ///
    /// Поэтому правила переставляются на самом переезде (`rebind_packages`
    /// вернула `true`) или когда применённое неизвестно (`applied.is_none()` —
    /// старт службы или отказавший netsh, и повторить попытку больше негде).
    #[test]
    fn a_settled_list_is_not_refenced_every_round() {
        let body = include_str!("main.rs")
            .split("fn supervise(")
            .nth(1)
            .and_then(|s| s.split("\nfn ").next())
            .expect("надзор на месте");
        assert!(
            body.contains("if s.rebind_packages() || s.applied.is_none() {"),
            "круг надзора переставляет правила безусловно: {body}",
        );
        // `edit()` зовёт `refence()` всегда — в круге надзора ему поэтому не
        // место. Уйдёт условие обратно в него, и метла вернётся каждые три
        // секунды на всякий подменяющий себя exe.
        assert!(!body.contains("s.edit("), "правка через edit() в круге надзора — это refence() безусловно");

        // И то же самое от состояния, а не от текста: длина списка зависит от
        // того, отвечает ли файл. Берём свой файл, чтобы не гадать про чужие, и
        // пишем путь так, чтобы канонический от записанного отличался, — на
        // Windows их разводит регистр, а здесь развести нечем. Отличие даёт
        // `..`: `canonicalize` его схлопывает, но только пока файл на месте.
        let home = std::env::temp_dir().join("pg-selected-flap");
        std::fs::create_dir_all(&home).expect("временный каталог");
        let file = home.join("flap.exe");
        std::fs::write(&file, b"").expect("временный файл");
        let winding = home.join("..").join("pg-selected-flap").join("flap.exe");
        let mut st = Status::default();
        st.apps.push(App { path: winding.to_string_lossy().into_owned(), name: "flap".into(), enabled: true });
        let present = Service::selected(&st).len();
        std::fs::remove_dir_all(&home).expect("временный каталог убирается");
        let missing = Service::selected(&st).len();
        assert!(
            present > missing,
            "список путей перестал зависеть от диска — тогда и условие выше можно снимать: {present} против {missing}",
        );
    }

    /// Пропуск браузера живёт ровно столько, сколько сеанс, — и это перестало
    /// держаться само собой.
    ///
    /// Держалось оно на круге надзора: тот переставлял правила каждый раз, и
    /// умерший сеанс терял пропуск в течение трёх секунд просто попутно.
    /// Круг так больше не делает (`a_settled_list_is_not_refenced_every_round`),
    /// поэтому снять пропуск обязан тот, кто заметил смерть, — прополка живых
    /// сеансов в ответе на `Status`. Не снимет, и правило переживёт сеанс: не
    /// дыра в туннеле (`remoteip=127.0.0.1`), но обещание в доках, которое
    /// перестало быть правдой.
    #[test]
    fn a_dead_session_takes_its_pass_with_it() {
        let handle = include_str!("main.rs").split_once("\nfn handle(").expect("handle()").1;
        let status = handle.split_once("Request::Status => {").expect("ответ на Status").1;
        let status = status.split_once("Request::ListApps").expect("конец ответа на Status").0;
        assert!(status.contains("retain(|_, proc| proc.alive())"), "мёртвые сеансы перестали пропалываться: {status}");
        assert!(status.contains("s.refence()"), "прополка не снимает пропуск умершего сеанса: {status}");

        // Снимать есть что только пока пропуск вообще привязан к наличию
        // сеансов: пусто — нет и правила.
        let pass = include_str!("main.rs").split_once("fn browser_pass(").expect("пропуск браузера").1;
        assert!(
            pass.split_once('}').expect("тело пропуска").0.contains("self.browsers.is_empty()"),
            "пропуск браузера отвязали от сеансов — тогда и снимать его прополкой нечего",
        );
    }

    /// Счётчики трафика обязаны забираться реже круга надзора: Clash API отдаёт
    /// их только вместе со всем списком живых соединений, и в патологии это
    /// десятки мегабайт на опрос. Вернут сюда каждый круг — надзор станет
    /// усилителем того самого расхода, который им же и меряют.
    ///
    /// Живость при этом обязана остаться на своём периоде: она стоит одного
    /// `try_wait` и к Clash API не ходит вовсе.
    #[test]
    fn the_counters_are_not_polled_every_round() {
        assert!(TRAFFIC_EVERY > 1, "иначе отвязывать было не от чего");
        assert!(PROBE_EVERY * TRAFFIC_EVERY >= Duration::from_secs(10), "слишком часто, чтобы окупиться");

        let src = include_str!("main.rs");
        let body = src
            .split("fn supervise(")
            .nth(1)
            .and_then(|s| s.split("\nfn ").next())
            .expect("надзор на месте");
        // Единственный поход за счётчиками, и он под условием круга.
        assert_eq!(body.matches("core_tunnel::traffic(").count(), 1, "поход за счётчиками обязан быть один");
        assert!(body.contains("due.then("), "счётчики обязаны забираться по условию круга: {body}");
        assert!(body.contains("% TRAFFIC_EVERY"), "условие обязано считать круги");
        // А живость — вне этого условия и на своём периоде.
        assert!(body.contains("watch_for_death(svc)"), "живость идёт своим чередом");
    }

    /// Сторож окна утечки. Проверка живости обязана быть заметно чаще пробы и
    /// укладываться в неё целое число раз — иначе «пауза» между пробами
    /// растянется, и окно, ради которого всё это заведено, вырастет обратно.
    ///
    /// Второе, и оно важнее: из наблюдателя за смертью нельзя поднимать
    /// туннель. Перезапуском заведует одна ветка `supervise` вместе с паузами и
    /// счётчиком попыток; вторая точка перезапуска — это два sing-box на один
    /// TUN и один `singbox.pid`. Поэтому здесь проверяется текстом, что в теле
    /// наблюдателя нет ни одного вызова `start`.
    #[test]
    fn the_death_watch_only_blocks() {
        assert!(DEATH_EVERY < PROBE_EVERY, "проверять живость реже пробы бессмысленно");
        assert_eq!(
            PROBE_EVERY.as_millis() % DEATH_EVERY.as_millis(),
            0,
            "период пробы обязан делиться на период проверки живости нацело",
        );
        assert!(PROBE_EVERY.as_millis() / DEATH_EVERY.as_millis() >= 10, "окно сокращается меньше чем на порядок — незачем");

        let src = include_str!("main.rs");
        let body = src
            .split("fn watch_for_death(")
            .nth(1)
            .and_then(|s| s.split("\nfn ").next())
            .expect("наблюдатель за смертью на месте");
        assert!(!body.contains(".start("), "поднимать туннель отсюда нельзя: {body}");
        assert!(body.contains("guard(true)"), "иначе наблюдатель не запирает вовсе");
        // Ранний выход ради первой пробы обязан снимать флаг тем же движением:
        // прочитанный, но не снятый, он превратил бы наблюдателя в пустышку
        // навсегда — то есть окно после смерти процесса стало бы бесконечным.
        assert_eq!(body.matches("probe_now").count(), 1, "флаг первой пробы читается ровно один раз: {body}");
        assert!(body.contains("mem::take"), "флаг первой пробы обязан сниматься при чтении: {body}");
        // И читаться он обязан внутри цикла кругов. Взводит флаг чужой поток, а
        // цикл занимает все три секунды из трёх: прочитанный только на входе, он
        // не застаётся почти никогда — первая проба ждёт полный `PROBE_EVERY`
        // вместо `DEATH_EVERY`, а сам флаг съедает следующее ожидание, которое
        // ждать как раз и должно.
        let before_loop = body.split("for _ in 0..rounds").next().unwrap_or_default();
        assert!(!before_loop.contains("probe_now"), "флаг первой пробы обязан читаться внутри цикла, а не на входе: {body}");
    }

    /// Ни галочка в списке приложений, ни переключение охвата не имеют права
    /// трогать туннель. Конфиг у обоих охватов один и ни списка, ни охвата не
    /// содержит (сторож `nothing_can_go_direct` в `core-tunnel`), поэтому
    /// перезапускать нечего — а перезапуск оборвал бы всё живое: SSH, загрузки,
    /// звонки. Заодно он означал бы и окно, в котором выбранные приложения
    /// заперты, — на ровном месте, ради одной галочки.
    ///
    /// Заменил собой `the_tunnel_restarts_exactly_when_singbox_would_see_another_config`:
    /// тот сторожил ровно обратное правило, и оно было верным, пока конфиг
    /// перечислял `process_path` поимённо.
    #[test]
    fn editing_the_list_never_restarts_the_tunnel() {
        let src = include_str!("main.rs");
        let body = src
            .split("fn edit(")
            .nth(1)
            .and_then(|s| s.split("\n    fn ").next())
            .expect("правка на месте");
        assert!(!body.contains("start("), "правка обязана не поднимать туннель: {body}");
        assert!(body.contains("refence()"), "но правила брандмауэра переставить обязана: {body}");
        // Перезапуск ради списка ушёл вместе с охватом «выбранные приложения».
        // Иголка собирается на месте: написанная целиком, она нашла бы себя.
        let gone = format!("fn {}(", "reapply");
        assert!(!src.contains(&gone), "перезапуск ради списка вернулся — значит вернулись и обрывы соединений");

        // И то же самое от состояния, а не от текста: список меняется, ключ
        // конфига не существует вовсе, а правила брандмауэра идут за списком.
        let mut st = Status::default();
        assert!(Service::selected(&st).is_empty());
        st.apps.push(App { path: "/bin/true".into(), name: "true".into(), enabled: false });
        assert!(Service::selected(&st).is_empty(), "найденное выключенным сети не получает");
        st.apps[0].enabled = true;
        // Форм пути может быть две — записанная и приведённая к файловой
        // системе: какая совпадёт с тем, что покажет Windows, заранее неизвестно.
        assert!(Service::selected(&st).contains(&"/bin/true".to_string()), "выбранному нужен пропуск");
    }

    /// Автообнаружение обязано узнавать путь, который у него уже есть, в любом
    /// регистре: установщик пишет в реестр один вид, а `state.json` хранит тот,
    /// что пришёл когда-то, и на Windows это один файл. Побайтовая сверка
    /// заводила второй экземпляр — список показывал приложение дважды, а окно
    /// падало на повторяющемся ключе React.
    #[test]
    fn discovery_knows_a_path_it_already_has() {
        let apps = vec![App {
            path: r"C:\Program Files\WindowsApps\Microsoft.WindowsStore\store.exe".into(),
            name: "store".into(),
            enabled: false,
        }];
        assert!(knows(&apps, &apps[0].path), "тот же путь — точно знакомый");
        assert!(
            knows(&apps, r"C:\Program Files\WindowsApps\Microsoft.WindowsStore\Store.exe"),
            "регистр не делает из приложения второе"
        );
        assert!(
            !knows(&apps, r"C:\Program Files\WindowsApps\Microsoft.WindowsStore\other.exe"),
            "другой файл обязан остаться новым"
        );
    }

    /// Автообнаружение складывает находки из каталога, реестра, пакетов и живых
    /// процессов, и один exe приходит оттуда столько раз, сколько у него
    /// процессов. Сверки со списком мало: он про принятое в этом же заходе не
    /// знает, и пачка одинаковых находок уезжала в список целиком — по строке
    /// на процесс.
    #[test]
    fn discovery_never_adds_one_exe_twice_in_a_single_pass() {
        let store = r"C:\Program Files\WindowsApps\Microsoft.WindowsStore\store.exe";
        let f = |path: &str| core_apps::Found { name: "store".into(), path: path.into() };

        let batch = vec![f(store), f(store), f(store), f(&store.replace("store.exe", "Store.exe"))];
        let added = newcomers(&[], batch);
        assert_eq!(added.len(), 1, "один exe — одна новая строка, сколько бы раз его ни нашли");
        assert!(!added[0].enabled, "найденное не значит выбранное");

        // Уже известное не заводится заново — ради этого сверка и стояла.
        let known = vec![App { path: store.into(), name: "store".into(), enabled: true }];
        assert!(newcomers(&known, vec![f(store)]).is_empty(), "известный путь новым не станет");

        let mixed = newcomers(&known, vec![f(store), f(r"C:\other.exe"), f(r"C:\other.exe")]);
        assert_eq!(mixed.len(), 1, "новое приходит по одной записи на файл");
        assert_eq!(mixed[0].path, r"C:\other.exe");
    }

    /// Обновление пакета MSIX схлопывает пути: две записи разных версий одного
    /// пакета были законно разными файлами, а после переезда читаются одной
    /// строкой. Проверки на добавлении тут бессильны — путь меняется у уже
    /// принятой записи, — и список получал точный дубль. Единственный способ
    /// его завести: среди двух сотен приложений так задвоился ровно тот, что и
    /// живёт в WindowsApps.
    #[test]
    fn an_updated_package_does_not_split_into_two_rows() {
        // Ровно то, чем становятся две версии Store после переезда на 1401.3.0.
        let now = r"C:\Program Files\WindowsApps\Microsoft.WindowsStore_22607.1401.3.0_x64__8wekyb3d8bbwe\store.exe";
        let after = Service::dedup_apps(vec![
            App { path: now.into(), name: "store".into(), enabled: false },
            App { path: now.into(), name: "store".into(), enabled: true },
        ]);
        assert_eq!(after.len(), 1, "обновившийся пакет — одна строка, а не две");
        assert!(after[0].enabled, "выбор человека обязан пережить переезд пакета");

        // Склейка сама себя не позовёт: правило держится, только пока переезд
        // через неё и проходит. Иголка собирается на месте — написанная
        // целиком, она нашла бы саму себя.
        let needle = format!("Self::{}(std::mem::take(&mut self.status.apps))", "dedup_apps");
        assert!(
            include_str!("main.rs").contains(&needle),
            "rebind_packages обязана чистить список после переезда путей"
        );
    }

    /// Дубль в `state.json` переживал любое число перезапусков: `load()` брал
    /// список как есть, а `save()` писал его обратно. Окно рисовало приложение
    /// двумя строками, убрать лишнюю было нечем — `RemoveApp` вычищает обе, —
    /// и React ругался на повторяющийся ключ.
    #[test]
    fn a_duplicate_app_never_survives_loading() {
        let store = r"C:\Program Files\WindowsApps\Microsoft.WindowsStore\store.exe";
        let app = |path: &str, enabled: bool| App { path: path.into(), name: "store".into(), enabled };

        let one = Service::dedup_apps(vec![app(store, false), app(store, false)]);
        assert_eq!(one.len(), 1, "один и тот же путь — одна строка списка");

        // Выключенная запись не должна отменять выбранную: это молча вынуло бы
        // приложение из туннеля, оставив его в списке.
        let kept = Service::dedup_apps(vec![app(store, false), app(store, true)]);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].enabled, "выбранность обязана пережить склейку дублей");

        let by_case = Service::dedup_apps(vec![app(store, true), app(&store.replace("store.exe", "Store.exe"), false)]);
        assert_eq!(by_case.len(), 1, "регистр не делает из приложения второе");

        let other = Service::dedup_apps(vec![app(store, true), app(r"C:\other.exe", false)]);
        assert_eq!(other.len(), 2, "разные файлы обязаны остаться разными");

        // Сама по себе склейка ничего не чинит: правило держится, только пока
        // список с диска через неё и проходит. Иголка собирается на месте —
        // написанная целиком, она нашла бы саму себя.
        let needle = format!("Self::{}(saved.apps)", "dedup_apps");
        assert!(
            include_str!("main.rs").contains(&needle),
            "load() обязана чистить список приложений, пришедший с диска"
        );
    }

    /// Вставленное разбирается целиком, а не первой строкой: из канала ссылки
    /// приходят пачкой. И наоборот — одиночная битая ссылка обязана остаться
    /// отказом с причиной, а не превратиться в «ничего не нашлось»: причина
    /// тут единственное, чем чинят опечатку в один символ.
    #[test]
    fn a_pasted_batch_is_imported_whole() {
        const A: &str = "vless://b831381d-6324-4d53-ad4f-8cda48b30811@a.com:443?type=tcp#A";
        const B: &str = "vless://b831381d-6324-4d53-ad4f-8cda48b30811@b.com:443?type=tcp#B";

        assert_eq!(parse_pasted(A).unwrap().found.len(), 1, "одна ссылка так и остаётся одной");
        let both = parse_pasted(&format!("{A}\n{B}")).unwrap();
        let names: Vec<&str> = both.found.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(both.found.len(), 2, "пачка разбирается целиком, а не первой строкой: {names:?}");
        // Имена — то самое место, где ломался прежний путь: `parse` утаскивал
        // вторую ссылку во фрагмент первой и звал это именем узла.
        assert_eq!(names, ["A", "B"], "у каждого узла своё имя, а не хвост из соседней строки");

        let why = parse_pasted("это вообще не ссылка").unwrap_err();
        assert!(!why.is_empty(), "у битой одиночной ссылки остаётся причина отказа");
    }

    /// Адрес подписки узнаётся построчно, а не по префиксу всего текста.
    ///
    /// Пока смотрели на первый префикс, вставка из двух адресов уезжала в
    /// `fetch` целиком — вместе с переносом строки и вторым адресом, — и
    /// человек получал «подписка не скачалась» на двух исправных панелях. Окно
    /// при этом обещало «строк: 2 — импортируются разом».
    #[test]
    fn a_paste_splits_into_lines() {
        const LINK: &str = "vless://b831381d-6324-4d53-ad4f-8cda48b30811@a.com:443?type=tcp#A";

        let (urls, rest) = split_paste("https://panel/one\nhttps://panel/two");
        assert_eq!(urls, ["https://panel/one", "https://panel/two"], "два адреса — две подписки");
        assert!(rest.is_empty(), "лишнего не осталось: {rest}");

        let (urls, rest) = split_paste(&format!("https://panel/one\n{LINK}\n# комментарий"));
        assert_eq!(urls, ["https://panel/one"], "адрес отделён от ссылок");
        assert_eq!(rest, LINK, "ссылка осталась ссылкой, комментарий выброшен");

        let (urls, rest) = split_paste("  https://panel/one  ");
        assert_eq!(urls, ["https://panel/one"], "одиночный адрес — по-прежнему подписка");
        assert!(rest.is_empty());

        // JSON построчно не режется вовсе: адрес внутри конфига — не подписка.
        let json = "{\n  \"type\": \"vless\",\n  \"server\": \"https://a.com\"\n}";
        let (urls, rest) = split_paste(json);
        assert!(urls.is_empty(), "адрес внутри JSON не адрес подписки: {urls:?}");
        assert_eq!(rest, json, "JSON уходит на разбор целиком");
    }

    /// Тот же узел вторым профилем не заводится. Имя ему `free_name` выдал бы
    /// свободное, и в списке оказались бы две строки, которые ничем не
    /// различить: имя узлу пишет чужая панель, а не мы.
    #[test]
    fn the_same_node_is_never_imported_twice() {
        const LINK: &str = "vless://b831381d-6324-4d53-ad4f-8cda48b30811@a.com:443?type=tcp#A";
        let _state = scratch("pg-import-test");
        let mut s = Service::load();

        let first = add_profiles(&mut s, parse_pasted(LINK).unwrap());
        assert_eq!((first.added, first.kept), (1, 0), "первый раз — новый профиль");

        let again = add_profiles(&mut s, parse_pasted(LINK).unwrap());
        assert_eq!((again.added, again.kept), (0, 1), "второй раз — тот же узел, а не «A (2)»");
        assert_eq!(s.profiles.len(), 1, "в списке по-прежнему один: {:?}", s.profiles.keys());
    }

    /// Узел из подписки не правится: её набор заменяет сверка целиком, и правка
    /// вернулась бы к прежнему виду ближайшим кругом.
    #[test]
    fn a_subscription_node_is_never_edited() {
        let _state = scratch("pg-edit-test");
        let mut s = Service::load();
        s.profiles.insert("NL-01".into(), json!({"type": "vless", "server": "a.com"}));
        s.subscriptions.insert("https://panel/sub".into(), vec!["NL-01".into()]);

        let out = edit_profile(&mut s, "NL-01", "дом", "");
        assert!(matches!(out, Response::Error { .. }), "переименование узла подписки отклоняется: {out:?}");
        assert!(s.profiles.contains_key("NL-01"), "имя осталось прежним");

        // Свой профиль правится: имя, узел и то и другое разом.
        s.subscriptions.clear();
        let out = edit_profile(&mut s, "NL-01", "дом", "");
        assert!(matches!(out, Response::Done), "{out:?}");
        assert!(s.profiles.contains_key("дом"), "свой профиль переименовался: {:?}", s.profiles.keys());

        let out = edit_profile(&mut s, "дом", "", "не ссылка и не JSON");
        assert!(matches!(out, Response::Error { .. }), "битый узел отклоняется с причиной: {out:?}");
    }

    /// Занятое имя получает номер на обоих путях импорта. Голый `insert` в
    /// ручной вставке молча забирал чужое имя: старый узел исчезал без слова, а
    /// активный профиль начинал показывать на другой сервер — при живом
    /// sing-box от прежнего.
    ///
    /// Сверяется текстом: подменить тут нечего, а забыть вызов — легко, ровно
    /// так эта дыра и появилась.
    #[test]
    fn a_hand_imported_profile_never_steals_a_taken_name() {
        let needle = format!("{}(&s.profiles", "free_name");
        assert_eq!(
            include_str!("main.rs").matches(&needle).count(),
            2,
            "free_name зовут оба пути импорта: и подписка, и ручная вставка",
        );
    }

    /// Заголовок `Subscription-Userinfo` — де-факто стандарт панелей, а не RFC:
    /// поля необязательны, порядок произволен, пробелы встречаются, а половина
    /// панелей не шлёт его вовсе. Терпимость тут не небрежность: непонятый
    /// заголовок обязан давать «нечего показать», а не отказ импорта — узлы в
    /// том же ответе разобраны и нужны.
    #[test]
    fn a_panel_quota_is_read_from_the_header() {
        let full = parse_userinfo(Some(
            "upload=455727941; download=6603863621; total=1073741824000; expire=1673684400",
        ))
        .expect("полный заголовок разбирается");
        assert_eq!(full.upload, 455_727_941);
        assert_eq!(full.download, 6_603_863_621);
        assert_eq!(full.total, 1_073_741_824_000);
        assert_eq!(full.expire, 1_673_684_400);

        // Безлимитная подписка шлёт только расход.
        let partial = parse_userinfo(Some("upload=1; download=2")).expect("частичный заголовок");
        assert_eq!((partial.total, partial.expire), (0, 0), "непришедшее — ноль, а не отказ");

        // Пробелы и обратный порядок — та же строка.
        let messy = parse_userinfo(Some(" expire = 7 ;  total=9 ")).expect("пробелы не мешают");
        assert_eq!((messy.total, messy.expire), (9, 7));

        // Битое число и незнакомое поле пропускаются, остальное читается.
        let dirty = parse_userinfo(Some("upload=abc; download=5; reset_day=1")).expect("мусор не роняет");
        assert_eq!((dirty.upload, dirty.download), (0, 5));

        assert_eq!(parse_userinfo(None), None, "заголовка нет — это норма");
        assert_eq!(parse_userinfo(Some("хлам без знака равенства")), None, "понять нечего — молчим");
        assert_eq!(parse_userinfo(Some("upload=0; download=0")), None, "все нули показывать нечего");
    }

    /// Отсчёт до следующей попытки не показывает ноль: «через 0 с» читается как
    /// «ничего не происходит» ровно там, где происходит ожидание. Прошедшая
    /// пауза и отсутствие паузы для окна одно и то же — круг надзора в обоих
    /// случаях возьмётся сам.
    #[test]
    fn the_retry_countdown_never_shows_zero() {
        // Отсчёт от будущего момента: у свежего процесса `Instant::now()` может
        // быть меньше вычитаемого, и `now - 5s` паникует.
        let now = Instant::now() + Duration::from_secs(60);
        assert_eq!(retry_in(None, now), None, "паузы не запланировано");
        assert_eq!(retry_in(Some(now - Duration::from_secs(5)), now), None, "пауза уже истекла");
        assert_eq!(retry_in(Some(now), now), None, "пауза истекает ровно сейчас");
        assert_eq!(
            retry_in(Some(now + Duration::from_millis(500)), now),
            Some(1),
            "полсекунды — это ещё «через секунду», а не «уже»",
        );
        assert_eq!(retry_in(Some(now + Duration::from_secs(30)), now), Some(30));
    }

    /// Пустой каталог состояния и очередь к нему. Каталог задаётся переменными
    /// окружения, а они одни на процесс: без очереди тест, поставивший свой
    /// каталог, писал бы в чужой — и оба читали бы чужое состояние.
    static STATE_DIR: Mutex<()> = Mutex::new(());

    fn scratch(name: &str) -> std::sync::MutexGuard<'static, ()> {
        let held = STATE_DIR.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("XDG_CONFIG_HOME", &tmp);
        std::env::set_var("ProgramData", &tmp);
        held
    }

    /// Перезапуск не должен ни тихо возвращать выбранные приложения в открытую
    /// сеть, ни поднимать туннель после того, как его выключили.
    #[test]
    fn private_mode_survives_restart() {
        let _state = scratch("pg-state-test");

        let mut s = Service::load();
        s.status.apps.push(App { path: "/bin/true".into(), name: "true".into(), enabled: true });
        s.profiles.insert("p".into(), json!({ "type": "trojan", "server": "a.com", "server_port": 443 }));
        s.status.profile = Some("p".into());
        s.private = true;
        s.status.scope = Scope::Whitelist;
        s.save();

        let restored = Service::load();
        assert!(restored.private, "приватный режим обязан пережить перезапуск");
        assert_eq!(
            restored.status.scope,
            Scope::Whitelist,
            "охват тоже: сузить его молча значило бы выпустить трафик наружу",
        );
        assert_eq!(restored.status.profile.as_deref(), Some("p"));
        assert_eq!(restored.status.apps.len(), 1);
        assert_eq!(restored.status.tunnel, TunnelState::Off, "туннель после старта ещё не поднят");
        assert_eq!(restored.status.rx, 0, "счётчики трафика не переносятся");

        let mut s = restored;
        s.stop();
        assert!(!Service::load().private, "выключение — тоже решение, и оно тоже запоминается");
    }
}

fn serve(svc: &Mutex<Service>, mut conn: Stream) {
    let Ok(clone) = conn.try_clone() else { return };
    let mut reader = BufReader::new(clone);
    loop {
        // Потолок ставится на каждую строку заново, а не на соединение целиком:
        // строк по одному соединению может прийти сколько угодно, а вот строка
        // без перевода строки без потолка съедает всю память службы — и это
        // умеет любой локальный процесс, если канал откатился на сокет.
        let mut line = String::new();
        match reader.by_ref().take(core_ipc::MAX_LINE).read_line(&mut line) {
            Ok(0) | Err(_) => return, // клиент ушёл или прислал не UTF-8
            Ok(_) => {}
        }
        // Строка без перевода строки — это либо упёршийся в потолок запрос,
        // либо оборванный на середине. В обоих случаях отвечаем и уходим:
        // остаток по этому соединению — хвост той же строки, а не следующий
        // запрос, и разбирать его значит отвечать мусором на мусор.
        let overflow = !line.ends_with('\n');
        let resp = if overflow {
            Response::Error { message: t("запрос слишком длинный") }
        } else {
            match serde_json::from_str(&line) {
                Ok(req) => handle(svc, req),
                Err(e) => Response::Error {
                    message: tf!("неразбираемый запрос: {}", e),
                },
            }
        };
        let out = serde_json::to_string(&resp).unwrap();
        let sent = writeln!(conn, "{out}").is_ok() && conn.flush().is_ok();
        if overflow || !sent {
            return;
        }
    }
}

/// Тело службы. `stop` приходит от SCM; в консольном режиме его нет, и тогда
/// функция не возвращается — работу заканчивает Ctrl+C.
fn run(stop: Option<mpsc::Receiver<()>>) -> std::io::Result<()> {
    // Права каталога — впереди всего, что в него пишет, и потому впереди
    // `Service::load()`: первую же строку журнала служба положит на диск сама.
    // Отказ не останавливает запуск: непрочитанный чужими `state.json` дороже
    // прав на каталог, но машина без службы дороже обоих — там нет ни туннеля,
    // ни правил. Поэтому не отказ, а строка в журнале, видная в окне.
    let state = dir();
    let sealed = secure_dir(&state);
    let svc = Arc::new(Mutex::new(Service::load()));
    // Отказ здесь — на Windows это несозданный канал. Служба не поднимается:
    // сокет вместо канала означал бы управление приватным режимом откуда угодно.
    let (listener, endpoint) = Listener::bind()?;
    {
        let mut s = lock(&svc);
        let (apps, profiles) = (s.status.apps.len(), s.profiles.len());
        let where_ = match endpoint {
            Endpoint::Pipe => format!("канал {}", core_ipc::PIPE),
            Endpoint::Tcp => format!("сокет {ADDR}"),
        };
        s.log(tf!("служба слушает {}; приложений: {}, профилей: {}", where_, apps, profiles));
        if !elevated() {
            s.warn(t("ВНИМАНИЕ: служба запущена без прав администратора — TUN и правила брандмауэра работать не будут"));
        }
        if let Err(e) = sealed {
            s.warn(tf!("права каталога состояния не выставлены — пароли профилей читает вся машина: {}", e));
        }
        match (s.private, s.status.profile.clone()) {
            // Приватный режим пережил перезапуск — восстанавливаем его сами.
            // start() сначала блокирует, потом поднимает туннель, поэтому окна
            // прямого доступа между загрузкой системы и туннелем не возникает.
            (true, Some(profile)) => {
                s.log(tf!("приватный режим был включён — восстанавливаю профиль «{}»", profile));
                let _ = s.start(&profile);
            }
            // Служба, убитая прошлый раз, могла оставить блокирующие правила: без
            // этого выбранные приложения остались бы без сети и снять их было бы
            // нечем. Снимаем ровно по приватному режиму, а не безусловно: он мог
            // пережить перезапуск без профиля (профиль удалили), и тогда правила
            // обязаны остаться.
            _ => {
                let private = s.private;
                s.guard(private);
            }
        }
        // Политику надо запомнить, пока она ещё не наша: снимая замок, служба
        // обязана вернуть ту, которую взяла, а взять её потом уже негде.
        //
        // Здесь, а не в `guard`, по двум причинам. Вопрос идёт через PowerShell
        // (модуль NetSecurity), а `guard(true)` обязан быть быстрым: это то
        // самое окно, в котором выбранные приложения ещё ходят напрямую. И под
        // собственным замком читать нечего — вышел бы наш же `blockoutbound`,
        // поэтому спрашиваем только когда замка нет, а под замком верим
        // `state.json`: он и заведён ради падения службы.
        if s.policy.is_none() && s.applied.as_ref().map(|a| a.killswitch) != Some(true) {
            s.policy = core_filter::policy_now();
            s.save();
        }
        // Обход каталога — уже после того, как приватный режим восстановлен:
        // до `guard` выше выбранные приложения ходят напрямую, и растить это
        // окно обходом диска нельзя.
        if let Err(e) = secure_tree(&state) {
            s.warn(tf!("права каталога состояния не выставлены — пароли профилей читает вся машина: {}", e));
        }
    }

    let watched = Arc::clone(&svc);
    std::thread::spawn(move || supervise(&watched));

    // Поток заводится всегда: выключенная сверка — это его молчание, а не его
    // отсутствие, иначе включить её без перезапуска службы было бы нечем.
    let refreshed = Arc::clone(&svc);
    std::thread::spawn(move || refresh_loop(refreshed));

    let accepting = Arc::clone(&svc);
    std::thread::spawn(move || loop {
        match listener.accept() {
            Ok(conn) => {
                let svc = Arc::clone(&accepting);
                std::thread::spawn(move || serve(&svc, conn));
            }
            // Отвалившееся соединение не должно останавливать приём следующих.
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    });

    match stop {
        Some(rx) => {
            let _ = rx.recv();
            // Остановка по команде — гасим туннель и снимаем правила. Инстансы
            // под окна браузера тоже наши процессы: сиротами они бы остались жить.
            let mut s = lock(&svc);
            s.browsers.clear();
            s.stop();
        }
        None => loop {
            std::thread::park();
        },
    }
    Ok(())
}

const USAGE: &str = "pg-service — служба proxybox

  (без аргументов)  работать консольным процессом (разработка)
  install           зарегистрировать службу Windows и включить автозапуск
  uninstall         остановить и удалить службу";

fn main() -> std::process::ExitCode {
    let arg = std::env::args().nth(1).unwrap_or_default();

    #[cfg(windows)]
    {
        let done = |r: windows_service::Result<()>| match r {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                std::process::ExitCode::FAILURE
            }
        };
        match arg.as_str() {
            service::ARG => return done(service::dispatch()),
            "install" => {
                let exe = match std::env::current_exe() {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("не удалось определить путь к себе: {e}");
                        return std::process::ExitCode::FAILURE;
                    }
                };
                return done(service::install(exe));
            }
            "uninstall" => return done(service::uninstall()),
            _ => {}
        }
    }

    if !arg.is_empty() {
        eprintln!("{USAGE}");
        return std::process::ExitCode::FAILURE;
    }
    match run(None) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("служба не запустилась: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
