//! Служба Privacy Gateway: единственный владелец состояния, процесса sing-box и
//! правил брандмауэра. Клиенты (GUI, CLI) только шлют команды и читают статус.
//!
//! ponytail: пока обычный консольный бинарник. Регистрация Windows Service нужна
//! ровно тогда, когда правила брандмауэра и TUN потребуют прав администратора
//! без ручного «запустить от имени».

#[cfg(windows)]
mod service;

use core_ipc::{
    dir_name, t, App, BrowserProfile, Endpoint, Listener, Probe, Request, Response, Status, Stream,
    Tunnel as TunnelState, ADDR,
};
use core_tunnel::{build_config, Options, Tunnel as Process};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Как часто служба проверяет, жив ли туннель. Это же — окно, в котором
/// выбранные приложения могут успеть уйти напрямую после падения sing-box.
const PROBE_EVERY: Duration = Duration::from_secs(3);
/// Пауза перед повторной попыткой поднять туннель: удваивается до максимума.
/// Без неё отказ, который сам не пройдёт (нет прав, занят порт), превращается
/// в бесконечный поток одинаковых ошибок в журнале.
const RETRY_BASE: Duration = Duration::from_secs(3);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// Как часто служба сама сверяет подписки. Шесть часов — это про списки узлов,
/// которые панели правят днями, а не минутами; чаще значило бы дёргать чужой
/// сервер без повода.
/// ponytail: срок прибит гвоздями и отсчитывается от старта службы — настройка
/// появится тогда же, когда её будет где показать.
const REFRESH_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

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
    base.join("privacy-gateway")
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
    profile: Option<String>,
    #[serde(default)]
    lang: core_ipc::Lang,
    /// Был ли включён приватный режим. Переживает перезапуск намеренно: иначе
    /// после перезагрузки машины выбранные приложения молча оказались бы в
    /// сети напрямую — ровно то, чего продукт обещает не допускать.
    #[serde(default)]
    private: bool,
    /// Охват: весь трафик машины вместо списка приложений. Переживает
    /// перезапуск по той же причине, что и `private`: молча сузить охват после
    /// перезагрузки значило бы выпустить наружу то, что пользователь закрыл.
    #[serde(default)]
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
}

/// Секунды с эпохи. Часы могли прыгнуть назад — тогда измерение выглядит
/// сделанным только что, и это лучше паники на ровном месте.
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
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

struct Service {
    status: Status,
    profiles: BTreeMap<String, Value>,
    subscriptions: BTreeMap<String, Vec<String>>,
    /// Приватный режим включён пользователем. Не то же самое, что «туннель жив»:
    /// именно расхождение этих двух флагов и означает DROP.
    private: bool,
    tunnel: Option<Process>,
    probe_target: (String, u16),
    retry_at: Option<Instant>,
    retry_delay: Duration,
    /// Что уже применено к брандмауэру: (блокировать, охват «весь трафик»,
    /// список приложений). Без этой памяти надзор дёргал бы netsh каждые три
    /// секунды и засыпал журнал одинаковыми отказами.
    applied: Option<(bool, bool, Vec<String>)>,
    /// Инстансы под окна браузера: профиль → его процесс, по одному на профиль.
    /// Сеансы независимы — портов у каждого свои (`free_port`), каталог свой
    /// (`browser/<dir_name>`), и общий режим не трогает ни один.
    ///
    /// ponytail: числа сеансов никто не ограничивает, а каждый — это отдельный
    /// sing-box со своей памятью. Потолок — сколько процессов вытерпит машина;
    /// апгрейд — предел с отказом в `browse()`, когда найдётся, из чего его
    /// выбирать.
    browsers: BTreeMap<String, Process>,
    /// Номер поколения туннеля: растёт на каждом запуске и на каждом гашении.
    /// Проба идёт без замка и занимает секунды — за это время туннель успевают
    /// перезапустить, а порты у нас постоянные. Номер отличает ответ про
    /// нынешний процесс от ответа про прошлый.
    generation: u64,
}

