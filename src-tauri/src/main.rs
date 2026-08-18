#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Тонкий клиент службы: пробрасывает contract-запросы из фронтенда в core-ipc.
//! Своей логики и своего состояния у оболочки нет.

use core_ipc::{call, Request, Response};

#[tauri::command]
fn ipc(req: Request) -> Result<Response, String> {
    // Единственное, что оболочка добавляет от себя: своё окружение. Фронтенду
    // его взять неоткуда — он в вебвью, — а служба под LocalSystem видит
    // System32 и системный PATH.
    let req = match req {
        Request::Discover { .. } => {
            let (home, path) = core_ipc::whoami();
            Request::Discover { home, path }
        }
        req => req,
    };
    call(&req).map_err(|e| format!("служба недоступна: {e}"))
}

/// Открыть ссылку в браузере пользователя. Нужна ровно одному месту — кнопке
/// «Скачать» у релиза: установщик качает и запускает человек, окно только
/// доводит до него.
///
/// Плагин `opener` ради этого не берём: `rundll32 url.dll,FileProtocolHandler`
/// не разбирает аргументы через оболочку, так что вставлять в ссылку нечего.
/// Ограничение на github.com — граница, а не паранойя: других ссылок окну
/// взять неоткуда, и появиться они должны осознанно.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err(format!("ссылка не с github.com: {url}"));
    }
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("не удалось открыть браузер: {e}"))
}

/// Окно браузера через отдельный туннель профиля. Порт поднимает служба
/// (`Request::Browse`), а браузер запускает оболочка: служба работает в сессии
/// 0, и её окна человек бы не увидел.
///
/// Свой `--user-data-dir` обязателен: без него Chromium передаёт аргументы уже
/// запущенному экземпляру и открывает обычную вкладку мимо прокси.
#[tauri::command]
fn open_browser(port: u16, profile: String) -> Result<(), String> {
    let browser = core_apps::browser().ok_or_else(|| {
        core_ipc::t(
            "браузер на Chromium не найден: нужен Chrome, Edge, Brave или Яндекс",
            "no Chromium browser found: install Chrome, Edge, Brave or Yandex",
        )
    })?;
    // Имя профиля пишет человек, а каталог из него делаем мы: в имени законны и
    // слэш, и двоеточие.
    let safe: String = profile.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    let data = std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
        .join("privacy-gateway")
        .join("browser")
        .join(&safe);
    std::process::Command::new(&browser.path)
        .arg(format!("--proxy-server=socks5://127.0.0.1:{port}"))
        .arg(format!("--user-data-dir={}", data.display()))
        .arg("--no-first-run")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", browser.path))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc, open_url, open_browser])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно");
}
