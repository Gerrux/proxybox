//! Контракт службы ↔ клиенты (GUI, CLI).
//!
//! Обмен — построчный JSON: одна строка запроса, одна строка ответа.
//!
//! Транспорт на Windows — именованный канал с ACL, и только он: сокет на
//! loopback ограничить некому, и службой через него управлял бы любой процесс
//! машины. Канал пускает SYSTEM, администраторов и интерактивных пользователей
//! и отсекает процессы низкой целостности (песочницы браузеров). На остальных
//! системах — TCP на loopback: там служба не работает, там разработка.
//!
//! Открывает канал клиент анонимно (`SECURITY_ANONYMOUS`). Имя канала свободно
//! ровно до старта службы, и занять его может кто угодно; подставной сервер без
//! этого флага вызвал бы `ImpersonateNamedPipeClient` и получил бы токен
//! клиента — а клиентом бывает `pg-cli` от администратора.

#[cfg(windows)]
mod windows_pipe;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicU8, Ordering};
#[cfg(not(windows))]
use std::net::{TcpListener, TcpStream};

pub const ADDR: &str = "127.0.0.1:48291";
/// Потолок одной строки протокола. Без него строка без перевода строки растёт
/// до предела памяти процесса: у службы это отказ обслуживания от любого
/// локального процесса, у клиента — от подставного канала. Восемь мегабайт
/// заведомо больше самого толстого ответа (статус с иконкой), но конечны.
pub const MAX_LINE: u64 = 8 << 20;
/// Служба создаёт экземпляры канала по одному, и между отданным клиенту
/// экземпляром и следующим канала нет вовсе. Сдаться в этот момент — соврать
/// «служба не запущена», поэтому клиент пробует ещё несколько раз.
#[cfg(windows)]
const PIPE_TRIES: u32 = 5;
#[cfg(windows)]
const PIPE_PAUSE: std::time::Duration = std::time::Duration::from_millis(20);
/// Имя канала на Windows.
pub const PIPE: &str = r"\\.\pipe\privacy-gateway";
/// Имя службы в SCM. Живёт в контракте, потому что нужно и службе (регистрация),
/// и клиенту (`doctor` смотрит, работает ли она).
pub const SERVICE_NAME: &str = "PrivacyGateway";

/// Язык сообщений. Один на процесс: продукт однопользовательский, а язык
/// меняют раз в жизни — тащить его параметром через каждую функцию, которая
/// умеет ошибаться, дороже, чем он того стоит.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lang {
    #[default]
    Ru,
    En,
}

static LANG: AtomicU8 = AtomicU8::new(0);

pub fn set_lang(lang: Lang) {
    LANG.store(lang as u8, Ordering::Relaxed);
}

pub fn lang() -> Lang {
    match LANG.load(Ordering::Relaxed) {
        0 => Lang::Ru,
        _ => Lang::En,
    }
}

/// Строка на текущем языке. Оба варианта стоят рядом в коде: словарь с ключами
/// прятал бы текст от того, кто его пишет и читает.
pub fn t(ru: &str, en: &str) -> String {
    match lang() {
        Lang::Ru => ru,
        Lang::En => en,
    }
    .to_string()
}

/// Имя каталога под сеанс браузера. Нужно обоим клиентам сразу: службе — под
/// свой каталог sing-box, оболочке — под свой `--user-data-dir`, а имя профиля
/// приходит из подписки, и законны в нём и слэш, и двоеточие.
///
/// Хвост-хеш здесь не украшение: одной чисткой символов «a/b» и «a-b» дают один
/// каталог, а каталог сеанса — это его `singbox.pid`, по которому `Tunnel::start`
/// добивает предшественника. Два профиля молча гасили бы друг друга. Пока сеанс
/// был один, столкнуться было не с чем.
///
/// FNV-1a, а не `DefaultHasher`: каталог обязан пережить перезапуск (в нём
/// лежат входы и куки человека), а стабильность `DefaultHasher` между версиями
/// компилятора никто не обещал.
pub fn dir_name(profile: &str) -> String {
    let safe: String =
        profile.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).take(40).collect();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in profile.as_bytes() {
        hash = (hash ^ *byte as u64).wrapping_mul(0x100_0000_01b3);
    }
    format!("{safe}-{hash:016x}")
}