impl Service {
    fn load() -> Self {
        let raw = std::fs::read_to_string(dir().join("state.json")).unwrap_or_default();
        let saved: Saved = serde_json::from_str(&raw).unwrap_or_default();
        // Язык поднимается до первой строки журнала — иначе стартовые сообщения
        // выходили бы не на том языке, который выбрал пользователь.
        core_ipc::set_lang(saved.lang);
        Self {
            status: Status {
                lang: saved.lang,
                profile: saved.profile,
                apps: saved.apps,
                all_traffic: saved.all_traffic,
                profiles: saved.profiles.keys().cloned().collect(),
                subscriptions: saved.subscriptions.keys().cloned().collect(),
                probes: saved.probes,
                browser_profiles: saved.browser_profiles,
                ..Default::default()
            },
            profiles: saved.profiles,
            subscriptions: saved.subscriptions,
            private: saved.private,
            tunnel: None,
            probe_target: (String::new(), 0),
            retry_at: None,
            retry_delay: RETRY_BASE,
            applied: None,
            browsers: BTreeMap::new(),
            generation: 0,
        }
    }

    fn save(&mut self) {
        self.status.profiles = self.profiles.keys().cloned().collect();
        self.status.subscriptions = self.subscriptions.keys().cloned().collect();
        // Профиля больше нет — и мерить нечего: без этой прополки кэш измерений
        // рос бы вечно, а подписка на сотню узлов переписывает их именами раз в
        // сутки. Здесь, а не в каждом месте удаления: через save() проходят все.
        self.status.probes.retain(|p| self.profiles.contains_key(&p.name));
        let saved = Saved {
            apps: self.status.apps.clone(),
            profiles: self.profiles.clone(),
            subscriptions: self.subscriptions.clone(),
            profile: self.status.profile.clone(),
            lang: self.status.lang,
            private: self.private,
            all_traffic: self.status.all_traffic,
            probes: self.status.probes.clone(),
            browser_profiles: self.status.browser_profiles.clone(),
        };
        let _ = std::fs::create_dir_all(dir());
        if let Ok(raw) = serde_json::to_string_pretty(&saved) {
            let _ = std::fs::write(dir().join("state.json"), raw);
        }
    }

