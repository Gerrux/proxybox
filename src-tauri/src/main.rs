#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Тонкий клиент службы: пробрасывает contract-запросы из фронтенда в core-ipc.
//! Своей логики и своего состояния у оболочки нет: всё, что она показывает, —
//! ответ службы. Решает она сама ровно одно — судьбу окна: закрытое окно
//! прячется в трей, потому что служба держит туннель и правила и без окна, а
//! значок в трее — единственное, что об этом говорит.
//!
//! Окон два. `main` — обычное, со списками и настройками. `tray` — плашка,
//! которую открывает левый клик по значку: тот же фронтенд в 380 px, где
//! раскладка и так сжимается в одну колонку (`index.css`), без рамки, поверх
//! всех и гаснущая при потере фокуса. Второе окно, а не переезд первого:
//! таскать окно человека к трею и обратно, меняя ему размер и положение, —
//! значит потерять и то и другое.

use core_ipc::{call, t, tf, Request, Response, Status};
use std::collections::HashSet;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, Rect, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

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
/// Последний статус, проехавший через мост окна, и когда он приехал.
///
/// Значок спрашивает службу своим потоком, потому что с закрытым окном спросить
/// за него некому. Но пока окно открыто, тот же статус едет мимо и так —
/// каждые две секунды, — и свой опрос значка становится вторым запросом об
/// одном и том же, а с открытой плашкой третьим. Служба на каждый заводит
/// поток и берёт свой замок, и стоит это ровно ничего полезного.
///
/// Условие тут не «окно видно», а «статус свежий»: окно, спрятанное в трей,
/// перестаёт спрашивать само, отметка стареет, и значок возвращается к
/// собственному опросу — без единой проверки видимости.
static SEEN: Mutex<Option<(Instant, Status)>> = Mutex::new(None);

/// Статус, если он моложе круга значка. Дальше — как будто кэша нет: значок
/// спросит службу сам.
fn seen(fresher_than: Duration) -> Option<Status> {
    let seen = SEEN.lock().ok()?;
    let (at, status) = seen.as_ref()?;
    (at.elapsed() < fresher_than).then(|| status.clone())
}

#[tauri::command(async)]
fn ipc(req: Request) -> Result<Response, String> {
    // Единственное, что оболочка добавляет от себя: своё окружение. Фронтенду
    // его взять неоткуда — он в вебвью, — а служба под LocalSystem видит
    // System32 и системный PATH.
    let req = match req {
        Request::Discover { .. } => Request::Discover { env: core_ipc::whoami() },
        req => req,
    };
    let out = call(&req);
    if let Ok(Response::Status(s)) = &out {
        if let Ok(mut seen) = SEEN.lock() {
            *seen = Some((Instant::now(), s.clone()));
        }
    }
    out.map_err(|e| match e.kind() {
        // Ни канала, ни сокета — служба не запущена. Код ошибки об этом не
        // говорит, а человеку нужно ровно одно действие.
        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound => tf!("служба не запущена ({}): запустите proxybox", e),
        _ => tf!("служба недоступна: {}", e),
    })
}

/// Системное меню окна — то, что у окна с рамкой даёт правый клик по титульной
/// полосе и Alt+Space. У безрамочного полоса лежит в клиентской области, и меню
/// туда не приносит никто: жест перестаёт работать, а окно, которое нельзя
/// подвинуть с клавиатуры, для человека без мыши заперто там, где оказалось.
///
/// Рисует его Windows (`core_apps::system_menu`) — здесь только хэндл окна и
/// поток. Поток обязателен: меню живёт в очереди сообщений того потока,
/// которому окно принадлежит, а `command(async)` уводит вызов в задачу
/// рантайма — оттуда `TrackPopupMenu` просто ничего не покажет.
/// `run_on_main_thread` возвращает вызов туда, где окно, и очередь при этом
/// продолжает разбираться: меню её и крутит.
#[tauri::command(async)]
fn system_menu(window: tauri::Window, at_cursor: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let at = hwnd.0 as isize;
        let _ = window.run_on_main_thread(move || core_apps::system_menu(at, at_cursor));
    }
    #[cfg(not(windows))]
    let _ = (window, at_cursor);
}

/// Процесс из окна запускается только так. Без `CREATE_NO_WINDOW` Windows
/// заводит консольной программе собственное окно: `reg`, которым панель
/// настроек читает автозапуск, мелькает чёрным прямоугольником поверх всего на
/// каждое открытие. Флаг безвреден для программ с собственным окном (браузер),
/// поэтому исключений нет: единственный запуск процесса в оболочке живёт здесь,
/// и за этим следит `the_shell_never_calls_from_its_event_loop`.
fn quiet(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    // 0x0800_0000 — CREATE_NO_WINDOW из winbase.h; зависимость ради одной
    // константы оболочке не нужна.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    command
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
        return Err(tf!("ссылка не с github.com: {}", url));
    }
    quiet("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| tf!("не удалось открыть браузер: {}", e))
}