/// Окружение пользователя, от имени которого работает клиент, — для `Discover`.
/// Живёт в контракте, потому что нужно обоим клиентам и означает ровно то, что
/// написано у команды.
///
/// Переменные перечислены поимённо, а не отдаются целиком: службе нужны ровно
/// эти четыре, а всё остальное окружение клиента — не её дело. `HOME` — для
/// разработки не на Windows.
pub fn whoami() -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for name in ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH"] {
        if let Some(value) = std::env::var(name).ok().filter(|v| !v.is_empty()) {
            env.insert(name.to_string(), value);
        }
    }
    if !env.contains_key("USERPROFILE") {
        if let Ok(home) = std::env::var("HOME") {
            env.insert("USERPROFILE".into(), home);
        }
    }
    env
}

/// Язык из окружения — для клиентов, которым не у кого спросить (usage, doctor).
pub fn lang_from_env() -> Lang {
    let vars = ["PG_LANG", "LC_ALL", "LC_MESSAGES", "LANG"];
    let value = vars.iter().find_map(|v| std::env::var(v).ok()).unwrap_or_default();
    if value.is_empty() || value.to_lowercase().starts_with("ru") {
        Lang::Ru
    } else {
        Lang::En
    }
}

/// Браузерный профиль — личность окна, и она не то же самое, что узел. Узел
/// даёт адрес, каталог сеанса — куки и входы, `ua` с `lang` — то, что о
/// браузере узнаёт сайт. На один узел их бывает несколько: два аккаунта через
/// одну страну иначе не развести.
///
/// Чего этим не добиться, сказано один раз и честно: `--user-agent` меняет
/// строку запроса и `navigator.userAgent`, а `Sec-CH-UA` и
/// `navigator.userAgentData` Chromium собирает из настоящей сборки, и флагом
/// они не трогаются. Canvas, шрифты, экран и GPU у всех профилей одной машины
/// общие. Это разделение аккаунтов, а не антидетект: тот делается патченным
/// Chromium, а не набором флагов.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BrowserProfile {
    pub name: String,
    /// Имя профиля узла — ключ из `Status::profiles`. Узел могли удалить: тогда
    /// сеанс не поднимется, но сам браузерный профиль остаётся жить, потому что
    /// в его каталоге лежат входы человека.
    pub node: String,
    /// Пусто — настоящий user-agent установленного браузера. Выдумка тем
    /// заметнее, чем дальше она от него: расхождение со `Sec-CH-UA` видно.
    #[serde(default)]
    pub ua: String,
    /// Значение `Accept-Language` вида `nl-NL,nl,en-US,en`. Пусто — системный.
    /// Язык — второе по громкости после адреса: русский при голландском выходе
    /// виден любому сайту.
    #[serde(default)]
    pub lang: String,
}

/// Одно живое соединение sing-box, как его видит Clash API. Смысл этого списка
/// не в счётчиках, а в колонке `tunneled`: правило по `process_path` сверяет
/// путь побайтово, и промах у него тихий — приложение уходит мимо туннеля, не
/// переставая считаться защищённым. Здесь этот промах видно глазами.
///
/// Ничего не хранится: список собирается на запрос и живёт до ответа.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conn {
    /// Путь к процессу-владельцу целиком, как его отдал sing-box. Пусто — он
    /// его не определил: так выглядит трафик без процесса за ним (DNS, служба,
    /// драйвер), и в охвате «весь компьютер» его особенно много.
    pub process: String,
    /// Куда: домен, если он известен, иначе адрес назначения, и порт рядом.
    pub host: String,
    /// Идёт ли соединение в туннель. Считается по цепочке маршрутов, а не по
    /// списку приложений: список — это намерение, а цепочка — то, что вышло.
    pub tunneled: bool,
    pub rx: u64,
    pub tx: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", content = "arg", rename_all = "kebab-case")]
