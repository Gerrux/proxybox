//! Headless-клиент службы. Тот же контракт, что у GUI, — core-ipc.

// Разбор вывода утилит Windows на других платформах не вызывается, но тестами
// покрыт — на Windows dead_code остаётся включённым.
#[cfg_attr(not(windows), allow(dead_code))]
mod doctor;

use core_ipc::{call, Request, Response};

const USAGE: &str = "privacy-gateway <команда>

  status                 состояние туннеля и список приложений
  doctor                 проверка окружения: почему может не работать
  on --profile <имя>     включить приватный режим
  off                    выключить приватный режим
  list-apps              приложения под управлением
  discover               найти установленные приложения и добавить выключенными
  add-app --path <exe>   добавить приложение по пути к .exe
  enable --path <exe>    пустить приложение в туннель
  disable --path <exe>   убрать приложение из-под управления
  add-profile --link <l> импортировать share-link (vless/vmess/trojan/ss/hy2/wg)
  profiles               список профилей";

fn flag(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

fn parse(args: &[String]) -> Result<Request, String> {
    match args.first().map(String::as_str) {
        Some("status") => Ok(Request::Status),
        Some("off") => Ok(Request::Off),
        Some("list-apps") => Ok(Request::ListApps),
        Some("discover") => Ok(Request::Discover),
        Some("on") => flag(args, "--profile")
            .map(|profile| Request::On { profile })
            .ok_or_else(|| "нужен --profile <имя>".into()),
        Some("add-app") => flag(args, "--path")
            .map(|path| Request::AddApp { path })
            .ok_or_else(|| "нужен --path <путь к .exe>".into()),
        Some(cmd @ ("enable" | "disable")) => flag(args, "--path")
            .map(|path| Request::SetApp { path, enabled: cmd == "enable" })
            .ok_or_else(|| "нужен --path <путь к .exe>".into()),
        Some("add-profile") => flag(args, "--link")
            .map(|link| Request::AddProfile { link })
            .ok_or_else(|| "нужен --link <share-link>".into()),
        Some("profiles") => Ok(Request::Status),
        _ => Err(USAGE.into()),
    }
}

/// Консоль Windows живёт в кодовой странице 866/1251, и русский вывод в ней
/// превращается в мусор. Переключаем на UTF-8 — kernel32 линкуется всегда,
/// ради одного вызова тянуть крейт незачем.
#[cfg(windows)]
fn utf8_console() {
    extern "system" {
        fn SetConsoleOutputCP(code_page: u32) -> i32;
    }
    unsafe { SetConsoleOutputCP(65001) };
}

#[cfg(not(windows))]
fn utf8_console() {}

fn main() -> std::process::ExitCode {
    utf8_console();
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Единственная команда мимо службы: она нужна как раз когда служба молчит.
    if args.first().is_some_and(|a| a == "doctor") {
        return match doctor::report(&doctor::run()) {
            true => std::process::ExitCode::SUCCESS,
            false => std::process::ExitCode::FAILURE,
        };
    }
    let req = match parse(&args) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    match call(&req) {
        Err(e) => {
            eprintln!("служба недоступна ({e}): запустите pg-service");
            std::process::ExitCode::FAILURE
        }
        Ok(Response::Error { message }) => {
            eprintln!("{message}");
            std::process::ExitCode::FAILURE
        }
        // Иконок CLI не спрашивает — печатать в терминал нечего.
        Ok(Response::Done | Response::Icon(_)) => std::process::ExitCode::SUCCESS,
        Ok(Response::Apps(apps)) => {
            for a in apps {
                println!("[{}] {} — {}", if a.enabled { "x" } else { " " }, a.name, a.path);
            }
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Status(s)) if args[0] == "profiles" => {
            for p in &s.profiles {
                println!("{}{p}", if s.profile.as_deref() == Some(p) { "* " } else { "  " });
            }
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Status(s)) => {
            println!("туннель:    {}", match s.tunnel {
                core_ipc::Tunnel::Off => "выключен".to_string(),
                core_ipc::Tunnel::Connecting => "подключение".to_string(),
                core_ipc::Tunnel::Up => format!("поднят, {} мс", s.latency_ms.unwrap_or(0)),
                core_ipc::Tunnel::Down => "недоступен — выбранные приложения без сети".to_string(),
            });
            println!("профиль:    {}", s.profile.unwrap_or_else(|| "—".into()));
            println!("трафик:     ↓{} ↑{} байт", s.rx, s.tx);
            println!("приложения: {} (в туннеле {})", s.apps.len(), s.apps.iter().filter(|a| a.enabled).count());
            if let Some(last) = s.log.first() {
                println!("последнее:  {last}");
            }
            std::process::ExitCode::SUCCESS
        }
    }
}