/// Открыть каталог службы в Проводнике. Нужен ровно одному делу — понять,
/// почему отвалился туннель: лента говорит, что он отвалился, а причину пишет
/// сам sing-box в `singbox.log`, и пути к нему из окна не было вовсе. Рядом
/// там же конфиг, с которым он запущен, и `state.json`.
///
/// Путь фиксирован и от фронтенда не приходит: `open_url` рядом принимает
/// ссылку и потому сверяет её с github.com, а здесь сверять было бы нечего —
/// принять путь значило отдать окну открытие любого каталога машины.
#[tauri::command(async)]
fn open_logs() -> Result<(), String> {
    let dir = std::path::PathBuf::from(std::env::var("ProgramData").unwrap_or_default()).join("proxybox");
    quiet("explorer")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| tf!("не удалось открыть каталог: {}", e))
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
        .join("proxybox")
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
fn open_browser(port: u16, profile: String, ua: String, lang: String, color: String) -> Result<(), String> {
    let browser = core_apps::browser().ok_or_else(|| {
        t("браузер на Chromium не найден: нужен Chrome, Edge, Brave или Яндекс")
    })?;
    let data = session_dir(&profile);
    set_accept_language(&data, &lang);
    let mut command = quiet(&browser.path);
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
    let profile_for_icon = profile.clone();
    let mut child = command.spawn().map_err(|e| format!("{}: {e}", browser.path))?;
    #[cfg(windows)]
    paint_icon(child.id(), &data, &profile_for_icon, &color);
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
    // proxybox оставляет сеанс жить до перезапуска службы. Потолок —
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

/// Значок окна сеанса — тот, что видно в панели задач. Иконку самого Chromium
/// подменить нечем: она в ресурсах `chrome.exe`. Зато окну можно послать свою,
/// и делает это `core_apps::set_window_icon` — там же, где её и проверяет
/// компилятор (`src-tauri` не собирается нигде, кроме Windows).
///
/// Ждём в своём потоке: окна в момент запуска ещё нет — Chrome распаковывает
/// профиль, читает настройки и рисует окно спустя секунды, а на первом запуске
/// нового профиля и дольше. Пятнадцать секунд с шагом в четверть — это про
/// холодный старт на медленном диске, а не про красоту числа.
#[cfg(windows)]
fn paint_icon(pid: u32, data: &std::path::Path, profile: &str, color: &str) {
    // Цвет приходит из окна строкой `#rrggbb` — той же, которой оно рисует точку
    // в списке профилей. Разобрать не вышло — значка просто не будет: рисовать
    // не тот цвет хуже, чем не рисовать вовсе.
    let hex = color.strip_prefix('#').unwrap_or(color);
    let byte = |at: usize| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok();
    let (Some(r), Some(g), Some(b)) = (byte(0), byte(2), byte(4)) else {
        return;
    };
    let icon = data.join("icon.ico");
    if std::fs::create_dir_all(data).is_err() {
        return;
    }
    let bytes = core_apps::icon_bytes((r, g, b));
    if std::fs::write(&icon, &bytes).is_err() {
        return;
    }
    // Хром хранит иконку профиля отдельно и сам ставит её в
    // PKEY_AppUserModel_RelaunchIconResource (Google Profile.ico внутри
    // Default). Если перебить только окно, хром после
    // BrowserWindowPropertyManager::UpdateWindowProperties перетрёт наш
    // AUMI/icon своим — поэтому кладём тот же кружок туда, где его ищет
    // хром, до запуска. Тогда даже если наш SHGetPropertyStoreForWindow
    // проиграет гонку, хром сам поставит наш цвет.
    let chrome_icon = data.join("Default").join("Google Profile.ico");
    let _ = std::fs::create_dir_all(chrome_icon.parent().unwrap_or(data));
    let _ = std::fs::write(&chrome_icon, &bytes);
    // И не даём хрому решить что иконка устарела (kProfileIconVersion=10)
    // — иначе он пересоздаст Google Profile.ico поверх нашего.
    let prefs = data.join("Default").join("Preferences");
    let mut need_icon_version = true;
    if let Ok(raw) = std::fs::read_to_string(&prefs) {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
            let cur = v
                .get("profile")
                .and_then(|p| p.get("icon_version"))
                .and_then(|n| n.as_i64())
                .unwrap_or(0);
            if cur >= 10 {
                need_icon_version = false;
            } else if let Some(obj) = v.as_object_mut() {
                let prof = obj
                    .entry("profile")
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(p) = prof.as_object_mut() {
                    p.insert(
                        "icon_version".into(),
                        serde_json::Value::Number(10.into()),
                    );
                }
                let _ = std::fs::write(&prefs, v.to_string());
                need_icon_version = false;
            }
        }
    }
    if need_icon_version {
        let _ = std::fs::create_dir_all(prefs.parent().unwrap_or(data));
        let _ = std::fs::write(
            &prefs,
            serde_json::json!({"profile": {"icon_version": 10}}).to_string(),
        );
    }
    let profile_owned = profile.to_owned();
    std::thread::spawn(move || {
        // Chromium после создания окна шлёт свой WM_SETICON из ресурсов
        // chrome.exe и перетирает наш. Одной постановки мало — переставляем
        // несколько секунд подряд, пока окно не перестанет пересоздавать иконку.
        // Дополнительно ставим отдельный AppUserModelID чтобы Windows 11 в
        // сгруппированной панели задач не брала иконку из закреплённого ярлыка
        // Chrome, а использовала WM_SETICON (SHGetPropertyStoreForWindow).
        //
        // COM-инициализация вынесена в set_window_icon_for_profile, но без
        // неё SHGetPropertyStoreForWindow падал с CO_E_NOTINITIALIZED и
        // группировка оставалась за Chrome — тогда WM_SETICON виден только
        // в заголовке, а в панели задач остаётся стандартный значок
        // (симптом после обновлений Chrome/Win11).
        //
        // Chromium переставляет свой AUMI не только при создании окна, но и
        // позже — на OnProfileIconVersionChange, при смене темы/расширения.
        // Поэтому после первоначальной серии делаем дежурный цикл: раз в
        // секунду сверяем и, если Chrome перетёр, ставим снова. Держим
        // поток живо пока процесс жив, иначе вечный утечный цикл.
        let mut successes = 0u32;
        let mut consecutive_fails = 0u32;
        let mut burst_done = false;
        for iter in 0..300 {
            let ok = core_apps::set_window_icon_for_profile(pid, &icon, &profile_owned);
            if ok {
                successes += 1;
                consecutive_fails = 0;
            } else {
                successes = 0;
                consecutive_fails += 1;
            }
            if !burst_done && successes >= 5 {
                // Окно стабилизировалось — контрольная через секунду и
                // переход в дежурный режим (реже, но долго).
                std::thread::sleep(std::time::Duration::from_secs(1));
                let _ = core_apps::set_window_icon_for_profile(pid, &icon, &profile_owned);
                burst_done = true;
            }
            // После всплеска реже: 1 сек вместо 250 мс, чтобы не жечь
            // GDI-дескрипторы (каждый вызов грузит 2 HICON).
            let pause = if burst_done {
                std::time::Duration::from_secs(1)
            } else {
                std::time::Duration::from_millis(250)
            };
            std::thread::sleep(pause);
            // Если после обязательного всплеска (60 итераций ≈15 сек на
            // холодный старт) 15 секунд подряд окна нет — процесс закрыт,
            // дальше держать поток незачем.
            if burst_done && consecutive_fails >= 15 {
                return;
            }
            // Даже без всплеска холодный старт мог занять все 60 попыток;
            // если и после него окна нет долго — тоже выходим.
            if iter >= 75 && consecutive_fails >= 15 {
                return;
            }
            // 300 итераций ≈ 5 минут дежурства — хватает на любые
            // отложенные перерисовки Chromium (OnProfileIconVersionChange
            // и т.п.), дальше значок уже закрепился в шелле.
            if iter >= 299 {
                return;
            }
        }
    });
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
        Err(e) => Err(tf!("не удалось стереть сеанс браузера: {}", e)),
    }
}