pub enum Request {
    Status,
    /// Включить приватный режим с профилем.
    On { profile: String },
    /// Выключить приватный режим: фильтры снимаются.
    Off,
    ListApps,
    /// Найти установленные приложения по стандартным путям и добавить в список
    /// выключенными: перехватывать что-то без ведома пользователя мы не будем.
    ///
    /// `env` — окружение того, кто спрашивает (`whoami()`). Служба работает под
    /// LocalSystem: её собственный `%USERPROFILE%` лежит внутри System32, её
    /// `%APPDATA%` — там же, а пользовательская ветка `PATH` (`HKCU\Environment`)
    /// в её окружение не попадает вовсе. Спросить «кто там на том конце» службе
    /// нечем — зато клиент работает от имени человека и знает это про себя, в
    /// том числе куда перенесли его AppData групповой политикой.
    ///
    /// Пустая карта — старый ответ: перебрать все профили из `ProfileList`,
    /// считая подкаталоги профиля стандартными, и искать по своему `PATH`.
    Discover { env: BTreeMap<String, String> },
    AddApp { path: String },
    /// Иконка приложения отдельным запросом, а не полем в `App`: картинки
    /// весят килобайты, а статус окно опрашивает каждые две секунды.
    Icon { path: String },
    SetApp { path: String, enabled: bool },
    RemoveApp { path: String },
    /// Переключить охват: весь трафик машины через туннель либо только
    /// выбранные приложения. Список приложений при этом не трогается — он
    /// просто не участвует, пока охват «весь трафик».
    SetAllTraffic { enabled: bool },
    /// Импорт профиля из share-link (vless://, vmess://, trojan://, ss://, hy2://,
    /// wg://) либо из JSON-конфига sing-box. `https://` — это подписка: служба
    /// скачает её и заведёт профиль на каждый узел. Повторный импорт того же
    /// адреса обновляет подписку, отдельной команды на это нет.
    AddProfile { link: String },
    RemoveProfile { name: String },
    /// Отписаться: уходит и адрес, и все профили, которые с него пришли.
    RemoveSubscription { url: String },
    SetLang { lang: Lang },
    /// Прогнать все профили: каждый поднимается отдельным sing-box без TUN и
    /// пробуется. Живой туннель при этом не трогается — прогон ничего не
    /// переключает, только меряет.
    TestProfiles,
    /// Поднять под профиль отдельный локальный прокси и вернуть его порт
    /// (`Response::Proxy`). Нужен окну браузера: одно окно ходит в выбранный
    /// туннель мимо общего режима. Живой туннель не трогается — у инстанса свои
    /// порты, свой каталог и нет TUN. Запускает браузер клиент: служба работает
    /// в сессии 0, её окна человек не увидит.
    ///
    /// Сеансов бывает несколько разом, по одному на браузерный профиль; тот же
    /// профиль второй раз — тот же порт, второго sing-box ему не надо. `profile`
    /// здесь — имя браузерного профиля, а узел берётся из него.
    Browse { profile: String },
    /// Погасить сеанс браузера. Шлёт его тот, кто окно и открыл: оболочка ждёт
    /// закрытия окна браузера и сообщает. Без этого метка «браузер» пережила бы
    /// окно, а sing-box сеанса — обоих.
    BrowseStop { profile: String },
    /// Завести браузерный профиль либо переписать существующий с тем же именем.
    /// Одна команда на оба случая: правка личности — это и есть перезапись, а
    /// каталог с куками привязан к имени и переживает её.
    SetBrowserProfile { profile: BrowserProfile },
    /// Убрать браузерный профиль. Сеанс его гаснет, а каталог с куками сносит
    /// клиент: он лежит в `%LOCALAPPDATA%` человека, куда службе не дотянуться.
    RemoveBrowserProfile { name: String },
    /// Живые соединения туннеля: кто, куда, каким маршрутом и сколько байт.
    /// Спрашивается по требованию и только пока панель открыта — служба
    /// соединения не хранит, не пишет в журнал и не сохраняет на диск. Это тот
    /// же принцип «ни логов трафика»: посмотреть можно, накопить — нет.
    Connections,
    /// Переписать настройки службы целиком. Туннель при этом не трогается:
    /// ни одно из полей не меняет судьбу уже поднятого sing-box — путь к
    /// бинарнику действует со следующего запуска, проба и страна со следующего
    /// измерения, сверка подписок со следующего круга.
    SetSettings { settings: Settings },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tunnel {
    /// Приватный режим выключен, фильтров нет — приложения ходят напрямую.
    #[default]
    Off,
    Connecting,
    Up,
    /// Приватный режим включён, туннеля нет → выбранные приложения в DROP.
    /// Прямого доступа в этом состоянии не бывает: это и есть fail-closed.
    Down,
}

/// Последнее известное про профиль. Ошибка строкой, а не `Result`: контракт
/// едет в JSON и читается ещё и фронтендом.
///
/// Переживает перезапуск службы: узел не переезжает из страны в страну, и
/// заставлять человека прогонять профили заново ради того, что уже измерено, —
/// значит показывать пустую строку там, где ответ известен. Возраст измерения
/// едет рядом (`at`) именно поэтому: задержка стареет куда быстрее страны, и
/// выдавать вчерашнюю цифру за сегодняшнюю нельзя.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Probe {
    pub name: String,
    pub latency_ms: Option<u32>,
    /// Точка выхода этого профиля, как её видит внешний сервис. None — профиль
    /// не ответил, спросить не вышло или точку выхода не спрашивают (`PG_GEO=0`).
    #[serde(default)]
    pub country: Option<String>,
    /// Код страны ISO 3166-1 alpha-2 («NL»). Им подписана строка профиля:
    /// полное название туда не помещается и живёт в подсказке.
    #[serde(default)]
    pub code: Option<String>,
    pub error: Option<String>,
    /// Когда измерено, unix-время в секундах. 0 — неизвестно: так выглядят
    /// записи из состояния, сохранённого прошлыми версиями.
    #[serde(default)]
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct App {
    pub path: String,
    pub name: String,
    pub enabled: bool,
}

/// Строка журнала со временем записи. Время здесь не украшение: журнал читают,
/// когда уже что-то пошло не так, и «когда именно» — половина ответа. Формат
/// тот же, что у `Probe::at` (unix-секунды), а словами возраст переводит клиент:
/// служба не знает ни языка окна, ни часового пояса того, кто смотрит.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogLine {
    pub at: u64,
    pub text: String,
}

