//! Headless-клиент службы. Тот же контракт, что у GUI, — core-ipc.

// Разбор вывода утилит Windows на других платформах не вызывается, но тестами
// покрыт — на Windows dead_code остаётся включённым.
#[cfg_attr(not(windows), allow(dead_code))]
mod doctor;

use core_ipc::{call, t, Request, Response};

const USAGE_RU: &str = "privacy-gateway <команда>

  status                 состояние туннеля и список приложений
  doctor                 проверка окружения: почему может не работать
  on --profile <имя>     включить приватный режим
  off                    выключить приватный режим
  list-apps              приложения под управлением
  discover               найти установленные приложения и добавить выключенными
  add-app --path <exe>   добавить приложение по пути к .exe
  enable --path <exe>    пустить приложение в туннель
  disable --path <exe>   убрать приложение из-под управления
  scope apps|all         охват: только выбранные приложения либо весь трафик
  add-profile --link <l> импортировать share-link (vless/vmess/trojan/ss/hy2/wg),
                         JSON-конфиг sing-box или подписку по http(s)-адресу;
                         тот же адрес повторно — обновить подписку
  profiles               список профилей
  test                   прогнать все профили: кто отвечает и за сколько
  browse --profile <имя> поднять отдельный прокси под этот профиль и напечатать
                         его адрес: браузер с --proxy-server пойдёт в него
  lang ru|en             язык сообщений службы и окна";

const USAGE_EN: &str = "privacy-gateway <command>

  status                 tunnel state and app list
  doctor                 environment check: why it may not work
  on --profile <name>    turn private mode on
  off                    turn private mode off
  list-apps              apps under control
  discover               find installed apps and add them disabled
  add-app --path <exe>   add an app by path to its .exe
  enable --path <exe>    let the app into the tunnel
  disable --path <exe>   take the app out of control
  scope apps|all         scope: selected apps only or all machine traffic
  add-profile --link <l> import a share-link (vless/vmess/trojan/ss/hy2/wg),
                         a sing-box JSON config or a subscription http(s) URL;
                         the same URL again refreshes the subscription
  profiles               list profiles
  test                   run every profile: who answers and how fast
  browse --profile <name> bring up a separate proxy for that profile and print
                         its address: a browser with --proxy-server goes there
  lang ru|en             language of service and window messages";

