//! Контракт службы ↔ клиенты (GUI, CLI).
//!
//! Транспорт — построчный JSON поверх TCP на 127.0.0.1: одна строка запроса,
//! одна строка ответа. Локальный управляющий сокет, трафика тут нет.
//! ponytail: TCP на loopback вместо named pipe — кроссплатформенно для разработки
//! на не-Windows. Перейти на named pipe, когда служба начнёт требовать ACL.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpStream;

pub const ADDR: &str = "127.0.0.1:48291";
/// Имя службы в SCM. Живёт в контракте, потому что нужно и службе (регистрация),
/// и клиенту (`doctor` смотрит, работает ли она).
pub const SERVICE_NAME: &str = "PrivacyGateway";

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
    SetApp { path: String, enabled: bool },
    /// Импорт профиля из share-link (vless://, vmess://, trojan://, ss://, hy2://, wg://).
    AddProfile { link: String },
    RemoveProfile { name: String },
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
    pub rx: u64,
    pub tx: u64,
    pub apps: Vec<App>,
    pub profiles: Vec<String>,
    /// Последние события службы, новое сверху. Не переживает перезапуск.
    #[serde(default)]
    pub log: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "kebab-case")]
pub enum Response {
    Status(Status),
    Apps(Vec<App>),
    Done,
    Error { message: String },
}

/// Один запрос — один ответ. Используется и CLI, и Tauri-оболочкой.
pub fn call(req: &Request) -> io::Result<Response> {
    let stream = TcpStream::connect(ADDR)?;
    let line = serde_json::to_string(req).map_err(io::Error::other)?;
    writeln!(&stream, "{line}")?;
    let mut reply = String::new();
    BufReader::new(&stream).read_line(&mut reply)?;
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
            Request::Discover,
            Request::AddProfile { link: "vless://u@a.com:443".into() },
            Request::RemoveProfile { name: "myvpn".into() },
        ];
        for r in reqs {
            let s = serde_json::to_string(&r).unwrap();
            assert_eq!(r, serde_json::from_str(&s).unwrap(), "запрос {s}");
        }

        let resps = [
            Response::Status(Status {
                tunnel: Tunnel::Down,
                profile: Some("myvpn".into()),
                apps: vec![App { path: r"C:\app.exe".into(), name: "app".into(), enabled: true }],
                profiles: vec!["myvpn".into()],
                ..Default::default()
            }),
            Response::Apps(vec![]),
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
    fn single_line() {
        let s = serde_json::to_string(&Response::Error { message: "a\nb".into() }).unwrap();
        assert!(!s.contains('\n'), "{s}");
    }
}
