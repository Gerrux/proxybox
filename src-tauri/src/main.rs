#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Тонкий клиент службы: пробрасывает contract-запросы из фронтенда в core-ipc.
//! Своей логики и своего состояния у оболочки нет: всё, что она показывает, —
//! ответ службы. Решает она сама ровно одно — судьбу окна: закрытое окно
//! прячется в трей, потому что служба держит туннель и правила и без окна, а
//! значок в трее — единственное, что об этом говорит.

use core_ipc::{call, Request, Response};
use std::collections::HashSet;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// `async` здесь не про параллелизм, а про то, чтобы окно оставалось живым:
/// синхронную команду Tauri выполняет прямо в цикле событий главного потока, а
/// `call` — блокирующий ввод-вывод. Служба отвечает, только закончив работу
/// (`on` перезапускает sing-box, `test-profiles` идёт секундами), и всё это
/// время главный поток не разбирал бы очередь сообщений окна: ни свернуть, ни
/// закрыть, ни сдвинуть — Windows рисует «не отвечает». Со службой, которой
/// нет, то же самое мельче: каждый опрос статуса упирается в перебор канала
/// (`PIPE_TRIES` × `PIPE_PAUSE`) и отказ сокета.
///
/// `command(async)` уводит вызов в задачу рантайма Tauri; блокировка остаётся,
/// но уже не на потоке окна. Служба принимает соединения по потоку на каждое,
/// так что опрос статуса больше не стоит в очереди за долгой командой.
#[tauri::command(async)]
fn ipc(req: Request) -> Result<Response, String> {
    // Единственное, что оболочка добавляет от себя: своё окружение. Фронтенду
    // его взять неоткуда — он в вебвью, — а служба под LocalSystem видит
    // System32 и системный PATH.
    let req = match req {
        Request::Discover { .. } => Request::Discover { env: core_ipc::whoami() },
        req => req,
    };
    call(&req).map_err(|e| match e.kind() {
        // Ни канала, ни сокета — служба не запущена. Код ошибки об этом не
        // говорит, а человеку нужно ровно одно действие.
        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound => core_ipc::t(
            &format!("служба не запущена ({e}): запустите Privacy Gateway"),
            &format!("the service is not running ({e}): start Privacy Gateway"),
        ),
        _ => core_ipc::t(&format!("служба недоступна: {e}"), &format!("service unavailable: {e}")),
    })
}

/// Открыть ссылку в браузере пользователя. Нужна ровно одному месту — кнопке
/// «Скачать» у релиза: установщик качает и запускает человек, окно только
/// доводит до него.
///
/// Плагин `opener` ради этого не берём: `rundll32 url.dll,FileProtocolHandler`
/// не разбирает аргументы через оболочку, так что вставлять в ссылку нечего.
/// Ограничение на github.com — граница, а не паранойя: других ссылок окну
/// взять неоткуда, и появиться они должны осознанно.
///
/// `async` — по тому же правилу, что и у `ipc`: запуск процесса в цикле
/// событий главного потока окну не нужен.
#[tauri::command(async)]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err(core_ipc::t(&format!("ссылка не с github.com: {url}"), &format!("link is not from github.com: {url}")));
    }
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| core_ipc::t(&format!("не удалось открыть браузер: {e}"), &format!("could not open the browser: {e}")))
}

/// Каталог сеанса браузера: входы, куки и закладки этого профиля. Он же —
/// причина, по которой окно открывается пустым: это не общий профиль Chrome
/// человека, а отдельный, свой на каждый узел.
///
/// Имя каталога считает `core_ipc::dir_name` — та же функция, что и у службы:
/// чистка символов у обоих одинаковая, и два профиля с именами «a/b» и «a-b» не
/// делят один каталог.
fn session_dir(profile: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
        .join("privacy-gateway")
        .join("browser")
        .join(core_ipc::dir_name(profile))
}