    fn log(&mut self, line: impl Into<String>) {
        let line = line.into();
        // Повтор в цикле перезапуска не должен вытеснять из журнала всё остальное.
        if self.status.log.first() == Some(&line) {
            return;
        }
        eprintln!("{line}");
        self.status.log.insert(0, line);
        self.status.log.truncate(30);
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
    fn selected(&self) -> Vec<String> {
        let mut out = Vec::new();
        for app in self.status.apps.iter().filter(|a| a.enabled) {
            let canonical = core_apps::canonical(&app.path);
            if canonical != app.path {
                out.push(canonical);
            }
            out.push(app.path.clone());
        }
        out
    }

    /// Блокировка на всё время, пока туннель не подтверждён: выбранных
    /// приложений — правилами по путям, всей машины — политикой брандмауэра.
    ///
    /// Режимы взаимоисключающие, и снимаются оба сразу: смена охвата на ходу
    /// иначе оставила бы правила прошлого режима висеть — а это либо
    /// заблокированные навсегда приложения, либо машина без сети.
    fn guard(&mut self, blocked: bool) {
        let want = (blocked, self.status.all_traffic, self.selected());
        if self.applied.as_ref() == Some(&want) {
            return;
        }
        // Политику брандмауэра трогаем, только пока она может быть нашей: в
        // охвате «выбранные приложения» настройка машины нас не касается, и
        // возвращать её в умолчание Windows значило бы стереть чужую. Условие
        // держится на том, что охват сохраняется на диск: служба, упавшая с
        // запретом всего исходящего, на следующем старте видит `all_traffic` и
        // снимает его — сразу, если приватный режим был выключен.
        let ours = want.1 || self.applied.as_ref().is_some_and(|(blocked, all, _)| *blocked && *all);
        let outcome = core_filter::set_blocked(&want.2, blocked && !want.1).and_then(|()| match ours {
            true => core_filter::set_killswitch(blocked && want.1, &core_tunnel::binary()),
            false => Ok(()),
        });
        match outcome {
            Ok(()) => self.applied = Some(want),
            Err(e) => {
                // Неудачу не запоминаем: на следующей смене состояния попробуем снова.
                self.applied = None;
                self.log(t(&format!("правила брандмауэра не поставлены — {e}"), &format!("firewall rules not applied — {e}")));
            }
        }
    }

    fn start(&mut self, profile: &str) -> Result<(), String> {
        let node = self.profiles.get(profile).cloned().ok_or_else(|| t(&format!("нет профиля «{profile}»"), &format!("no profile \"{profile}\"")))?;
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

        let opts = Options { tun: tun_enabled(), apps: self.selected(), all: self.status.all_traffic, ..Default::default() };
        let config = build_config(&node, &opts);
        self.probe_target = probe_target(&node);
        match Process::start(&config, &dir()) {
            Ok(process) => {
                self.tunnel = Some(process);
                self.status.tunnel = TunnelState::Connecting;
                self.retry_at = None;
                self.retry_delay = RETRY_BASE;
                let count = opts.apps.len();
                let scope = match opts.all {
                    true => t("весь трафик компьютера", "all computer traffic"),
                    false => t(&format!("приложений в туннеле: {count}"), &format!("apps in the tunnel: {count}")),
                };
                self.log(t(
                    &format!("профиль «{profile}»: sing-box запущен, {scope}"),
                    &format!("profile \"{profile}\": sing-box started, {scope}"),
                ));
                Ok(())
            }
            Err(e) => {
                self.status.tunnel = TunnelState::Down;
                self.retry_at = Some(Instant::now() + self.retry_delay);
                let wait = self.retry_delay.as_secs();
                self.retry_delay = (self.retry_delay * 2).min(RETRY_MAX);
                let reason = explain(&e.to_string());
                self.log(t(
                    &format!("sing-box не запустился: {reason}; следующая попытка через {wait} с"),
                    &format!("sing-box failed to start: {reason}; retrying in {wait} s"),
                ));
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
        self.log(t("приватный режим выключен: правила сняты", "private mode off: rules removed"));
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
                t(&format!("нет браузерного профиля «{profile}»"), &format!("no browser profile \"{profile}\""))
            })?;
        // Узел могли удалить или он мог пропасть из подписки: сам браузерный
        // профиль это переживает (в его каталоге входы), а вот открыть его
        // теперь нечем — и молчать об этом нельзя.
        let node = self
            .profiles
            .get(&node_name)
            .cloned()
            .ok_or_else(|| t(&format!("нет узла «{node_name}»"), &format!("no node \"{node_name}\"")))?;
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
        self.log(t(
            &format!("профиль «{profile}» поднят под браузер: 127.0.0.1:{port}"),
            &format!("profile \"{profile}\" is up for the browser: 127.0.0.1:{port}"),
        ));
        self.browsers.insert(profile.to_string(), proc);
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
    }

    /// Сеанс браузера погашен. Процесс уходит Drop'ом, порт закрывается — и
    /// незакрытая вкладка остаётся без сети: прямого доступа тут не появляется
    /// ни на такт, ровно как и при падении самого sing-box.
    fn browse_stop(&mut self, profile: &str) {
        if self.browsers.remove(profile).is_none() {
            return;
        }
        self.log(t(
            &format!("сеанс браузера «{profile}» закрыт"),
            &format!("browser session \"{profile}\" closed"),
        ));
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
            let names = moved.join(", ");
            self.log(t(
                &format!("приложения обновились, пути в списке освежены: {names}"),
                &format!("apps updated, paths refreshed: {names}"),
            ));
            self.save();
        }
        !moved.is_empty()
    }

    /// Перезапуск с новым списком приложений — иначе только что добавленное
    /// приложение продолжило бы ходить напрямую.
    fn reapply(&mut self) {
        if self.private {
            if let Some(profile) = self.status.profile.clone() {
                let _ = self.start(&profile);
            }
        }
    }
}

