//! Автообнаружение установленных приложений и их иконки.
//!
//! Пять источников, и порядок между ними — это порядок дедупа: один и тот же
//! exe остаётся в списке один раз, с именем того источника, что назвал его
//! первым. Поэтому сначала идут те, у кого имена человеческие.
//!
//! 1. Вшитый каталог (`include_str!`) — консольные инструменты и программы,
//!    которые не регистрируются в реестре: без сети, без файла рядом с exe.
//! 2. Ярлыки меню «Пуск» — то, что человек сам считает своими программами, и
//!    имя у ярлыка тоже человеческое («Telegram Desktop», а не `Telegram.exe`).
//! 3. Реестр Windows — то, что система и так знает об установленном:
//!    `Uninstall` (имя + `DisplayIcon`, почти всегда главный exe) и `App Paths`
//!    (имя exe → полный путь), у машины и у каждого пользователя в `HKEY_USERS`.
//! 4. Пакеты MSIX (Store, winget) — их нет ни в `Uninstall`, ни в `App Paths`,
//!    а путь вида `…\WindowsApps\Claude_1.6608.0.0_x64__pzs8sxrjxfjjc\app` несёт
//!    в себе версию и меняется при каждом обновлении, так что шаблоном каталога
//!    его тоже не поймать. Какой exe в пакете главный — знает его манифест.
//! 5. Запущенные процессы — единственный источник про машину, а не про
//!    установленное: portable-программа, распакованный архив, игра из чужой
//!    библиотеки в реестре не значатся и значиться не будут.
//!
//! Каталогов при этом обходится ровно два — меню «Пуск» и `WindowsApps`, — и
//! оба потому, что другого способа там нет. Обход `Program Files` не помог бы
//! всё равно: он не отличает главный exe от служебного.
//!
//! Обнаружение выполняется в службе, а служба работает под LocalSystem: её
//! `%USERPROFILE%` — это профиль SYSTEM внутри System32, `%APPDATA%` и
//! `%LOCALAPPDATA%` — его же. Раскрывать пользовательские переменные из своего
//! окружения ей бесполезно: Telegram, Spotify, Claude Code и всё прочее, что
//! ставится в домашний каталог, лежит не там. Окружение человека приходит от
//! клиента — он-то и работает от его имени; своё окружение службы отвечает
//! только за общесистемное (`%ProgramFiles%`, `%SystemRoot%`). Клиент ничего не
//! передал — остаётся старый ответ: пройти все профили из `ProfileList`, считая
//! их подкаталоги стандартными, потому что спросить больше не у кого.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

const CATALOG: &str = include_str!("../../../resources/apps/catalog.v1.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Known {
    pub name: String,
    /// Шаблоны путей по убыванию предпочтения: первый существующий выигрывает.
    /// Шаблон без разделителя пути (`curl.exe`) ищется в PATH.
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    apps: Vec<Known>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub name: String,
    pub path: String,
}

pub fn catalog() -> Vec<Known> {
    // Каталог свой и вшитый: битым он может стать только при сборке, и это ловит тест.
    serde_json::from_str::<Catalog>(CATALOG).expect("каталог приложений разбирается").apps
}

/// Каталог первым: имена там человеческие и выверенные, а реестр и пакеты
/// только дополняют. Один и тот же exe из разных источников — одна запись.
///
/// `env` — окружение спрашивающего (см. `Request::Discover`). Без него в списке
/// на общей машине оказывались бы и чужие приложения: правила брандмауэра всё
/// равно ставятся по пути, то есть на всю машину, но предлагать человеку чужой
/// Telegram — не то же самое, что найти его собственный.
pub fn discover(env: &BTreeMap<String, String>) -> Vec<Found> {
    let catalog = catalog();
    // Чего в присланном окружении нет, то возьмётся из окружения службы:
    // %ProgramFiles% и прочее общесистемное у них и так одно на двоих.
    let client: Vec<(&str, String)> = env.iter().map(|(name, value)| (name.as_str(), value.clone())).collect();
    let mut found = discover_from(&catalog, &client);
    found.extend(from_shortcuts(&client));
    // Клиент представился — чужие профили не наше дело.
    let profiles = if env.contains_key("USERPROFILE") { Vec::new() } else { user_profiles() };
    for profile in profiles {
        let vars = user_vars(&profile);
        found.extend(discover_from(&catalog, &vars));
        found.extend(from_shortcuts(&vars));
    }
    found.extend(from_registry());
    found.extend(from_packages());
    found.extend(from_processes());
    let mut seen = std::collections::HashSet::new();
    found.retain(|f| seen.insert(f.path.to_lowercase()));
    found
}

/// `vars` подменяет переменные окружения на время прохода: так один и тот же
/// каталог раскрывается в профиль каждого пользователя по очереди.
pub fn discover_from(apps: &[Known], vars: &[(&str, String)]) -> Vec<Found> {
        apps.iter()
        .filter_map(|app| {
            let path = app.paths.iter().find_map(|template| {
                if template.contains(['\\', '/']) {
                    expand(template, vars).filter(|p| Path::new(p).is_file())
                } else {
                    in_path(template, vars)
                }
            })?;
            Some(Found { name: app.name.clone(), path })
        })
        .collect()
}

/// Переменные каталога, собранные из одного лишь пути к профилю, — это ответ
/// для случая, когда клиент не представился. Подкаталоги AppData считаются
/// стандартными: куда их перенесла групповая политика, знает только сам
/// пользователь, и приходит это в `Discover` его окружением.
fn user_vars(profile: &str) -> Vec<(&'static str, String)> {
    vec![
        ("USERPROFILE", profile.to_string()),
        ("LOCALAPPDATA", format!(r"{profile}\AppData\Local")),
        ("APPDATA", format!(r"{profile}\AppData\Roaming")),
    ]
}

