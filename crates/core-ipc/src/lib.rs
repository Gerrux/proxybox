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
    /// (`Response::Proxy`). Нужен окну браузера: одна вкладка ходит в выбранный
    /// туннель мимо общего режима. Живой туннель не трогается — у инстанса свои
    /// порты, свой каталог и нет TUN. Запускает браузер клиент: служба работает
    /// в сессии 0, её окна человек не увидит.
    Browse { profile: String },
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
    pub log: Vec<String>,
    /// Итог последнего прогона профилей. Держится до следующего прогона и не
    /// сохраняется на диск: это измерение, а не состояние.
    #[serde(default)]
    pub probes: Vec<Probe>,
    /// Профиль, под которым сейчас поднят прокси для окна браузера. Мимо
    /// туннеля и мимо `tunnel`: окно браузера живёт своей жизнью, и узнать о
    /// нём в интерфейсе больше неоткуда.
    #[serde(default)]
    pub browser: Option<String>,
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
                browser: Some("myvpn".into()),
                probes: vec![Probe {
                    name: "myvpn".into(),
                    latency_ms: Some(42),
                    country: Some("Нидерланды, Амстердам".into()),
                    code: Some("NL".into()),
                    error: None,
                    at: 1_755_000_000,
                }],
                ..Default::default()
            }),
            Response::Apps(vec![]),
            Response::Icon(Some("data:image/png;base64,iVBOR".into())),
            Response::Icon(None),
            Response::Done,
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

    #[test]
    fn single_line() {
        let s = serde_json::to_string(&Response::Error { message: "a\nb".into() }).unwrap();
        assert!(!s.contains('\n'), "{s}");
    }
}