/// Автозапуск окна вместе с Windows. Служба стартует сама — она в SCM, и
/// туннель поднимается без всякого окна; автозапуск нужен ровно значку в трее:
/// в охвате «весь компьютер» запертая машина иначе не оставляет о себе следа в
/// интерфейсе, пока человек не вспомнит про ярлык.
///
/// Ключ `HKCU\...\Run`, а не плагин и не задача планировщика: это тот же
/// приём, которым продукт уже пользуется у брандмауэра (`netsh` в
/// `core-filter`) — системная команда вместо ещё одной зависимости в дереве.
/// `HKCU`, а не `HKLM`: окно принадлежит человеку, а прав администратора у него
/// может и не быть.
///
/// Ставится с `--hidden`: автозапуск, каждое утро открывающий окно поверх
/// работы, выключат в первый же день.
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_NAME: &str = "proxybox";
/// Имя записи до переименования продукта. Оставленная в реестре, она указывает
/// на exe прошлой установки — а он никуда не делся, установщик кладёт новый в
/// каталог под новым именем. То есть после перезагрузки человеку открывалось бы
/// прошлое приложение, разговаривающее с уже удалённой службой: «служба не
/// запущена» на исправной машине.
#[cfg(windows)]
const LEGACY_RUN_NAME: &str = "Privacy Gateway";

