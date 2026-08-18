#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Тонкий клиент службы: пробрасывает contract-запросы из фронтенда в core-ipc.
//! Своей логики и своего состояния у оболочки нет.

use core_ipc::{call, Request, Response};

#[tauri::command]
fn ipc(req: Request) -> Result<Response, String> {
    call(&req).map_err(|e| format!("служба недоступна: {e}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно");
}