/// Профиль живого человека — это SID машины или домена (`S-1-5-21-…`). В
/// `ProfileList` рядом лежат SYSTEM (`S-1-5-18`), LOCAL SERVICE и NETWORK
/// SERVICE: именно их окружение служба и так видит, и именно оно бесполезно.
/// В `HKEY_USERS` рядом с профилем лежит ещё и его ветка классов
/// (`S-1-5-21-…_Classes`) — то же самое, только про ассоциации файлов.
// Список профилей читается только на Windows, но фильтр SID проверяется везде —
// иначе на Linux он числился бы мёртвым кодом.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_user_sid(sid: &str) -> bool {
    sid.starts_with("S-1-5-21-") && !sid.ends_with("_Classes")
}

#[cfg(not(windows))]
fn user_profiles() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn user_profiles() -> Vec<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    const PROFILE_LIST: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList";

    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(PROFILE_LIST, KEY_READ) else {
        return Vec::new();
    };
    root.enum_keys()
        .flatten()
        .filter(|sid| is_user_sid(sid))
        .filter_map(|sid| {
            let entry = root.open_subkey_with_flags(&sid, KEY_READ).ok()?;
            let raw: String = entry.get_value("ProfileImagePath").ok()?;
            // Внутри бывает %SystemDrive% — это переменная службы, не человека,
            // так что раскрывается своим же окружением.
            let path = expand(raw.trim(), &[]).map(native)?;
            // Профиль удалённого пользователя остаётся в реестре ещё долго.
            Path::new(&path).is_dir().then_some(path)
        })
        .collect()
}

/// Первый найденный браузер на Chromium — для кнопки «открыть через профиль».
/// Порядок предпочтения свой, а не каталожный. Firefox и Tor сюда не годятся:
/// `--proxy-server` понимают только Chromium-браузеры, у остальных прокси живёт
/// в настройках профиля.
///
/// Ищем в окружении того, кто спрашивает: вызывает это оболочка окна, а она и
/// работает от имени человека.
pub fn browser() -> Option<Found> {
    let found = discover_from(&catalog(), &[]);
    CHROMIUM.iter().find_map(|name| found.iter().find(|f| f.name == *name).cloned())
}

/// Имена из каталога, а не пути: пути там уже описаны, и дублировать их значило
/// бы разъехаться с ними на первом же обновлении каталога.
const CHROMIUM: [&str; 4] = ["Google Chrome", "Microsoft Edge", "Brave", "Яндекс.Браузер"];

/// Ярлыки меню «Пуск» — список того, что человек сам считает своими
/// программами: туда попадает и то, что не регистрируется в `Uninstall`, и
/// распакованное руками, если для него делали ярлык. Имя ярлыка вдобавок
/// человеческое («Telegram Desktop»), а не имя файла.
///
/// Каталогов два: общий и пользовательский, и второй раскрывается окружением
/// спрашивающего — так же, как и всё остальное пользовательское.
fn from_shortcuts(vars: &[(&str, String)]) -> Vec<Found> {
    const MENUS: [&str; 2] = [
        r"%ProgramData%\Microsoft\Windows\Start Menu\Programs",
        r"%APPDATA%\Microsoft\Windows\Start Menu\Programs",
    ];
    let system = expand("%SystemRoot%", &[]).unwrap_or_default();
    MENUS
        .iter()
        .filter_map(|menu| expand(menu, vars))
        .flat_map(|menu| shortcuts_in(Path::new(&menu), 0))
        .filter(|found| is_own_process(&found.path, &system))
        .collect()
}

/// Меню разложено по подпапкам вендоров, поэтому обход рекурсивный. Предел
/// глубины — против junction, которым Windows умеет закольцевать дерево.
fn shortcuts_in(dir: &Path, depth: usize) -> Vec<Found> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 6 {
                out.extend(shortcuts_in(&path, depth + 1));
            }
            continue;
        }
        let Some(file) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        if !file.to_lowercase().ends_with(".lnk") {
            continue;
        }
        let name = file[..file.len() - ".lnk".len()].to_string();
        // Ярлык на справку или на сайт вендора цели-exe не имеет и отсеется сам,
        // а вот «Удалить...» рядом с программой лежит почти всегда.
        if let Some(target) = std::fs::read(&path).ok().as_deref().and_then(shortcut_target) {
            // Имя файла отделяем сами: в цели ярлыка разделитель всегда
            // windows-овский, чей бы Path нас ни разбирал.
            let file = target.rsplit(['\\', '/']).next().unwrap_or_default().to_lowercase();
            if !file.starts_with("unins") {
                out.push(Found { name, path: target });
            }
        }
    }
    out
}

/// Разбор `.lnk` (MS-SHLLINK): заголовок фиксированной длины, за ним по флагам
/// идут списки, а нужный нам путь лежит в блоке `LinkInfo`. Ярлыки на
/// приложения Store сюда не попадут — у них вместо пути идентификатор пакета,
/// но пакеты мы и так перечисляем отдельно.
///
/// ponytail: читается только `LocalBasePath` в юникоде и его ASCII-вариант,
/// сетевые цели (`CommonNetworkRelativeLink`) пропускаются. Потолок — ярлык на
/// программу с сетевого диска не найдётся; апгрейд — дочитать вторую половину
/// структуры, когда такой случай появится.
fn shortcut_target(lnk: &[u8]) -> Option<String> {
    const HEADER: usize = 0x4C;
    const HAS_TARGET_LIST: u32 = 1;
    const HAS_LINK_INFO: u32 = 1 << 1;
    const HAS_LOCAL_PATH: u32 = 1;

    let u32_at = |at: usize| -> Option<u32> { Some(u32::from_le_bytes(lnk.get(at..at + 4)?.try_into().ok()?)) };
    if u32_at(0)? as usize != HEADER {
        return None;
    }
    let flags = u32_at(20)?;
    let mut at = HEADER;
    if flags & HAS_TARGET_LIST != 0 {
        at += 2 + u16::from_le_bytes(lnk.get(at..at + 2)?.try_into().ok()?) as usize;
    }
    if flags & HAS_LINK_INFO == 0 || u32_at(at + 8)? & HAS_LOCAL_PATH == 0 {
        return None;
    }
    // Юникодная половина структуры появилась позже и есть не у всех ярлыков:
    // видно это по длине заголовка блока, и от неё же зависит, где лежат строки.
    let unicode = u32_at(at + 4)? >= 0x24;
    let string_at = |offset_field: usize| -> Option<String> {
        let start = at + u32_at(offset_field)? as usize;
        let raw = lnk.get(start..)?;
        match unicode {
            true => {
                let chars: Vec<u16> =
                    raw.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).take_while(|c| *c != 0).collect();
                String::from_utf16(&chars).ok()
            }
            // Однобайтовая половина — в кодовой странице системы, и угадывать её
            // мы не станем: не ASCII — пусть находится другим источником.
            false => {
                let bytes: Vec<u8> = raw.iter().copied().take_while(|b| *b != 0).collect();
                bytes.is_ascii().then(|| String::from_utf8_lossy(&bytes).into_owned())
            }
        }
    };
    let path = string_at(at + if unicode { 28 } else { 16 })?;
    // Суффикс общего пути дописывается редко — обычно путь уже целый, — но
    // когда он есть, без него вместо файла получится каталог.
    let suffix = string_at(at + if unicode { 32 } else { 24 }).unwrap_or_default();
    Some(path + &suffix)
}

