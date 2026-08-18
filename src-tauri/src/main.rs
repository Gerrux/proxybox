#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Тонкий клиент службы: пробрасывает contract-запросы из фронтенда в core-ipc.
//! Своей логики и своего состояния у оболочки нет.

use core_ipc::{call, Request, Response};

#[tauri::command]
fn ipc(req: Request) -> Result<Response, String> {
    // Единственное, что оболочка добавляет от себя: свой профиль. Фронтенду его
    // взять неоткуда — он в вебвью, — а служба под LocalSystem видит System32.
    let req = match req {
        Request::Discover { .. } => Request::Discover { home: core_ipc::home() },
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc, open_url])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно");
}