/// Переносит автозапуск на новое имя. Именно переносит, а не стирает: тумблер
/// человек когда-то включил сам, и молча его выключить — та же потеря выбора,
/// что и потерянный `state.json`, только незаметнее. Ставим новую запись на
/// свой путь, старую убираем.
///
/// Ничего не делаем, когда старой записи нет или новая уже стоит: второе — это
/// повторный запуск, и переносить там нечего.
#[cfg(windows)]
fn migrate_autostart() {
    let has = |name: &str| {
        quiet("reg")
            .args(["query", RUN_KEY, "/v", name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if !has(LEGACY_RUN_NAME) {
        return;
    }
    if !has(RUN_NAME) {
        let _ = set_autostart(true);
    }
    let _ = quiet("reg")
        .args(["delete", RUN_KEY, "/v", LEGACY_RUN_NAME, "/f"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn migrate_autostart() {}

#[cfg(windows)]
#[tauri::command(async)]
fn autostart() -> bool {
    quiet("reg")
        .args(["query", RUN_KEY, "/v", RUN_NAME])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(windows)]
#[tauri::command(async)]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    let exe = std::env::current_exe()
        .map_err(|e| tf!("не найден свой путь: {}", e))?;
    let value = format!("\"{}\" --hidden", exe.display());
    let args: Vec<&str> = match enabled {
        true => vec!["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d", &value, "/f"],
        false => vec!["delete", RUN_KEY, "/v", RUN_NAME, "/f"],
    };
    let out = quiet("reg")
        .args(&args)
        .output()
        .map_err(|e| tf!("не удалось править реестр: {}", e))?;
    // Снятие того, чего нет, — не отказ: тумблер выключен и был выключен.
    if !out.status.success() && enabled {
        return Err(tf!("реестр не принял запись: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(enabled)
}

/// В разработке не на Windows автозапуска нет и подделывать его нечем: окно
/// показывает тумблер выключенным и не даёт его тронуть.
#[cfg(not(windows))]
#[tauri::command(async)]
fn autostart() -> bool {
    false
}

#[cfg(not(windows))]
#[tauri::command(async)]
fn set_autostart(_enabled: bool) -> Result<bool, String> {
    Err(t("автозапуск есть только в Windows"))
}

/// Значок в трее живёт, пока живёт оболочка, и удался ли он — знать обязательно:
/// без значка закрытое окно нельзя прятать, иначе приложение исчезнет совсем.
static TRAY: AtomicBool = AtomicBool::new(false);

/// Круг значка: чаще службы всё равно не узнать — надзор у неё тот же.
const TRAY_EVERY: Duration = Duration::from_secs(3);

/// Показать окно с любого места: из меню значка и по клику по нему. Свёрнутое
/// окно `show()` не поднимает — нужен ещё и `unminimize()`.
fn raise(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Выйти из окна совсем. Плагина процесса ради одной кнопки не берём, а сам
/// `app.exit` из вебвью не вызвать.
///
/// Именно из окна: служба остаётся работать, туннель — поднятым, правила — на
/// месте. Обещать здесь «выход» целиком было бы неправдой, и диалог закрытия
/// говорит об этом теми же словами.
#[tauri::command(async)]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Как выглядит состояние — в значке, в подписи и в меню. Пять положений, те
/// же, что у шапки окна; «служба не отвечает» отдельным не заводим — снаружи
/// это такая же поломка, как и всё, что требует человека.
#[derive(Clone, Copy, PartialEq)]
enum Look {
    Up,
    Wait,
    Closed,
    Off,
    Fault,
}

fn look(status: Option<&Status>) -> Look {
    match status.map(|s| s.tunnel) {
        None => Look::Fault,
        Some(core_ipc::Tunnel::Up) => Look::Up,
        Some(core_ipc::Tunnel::Connecting) => Look::Wait,
        Some(core_ipc::Tunnel::Down) => Look::Closed,
        Some(core_ipc::Tunnel::Off) => Look::Off,
    }
}

/// Сторона значка. 32 px хватает: Windows показывает его в 16 и масштабирует
/// сама, а рисунок здесь — знак, ему детализация ни к чему.
const ICON: u32 = 32;

/// Знак в поле 100×100: углы, радиус лаза и его центр. Форма взята мелкая
/// (18 / 26 / 36,62), а не та, что положена 32 px, потому что размер значка
/// здесь — не 32, а 16: столько ему отводит панель задач, а 32 мы отдаём,
/// чтобы Windows ужимала сама и не мылила. Разбор трёх форм — в
/// `docs/brand.md`, оттуда же их берёт `scripts/icons.py`. Сторож —
/// `the_mark_is_one_shape` в `core-ipc`.
const CORNER: f32 = 18.0;
const HOLE: f32 = 26.0;
const HOLE_AT: (f32, f32) = (36.0, 62.0);

/// Значок трея под состояние. Рисуется в коде, а не лежит пятью .ico рядом:
/// картинка — тот же знак, что у приложения, и держать под неё файлы, которых
/// не видно в дифе и которые невозможно поправить текстом, дороже двадцати
/// строк арифметики.
///
/// Плоский цвет, без свечения: свечение принадлежит значку операционной
/// системы и больше нигде не появляется. Цвета — из фирменного стиля, тёмный
/// ряд: панель задач чаще тёмная, и светлые значения на ней тонут.
///
/// Состояний у продукта пять, а в стиле их четыре: «заперто намеренно» там
/// нет. Красным его красить нельзя — сработавшая защита не поломка, — поэтому
/// янтарь остаётся свой, из токенов окна (`ui/app-shell/src/tokens.css`,
/// тёмный вариант). Остальные четыре взяты у стиля как есть.
///
/// Формой состояние больше не различается, и это осознанная потеря. Круг
/// раньше рубился поперёк, и это читалось без цвета; на знаке тот же разрез
/// сливается с лазом — в 16 px выходит не «перерубленный канал», а клякса,
/// которую уже не опознать как марку. Проверено рисованием. Словами состояние
/// говорят подсказка значка и плашка, цветом — сам значок.
fn tray_icon(look: Look) -> Image<'static> {
    let (r, g, b) = match look {
        Look::Up => (0x2F, 0xBE, 0x6C),     // поток
        Look::Wait => (0xFF, 0x9A, 0x2E),   // подключение
        Look::Closed => (0xEB, 0xBD, 0x57), // заперто намеренно — токен окна
        Look::Fault => (0xF4, 0x56, 0x4A),  // сбой
        Look::Off => (0x8A, 0x93, 0xA6),    // выключено
    };
    let mut rgba = vec![0u8; (ICON * ICON * 4) as usize];
    for y in 0..ICON {
        for x in 0..ICON {
            // Шестнадцать проб на пиксель вместо сглаживания: у знака есть и
            // скруглённые углы, и кромка лаза, и в 32 px четырёх градаций
            // прозрачности им мало — перемычка между лазом и краем выходит
            // рваной. Полноценный растеризатор сюда тащить незачем.
            let mut hits = 0u32;
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = (x as f32 + (sx as f32 + 0.5) / 4.0) * 100.0 / ICON as f32;
                    let py = (y as f32 + (sy as f32 + 0.5) / 4.0) * 100.0 / ICON as f32;
                    if inside(px, py) {
                        hits += 1;
                    }
                }
            }
            let i = ((y * ICON + x) * 4) as usize;
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
            rgba[i + 3] = (hits * 255 / 16) as u8;
        }
    }
    Image::new_owned(rgba, ICON, ICON)
}

/// Точка внутри массы знака: в корпусе и не в лазу. Лаз сквозной, поэтому он
/// именно вычитается — заглушка своим цветом сделала бы из марки запрещённый
/// вариант с белым кружком.
fn inside(x: f32, y: f32) -> bool {
    let dx = (x - 50.0).abs() - (50.0 - CORNER);
    let dy = (y - 50.0).abs() - (50.0 - CORNER);
    // Скругление считается только в углу — там, где точка вышла за прямые
    // кромки сразу по обеим осям; во всех остальных местах корпус прямой.
    let corpus = dx <= 0.0 || dy <= 0.0 || (dx * dx + dy * dy).sqrt() <= CORNER;
    let hx = x - HOLE_AT.0;
    let hy = y - HOLE_AT.1;
    corpus && (hx * hx + hy * hy).sqrt() > HOLE
}

/// Состояние словами: заголовок и строка под ним. Те же слова, что и в шапке
/// окна, — оболочка не выдумывает своих, она показывает ответ службы.
fn words(status: Option<&Status>) -> (String, String) {
    let Some(s) = status else {
        return (
            t("Служба не отвечает"),
            t("запустите proxybox"),
        );
    };
    let title = match s.tunnel {
        core_ipc::Tunnel::Off => t("Приватный режим выключен"),
        core_ipc::Tunnel::Connecting => t("Подключение…"),
        core_ipc::Tunnel::Up => t("Защищено"),
        core_ipc::Tunnel::Down => {
            t("Туннеля нет — доступ закрыт")
        }
    };
    // Профиль, страна и задержка — то, ради чего в меню и заглядывают: «через
    // что я сейчас хожу и не тормозит ли». Их же показывает шапка окна.
    let mut detail: Vec<String> = Vec::new();
    if let Some(p) = &s.profile {
        detail.push(p.clone());
    }
    if let (core_ipc::Tunnel::Up, Some(c)) = (s.tunnel, &s.country) {
        detail.push(c.clone());
    }
    if let (core_ipc::Tunnel::Up, Some(ms)) = (s.tunnel, s.latency_ms) {
        detail.push(format!("{ms} ms"));
    }
    if detail.is_empty() {
        detail.push(t("узел не выбран"));
    }
    // Охват называем всегда: «весь компьютер» меняет не состояние, а того, о
    // ком оно, и молчать об этом в трее нельзя — окна может не быть вовсе.
    match s.scope {
        core_ipc::Scope::All => detail.push(t("весь компьютер")),
        core_ipc::Scope::Whitelist => {
            detail.push(t("остальным сеть закрыта"))
        }
        // Диагностический охват: замок стоит, а пропусков нет ни у кого. В окне
        // его не выбрать вовсе, но приехать в статус он может — ставят его из
        // консоли, и молчать о нём в трее нельзя: это машина без сети, и
        // объяснение у неё ровно одно.
        core_ipc::Scope::None => detail.push(t("в туннель не идёт никто")),
    }
    (title, detail.join(" · "))
}

/// Меню значка. Собирается заново, только когда изменилось то, что в нём
/// написано: перестроенное под открытой рукой меню закрывается само.
///
/// Выключение приватного режима здесь есть, и это осознанно: это самое частое
/// действие продукта, а прятать его в окно, которое ещё надо открыть, значит
/// сделать трей витриной. Цена — один клик до открытой сети, поэтому цену и
/// написали прямо в пункте: он говорит, что случится, а не «выключить».
fn build_menu(app: &tauri::AppHandle, status: Option<&Status>) -> tauri::Result<Menu<tauri::Wry>> {
    let (title, detail) = words(status);
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "state", title, false, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "detail", detail, false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    if let Some(s) = status {
        if !s.profiles.is_empty() {
            let items: Vec<CheckMenuItem<tauri::Wry>> = s
                .profiles
                .iter()
                .map(|p| {
                    let name = &p.name;
                    CheckMenuItem::with_id(
                        app,
                        format!("profile:{name}"),
                        name,
                        true,
                        Some(name) == s.profile.as_ref(),
                        None::<&str>,
                    )
                })
                .collect::<tauri::Result<_>>()?;
            let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
                items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
            menu.append(&Submenu::with_items(app, t("Профиль"), true, &refs)?)?;
        }
        let on = s.tunnel != core_ipc::Tunnel::Off;
        let label = match (on, s.scope) {
            (true, core_ipc::Scope::All) => t("Выключить — компьютер пойдёт в сеть напрямую"),
            // В белом списке выключение не только выпускает выбранных мимо
            // туннеля, но и открывает сеть всем остальным. Пункт обязан
            // говорить, что случится, — иначе цена клика тут вдвое больше
            // написанного.
            // Охват «ничего» тут неотличим от белого списка, и это не
            // экономия на строке: замок в нём стоит ровно так же, значит и
            // выключение открывает сеть ровно всем.
            (true, core_ipc::Scope::Whitelist | core_ipc::Scope::None) => t("Выключить — сеть откроется всем"),
            (false, _) => t("Включить приватный режим"),
        };
        // Без профилей включать нечего, и гаснущий пункт говорит об этом лучше,
        // чем отказ после нажатия.
        menu.append(&MenuItem::with_id(
            app,
            "toggle",
            label,
            on || !s.profiles.is_empty(),
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    menu.append(&MenuItem::with_id(app, "open", t("Открыть окно"), true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "settings", t("Настройки"), true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        t("Выйти из окна"),
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Отпечаток того, что видно снаружи. Значок и меню трогаем, только когда он
/// изменился: перестроенное меню закрывается под рукой, а `set_icon` каждые три
/// секунды — это мигание в панели задач на ровном месте.
fn signature(status: Option<&Status>) -> String {
    match status {
        None => "down".into(),
        Some(s) => format!(
            "{:?}|{}|{}|{}|{:?}|{}|{}",
            s.tunnel,
            s.profile.clone().unwrap_or_default(),
            s.country.clone().unwrap_or_default(),
            s.latency_ms.unwrap_or(0),
            s.lang,
            format!("{:?}", s.scope),
            // Имена, а не узлы целиком: отпечаток нужен, чтобы заметить смену
            // списка в меню, а меню показывает имена.
            s.profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(",")
        ),
    }
}

/// Видно ли окно. Спрятанное в трей и свёрнутое одинаково не видно, а
/// уведомление нужно ровно тому, кто на окно сейчас не смотрит: на открытом
/// окне то же самое написано в шапке крупными буквами.
fn unseen(app: &tauri::AppHandle) -> bool {
    match app.get_webview_window("main") {
        Some(w) => !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false),
        None => true,
    }
}

/// Сказать в системное уведомление. Отказ глотаем: на Windows тост требует
/// ярлыка в меню «Пуск» (его ставит установщик) и разрешения в параметрах
/// системы — без них показать нечего, но ронять из-за этого значок незачем.
fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Команда службе из меню — всегда своим потоком. `call` блокирующий, а
/// обработчик меню крутится в цикле событий: секунда на ответ службы (а `on`
/// перезапускает sing-box) — это секунда, когда окно не разбирает очередь
/// сообщений и Windows рисует «не отвечает».
fn detached(req: Request) {
    std::thread::spawn(move || {
        let _ = call(&req);
    });
}

/// Плашка гаснет при потере фокуса — а клик по значку фокус и уводит. Без этой
/// отметки тот же клик, которым её закрывают, тут же открывал бы её заново.
static HIDDEN_AT: Mutex<Option<Instant>> = Mutex::new(None);

/// Показать плашку в углу рабочей области — там же, где всплывают панели самой
/// Windows. Положение значка на это больше не влияет: значок уезжает в
/// переполнение трея и обратно, а угол стоит на месте.
fn show_flyout(app: &tauri::AppHandle, icon: Rect) {
    let Some(w) = app.get_webview_window("tray") else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
    if HIDDEN_AT
        .lock()
        .ok()
        .and_then(|t| *t)
        .is_some_and(|t| t.elapsed() < Duration::from_millis(300))
    {
        return;
    }
    let Ok(size) = w.outer_size() else { return };
    let (ix, iy) = match icon.position {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(p) => (p.x, p.y),
    };
    // Монитор ищем по значку: их бывает несколько, и всплыть плашка должна на
    // том, где нажали. Угол считаем от рабочей области, а не от экрана: это
    // экран без панели задач, иначе плашка уехала бы под неё.
    if let Ok(Some(m)) = app.monitor_from_point(ix, iy) {
        let area = m.work_area();
        let (left, top) = (area.position.x as f64, area.position.y as f64);
        let (right, bottom) = (left + area.size.width as f64, top + area.size.height as f64);
        let gap = 8.0;
        let x = right - size.width as f64 - gap;
        // Панель задач бывает и сверху: тогда и угол верхний, иначе плашка
        // всплывала бы у противоположной кромки экрана.
        let y = if iy < (top + bottom) / 2.0 {
            top + gap
        } else {
            bottom - size.height as f64 - gap
        };
        let _ = w.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// Значок в трее и его меню.
///
/// Нужен он ровно из-за инварианта продукта: служба держит туннель и правила
/// брандмауэра независимо от окна, и в охвате «весь компьютер» закрытое окно
/// оставляло машину запертой вообще без единого следа в интерфейсе. Значок —
/// и есть этот след, поэтому закрытие окна его прячет, а не гасит продукт.
///
/// Левый клик открывает плашку, правый — меню: показывать меню на оба значило
/// бы отобрать самый частый жест.
fn tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    TrayIconBuilder::with_id("pg")
        .icon(tray_icon(Look::Fault))
        .tooltip("proxybox")
        .menu(&build_menu(&handle, None)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => raise(app),
            "settings" => {
                raise(app);
                // Какую панель показать, решает фронтенд: своего состояния у
                // оболочки нет и заводить его ради одного пункта меню незачем.
                let _ = app.emit_to("main", "open-settings", ());
            }
            "toggle" => {
                let app = app.clone();
                // Со статусом сверяемся тоже не здесь: это ещё один поход в
                // службу, а мы в цикле событий.
                std::thread::spawn(move || {
                    let Ok(Response::Status(s)) = call(&Request::Status) else { return };
                    match s.tunnel {
                        core_ipc::Tunnel::Off => {
                            match s.profile.or_else(|| s.profiles.first().map(|p| p.name.clone())) {
                                Some(profile) => {
                                    let _ = call(&Request::On { profile });
                                }
                                // Включать нечем — это разговор про профили, и
                                // он не в меню из пяти строк.
                                None => raise(&app),
                            }
                        }
                        _ => {
                            let _ = call(&Request::Off);
                        }
                    }
                });
            }
            // Имя профиля приходит из подписки и содержит что угодно, включая
            // двоеточие, — поэтому режем по первому, а не по последнему.
            id => {
                if let Some(profile) = id.strip_prefix("profile:") {
                    detached(Request::On { profile: profile.to_string() });
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                show_flyout(tray.app_handle(), rect);
            }
        })
        .build(app)?;

    // Значок, подпись и меню обновляются своим потоком: чаще службы всё равно не
    // узнать, а окно к этому времени может быть спрятано — спрашивать за него
    // некому.
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut shown = String::new();
        // Что было в прошлый круг и говорили ли мы уже о падении. Уведомление
        // рассказывает о переходе, а не о состоянии: «туннеля нет» каждые три
        // секунды — это не уведомление, а сирена.
        let mut was: Option<core_ipc::Tunnel> = None;
        let mut warned = false;
        loop {
            // Спрашиваем службу, только если окно не спросило за нас: см. `SEEN`.
            let status = seen(TRAY_EVERY).or_else(|| match call(&Request::Status) {
                Ok(Response::Status(s)) => Some(s),
                _ => None,
            });
            // Язык выбирают в окне, и хранит его служба: значок обязан говорить
            // на нём же. Заодно на него переходят и сообщения оболочки.
            if let Some(s) = &status {
                core_ipc::set_lang(s.lang);
            }
            let now = signature(status.as_ref());
            let (title, detail) = words(status.as_ref());
            // Единственный однозначный переход — «подтверждён → упал»: выбранные
            // приложения (а в охвате «весь компьютер» — вся машина) только что
            // остались без сети, и сказать об этом больше нечему: окно спрятано,
            // а значок в трее меняет цвет молча.
            //
            // Отказ старта (Connecting → Down) сюда не входит намеренно: его
            // повторяет цикл перезапуска, и это был бы тост в минуту. Смерть
            // самой службы — тоже: снаружи не отличить остановку командой, где
            // правила сняты и сеть есть, от падения, где правила остались.
            let tunnel = status.as_ref().map(|s| s.tunnel);
            match (was, tunnel) {
                (Some(core_ipc::Tunnel::Up), Some(core_ipc::Tunnel::Down)) => {
                    // Отметку ставит сказанное, а не случившееся: падение при
                    // открытом окне человек увидел сам, и «всё снова хорошо» в
                    // ответ на непрозвучавшую плохую новость — тост ни о чём.
                    if unseen(&handle) {
                        notify(&handle, &title, &detail);
                        warned = true;
                    }
                }
                // О возвращении говорим только тому, кому сказали о падении:
                // «Защищено» без предшествующей плохой новости — это просто
                // рабочий продукт, и поздравлять с ним человека не с чем.
                (Some(core_ipc::Tunnel::Down), Some(core_ipc::Tunnel::Up)) if warned => {
                    warned = false;
                    if unseen(&handle) {
                        notify(&handle, &title, &detail);
                    }
                }
                _ => {}
            }
            was = tunnel;
            if now != shown {
                shown = now;
                if let Some(tray) = handle.tray_by_id("pg") {
                    let _ = tray.set_icon(Some(tray_icon(look(status.as_ref()))));
                    let _ = tray.set_tooltip(Some(format!("proxybox — {title}\n{detail}")));
                    if let Ok(menu) = build_menu(&handle, status.as_ref()) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
            }
            std::thread::sleep(TRAY_EVERY);
        }
    });
    Ok(())
}

/// Плашка заводится сразу, но спрятанной: строить окно в момент клика — это
/// пустой прямоугольник на полсекунды, пока поднимается вебвью.
///
/// Размер — тот самый третий из макета: 380 px, где раскладка окна и так
/// сжимается в одну колонку. Без рамки, поверх всех и мимо панели задач: у
/// плашки из трея своей кнопки на панели быть не должно.
fn flyout(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("index.html".into()))
        .title("proxybox")
        .inner_size(380.0, 520.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
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
        // Уведомления — единственное, чем оболочка говорит о том, чего человек
        // не спрашивал: см. `notify`.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Переезд автозапуска на новое имя — своим потоком: три вызова
            // `reg` в цикле событий задержали бы появление окна на ровном месте,
            // а ответа от них никто не ждёт.
            std::thread::spawn(migrate_autostart);
            match tray(app) {
                Ok(()) => {
                    TRAY.store(true, Ordering::Relaxed);
                    // Плашка нужна только со значком: открывать её больше
                    // нечем, а спрятанное окно без входа — это потерянное окно.
                    if let Err(e) = flyout(app) {
                        eprintln!(
                            "{}",
                            tf!("плашка из трея не создана: {}", e)
                        );
                    }
                    // Запуск из автозапуска: окна не показываем, продукт живёт
                    // значком. Прятать можно только со значком — без него
                    // приложение стало бы невидимым и незакрываемым, ровно как
                    // при закрытии окна.
                    if std::env::args().any(|a| a == "--hidden") {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                }
                // Не удался значок — окно остаётся единственным интерфейсом, и
                // прятать его тогда нельзя ни в коем случае.
                Err(e) => eprintln!("{}", tf!("значок в трее не создан: {}", e)),
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Плашка гаснет, стоит уйти фокусу: это выпадающая панель у значка,
            // а не окно, и оставаться поверх всего ей незачем. Момент гашения
            // помним — клик по значку уводит фокус, и без отметки тот же клик
            // открывал бы её заново (см. `show_flyout`).
            tauri::WindowEvent::Focused(false) if window.label() == "tray" => {
                let _ = window.hide();
                if let Ok(mut t) = HIDDEN_AT.lock() {
                    *t = Some(Instant::now());
                }
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "tray" {
                    // У плашки нет своей кнопки закрытия, но Esc и Alt+F4 есть:
                    // закрыть её насовсем значило бы остаться без левого клика.
                    api.prevent_close();
                    let _ = window.hide();
                } else if TRAY.load(Ordering::Relaxed) {
                    // Спрашивает фронтенд, а не оболочка: свернуть в трей или
                    // закрыть совсем — это разговор с человеком, и вести его
                    // системным диалогом посреди безрамочного окна нельзя. Он же
                    // помнит ответ, если попросили не спрашивать больше.
                    api.prevent_close();
                    // Именно `emit_to`: `emit` рассылает событие всем окнам, и
                    // плашка получила бы чужой крестик — а она на него отвечает
                    // тем же вопросом про закрытие продукта.
                    let _ = window.emit_to("main", "close-requested", ());
                }
                // Значка нет — прятать некуда: окно закрывается как обычное.
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            ipc,
            system_menu,
            open_url,
            open_logs,
            open_browser,
            forget_browser,
            autostart,
            set_autostart,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно");
}