/// Настройки службы. Всё, что раньше жило только в переменных окружения и
/// потому было недоступно тому, у кого продукт установлен, а не собран.
///
/// Одной структурой, а не командой на поле: полей четыре, меняют их разом
/// (экран настроек отдаёт весь набор), а команда на каждое — это четыре ветки
/// в `handle()`, четыре разбора в CLI и четыре типа во фронтенде.
///
/// Переменная окружения по-прежнему сильнее настройки: ею пользуются e2e и
/// разработка, и молча проиграть сохранённому полю она не должна. Служба
/// говорит об этом строкой в журнале при старте — иначе тумблер в окне не
/// липнет, и понять почему неоткуда.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    /// Сверять подписки в фоне раз в сутки. `PG_REFRESH=0` — то же самое.
    pub refresh: bool,
    /// Куда стучится проба, `host:port`. Пусто — сам сервер выбранного узла:
    /// сторонних адресов продукт по умолчанию не трогает. `PG_PROBE` сильнее.
    pub probe: String,
    /// Путь к бинарнику sing-box. Пусто — рядом со службой, иначе `PATH`.
    /// `PG_SINGBOX` сильнее.
    pub singbox: String,
    /// Спрашивать точку выхода у внешнего сервиса. Единственный запрос службы
    /// наружу, и потому он выключаемый. `PG_GEO=0` — то же самое.
    pub geo: bool,
}