/// Что работает прямо сейчас. Единственный источник, отвечающий про машину, а
/// не про установленное: распакованный архив, программа из «Загрузок», игра из
/// библиотеки Steam на втором диске — ничего этого в реестре нет и не будет.
/// Чужие per-app-фаерволы (Portmaster, simplewall, OpenSnitch) на этом и стоят:
/// список строится из того, кто реально работает, а не из того, что кто-то
/// когда-то установил.
///
/// Идёт последним: имя тут — просто имя файла, и человеческое имя из каталога
/// или реестра выигрывает дедуп.
#[cfg(not(windows))]
fn from_processes() -> Vec<Found> {
    Vec::new()
}

#[cfg(windows)]
fn from_processes() -> Vec<Found> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // Служба видит все процессы машины, включая начинку Windows: её отсекаем
    // по каталогу. Предлагать человеку выбрать svchost — это не «полный
    // список», это ловушка: под правило попадут и службы, и обновления.
    let system = expand("%SystemRoot%", &[]).unwrap_or_default().to_lowercase();
    let mut out = Vec::new();
    for pid in pids() {
        // Ограниченный доступ хватает для имени и не требует прав на сам
        // процесс: защищённые процессы иначе отвечали бы отказом.
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { continue };
        let mut buffer = [0u16; 260 * 2];
        let mut len = buffer.len() as u32;
        // SAFETY: буфер и длина — наши, дескриптор жив до CloseHandle ниже.
        let path = unsafe {
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut len,
            );
            let _ = CloseHandle(handle);
            ok.is_ok().then(|| String::from_utf16_lossy(&buffer[..len as usize]))
        };
        let Some(path) = path else { continue };
        if !is_own_process(&path, &system) {
            continue;
        }
        let name = Path::new(&path).file_stem().unwrap_or_default().to_string_lossy().into_owned();
        out.push(Found { name, path });
    }
    out
}

/// Процесс человека, а не начинка Windows. Начинку отсекаем по каталогу:
/// предлагать выбрать svchost — это не «полный список», а ловушка, под правило
/// попали бы и службы, и обновления системы.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_own_process(path: &str, system: &str) -> bool {
    is_exe(path) && (system.is_empty() || !path.to_lowercase().starts_with(&system.to_lowercase()))
}

/// ponytail: список процессов берётся одним заходом в буфер на 4096 записей —
/// столько их не бывает даже на сервере. Потолок: хвост сверх этого не увидим;
/// апгрейд — повторять с растущим буфером, пока заполнен целиком.
#[cfg(windows)]
fn pids() -> Vec<u32> {
    use windows::Win32::System::ProcessStatus::EnumProcesses;

    let mut pids = [0u32; 4096];
    let mut filled = 0u32;
    // SAFETY: размер передаётся в байтах, ответ — сколько байт заполнено.
    let ok = unsafe { EnumProcesses(pids.as_mut_ptr(), std::mem::size_of_val(&pids) as u32, &mut filled) };
    if ok.is_err() {
        return Vec::new();
    }
    pids[..filled as usize / std::mem::size_of::<u32>()].to_vec()
}