/// Окно браузера через отдельный туннель профиля. Порт поднимает служба
/// (`Request::Browse`), а браузер запускает оболочка: служба работает в сессии
/// 0, и её окна человек бы не увидел.
///
/// Свой `--user-data-dir` обязателен: без него Chromium передаёт аргументы уже
/// запущенному экземпляру и открывает обычную вкладку мимо прокси. Он же делает
/// сеансы независимыми: у каждого профиля свои входы, и одним сайтом можно
/// пользоваться из разных стран одновременно.
///
/// `--user-agent` и язык — личность браузерного профиля, и её потолок написан у
/// `core_ipc::BrowserProfile`: строка запроса и `navigator.userAgent` меняются,
/// `Sec-CH-UA` — нет.
///
/// `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` — не украшение.
/// SOCKS5 у Chromium везёт TCP, а WebRTC собирает кандидатов по UDP с настоящих
/// интерфейсов: STUN-запрос уходит мимо прокси, и сайт видит настоящий адрес
/// человека при поднятом туннеле. Обещание «прямого доступа не даёт ни на такт»
/// без этого флага неправда.
///
/// `async` — по тому же правилу, что и у `ipc`.
#[tauri::command(async)]
fn open_browser(port: u16, profile: String, ua: String, lang: String) -> Result<(), String> {
    let browser = core_apps::browser().ok_or_else(|| {
        core_ipc::t(
            "браузер на Chromium не найден: нужен Chrome, Edge, Brave или Яндекс",
            "no Chromium browser found: install Chrome, Edge, Brave or Yandex",
        )
    })?;
    let data = session_dir(&profile);
    set_accept_language(&data, &lang);
    let mut command = std::process::Command::new(&browser.path);
    command
        .arg(format!("--proxy-server=socks5://127.0.0.1:{port}"))
        .arg(format!("--user-data-dir={}", data.display()))
        .arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
        .arg("--no-first-run");
    if !ua.is_empty() {
        command.arg(format!("--user-agent={ua}"));
    }
    // Языков в списке несколько, а интерфейсу браузера нужен один — первый.
    // Сайту он не виден, но окно на чужом языке смущает человека, а не сайт.
    if let Some(first) = lang.split(',').next().filter(|l| !l.is_empty()) {
        command.arg(format!("--lang={first}"));
    }
    let mut child = command.spawn().map_err(|e| format!("{}: {e}", browser.path))?;
    // Закрытие окна службе не видно: она видит живой sing-box, а тот переживает
    // браузер легко — и метка «браузер» врала бы, пока жив процесс. Ждёт тот,
    // кто окно и запустил.
    //
    // Ждёт ровно один поток на профиль: второе нажатие при живом окне — это «ещё
    // одна вкладка», Chromium передаёт аргументы уже запущенному экземпляру и
    // тут же выходит сам. Дождаться такого выхода значило бы погасить сеанс
    // из-под открытого окна.
    //
    // ponytail: ждём мы, а не служба, поэтому закрытое раньше браузера окно
    // Privacy Gateway оставляет сеанс жить до перезапуска службы. Потолок —
    // сирота на один сеанс: без TUN, без правил, никуда не маршрутизирует;
    // апгрейд — сообщать службе время жизни сеанса и гасить по молчанию, но
    // тогда придётся выдумывать «молчание» для окна, которое просто открыто.
    if waiting().lock().is_ok_and(|mut w| w.insert(profile.clone())) {
        std::thread::spawn(move || {
            let _ = child.wait();
            let _ = waiting().lock().map(|mut w| w.remove(&profile));
            let _ = call(&Request::BrowseStop { profile });
        });
    }
    Ok(())
}

/// `Accept-Language` Chromium берёт из настроек профиля, а не из аргументов, —
/// поэтому язык кладётся в `Preferences` каталога сеанса до запуска. Читаем и
/// правим одно поле, а не пишем файл целиком: всё остальное в нём — настройки
/// самого браузера, накопленные человеком.
///
/// ponytail: у уже открытого окна язык прежний — Chrome держит настройки в
/// памяти и при выходе перепишет файл своим. Потолок — правка применяется со
/// следующего запуска окна; апгрейд — гасить сеанс при смене языка, но это
/// значит закрыть человеку то, что он в окне делает.
fn set_accept_language(data: &std::path::Path, lang: &str) {
    if lang.is_empty() {
        return;
    }
    let file = data.join("Default").join("Preferences");
    let mut prefs: serde_json::Value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    prefs["intl"]["accept_languages"] = serde_json::Value::String(lang.to_string());
    if std::fs::create_dir_all(file.parent().unwrap_or(data)).is_err() {
        return;
    }
    let _ = std::fs::write(&file, prefs.to_string());
}

/// Профили, за окнами которых уже кто-то ждёт. Своё состояние оболочке иметь не
/// положено, и это не оно: правда о сеансах живёт в службе, здесь — только
/// список собственных потоков, чтобы их не заводилось по одному на нажатие.
fn waiting() -> &'static Mutex<HashSet<String>> {
    static WAITING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    WAITING.get_or_init(Mutex::default)
}

/// Стереть сеанс браузера: входы, куки и закладки этого профиля. Зовётся из
/// окна вместе с удалением самого профиля — узла больше нет, и хранить его
/// вход не для чего.
///
/// Делает это оболочка, а не служба: каталог лежит в `%LOCALAPPDATA%` человека,
/// а служба работает под LocalSystem и видит там системный профиль.
#[tauri::command(async)]
fn forget_browser(profile: String) -> Result<(), String> {
    match std::fs::remove_dir_all(session_dir(&profile)) {
        Ok(()) => Ok(()),
        // Сеанса просто не было: профиль в браузере ни разу не открывали.
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(core_ipc::t(
            &format!("не удалось стереть сеанс браузера: {e}"),
            &format!("could not erase the browser session: {e}"),
        )),
    }
}