/// Умолчания — то же поведение, что было до появления настроек: подписки
/// сверяются, проба идёт на сервер пользователя, sing-box ищется рядом,
/// страна спрашивается.
impl Default for Settings {
    fn default() -> Self {
        Self { refresh: true, probe: String::new(), singbox: String::new(), geo: true }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub tunnel: Tunnel,
    pub profile: Option<String>,
    pub latency_ms: Option<u32>,
    /// Страна точки выхода, как её видит внешний сервис. None — ещё не
    /// спрашивали, не дозвонились или туннель не поднят.
    #[serde(default)]
    pub country: Option<String>,
    pub rx: u64,
    pub tx: u64,
    pub apps: Vec<App>,
    /// Весь трафик машины идёт в туннель, а не только выбранные приложения.
    /// Список `apps` в этом режиме не применяется, но и не теряется.
    #[serde(default)]
    pub all_traffic: bool,
    pub profiles: Vec<String>,
    /// Адреса подписок. Какие профили с какой пришли, знает только служба —
    /// окну хватает списка, чтобы дать обновить и отписаться.
    #[serde(default)]
    pub subscriptions: Vec<String>,
    #[serde(default)]
    pub lang: Lang,
    /// Последние события службы, новое сверху. Не переживает перезапуск.
    #[serde(default)]
    pub log: Vec<LogLine>,
    /// Итог последнего прогона профилей. Держится до следующего прогона и не
    /// сохраняется на диск: это измерение, а не состояние.
    #[serde(default)]
    pub probes: Vec<Probe>,
    /// Профили, под которыми сейчас подняты прокси для окон браузера. Мимо
    /// туннеля и мимо `tunnel`: окна браузера живут своей жизнью, и узнать о
    /// них в интерфейсе больше неоткуда.
    ///
    /// Список, а не один профиль: сеансы независимы.
    #[serde(default)]
    pub browsers: Vec<String>,
    /// Заведённые браузерные профили. Переживают перезапуск: в их каталогах
    /// лежат входы человека, и потерять имя значило бы потерять и вход.
    #[serde(default)]
    pub browser_profiles: Vec<BrowserProfile>,
    /// Настройки службы — уже с учётом переменных окружения: окно показывает
    /// то, что действует, а не то, что записано в state.json.
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "kebab-case")]
pub enum Response {
    Status(Status),
    Apps(Vec<App>),
    /// PNG в data-URL; `None` — иконки нет, окно нарисует заглушку.
    Icon(Option<String>),
    Done,
    /// Локальный порт mixed-прокси, поднятого под профиль (`Browse`).
    Proxy { port: u16 },
    /// Живые соединения. `total` — сколько их было всего: в списке едут только
    /// самые говорливые, и без этого числа обрезанный список читался бы как
    /// полный.
    Connections { conns: Vec<Conn>, total: usize },
    Error { message: String },
}

/// Один запрос — один ответ. Используется и CLI, и Tauri-оболочкой.
/// Соединение с той стороной: канал на Windows, сокет на остальных.
pub struct Stream(Inner);

enum Inner {
    #[cfg(not(windows))]
    Tcp(TcpStream),
    #[cfg(windows)]
    Pipe(std::fs::File),
}

impl Stream {
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream(match &self.0 {
            #[cfg(not(windows))]
            Inner::Tcp(s) => Inner::Tcp(s.try_clone()?),
            #[cfg(windows)]
            Inner::Pipe(f) => Inner::Pipe(f.try_clone()?),
        }))
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match &mut self.0 {
            #[cfg(not(windows))]
            Inner::Tcp(s) => s.read(buf),
            #[cfg(windows)]
            Inner::Pipe(f) => f.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match &mut self.0 {
            #[cfg(not(windows))]
            Inner::Tcp(s) => s.write(buf),
            #[cfg(windows)]
            Inner::Pipe(f) => f.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match &mut self.0 {
            #[cfg(not(windows))]
            Inner::Tcp(s) => s.flush(),
            #[cfg(windows)]
            Inner::Pipe(f) => f.flush(),
        }
    }
}

/// Куда встала служба. Показывается в журнале: на Windows это всегда канал,
/// сокет остаётся только там, где службы и нет, — в разработке.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Pipe,
    Tcp,
}

