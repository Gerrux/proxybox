//! Автообнаружение установленных приложений и их иконки.
//!
//! Два источника, и оба отвечают сразу путём — каталогов мы не обходим. Обход
//! `Program Files` стоил бы секунды и всё равно не отличил бы главный exe от
//! служебного.
//!
//! 1. Вшитый каталог (`include_str!`) — консольные инструменты и программы,
//!    которые не регистрируются в реестре: без сети, без файла рядом с exe.
//! 2. Реестр Windows — то, что система и так знает об установленном:
//!    `Uninstall` (имя + `DisplayIcon`, почти всегда главный exe) и `App Paths`
//!    (имя exe → полный путь). Каталог покрывал три десятка программ, реестр —
//!    всё, что человек ставил сам.
//!
//! Обнаружение выполняется в службе, а служба работает под LocalSystem: её
//! `%USERPROFILE%` — это профиль SYSTEM внутри System32, `%APPDATA%` и
//! `%LOCALAPPDATA%` — его же. Раскрывать пользовательские переменные из своего
//! окружения ей бесполезно: Telegram, Spotify, Claude Code и всё прочее, что
//! ставится в домашний каталог, лежит не там. Профиль человека приходит от
//! клиента — он-то и работает от его имени; своё окружение службы отвечает
//! только за общесистемное (`%ProgramFiles%`, `%SystemRoot%`, PATH). Клиент
//! профиль не передал — остаётся старый ответ: пройти все профили из
//! `ProfileList`, потому что спросить больше не у кого.

use serde::Deserialize;
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

/// Каталог первым: имена там человеческие и выверенные, а реестр только
/// дополняет. Один и тот же exe из двух источников — одна запись.
///
/// `home` — профиль спрашивающего (см. `Request::Discover`). Без него в списке
/// на общей машине оказывались бы и чужие приложения: правила брандмауэра всё
/// равно ставятся по пути, то есть на всю машину, но предлагать человеку чужой
/// Telegram — не то же самое, что найти его собственный.
pub fn discover(home: Option<&str>) -> Vec<Found> {
    let catalog = catalog();
    // Окружение самой службы отвечает за общесистемное: %ProgramFiles%, PATH.
    let mut found = discover_from(&catalog, &[]);
    let profiles = match home {
        Some(home) => vec![home.to_string()],
        None => user_profiles(),
    };
    for profile in profiles {
        found.extend(discover_from(&catalog, &user_vars(&profile)));
    }
    found.extend(from_registry());
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
                    in_path(template)
                }
            })?;
            Some(Found { name: app.name.clone(), path })
        })
        .collect()
}

/// Пользовательские переменные каталога, раскрытые в конкретный профиль.
/// Подкаталоги AppData внутри профиля Windows не переименовывает; перенос
/// папок политикой домена мы не разбираем — там уже не про поиск exe.
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
// Список профилей читается только на Windows, но фильтр SID проверяется везде —
// иначе на Linux он числился бы мёртвым кодом.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_user_sid(sid: &str) -> bool {
    sid.starts_with("S-1-5-21-")
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

fn in_path(name: &str) -> Option<String> {
    std::env::split_paths(&std::env::var_os("PATH")?)
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
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const UNINSTALL: [(winreg::HKEY, &str); 3] = [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        // 32-битные программы на 64-битной системе живут в своей ветке.
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];
    const APP_PATHS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";

    let mut out = Vec::new();
    for (hive, branch) in UNINSTALL {
        let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(branch, KEY_READ) else { continue };
        for key in root.enum_keys().flatten() {
            let Ok(entry) = root.open_subkey_with_flags(&key, KEY_READ) else { continue };
            // Обновления и системные компоненты — не программы пользователя.
            if entry.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 {
                continue;
            }
            let (Ok(name), Ok(resource)) =
                (entry.get_value::<String, _>("DisplayName"), entry.get_value::<String, _>("DisplayIcon"))
            else {
                continue;
            };
            if let Some(path) = exe_from_icon_resource(&resource) {
                out.push(Found { name: name.trim().to_string(), path });
            }
        }
    }
    // `App Paths` — канонический ответ Windows на вопрос «где лежит этот exe».
    // Подбирает то, у чего в `Uninstall` иконкой стоит `.ico`.
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(APP_PATHS, KEY_READ) else { continue };
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

    /// Дедуп по пути: каталог и реестр находят одно и то же, в списке это одна строка.
    #[test]
    fn discover_deduplicates_by_path() {
        let found = discover(std::env::var("HOME").ok().as_deref());
        let mut paths: Vec<String> = found.iter().map(|f| f.path.to_lowercase()).collect();
        paths.sort();
        let before = paths.len();
        paths.dedup();
        assert_eq!(before, paths.len(), "один и тот же exe попал в список дважды");
    }
}