/// Иконка приложения как PNG в data-URL — окно показывает её прямо в `<img>`.
/// Не Windows, не exe, нет ресурса — `None`, и список обходится без картинки.
pub fn icon(path: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let base64 = windows_icons::get_icon_base64_by_path(path).ok()?;
        Some(format!("data:image/png;base64,{base64}"))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Раскрывает `%VAR%`: сначала из `vars`, потом из окружения процесса. Нет
/// переменной — нет и пути: значит эта ветка каталога к текущей системе не
/// относится.
pub fn expand(template: &str, vars: &[(&str, String)]) -> Option<String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        out.push_str(&rest[..start]);
        out.push_str(&var(&after[..end], vars)?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// Разделитель приводится к родному. Реестр не обязан писать путь через `\`:
/// кроссплатформенные установщики кладут туда `C:/Program Files/...`, и это
/// такой же валидный путь для самой Windows. Но правило sing-box сравнивает
/// `process_path` строкой, а реальный процесс всегда приходит с `\` — правило
/// с чужим разделителем не совпало бы молча, и выбранное приложение ушло бы
/// мимо туннеля. Нормализуем на выходе из реестра, ближе к правилу поздно.
#[cfg(windows)]
fn native(path: String) -> String {
    path.replace('/', "\\")
}

#[cfg(not(windows))]
fn native(path: String) -> String {
    path
}

/// Имена переменных в Windows регистронезависимы, и в каталоге они написаны
/// так, как принято у людей (`%ProgramFiles(x86)%`), а не как в реестре.
fn var(name: &str, vars: &[(&str, String)]) -> Option<String> {
    vars.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var(name).ok())
}

fn in_path(name: &str, vars: &[(&str, String)]) -> Option<String> {
    // PATH из vars — пользовательский, из окружения — свой, службы.
    let path = match vars.iter().find(|(key, _)| *key == "PATH") {
        Some((_, path)) => std::ffi::OsString::from(path),
        None => std::env::var_os("PATH")?,
    };
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// `DisplayIcon` — это ресурс иконки, а не путь: `"C:\p\app.exe",0`,
/// `C:\p\app.exe,0`, иногда просто `.ico` из кэша установщика. Нас интересует
/// только тот случай, когда за иконкой стоит настоящий exe: маршрутизация
/// sing-box работает по `process_path`, у `.ico` перехватывать нечего.
// Разбор реестровых значений вызывается только на Windows, но тестами покрыт
// везде — иначе на Linux он числился бы мёртвым кодом.
#[cfg_attr(not(windows), allow(dead_code))]
fn exe_from_icon_resource(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let path = match raw.strip_prefix('"') {
        // В кавычках путь целиком, индекс иконки — уже за закрывающей.
        Some(rest) => rest.split('"').next()?,
        None => match raw.rsplit_once(',') {
            // Запятая отрезается, только если за ней действительно индекс:
            // в самом пути запятая тоже встречается.
            Some((head, index)) if index.trim().parse::<i32>().is_ok() => head,
            _ => raw,
        },
    };
    let path = expand(path.trim(), &[]).map(native)?;
    is_exe(&path).then_some(path)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_exe(path: &str) -> bool {
    path.len() > 4 && path[path.len() - 4..].eq_ignore_ascii_case(".exe") && Path::new(path).is_file()
}

#[cfg(not(windows))]
fn from_registry() -> Vec<Found> {
    Vec::new()
}

#[cfg(windows)]
fn from_registry() -> Vec<Found> {
    use winreg::enums::KEY_READ;
    use winreg::RegKey;

    // Ветки есть и у машины, и у каждого пользователя; 32-битные программы на
    // 64-битной системе живут в своей.
    const UNINSTALL: [&str; 2] = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    const APP_PATHS: [&str; 2] = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
    ];

    let mut out = Vec::new();
    for (hive, branch) in branches(&UNINSTALL) {
        let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(&branch, KEY_READ) else { continue };
        for key in root.enum_keys().flatten() {
            let Ok(entry) = root.open_subkey_with_flags(&key, KEY_READ) else { continue };
            // Обновления и системные компоненты — не программы пользователя.
            if entry.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 {
                continue;
            }
            let Ok(name) = entry.get_value::<String, _>("DisplayName") else { continue };
            let name = name.trim();
            // `DisplayIcon` — почти всегда главный exe, но пишут его не все;
            // тогда остаётся каталог установки, где exe надо ещё и опознать.
            let path = entry
                .get_value::<String, _>("DisplayIcon")
                .ok()
                .and_then(|resource| exe_from_icon_resource(&resource))
                .or_else(|| {
                    let location = entry.get_value::<String, _>("InstallLocation").ok()?;
                    main_exe(Path::new(&expand(location.trim(), &[])?), name)
                });
            if let Some(path) = path {
                out.push(Found { name: name.to_string(), path });
            }
        }
    }
    // `App Paths` — канонический ответ Windows на вопрос «где лежит этот exe».
    // Подбирает то, у чего в `Uninstall` иконкой стоит `.ico`.
    for (hive, branch) in branches(&APP_PATHS) {
        let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(&branch, KEY_READ) else { continue };
        for key in root.enum_keys().flatten() {
            let Ok(entry) = root.open_subkey_with_flags(&key, KEY_READ) else { continue };
            let Ok(raw) = entry.get_value::<String, _>("") else { continue };
            let Some(path) = expand(raw.trim().trim_matches('"'), &[]).map(native) else { continue };
            if is_exe(&path) {
                // Имени тут нет, есть только `chrome.exe` — сойдёт как запасное:
                // записи с человеческим именем пришли раньше и выиграют дедуп.
                out.push(Found { name: key.trim_end_matches(".exe").to_string(), path });
            }
        }
    }
    out
}

/// Одна и та же ветка у машины и у каждого пользователя. Собственный
/// `HKEY_CURRENT_USER` службе бесполезен ровно так же, как её `%USERPROFILE%`:
/// под LocalSystem это hive SYSTEM, и установленного «для меня» — VS Code,
/// Discord, Telegram — там нет вовсе. Настоящие ветки лежат в `HKEY_USERS`.
///
/// ponytail: видны только загруженные hive, то есть вошедших в систему. Профиль
/// вышедшего лежит файлом `NTUSER.DAT` и требует `RegLoadKey` с
/// `SeRestorePrivilege`. Потолок — программы такого пользователя не найдутся;
/// апгрейд — грузить hive руками, когда это кому-нибудь понадобится.
#[cfg(windows)]
fn branches(under: &[&str]) -> Vec<(winreg::HKEY, String)> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_READ};
    use winreg::RegKey;

    let mut out: Vec<(winreg::HKEY, String)> =
        under.iter().map(|branch| (HKEY_LOCAL_MACHINE, branch.to_string())).collect();
    let Ok(users) = RegKey::predef(HKEY_USERS).open_subkey_with_flags("", KEY_READ) else { return out };
    for sid in users.enum_keys().flatten().filter(|sid| is_user_sid(sid)) {
        out.extend(under.iter().map(|branch| (HKEY_USERS, format!(r"{sid}\{branch}"))));
    }
    out
}

/// Какой exe в каталоге установки главный — вопрос без надёжного ответа, а
/// ошибиться тут дороже, чем промолчать: в туннель попадёт не то приложение.
/// Поэтому только два бесспорных случая — имя exe совпадает с именем программы
/// или exe в каталоге ровно один. Деинсталляторы не в счёт: они есть почти
/// везде и «единственным» exe оказались бы чаще всех.
#[cfg_attr(not(windows), allow(dead_code))]
fn main_exe(dir: &Path, name: &str) -> Option<String> {
    let simplify = |s: &str| s.to_lowercase().replace([' ', '-', '_'], "");
    let mut exes: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|file| file.to_lowercase().ends_with(".exe"))
        .filter(|file| !file.to_lowercase().starts_with("unins"))
        .collect();
    let wanted = simplify(name);
    exes.sort();
    let exe = exes
        .iter()
        .find(|file| simplify(file.trim_end_matches(".exe")) == wanted)
        .or_else(|| exes.first().filter(|_| exes.len() == 1))?;
    Some(dir.join(exe).to_string_lossy().into_owned())
}

