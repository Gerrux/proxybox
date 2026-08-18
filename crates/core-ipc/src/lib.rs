//! Контракт службы ↔ клиенты (GUI, CLI).
//!
//! Обмен — построчный JSON: одна строка запроса, одна строка ответа.
//!
//! Транспорт на Windows — именованный канал с ACL: службой управляет кто угодно
//! на машине, если её порт открыт всем, а TCP-сокет ограничить некому. Канал же
//! пускает SYSTEM, администраторов и интерактивных пользователей и отсекает
//! процессы низкой целостности (песочницы браузеров). На остальных системах —
//! по-прежнему TCP на loopback: там служба не работает, там разработка.

#[cfg(windows)]
mod windows_pipe;

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicU8, Ordering};
use std::net::{TcpListener, TcpStream};

pub const ADDR: &str = "127.0.0.1:48291";
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
    Discover,
    AddApp { path: String },
    /// Иконка приложения отдельным запросом, а не полем в `App`: картинки
    /// весят килобайты, а статус окно опрашивает каждые две секунды.
    Icon { path: String },
    SetApp { path: String, enabled: bool },
    RemoveApp { path: String },
    /// Импорт профиля из share-link (vless://, vmess://, trojan://, ss://, hy2://,
    /// wg://) либо из JSON-конфига sing-box. `http(s)://` — это подписка: служба
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

/// Итог прогона одного профиля. Ошибка строкой, а не `Result`: контракт едет
/// в JSON и читается ещё и фронтендом.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Probe {
    pub name: String,
    pub latency_ms: Option<u32>,
    /// Точка выхода этого профиля, как её видит внешний сервис. None — профиль
    /// не ответил, спросить не вышло или точку выхода не спрашивают (`PG_GEO=0`).
    #[serde(default)]
    pub country: Option<String>,
    pub error: Option<String>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "kebab-case")]
pub enum Response {
    Status(Status),
    Apps(Vec<App>),
    /// PNG в data-URL; `None` — иконки нет, окно нарисует заглушку.
    Icon(Option<String>),
    Done,
    Error { message: String },
}

/// Один запрос — один ответ. Используется и CLI, и Tauri-оболочкой.
/// Соединение с той стороной: канал на Windows, сокет на остальных.
pub struct Stream(Inner);

enum Inner {
    Tcp(TcpStream),
    #[cfg(windows)]
    Pipe(std::fs::File),
}

impl Stream {
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream(match &self.0 {
            Inner::Tcp(s) => Inner::Tcp(s.try_clone()?),
            #[cfg(windows)]
            Inner::Pipe(f) => Inner::Pipe(f.try_clone()?),
        }))
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match &mut self.0 {
            Inner::Tcp(s) => s.read(buf),
            #[cfg(windows)]
            Inner::Pipe(f) => f.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match &mut self.0 {
            Inner::Tcp(s) => s.write(buf),
            #[cfg(windows)]
            Inner::Pipe(f) => f.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match &mut self.0 {
            Inner::Tcp(s) => s.flush(),
            #[cfg(windows)]
            Inner::Pipe(f) => f.flush(),
        }
    }
}

/// Куда встала служба. Показывается в журнале: подмена канала на сокет — это
/// понижение защиты, и молчать о нём нельзя.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Pipe,
    Tcp,
}

pub struct Listener(ListenerInner);

enum ListenerInner {
    Tcp(TcpListener),
    #[cfg(windows)]
    Pipe,
}

impl Listener {
    /// На Windows сначала канал; если он не создаётся — сокет, но с криком.
    pub fn bind() -> io::Result<(Listener, Endpoint)> {
        #[cfg(windows)]
        if windows_pipe::probe().is_ok() {
            return Ok((Listener(ListenerInner::Pipe), Endpoint::Pipe));
        }
        Ok((Listener(ListenerInner::Tcp(TcpListener::bind(ADDR)?)), Endpoint::Tcp))
    }

    pub fn accept(&self) -> io::Result<Stream> {
        match &self.0 {
            ListenerInner::Tcp(l) => Ok(Stream(Inner::Tcp(l.accept()?.0))),
            #[cfg(windows)]
            ListenerInner::Pipe => Ok(Stream(Inner::Pipe(windows_pipe::accept()?))),
        }
    }
}

fn connect() -> io::Result<Stream> {
    #[cfg(windows)]
    {
        // Канал открывается обычным File: серверная сторона — единственное
        // место, где нужен WinAPI.
        match std::fs::OpenOptions::new().read(true).write(true).open(PIPE) {
            Ok(f) => return Ok(Stream(Inner::Pipe(f))),
            // Канала нет — возможно, служба откатилась на сокет.
            Err(_) => {}
        }
    }
    Ok(Stream(Inner::Tcp(TcpStream::connect(ADDR)?)))
}

/// Один запрос — один ответ. Используется и CLI, и Tauri-оболочкой.
pub fn call(req: &Request) -> io::Result<Response> {
    let mut stream = connect()?;
    let line = serde_json::to_string(req).map_err(io::Error::other)?;
    writeln!(stream, "{line}")?;
    stream.flush()?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply)?;
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
            Request::Discover,
            Request::Icon { path: r"C:\app.exe".into() },
            Request::AddProfile { link: "vless://u@a.com:443".into() },
            Request::RemoveProfile { name: "myvpn".into() },
            Request::RemoveSubscription { url: "https://panel.example/sub?token=1".into() },
            Request::SetLang { lang: Lang::En },
            Request::TestProfiles,
        ];
        for r in reqs {
            let s = serde_json::to_string(&r).unwrap();
            assert_eq!(r, serde_json::from_str(&s).unwrap(), "запрос {s}");
        }

        let resps = [
            Response::Status(Status {
                tunnel: Tunnel::Down,
                profile: Some("myvpn".into()),
                country: Some("Нидерланды, Амстердам".into()),
                apps: vec![App { path: r"C:\app.exe".into(), name: "app".into(), enabled: true }],
                profiles: vec!["myvpn".into()],
                probes: vec![Probe {
                    name: "myvpn".into(),
                    latency_ms: Some(42),
                    country: Some("Нидерланды, Амстердам".into()),
                    error: None,
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