/// Значок в трее живёт, пока живёт оболочка, и удался ли он — знать обязательно:
/// без значка закрытое окно нельзя прятать, иначе приложение исчезнет совсем.
static TRAY: AtomicBool = AtomicBool::new(false);

/// Показать окно с любого места: из меню значка и по клику по нему. Свёрнутое
/// окно `show()` не поднимает — нужен ещё и `unminimize()`.
fn raise(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Подпись значка: то же состояние, что и в шапке окна, теми же словами.
/// Оболочка не заводит своего состояния — она спрашивает службу и показывает
/// ответ, ровно как это делает окно; решает по-прежнему одна служба.
fn tooltip() -> String {
    let Ok(Response::Status(s)) = call(&Request::Status) else {
        return format!("Privacy Gateway — {}", core_ipc::t("служба не отвечает", "service is not responding"));
    };
    // Язык выбирают в окне, и хранит его служба: подпись значка обязана
    // говорить на нём же. Заодно на него переходят и сообщения оболочки.
    core_ipc::set_lang(s.lang);
    let state = match s.tunnel {
        core_ipc::Tunnel::Off => core_ipc::t("приватный режим выключен", "private mode is off"),
        core_ipc::Tunnel::Connecting => core_ipc::t("подключение…", "connecting…"),
        core_ipc::Tunnel::Up => core_ipc::t("защищено", "protected"),
        core_ipc::Tunnel::Down => core_ipc::t("туннеля нет — доступ закрыт", "no tunnel — access is closed"),
    };
    format!("Privacy Gateway — {state}")
}

/// Значок в трее и его меню.
///
/// Нужен он ровно из-за инварианта продукта: служба держит туннель и правила
/// брандмауэра независимо от окна, и в охвате «весь компьютер» закрытое окно
/// оставляло машину запертой вообще без единого следа в интерфейсе. Значок —
/// и есть этот след, поэтому закрытие окна его прячет, а не гасит продукт.
///
/// Выключения приватного режима в меню нет намеренно: это ровно то действие,
/// после которого выбранные приложения уходят в открытую сеть, и делать его
/// одним кликом из меню, не показав, что вообще происходит, нельзя.
///
/// ponytail: значок один на все состояния, состояние живёт только в подписке.
/// Потолок — цвет канала не виден, пока не наведёшь мышь; апгрейд — три .ico
/// (открыт/заперт/поломка) и `set_icon` в том же потоке, что и подпись.
fn tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", core_ipc::t("Открыть окно", "Open window"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", core_ipc::t("Выйти из окна", "Quit the window"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id("pg")
        .icon(app.default_window_icon().cloned().ok_or("у окна нет иконки, брать значку нечего")?)
        .tooltip("Privacy Gateway")
        .menu(&menu)
        // Левый клик открывает окно, а меню остаётся на правом: показывать меню
        // на оба — значит отобрать самый частый жест.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => raise(app),
            // Именно из окна: служба остаётся работать, туннель — поднятым.
            // Обещать здесь «выход» целиком было бы неправдой.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                raise(tray.app_handle());
            }
        })
        .build(app)?;

    // Подпись обновляется своим потоком: чаще службы всё равно не узнать, а
    // окно к этому времени может быть спрятано — спрашивать за него некому.
    let handle = app.handle().clone();
    std::thread::spawn(move || loop {
        let text = tooltip();
        if let Some(tray) = handle.tray_by_id("pg") {
            let _ = tray.set_tooltip(Some(text));
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    });
    Ok(())
}

fn main() {
    // Язык до первого ответа службы берётся из окружения — как в CLI. Дальше
    // его уточнит подпись значка: она спрашивает статус и знает выбранный.
    core_ipc::set_lang(core_ipc::lang_from_env());
    tauri::Builder::default()
        // Плагин обязан стоять первым в цепочке — таково его условие. Второй
        // запуск не заводит своего окна: он поднимает окно первого и уходит.
        // Без этого спрятанный в трей продукт открывался бы по ярлыку заново,
        // и окон становилось бы столько, сколько раз по нему нажали.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| raise(app)))
        .setup(|app| {
            match tray(app) {
                Ok(()) => TRAY.store(true, Ordering::Relaxed),
                // Не удался значок — окно остаётся единственным интерфейсом, и
                // прятать его тогда нельзя ни в коем случае.
                Err(e) => eprintln!("{}", core_ipc::t(&format!("значок в трее не создан: {e}"), &format!("tray icon not created: {e}"))),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if TRAY.load(Ordering::Relaxed) {
                    // Закрывают окно, а не продукт: служба продолжает держать
                    // туннель и правила, и значок в трее об этом говорит.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![ipc, open_url, open_browser, forget_browser])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно");
}