pub struct Listener(ListenerInner);

enum ListenerInner {
    #[cfg(not(windows))]
    Tcp(TcpListener),
    #[cfg(windows)]
    Pipe,
}

impl Listener {
    /// На Windows — только канал. Отката на сокет нет намеренно: сокет открыт
    /// любому процессу машины, а служба под LocalSystem умеет выключать
    /// приватный режим. Не создался канал — служба не поднимается совсем.
    pub fn bind() -> io::Result<(Listener, Endpoint)> {
        #[cfg(windows)]
        {
            windows_pipe::probe()?;
            Ok((Listener(ListenerInner::Pipe), Endpoint::Pipe))
        }
        #[cfg(not(windows))]
        Ok((Listener(ListenerInner::Tcp(TcpListener::bind(ADDR)?)), Endpoint::Tcp))
    }

    pub fn accept(&self) -> io::Result<Stream> {
        match &self.0 {
            #[cfg(not(windows))]
            ListenerInner::Tcp(l) => Ok(Stream(Inner::Tcp(l.accept()?.0))),
            #[cfg(windows)]
            ListenerInner::Pipe => Ok(Stream(Inner::Pipe(windows_pipe::accept()?))),
        }
    }
}

fn connect() -> io::Result<Stream> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS: серверу канала достаётся
        // токен, которым нельзя ни представиться нами, ни узнать, кто мы. Имя
        // канала свободно до старта службы, и подставной сервер без этого флага
        // получил бы права того, кто к нему подключился.
        const SECURITY_ANONYMOUS: u32 = 0x0010_0000;
        // Канал открывается обычным File: серверная сторона — единственное
        // место, где нужен WinAPI.
        let mut last = io::Error::other("канал не открылся");
        for attempt in 0..PIPE_TRIES {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(SECURITY_ANONYMOUS)
                .open(PIPE)
            {
                Ok(f) => return Ok(Stream(Inner::Pipe(f))),
                // Не последняя попытка: скорее всего это щель между экземплярами
                // канала, а не отсутствие службы.
                Err(e) if attempt + 1 < PIPE_TRIES => {
                    last = e;
                    std::thread::sleep(PIPE_PAUSE);
                }
                // Канала нет совсем. На сокет не уходим: слушать его на Windows
                // некому, а если кто-то слушает — это не служба.
                Err(e) => last = e,
            }
        }
        Err(last)
    }
    #[cfg(not(windows))]
    Ok(Stream(Inner::Tcp(TcpStream::connect(ADDR)?)))
}