/// Пакеты MSIX лежат в одном общем каталоге, папкой на пакет, и какой exe в
/// пакете главный — знает только манифест внутри самой папки. Поэтому здесь
/// каталог всё-таки читается: на один уровень, по кнопке, и деваться некуда —
/// имя папки несёт версию (`Claude_1.6608.0.0_x64__pzs8sxrjxfjjc`), поимённо
/// такое не перечислить. Учёт пакетов ведёт ещё и реестр (`AppModel\Repository`),
/// но это та же работа через ключ, который виден одному лишь SYSTEM.
fn from_packages() -> Vec<Found> {
    let Some(root) = expand(r"%ProgramFiles%\WindowsApps", &[]) else { return Vec::new() };
    packages_in(Path::new(&root))
}

/// Сам каталог закрыт ACL: под администратором тут отказ, под службой — список.
/// Отказ и отсутствие каталога одинаково значат «пакетов не нашлось».
fn packages_in(root: &Path) -> Vec<Found> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out = Vec::new();
    for package in entries.flatten() {
        let dir = package.path();
        // Нет манифеста — нет и пакета; у фреймворков и языковых довесков он
        // есть, но приложений внутри не окажется, и они отсеются сами.
        let Ok(manifest) = std::fs::read_to_string(dir.join("AppxManifest.xml")) else { continue };
        let name = package_name(&manifest, &dir);
        out.extend(package_exes(&manifest, &dir).into_iter().map(|path| Found { name: name.clone(), path }));
    }
    out
}

/// Имя пакета Windows хранит ссылкой на ресурс (`ms-resource:AppName`), а
/// разрешать её без запущенного пакета нечем. Тогда сойдёт первое поле имени
/// папки: человек узнаёт «Claude» и в `Claude_1.6608.0.0_x64__pzs8sxrjxfjjc`.
fn package_name(manifest: &str, dir: &Path) -> String {
    manifest
        .split_once("<DisplayName>")
        .and_then(|(_, rest)| rest.split_once("</DisplayName>"))
        .map(|(name, _)| name.trim().to_string())
        .filter(|name| !name.is_empty() && !name.starts_with("ms-resource:"))
        .unwrap_or_else(|| {
            let folder = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
            folder.split('_').next().unwrap_or(&folder).to_string()
        })
}

/// Из манифеста нужен ровно один атрибут — `Executable` у `<Application>`.
///
/// ponytail: разбор подстрокой вместо XML. Потолок — манифест, где `<Application`
/// встретится внутри комментария или CDATA; апгрейд — `quick-xml`, если такой
/// однажды попадётся. Полноценный разбор ради одного атрибута не окупается.
fn package_exes(manifest: &str, dir: &Path) -> Vec<String> {
    manifest
        .split("<Application ")
        .skip(1)
        .filter_map(|app| {
            let app = app.split("</Application>").next().unwrap_or(app);
            // Приложение, которого нет в «Пуске», — служебное: хелпер обновления,
            // фоновая задача. В списке человек его всё равно не опознает.
            if app.contains(r#"AppListEntry="none""#) {
                return None;
            }
            let exe = attr(app, "Executable")?;
            let path = dir.join(exe.replace('\\', std::path::MAIN_SEPARATOR_STR)).to_string_lossy().into_owned();
            is_exe(&path).then_some(path)
        })
        .collect()
}

/// Пакет MSIX переезжает при каждом обновлении: версия стоит прямо в имени
/// папки. Выбранное приложение после обновления просто исчезло бы из обоих
/// слоёв разом — sing-box не нашёл бы его `process_path`, брандмауэр не нашёл
/// бы свой `program=`, — и оно пошло бы напрямую, никому об этом не сказав.
/// Поэтому путь переспрашивается: в имени `Claude_1.6608.0.0_x64__pzs8sxrjxfjjc`
/// неизменны первое поле и хвост после `__` (хеш издателя), по ним новая папка
/// и находится. Хвост пути внутри пакета остаётся тем же.
pub fn rebind(path: &str) -> Option<String> {
    // Файл на месте — значит и переезда не было; это же и весь расход в мирное время.
    if Path::new(path).is_file() {
        return None;
    }
    let (root, sep, rest) = split_windowsapps(path)?;
    let (old, tail) = rest.split_once(['\\', '/'])?;
    let identity = package_identity(old)?;
    std::fs::read_dir(root).ok()?.flatten().find_map(|entry| {
        let folder = entry.file_name().to_string_lossy().into_owned();
        if package_identity(&folder)? != identity {
            return None;
        }
        let candidate = format!("{root}{sep}{folder}{sep}{tail}");
        Path::new(&candidate).is_file().then_some(candidate)
    })
}