/// Единственный запрос наружу должен выключаться: продукт про приватность, и
/// решение обращаться к третьей стороне принадлежит пользователю, а не нам.
fn geo_enabled() -> bool {
    std::env::var("PG_GEO").as_deref() != Ok("0")
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

fn probe_target(node: &Value) -> (String, u16) {
    if let Some((h, p)) = std::env::var("PG_PROBE").ok().and_then(|v| {
        let (h, p) = v.rsplit_once(':')?;
        Some((h.to_string(), p.parse().ok()?))
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
fn fetch(url: &str, via_tunnel: bool) -> Result<String, String> {
    // Только https, и проверка здесь, а не в разборе команды: этот же fetch
    // ходит за плановым обновлением подписки, адрес которой мог приехать в
    // state.json ещё до этой проверки. Тело ответа — список серверов, через
    // которые пойдёт весь трафик выбранных приложений; по открытому каналу его
    // подменяет любой, кто на пути, и это не утечка, а подмена VPN целиком.
    if !url.starts_with("https://") {
        return Err(t(
            "подписка только по https: по http список узлов подменит любой, кто на пути",
            "subscriptions must use https: over http anyone on the path can replace the node list",
        ));
    }
    let direct = || get(url, None);
    if !via_tunnel {
        return direct();
    }
    // mixed-инбаунд отвечает и на HTTP CONNECT, поэтому socks-фича ureq не нужна.
    get(url, Some(&format!("http://127.0.0.1:{}", Options::default().socks_port))).or_else(|_| direct())
}

fn get(url: &str, proxy: Option<&str>) -> Result<String, String> {
    let fail = |e: &dyn std::fmt::Display| {
        t(&format!("подписка не скачалась: {e}"), &format!("subscription download failed: {e}"))
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
        .user_agent(concat!("privacy-gateway/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    agent.get(url).call().map_err(|e| fail(&e))?.body_mut().read_to_string().map_err(|e| fail(&e))
}

/// Занятое имя получает номер: в подписках узлы сплошь и рядом называются
/// одинаково, а профиль в списке — это ключ.
fn free_name(taken: &BTreeMap<String, Value>, want: &str) -> String {
    if !taken.contains_key(want) {
        return want.to_string();
    }
    (2..).map(|n| format!("{want} ({n})")).find(|name| !taken.contains_key(name)).expect("номер найдётся")
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
fn subscribe(svc: &Mutex<Service>, url: &str, scheduled: bool) -> Response {
    // Сеть — до захвата замка. Иначе окно на все двадцать секунд перестало бы
    // получать статус, а служба — выглядеть живой.
    // Замок берём на одно поле и сразу отпускаем: знать, жив ли туннель, надо
    // до сети, а держать состояние на все двадцать секунд запроса — нельзя.
    let via_tunnel = lock(svc).status.tunnel == TunnelState::Up;
    let body = match fetch(url, via_tunnel) {
        Ok(body) => body,
        Err(message) => return Response::Error { message },
    };
    let found = core_config::parse_many(&body);
    let mut s = lock(svc);
    if found.is_empty() {
        // Пустой ответ — это чаще всего не пустая подписка, а неверный адрес
        // или чужой формат. Старые профили в таком случае не трогаем.
        let message = t(
            "в ответе подписки нет ни одного узла — проверьте адрес",
            "the subscription returned no nodes — check the address",
        );
        s.log(message.clone());
        return Response::Error { message };
    }

    // Набор заменяется целиком, но живой туннель на это время не гасится:
    // между снятыми правилами и поднятым заново sing-box выбранные приложения
    // ушли бы напрямую — щель узкая, но это ровно та щель, которой продукт не
    // допускает. Поэтому профили сначала подменяются молча, а судьба активного
    // узла решается уже по готовому списку.
    let active = s.status.profile.clone();
    let before = active.as_ref().and_then(|name| s.profiles.get(name)).cloned();
    for name in s.subscriptions.remove(url).unwrap_or_default() {
        s.profiles.remove(&name);
    }
    let names: Vec<String> = found
        .into_iter()
        .map(|p| {
            let name = free_name(&s.profiles, &p.name);
            s.profiles.insert(name.clone(), p.node);
            name
        })
        .collect();
    s.log(t(
        &format!("подписка обновлена, узлов — {}", names.len()),
        &format!("subscription updated, nodes — {}", names.len()),
    ));
    s.subscriptions.insert(url.to_string(), names);
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
                s.log(t(
                    &format!("узел «{name}» изменился, туннель перезапускается"),
                    &format!("node \"{name}\" changed, restarting the tunnel"),
                ));
                let _ = s.start(&name);
            }
            Active::Stop => s.stop(),
            Active::Drop => {
                s.log(t(
                    &format!("узел «{name}» пропал из подписки: приватный режим оставлен включённым, выбранные приложения без сети"),
                    &format!("node \"{name}\" is gone from the subscription: private mode left on, selected apps have no network"),
                ));
                s.tunnel = None; // надзор увидит отсутствие процесса и заблокирует приложения
                s.generation += 1;
                s.save();
            }
        }
    }
    Response::Done
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

/// Сверка подписок по расписанию. Отдельным потоком, а не тиком надзора:
/// запрос к панели длится до двадцати секунд, и на это время присмотр за
/// туннелем встал бы — окно утечки после падения sing-box выросло бы с трёх
/// секунд до двадцати с лишним.
fn refresh_loop(svc: Arc<Mutex<Service>>) {
    loop {
        std::thread::sleep(REFRESH_EVERY);
        let urls: Vec<String> = lock(&svc).subscriptions.keys().cloned().collect();
        for url in urls {
            // Ошибку сверки глотаем намеренно: панель бывает недоступна, и
            // существующие профили в этом случае остаются как есть.
            let _ = subscribe(&svc, &url, true);
        }
    }
}

fn handle(svc: &Mutex<Service>, req: Request) -> Response {
    // Подписка ходит в сеть, поэтому разбирается до замка — остальные команды
    // работают с состоянием и берут его сразу.
    if let Request::AddProfile { link } = &req {
        let link = link.trim();
        if link.starts_with("http://") || link.starts_with("https://") {
            return subscribe(svc, link, false);
        }
    }
    let mut s = lock(svc);
    match req {
        Request::Status => {
            // Прокси под окна браузера не помнятся в статусе, а спрашиваются
            // здесь: процесс мог умереть сам, и запомненное «открыто» пережило
            // бы его — ровно та же ложь, что и «туннель поднят» после падения.
            s.browsers.retain(|_, proc| proc.alive());
            s.status.browsers = s.browsers.keys().cloned().collect();
            Response::Status(s.status.clone())
        }
        Request::ListApps => Response::Apps(s.status.apps.clone()),
        Request::Discover { env } => {
            let found = core_apps::discover(&env);
            let added: Vec<App> = found
                .into_iter()
                .filter(|f| !s.status.apps.iter().any(|a| a.path == f.path))
                // Выключенными: найдено — не значит выбрано.
                .map(|f| App { path: f.path, name: f.name, enabled: false })
                .collect();
            s.log(match added.len() {
                0 => t("автообнаружение: ничего нового не найдено", "discovery: nothing new found"),
                n => t(&format!("автообнаружение: добавлено приложений — {n}"), &format!("discovery: {n} apps added")),
            });
            s.status.apps.extend(added);
            s.save();
            Response::Apps(s.status.apps.clone())
        }
        // Иконку не храним: она есть у системы, и спрашивают её один раз за окно.
        Request::Icon { path } => Response::Icon(core_apps::icon(&path)),
        Request::AddApp { path } => {
            if !s.status.apps.iter().any(|a| a.path == path) {
                let name = path
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or(&path)
                    .trim_end_matches(".exe")
                    .to_string();
                s.status.apps.push(App { path, name, enabled: true });
                s.save();
                s.reapply();
            }
            Response::Done
        }
        Request::SetAllTraffic { enabled } => {
            if s.status.all_traffic != enabled {
                s.status.all_traffic = enabled;
                s.log(match enabled {
                    true => t("охват: весь трафик компьютера", "scope: all computer traffic"),
                    false => t("охват: только выбранные приложения", "scope: selected apps only"),
                });
                s.save();
                // Охват живёт в конфиге sing-box (маршрут по умолчанию), а не
                // только в статусе: без перезапуска трафик пошёл бы по-старому.
                // Правила прошлого охвата снимет ближайший цикл надзора — при
                // выключенном приватном режиме блокировать всё равно нечего.
                s.reapply();
            }
            Response::Done
        }
        Request::SetApp { path, enabled } => match s.status.apps.iter_mut().find(|a| a.path == path) {
            Some(app) => {
                app.enabled = enabled;
                s.save();
                s.reapply();
                Response::Done
            }
            None => Response::Error {
                message: t(&format!("приложение не в списке: {path}"), &format!("app is not in the list: {path}")),
            },
        },
        Request::RemoveApp { path } => {
            s.status.apps.retain(|a| a.path != path);
            s.save();
            // Приложение выпало из списка — конфиг туннеля больше не должен его
            // упоминать, иначе оно останется в туннеле до перезапуска.
            s.reapply();
            Response::Done
        }
        Request::AddProfile { link } => match core_config::parse(&link) {
            Ok(p) => {
                s.profiles.insert(p.name.clone(), p.node);
                s.log(t(&format!("профиль «{}» импортирован", p.name), &format!("profile \"{}\" imported", p.name)));
                s.save();
                Response::Done
            }
            Err(e) => Response::Error { message: e },
        },
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
                for name in &names {
                    s.forget_profile(name);
                }
                s.log(t(
                    &format!("подписка отключена, профилей убрано — {}", names.len()),
                    &format!("subscription removed, profiles dropped — {}", names.len()),
                ));
                s.save();
                Response::Done
            }
            None => Response::Error {
                message: t(&format!("нет подписки {url}"), &format!("no subscription {url}")),
            },
        },
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
        Request::RemoveBrowserProfile { name } => {
            s.browsers.remove(&name);
            s.status.browser_profiles.retain(|b| b.name != name);
            s.save();
            Response::Done
        }
        Request::TestProfiles => {
            // Список снимается под замком, а меряется без него: профиль тратит
            // до нескольких секунд, а под этим замком стоит весь GUI.
            let profiles: Vec<(String, Value)> =
                s.profiles.iter().map(|(name, node)| (name.clone(), node.clone())).collect();
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
            let geo = geo_enabled();
            let measured: Vec<(String, Option<u32>, Option<core_tunnel::Exit>, Option<String>)> = profiles
                .iter()
                .map(|(name, node)| {
                    let (host, port) = probe_target(node);
                    match core_tunnel::measure(node, &probe_dir, (&host, port), geo) {
                        Ok((ms, exit)) => (name.clone(), Some(ms), exit, None),
                        Err(e) => (name.clone(), None, None, Some(e.to_string())),
                    }
                })
                .collect();
            let mut s = lock(svc);
            let live = measured.iter().filter(|(_, ms, _, _)| ms.is_some()).count();
            let all = measured.len();
            s.log(t(
                &format!("прогон профилей: отвечают {live} из {all}"),
                &format!("profile run: {live} of {all} alive"),
            ));
            // Не замена списка, а обновление: прогон переписывает задержку и
            // отказ, но страну неответившего оставляет — она от того, что узел
            // сегодня молчит, не изменилась.
            for (name, latency, exit, error) in measured {
                remember(&mut s.status.probes, &name, latency, exit, error);
            }
            s.save();
            Response::Status(s.status.clone())
        }
    }
}

/// Присмотр за туннелем: живость, проба, счётчики. Замок на время пробы не
/// держим — иначе статус в GUI замирал бы на секунды.
fn supervise(svc: &Arc<Mutex<Service>>) {
    loop {
        std::thread::sleep(PROBE_EVERY);
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
            // же самое, что смена списка: конфиг надо пересобрать.
            if s.rebind_packages() {
                s.reapply();
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
            s.log(t(
                "sing-box не работает: выбранные приложения без сети, перезапуск",
                "sing-box is down: selected apps have no network, restarting",
            ));
            let _ = s.start(&profile);
            continue;
        };

        let result = core_tunnel::probe(socks_port, (&host, port));
        let traffic = core_tunnel::traffic(api_port).ok();

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
                    s.log(t(&format!("туннель поднят, задержка {latency} мс"), &format!("tunnel is up, latency {latency} ms")));
                    // Проверяем именно здесь: чужой туннель не мешает нам
                    // подняться, но может забрать маршруты — и тогда «Защищено»
                    // окажется правдой только про нас, а не про приложения.
                    for name in core_filter::foreign_tunnels() {
                        s.log(t(
                            &format!("рядом поднят чужой туннель «{name}» — выберите один: маршруты уйдут к тому, кто выиграет"),
                            &format!("another tunnel \"{name}\" is up — keep one: routes go to whichever wins"),
                        ));
                    }
                    s.guard(false); // дальше маршрутизацией занимается сам sing-box
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
                    s.log(t(
                        &format!("туннель недоступен ({e}): выбранные приложения без сети"),
                        &format!("tunnel unavailable ({e}): selected apps have no network"),
                    ));
                    s.guard(true);
                }
                s.status.tunnel = TunnelState::Down;
                s.status.latency_ms = None;
                s.status.country = None;
            }
        }
        if let Some((rx, tx)) = traffic {
            (s.status.rx, s.status.tx) = (rx, tx);
        }
        drop(s);

        // Единственный запрос наружу за всю работу службы — и только на переходе
        // в «поднят»: дёргать чужой сервис каждые три секунды незачем, он и сам
        // считает это флудом. Замок на это время отпущен: сеть медленная, а под
        // ним стоит весь GUI.
        if just_up && geo_enabled() {
            let found = core_tunnel::exit_country(socks_port);
            let mut s = lock(svc);
            match found {
                Ok(exit) => {
                    let name = &exit.name;
                    s.log(t(&format!("точка выхода: {name}"), &format!("exit point: {name}")));
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
                    s.log(t(&format!("страну выхода узнать не удалось ({e})"), &format!("could not determine the exit country ({e})")));
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
        std::env::remove_var("PG_PROBE");
        let vless = json!({ "type": "vless", "server": "a.com", "server_port": 8443 });
        assert_eq!(probe_target(&vless), ("a.com".to_string(), 8443));
        // У WireGuard сервер описан узлом peers, а не полем server.
        let wg = json!({ "type": "wireguard", "peers": [{ "address": "b.com", "port": 51820 }] });
        assert_eq!(probe_target(&wg), ("b.com".to_string(), 51820));
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

    /// Перезапуск не должен ни тихо возвращать выбранные приложения в открытую
    /// сеть, ни поднимать туннель после того, как его выключили. Обе половины
    /// в одном тесте: они делят каталог состояния, а тесты идут параллельно.
    #[test]
    fn private_mode_survives_restart() {
        let tmp = std::env::temp_dir().join("pg-state-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("XDG_CONFIG_HOME", &tmp);
        std::env::set_var("ProgramData", &tmp);

        let mut s = Service::load();
        s.status.apps.push(App { path: "/bin/true".into(), name: "true".into(), enabled: true });
        s.profiles.insert("p".into(), json!({ "type": "trojan", "server": "a.com", "server_port": 443 }));
        s.status.profile = Some("p".into());
        s.private = true;
        s.status.all_traffic = true;
        s.save();

        let restored = Service::load();
        assert!(restored.private, "приватный режим обязан пережить перезапуск");
        assert!(restored.status.all_traffic, "охват тоже: сузить его молча значило бы выпустить трафик наружу");
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
            Response::Error { message: t("запрос слишком длинный", "the request is too long") }
        } else {
            match serde_json::from_str(&line) {
                Ok(req) => handle(svc, req),
                Err(e) => Response::Error {
                    message: t(&format!("неразбираемый запрос: {e}"), &format!("unparsable request: {e}")),
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
        s.log(t(
            &format!("служба слушает {where_}; приложений: {apps}, профилей: {profiles}"),
            &format!("service listening on {where_}; apps: {apps}, profiles: {profiles}"),
        ));
        if !elevated() {
            s.log(t(
                "ВНИМАНИЕ: служба запущена без прав администратора — TUN и правила брандмауэра работать не будут",
                "WARNING: the service is running without administrator rights — TUN and firewall rules will not work",
            ));
        }
        match (s.private, s.status.profile.clone()) {
            // Приватный режим пережил перезапуск — восстанавливаем его сами.
            // start() сначала блокирует, потом поднимает туннель, поэтому окна
            // прямого доступа между загрузкой системы и туннелем не возникает.
            (true, Some(profile)) => {
                s.log(t(
                    &format!("приватный режим был включён — восстанавливаю профиль «{profile}»"),
                    &format!("private mode was on — restoring profile \"{profile}\""),
                ));
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
    }

    let watched = Arc::clone(&svc);
    std::thread::spawn(move || supervise(&watched));

    if std::env::var("PG_REFRESH").as_deref() != Ok("0") {
        let refreshed = Arc::clone(&svc);
        std::thread::spawn(move || refresh_loop(refreshed));
    }

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

const USAGE: &str = "pg-service — служба Privacy Gateway

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