/// Один запрос — один ответ. Используется и CLI, и Tauri-оболочкой.
pub fn call(req: &Request) -> io::Result<Response> {
    let mut stream = connect()?;
    let line = serde_json::to_string(req).map_err(io::Error::other)?;
    writeln!(stream, "{line}")?;
    stream.flush()?;
    let mut reply = String::new();
    BufReader::new(stream).take(MAX_LINE).read_line(&mut reply)?;
    serde_json::from_str(&reply).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let reqs = [
            Request::Status,
            Request::On { profile: "myvpn".into() },
            Request::Off,
            Request::ListApps,
            Request::AddApp { path: r"C:\app.exe".into() },
            Request::SetApp { path: r"C:\app.exe".into(), enabled: false },
            Request::RemoveApp { path: r"C:\app.exe".into() },
            Request::Discover { env: BTreeMap::from([("USERPROFILE".into(), r"C:\Users\ilya".into())]) },
            Request::Discover { env: BTreeMap::new() },
            Request::Icon { path: r"C:\app.exe".into() },
            Request::AddProfile { link: "vless://u@a.com:443".into() },
            Request::RemoveProfile { name: "myvpn".into() },
            Request::RemoveSubscription { url: "https://panel.example/sub?token=1".into() },
            Request::SetAllTraffic { enabled: true },
            Request::SetLang { lang: Lang::En },
            Request::TestProfiles,
            Request::Browse { profile: "myvpn".into() },
            Request::BrowseStop { profile: "myvpn".into() },
            Request::SetBrowserProfile {
                profile: BrowserProfile {
                    name: "работа".into(),
                    node: "myvpn".into(),
                    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)".into(),
                    lang: "nl-NL,nl,en-US,en".into(),
                },
            },
            Request::RemoveBrowserProfile { name: "работа".into() },
            Request::Connections,
            Request::SetSettings {
                settings: Settings {
                    refresh: false,
                    probe: "1.1.1.1:443".into(),
                    singbox: r"C:\Program Files\sing-box\sing-box.exe".into(),
                    geo: false,
                },
            },
        ];
        for r in reqs {
            let s = serde_json::to_string(&r).unwrap();
            assert_eq!(r, serde_json::from_str(&s).unwrap(), "запрос {s}");
        }

        let resps = [
            Response::Status(Status {
                tunnel: Tunnel::Down,
                profile: Some("myvpn".into()),
                all_traffic: true,
                country: Some("Нидерланды, Амстердам".into()),
                apps: vec![App { path: r"C:\app.exe".into(), name: "app".into(), enabled: true }],
                profiles: vec!["myvpn".into()],
                browsers: vec!["работа".into()],
                browser_profiles: vec![BrowserProfile {
                    name: "работа".into(),
                    node: "myvpn".into(),
                    ..Default::default()
                }],
                probes: vec![Probe {
                    name: "myvpn".into(),
                    latency_ms: Some(42),
                    country: Some("Нидерланды, Амстердам".into()),
                    code: Some("NL".into()),
                    error: None,
                    at: 1_755_000_000,
                }],
                log: vec![LogLine { at: 1_755_000_000, text: "туннель поднят".into() }],
                ..Default::default()
            }),
            Response::Apps(vec![]),
            Response::Icon(Some("data:image/png;base64,iVBOR".into())),
            Response::Icon(None),
            Response::Done,
            Response::Connections {
                conns: vec![Conn {
                    process: r"C:\Program Files\Google\Chrome\chrome.exe".into(),
                    host: "example.com:443".into(),
                    tunneled: true,
                    rx: 1024,
                    tx: 512,
                }],
                total: 17,
            },
            Response::Error { message: "нет".into() },
        ];
        for r in resps {
            let s = serde_json::to_string(&r).unwrap();
            assert_eq!(r, serde_json::from_str(&s).unwrap(), "ответ {s}");
        }
    }

    /// Ответ обязан быть одной строкой: транспорт построчный.
    #[test]
    fn language_switches_strings() {
        set_lang(Lang::Ru);
        assert_eq!(t("да", "yes"), "да");
        set_lang(Lang::En);
        assert_eq!(t("да", "yes"), "yes");
        set_lang(Lang::Ru);
    }

    #[test]
    fn env_language_defaults_to_russian() {
        std::env::remove_var("PG_LANG");
        std::env::set_var("LANG", "");
        assert_eq!(lang_from_env(), Lang::Ru, "пусто — русский");
        std::env::set_var("PG_LANG", "en_US.UTF-8");
        assert_eq!(lang_from_env(), Lang::En);
        std::env::set_var("PG_LANG", "ru_RU.UTF-8");
        assert_eq!(lang_from_env(), Lang::Ru);
        std::env::remove_var("PG_LANG");
    }

    /// Каталог сеанса — это его `singbox.pid`: совпали каталоги — второй сеанс
    /// добил первого. Одной чистки символов для этого мало.
    #[test]
    fn session_dirs_do_not_collide() {
        assert_ne!(dir_name("a/b"), dir_name("a-b"), "разные профили — разные каталоги");
        assert_eq!(dir_name("узел №1"), dir_name("узел №1"), "тот же профиль — тот же каталог");
        let name = dir_name("NL / Amsterdam: 01");
        assert!(!name.contains(['/', ':', ' ']), "имя каталога, а не имя профиля: {name}");
    }

    #[test]
    fn single_line() {
        let s = serde_json::to_string(&Response::Error { message: "a\nb".into() }).unwrap();
        assert!(!s.contains('\n'), "{s}");
    }
}