/// `to_ascii_lowercase` вместо `to_lowercase` не ради скорости: он не меняет
/// длину строки, и байтовые смещения из копии остаются годными для оригинала —
/// в пути бывает и кириллица (имя профиля).
fn split_windowsapps(path: &str) -> Option<(&str, char, &str)> {
    let lower = path.to_ascii_lowercase();
    let at = lower.find(r"\windowsapps\").or_else(|| lower.find("/windowsapps/"))?;
    let sep = path[at..].chars().next()?;
    let end = at + 1 + "windowsapps".len();
    Some((&path[..end], sep, path.get(end + 1..)?))
}

/// Имя папки пакета — `Имя_Версия_Архитектура__Хеш`; между версиями держатся
/// только края. Нет `__` — это не пакет, и переспрашивать нечего.
fn package_identity(folder: &str) -> Option<(String, String)> {
    let (name, rest) = folder.split_once('_')?;
    let (_, hash) = rest.rsplit_once("__")?;
    Some((name.to_lowercase(), hash.to_lowercase()))
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    tag.split_once(&format!("{name}=\""))?.1.split('"').next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_sane() {
        let apps = catalog();
        assert!(apps.len() > 20, "каталог подозрительно мал: {}", apps.len());
        let mut names: Vec<&str> = apps.iter().map(|a| a.name.as_str()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "в каталоге повторяются имена");
        for app in &apps {
            assert!(!app.paths.is_empty(), "у «{}» нет путей", app.name);
        }
    }

    #[test]
    fn expand_uses_environment() {
        std::env::set_var("PG_TEST_ROOT", "/root");
        assert_eq!(expand("%PG_TEST_ROOT%/a/b.exe", &[]).as_deref(), Some("/root/a/b.exe"));
        assert_eq!(expand("без переменных", &[]).as_deref(), Some("без переменных"));
        assert_eq!(expand("%PG_TEST_MISSING%/x", &[]), None, "нет переменной — нет пути");
        assert_eq!(expand("%незакрытая/x", &[]), None);
    }

    /// Окружение клиента, каким его шлёт `core_ipc::whoami()`. Свой крейт ради
    /// одного теста не подключаем — собираем те же переменные руками.
    fn core_ipc_env() -> BTreeMap<String, String> {
        ["USERPROFILE", "HOME", "PATH"]
            .iter()
            .filter_map(|name| Some((name.to_string(), std::env::var(name).ok()?)))
            .map(|(name, value)| (if name == "HOME" { "USERPROFILE".to_string() } else { name }, value))
            .collect()
    }

    /// Ради этого всё и затевалось: у службы под LocalSystem свой `%USERPROFILE%`,
    /// и он не должен побеждать профиль человека.
    #[test]
    fn profile_vars_win_over_service_environment() {
        std::env::set_var("USERPROFILE", "/системный/профиль");
        std::env::set_var("PG_TEST_ROOT", "/root");
        let vars = user_vars("/дом/петя");
        assert_eq!(expand("%USERPROFILE%/.local/bin/claude.exe", &vars).as_deref(), Some("/дом/петя/.local/bin/claude.exe"));
        // Регистр в каталоге написан по-человечески, в реестре — как попало.
        assert_eq!(expand("%userprofile%/x", &vars).as_deref(), Some("/дом/петя/x"));
        // Чего в профиле нет, то берётся из окружения службы как раньше.
        assert_eq!(expand("%PG_TEST_ROOT%/x", &vars).as_deref(), Some("/root/x"));
        assert_eq!(
            expand("%LOCALAPPDATA%|%APPDATA%", &vars).as_deref(),
            Some(r"/дом/петя\AppData\Local|/дом/петя\AppData\Roaming"),
            "AppData выводится из профиля, а не из окружения"
        );
    }

    /// В `ProfileList` вперемешку и люди, и служебные учётки — а окружение
    /// служебных и есть то бесполезное, от которого мы уходим.
    #[test]
    fn only_real_users_are_profiles() {
        assert!(is_user_sid("S-1-5-21-3623811015-3361044348-30300820-1013"));
        assert!(!is_user_sid("S-1-5-18"), "SYSTEM");
        assert!(!is_user_sid("S-1-5-19"), "LOCAL SERVICE");
        assert!(!is_user_sid("S-1-5-20"), "NETWORK SERVICE");
        assert!(!is_user_sid(".DEFAULT"));
        assert!(!is_user_sid("S-1-5-21-3623811015-3361044348-30300820-1013_Classes"), "ветка классов, не профиль");
    }

    /// Запись без `DisplayIcon` — половина установщиков MSI. Промолчать про неё
    /// дешевле, чем угадать не тот exe: угаданное попадёт в туннель как есть.
    #[test]
    fn picks_main_exe_from_install_location() {
        let dir = std::env::temp_dir().join("pg-location-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("solo")).unwrap();
        std::fs::write(dir.join("solo/tool.exe"), b"").unwrap();
        std::fs::write(dir.join("solo/unins000.exe"), b"").unwrap();
        assert!(main_exe(&dir.join("solo"), "Что-то своё").unwrap().ends_with("tool.exe"), "единственный exe");

        std::fs::create_dir_all(dir.join("many")).unwrap();
        for exe in ["Cool App.exe", "crashpad.exe", "helper.exe"] {
            std::fs::write(dir.join("many").join(exe), b"").unwrap();
        }
        assert!(main_exe(&dir.join("many"), "Cool App").unwrap().ends_with("Cool App.exe"), "имя совпало с программой");
        assert_eq!(main_exe(&dir.join("many"), "Совсем другое"), None, "гадать среди нескольких не будем");
        assert_eq!(main_exe(&dir.join("нет"), "X"), None, "каталога нет");
    }

    /// Имена браузеров — единственная связь кода с каталогом по имени: их
    /// переименование в каталоге кнопку «открыть через профиль» молча сломает.
    #[test]
    fn chromium_names_match_the_catalog() {
        let catalog = catalog();
        for name in CHROMIUM {
            assert!(catalog.iter().any(|app| app.name == name), "в каталоге нет «{name}»");
        }
    }

    /// Инструмент, прописанный только в пользовательском `PATH` (`HKCU\\Environment`):
    /// окружение службы его не видит, присланное клиентом — видит.
    #[test]
    fn user_path_finds_what_the_service_path_cannot() {
        let dir = std::env::temp_dir().join("pg-user-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pg-tool.exe"), b"").unwrap();

        let apps = [Known { name: "Инструмент".into(), paths: vec!["pg-tool.exe".into()] }];
        assert!(discover_from(&apps, &[]).is_empty(), "в PATH службы такого нет");
        let found = discover_from(&apps, &[("PATH", dir.to_string_lossy().into_owned())]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].path.ends_with("pg-tool.exe"));
    }

    /// Приложение из домашнего каталога находится, только если каталог прошли
    /// с переменными этого профиля.
    #[test]
    fn finds_app_inside_user_profile() {
        let profile = std::env::temp_dir().join("pg-profile-test");
        std::fs::create_dir_all(profile.join(".local/bin")).unwrap();
        std::fs::write(profile.join(".local/bin/claude.exe"), b"").unwrap();
        std::env::set_var("USERPROFILE", "/нет/такого/профиля");

        let apps = [Known { name: "Claude Code".into(), paths: vec!["%USERPROFILE%/.local/bin/claude.exe".into()] }];
        assert!(discover_from(&apps, &[]).is_empty(), "окружение службы этот exe не видит");
        let found = discover_from(&apps, &user_vars(&profile.to_string_lossy()));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].path.ends_with("claude.exe"));
    }

    #[test]
    fn discovers_only_existing_files() {
        let dir = std::env::temp_dir().join("pg-discover-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real.exe"), b"").unwrap();
        std::env::set_var("PG_TEST_DIR", &dir);

        let apps = vec![
            Known { name: "Есть".into(), paths: vec!["%PG_TEST_DIR%/нет.exe".into(), "%PG_TEST_DIR%/real.exe".into()] },
            Known { name: "Нет".into(), paths: vec!["%PG_TEST_DIR%/нет.exe".into()] },
            Known { name: "Без переменной".into(), paths: vec!["%PG_TEST_UNSET%/real.exe".into()] },
        ];
        let found = discover_from(&apps, &[]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].name, "Есть");
        assert!(found[0].path.ends_with("real.exe"), "берётся первый существующий путь");
    }

    #[test]
    fn finds_tools_in_path() {
        let sh = if cfg!(windows) { "cmd.exe" } else { "sh" };
        let found = discover_from(&[Known { name: "Оболочка".into(), paths: vec![sh.into()] }], &[]);
        assert_eq!(found.len(), 1, "{sh} должен находиться в PATH: {found:?}");
    }

    /// Форматы `DisplayIcon` из реестра — то, обо что спотыкается наивный разбор.
    #[test]
    fn parses_display_icon() {
        let dir = std::env::temp_dir().join("pg-icon-test");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("app.exe");
        std::fs::write(&exe, b"").unwrap();
        std::fs::write(dir.join("app.ico"), b"").unwrap();
        std::env::set_var("PG_TEST_ICON_DIR", &dir);
        let exe = exe.to_string_lossy().into_owned();
        let dir = dir.display().to_string();

        assert_eq!(exe_from_icon_resource(&exe).as_ref(), Some(&exe), "голый путь");
        assert_eq!(exe_from_icon_resource(&format!("{exe},0")).as_ref(), Some(&exe), "индекс отрезается");
        assert_eq!(exe_from_icon_resource(&format!("\"{exe}\",0")).as_ref(), Some(&exe), "кавычки и индекс");
        assert_eq!(exe_from_icon_resource(&format!("  \"{exe}\"  ")).as_ref(), Some(&exe), "пробелы по краям");
        assert_eq!(
            exe_from_icon_resource("%PG_TEST_ICON_DIR%/app.exe,0").as_ref(),
            Some(&exe),
            "переменная окружения раскрывается"
        );
        assert_eq!(exe_from_icon_resource(&format!("{dir}/app.ico")), None, "у иконки перехватывать нечего");
        assert_eq!(exe_from_icon_resource(&format!("{dir}/нет.exe")), None, "несуществующий exe");
        assert_eq!(exe_from_icon_resource(&format!("{exe},x")), None, "«,x» — часть имени, такого файла нет");
    }

    /// Ради этого источника всё и затевалось: путь пакета несёт версию, шаблоном
    /// каталога его не поймать, а в `Uninstall` пакетов нет вовсе.
    #[test]
    fn finds_msix_packages() {
        let root = std::env::temp_dir().join("pg-windowsapps-test");
        let _ = std::fs::remove_dir_all(&root);
        let claude = root.join("Claude_1.6608.0.0_x64__pzs8sxrjxfjjc");
        std::fs::create_dir_all(claude.join("app")).unwrap();
        std::fs::write(claude.join("app/Claude.exe"), b"").unwrap();
        std::fs::write(claude.join("Updater.exe"), b"").unwrap();
        std::fs::write(
            claude.join("AppxManifest.xml"),
            r#"<Package><Properties><DisplayName>ms-resource:AppName</DisplayName></Properties><Applications>
               <Application Id="App" Executable="app\Claude.exe" EntryPoint="Windows.FullTrustApplication">
                 <uap:VisualElements DisplayName="Claude" /></Application>
               <Application Id="Upd" Executable="Updater.exe">
                 <uap:VisualElements AppListEntry="none" /></Application>
               </Applications></Package>"#,
        )
        .unwrap();
        // Фреймворк: манифест есть, приложений нет — в списке ему не место.
        let vclibs = root.join("Microsoft.VCLibs.140.00_14.0.33728.0_x64__8wekyb3d8bbwe");
        std::fs::create_dir_all(&vclibs).unwrap();
        std::fs::write(vclibs.join("AppxManifest.xml"), "<Package><Properties/></Package>").unwrap();
        // Пакет с человеческим именем в манифесте — оно и должно победить папку.
        let tg = root.join("TelegramMessengerLLP.TelegramDesktop_5.1.0_x64__t4vj0pshhgkwm");
        std::fs::create_dir_all(&tg).unwrap();
        std::fs::write(tg.join("Telegram.exe"), b"").unwrap();
        std::fs::write(
            tg.join("AppxManifest.xml"),
            r#"<Package><Properties><DisplayName>Telegram Desktop</DisplayName></Properties>
               <Applications><Application Id="App" Executable="Telegram.exe"/></Applications></Package>"#,
        )
        .unwrap();

        let mut found = packages_in(&root);
        found.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(found.len(), 2, "служебное приложение и фреймворк не берутся: {found:?}");
        assert_eq!(found[0].name, "Claude", "имя-ресурс не разрешить — берётся первое поле папки");
        assert!(found[0].path.ends_with(&native("app/Claude.exe".into())), "{:?}", found[0].path);
        assert_eq!(found[1].name, "Telegram Desktop", "имя из манифеста лучше имени папки");
        assert!(packages_in(&root.join("нет")).is_empty(), "нет каталога — нет и пакетов");
    }

    /// Обновление пакета переносит exe в папку с новой версией. Выбранное
    /// приложение обязано переехать за ним: по старому пути его не увидят ни
    /// sing-box, ни брандмауэр — то есть оно молча пошло бы напрямую.
    #[test]
    fn rebinds_updated_package() {
        let sep = std::path::MAIN_SEPARATOR;
        let apps = std::env::temp_dir().join("pg-rebind-test").join("WindowsApps");
        let _ = std::fs::remove_dir_all(&apps);
        let new = apps.join("Claude_1.7.0.0_x64__pzs8sxrjxfjjc");
        std::fs::create_dir_all(new.join("app")).unwrap();
        std::fs::write(new.join("app").join("Claude.exe"), b"").unwrap();
        // Тёзка от другого издателя: имя совпало, хеш — нет, и это чужой пакет.
        let stranger = apps.join("Claude_9.9.9.9_x64__aaaaaaaaaaaaa");
        std::fs::create_dir_all(stranger.join("app")).unwrap();
        std::fs::write(stranger.join("app").join("Claude.exe"), b"").unwrap();
        let root = apps.display();

        let old = format!("{root}{sep}Claude_1.6608.0.0_x64__pzs8sxrjxfjjc{sep}app{sep}Claude.exe");
        let moved = rebind(&old).expect("папка находится по имени и хешу издателя");
        assert!(moved.contains("1.7.0.0"), "{moved}");
        assert_eq!(rebind(&moved), None, "файл на месте — переезда не было");
        assert_eq!(
            rebind(&format!("{root}{sep}Telegram_1.0_x64__zzzzzzzzzzzzz{sep}Telegram.exe")),
            None,
            "пакет удалён совсем — заменять нечем"
        );
        assert_eq!(rebind(&format!("C:{sep}Program Files{sep}app.exe")), None, "обычная программа не переезжает");
    }

    /// Служебные процессы Windows в списке приложений не нужны, а вот программа
    /// из «Загрузок» — единственное место, где она вообще может найтись.
    #[test]
    fn keeps_only_processes_worth_showing() {
        let dir = std::env::temp_dir().join("pg-process-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("game.exe"), b"").unwrap();
        let exe = dir.join("game.exe").to_string_lossy().into_owned();
        assert!(is_own_process(&exe, r"C:\Windows"));
        assert!(!is_own_process(&exe, &dir.to_string_lossy().to_uppercase()), "регистр каталога не важен");
        assert!(!is_own_process(&dir.join("нет.exe").to_string_lossy(), ""), "процесс есть, файла нет");
        assert!(!is_own_process(&dir.join("game.dll").to_string_lossy(), ""), "не exe");
    }

    /// Ярлык — бинарная структура, и путь в ней лежит по смещению, которого в
    /// заголовке нет: разобрать вслепую нельзя, а промахнуться легко.
    fn lnk(target: &str, unicode: bool) -> Vec<u8> {
        let mut out = vec![0u8; 0x4C];
        out[..4].copy_from_slice(&0x4Cu32.to_le_bytes());
        out[20..24].copy_from_slice(&2u32.to_le_bytes()); // только LinkInfo, без списка целей
        let header: u32 = if unicode { 0x24 } else { 0x1C };
        let path: Vec<u8> = match unicode {
            true => target.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect(),
            false => target.bytes().chain([0]).collect(),
        };
        let mut info = vec![0u8; header as usize];
        info[4..8].copy_from_slice(&header.to_le_bytes());
        info[8..12].copy_from_slice(&1u32.to_le_bytes()); // VolumeIDAndLocalBasePath
        let path_at = if unicode { 28 } else { 16 };
        info[path_at..path_at + 4].copy_from_slice(&header.to_le_bytes());
        let suffix_at = if unicode { 32 } else { 24 };
        info[suffix_at..suffix_at + 4].copy_from_slice(&(header + path.len() as u32).to_le_bytes());
        info.extend(path);
        info.extend(if unicode { vec![0, 0] } else { vec![0] });
        let size = info.len() as u32;
        info[..4].copy_from_slice(&size.to_le_bytes());
        out.extend(info);
        out
    }

    #[test]
    fn reads_shortcut_target() {
        let target = r"C:\Программы\Telegram.exe";
        assert_eq!(shortcut_target(&lnk(target, true)).as_deref(), Some(target), "юникодная половина");
        assert_eq!(shortcut_target(&lnk(r"C:\App\app.exe", false)).as_deref(), Some(r"C:\App\app.exe"), "старый ярлык");
        assert_eq!(shortcut_target(&lnk(target, false)), None, "кодовую страницу не угадываем");
        assert_eq!(shortcut_target("не ярлык вовсе".as_bytes()), None, "заголовок не тот");
        assert_eq!(shortcut_target(&[]), None, "пустой файл");
    }

    /// Меню «Пуск» — то, что человек сам считает своими программами, и имена
    /// там человеческие. Деинсталляторы лежат рядом с ними и в список не идут.
    #[test]
    fn walks_start_menu() {
        let menu = std::env::temp_dir().join("pg-menu-test");
        let _ = std::fs::remove_dir_all(&menu);
        std::fs::create_dir_all(menu.join("Telegram Desktop")).unwrap();
        std::fs::write(menu.join("Telegram Desktop/Telegram Desktop.lnk"), lnk(r"C:\tg\Telegram.exe", true)).unwrap();
        std::fs::write(menu.join("Telegram Desktop/Удалить Telegram.LNK"), lnk(r"C:\tg\unins000.exe", true)).unwrap();
        std::fs::write(menu.join("Readme.txt"), "не ярлык").unwrap();

        let found = shortcuts_in(&menu, 0);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].name, "Telegram Desktop", "имя берётся у ярлыка, а не у файла");
        assert_eq!(found[0].path, r"C:\tg\Telegram.exe");
    }

    /// Дедуп по пути: каталог и реестр находят одно и то же, в списке это одна строка.
    #[test]
    fn discover_deduplicates_by_path() {
        let found = discover(&core_ipc_env());
        let mut paths: Vec<String> = found.iter().map(|f| f.path.to_lowercase()).collect();
        paths.sort();
        let before = paths.len();
        paths.dedup();
        assert_eq!(before, paths.len(), "один и тот же exe попал в список дважды");
    }
}