fn usage() -> String {
    t(USAGE_RU, USAGE_EN)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

fn parse(args: &[String]) -> Result<Request, String> {
    match args.first().map(String::as_str) {
        Some("status") => Ok(Request::Status),
        Some("off") => Ok(Request::Off),
        Some("list-apps") => Ok(Request::ListApps),
        // Своё окружение CLI знает сам: он работает от имени человека.
        Some("discover") => Ok(Request::Discover { env: core_ipc::whoami() }),
        Some("on") => flag(args, "--profile")
            .map(|profile| Request::On { profile })
            .ok_or_else(|| t("нужен --profile <имя>", "needs --profile <name>")),
        Some("add-app") => flag(args, "--path")
            .map(|path| Request::AddApp { path })
            .ok_or_else(|| t("нужен --path <путь к .exe>", "needs --path <path to .exe>")),
        Some(cmd @ ("enable" | "disable")) => flag(args, "--path")
            .map(|path| Request::SetApp { path, enabled: cmd == "enable" })
            .ok_or_else(|| t("нужен --path <путь к .exe>", "needs --path <path to .exe>")),
        Some("add-profile") => flag(args, "--link")
            .map(|link| Request::AddProfile { link })
            .ok_or_else(|| t("нужен --link <share-link>", "needs --link <share-link>")),
        Some("scope") => match args.get(1).map(String::as_str) {
            Some("all") => Ok(Request::SetAllTraffic { enabled: true }),
            Some("apps") => Ok(Request::SetAllTraffic { enabled: false }),
            _ => Err(t("нужен охват: apps или all", "pick a scope: apps or all")),
        },
        Some("profiles") => Ok(Request::Status),
        Some("test") => Ok(Request::TestProfiles),
        Some("browse") => flag(args, "--profile")
            .map(|profile| Request::Browse { profile })
            .ok_or_else(|| t("нужен --profile <имя>", "needs --profile <name>")),
        Some("lang") => match args.get(1).map(String::as_str) {
            Some("ru") => Ok(Request::SetLang { lang: core_ipc::Lang::Ru }),
            Some("en") => Ok(Request::SetLang { lang: core_ipc::Lang::En }),
            _ => Err(t("нужен язык: ru или en", "pick a language: ru or en")),
        },
        _ => Err(usage()),
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

/// Язык службы — источник истины для всего, что она прислала. Явный PG_LANG
/// сильнее: его выставил пользователь именно для этого запуска.
fn adopt(lang: core_ipc::Lang) {
    if std::env::var_os("PG_LANG").is_none() {
        core_ipc::set_lang(lang);
    }
}

fn main() -> std::process::ExitCode {
    utf8_console();
    // Язык клиента: сначала из окружения — статус придёт позже и уточнит его.
    core_ipc::set_lang(core_ipc::lang_from_env());
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
            eprintln!("{}", t(&format!("служба недоступна ({e}): запустите pg-service"), &format!("service unavailable ({e}): start pg-service")));
            std::process::ExitCode::FAILURE
        }
        Ok(Response::Error { message }) => {
            eprintln!("{message}");
            std::process::ExitCode::FAILURE
        }
        // Иконок CLI не спрашивает — печатать в терминал нечего.
        Ok(Response::Done | Response::Icon(_)) => std::process::ExitCode::SUCCESS,
        // Адрес целиком: его вставляют в --proxy-server как есть.
        Ok(Response::Proxy { port }) => {
            println!("socks5://127.0.0.1:{port}");
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Apps(apps)) => {
            for a in apps {
                println!("[{}] {} — {}", if a.enabled { "x" } else { " " }, a.name, a.path);
            }
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Status(s)) if args[0] == "test" => {
            adopt(s.lang);
            for p in &s.probes {
                let verdict = match (p.latency_ms, &p.error) {
                    (Some(ms), _) => match &p.country {
                        Some(c) => t(&format!("{ms} мс — {c}"), &format!("{ms} ms — {c}")),
                        None => t(&format!("{ms} мс"), &format!("{ms} ms")),
                    },
                    (None, Some(e)) => e.clone(),
                    (None, None) => t("не проверен", "not checked"),
                };
                println!("{:<20} {verdict}", p.name);
            }
            // Все профили мёртвые — это отказ, а не «успешно ничего не нашли».
            match s.probes.iter().any(|p| p.latency_ms.is_some()) {
                true => std::process::ExitCode::SUCCESS,
                false => std::process::ExitCode::FAILURE,
            }
        }
        Ok(Response::Status(s)) if args[0] == "profiles" => {
            adopt(s.lang);
            for p in &s.profiles {
                println!("{}{p}", if s.profile.as_deref() == Some(p) { "* " } else { "  " });
            }
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Status(s)) => {
            adopt(s.lang);
            let latency = s.latency_ms.unwrap_or(0);
            let state = match s.tunnel {
                core_ipc::Tunnel::Off => t("выключен", "off"),
                core_ipc::Tunnel::Connecting => t("подключение", "connecting"),
                core_ipc::Tunnel::Up => t(&format!("поднят, {latency} мс"), &format!("up, {latency} ms")),
                core_ipc::Tunnel::Down => t(
                    "недоступен — выбранные приложения без сети",
                    "unavailable — selected apps have no network",
                ),
            };
            let on = s.apps.iter().filter(|a| a.enabled).count();
            println!("{:<11} {state}", t("туннель:", "tunnel:"));
            println!(
                "{:<11} {}",
                t("охват:", "scope:"),
                match s.all_traffic {
                    true => t("весь трафик компьютера", "all computer traffic"),
                    false => t("выбранные приложения", "selected apps"),
                }
            );
            println!("{:<11} {}", t("профиль:", "profile:"), s.profile.unwrap_or_else(|| "—".into()));
            println!("{:<11} {}", t("страна:", "exit:"), s.country.unwrap_or_else(|| "—".into()));
            println!("{:<11} ↓{} ↑{} {}", t("трафик:", "traffic:"), s.rx, s.tx, t("байт", "bytes"));
            println!(
                "{:<11} {} ({} {})",
                t("приложения:", "apps:"),
                s.apps.len(),
                t("в туннеле", "in tunnel"),
                on
            );
            if let Some(last) = s.log.first() {
                println!("{:<11} {last}", t("последнее:", "last:"));
            }
            std::process::ExitCode::SUCCESS
        }
    }
}
