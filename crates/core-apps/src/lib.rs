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
pub fn discover() -> Vec<Found> {
    let mut found = discover_from(&catalog());
    found.extend(from_registry());
    let mut seen = std::collections::HashSet::new();
    found.retain(|f| seen.insert(f.path.to_lowercase()));
    found
}

pub fn discover_from(apps: &[Known]) -> Vec<Found> {
    apps.iter()
        .filter_map(|app| {
            let path = app.paths.iter().find_map(|template| {
                if template.contains(['\\', '/']) {
                    expand(template).filter(|p| Path::new(p).is_file())
                } else {
                    in_path(template)
                }
            })?;
            Some(Found { name: app.name.clone(), path })
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

/// Раскрывает `%VAR%` из окружения. Нет переменной — нет и пути: значит эта
/// ветка каталога к текущей системе не относится.
pub fn expand(template: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        out.push_str(&rest[..start]);
        out.push_str(&std::env::var(&after[..end]).ok()?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
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
    let path = expand(path.trim())?;
    is_exe(&path).then_some(path)
}

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
            let Some(path) = expand(raw.trim().trim_matches('"')) else { continue };
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
        assert_eq!(expand("%PG_TEST_ROOT%/a/b.exe").as_deref(), Some("/root/a/b.exe"));
        assert_eq!(expand("без переменных").as_deref(), Some("без переменных"));
        assert_eq!(expand("%PG_TEST_MISSING%/x"), None, "нет переменной — нет пути");
        assert_eq!(expand("%незакрытая/x"), None);
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
        let found = discover_from(&apps);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].name, "Есть");
        assert!(found[0].path.ends_with("real.exe"), "берётся первый существующий путь");
    }

    #[test]
    fn finds_tools_in_path() {
        let sh = if cfg!(windows) { "cmd.exe" } else { "sh" };
        let found = discover_from(&[Known { name: "Оболочка".into(), paths: vec![sh.into()] }]);
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
        let found = discover();
        let mut paths: Vec<String> = found.iter().map(|f| f.path.to_lowercase()).collect();
        paths.sort();
        let before = paths.len();
        paths.dedup();
        assert_eq!(before, paths.len(), "один и тот же exe попал в список дважды");
    }
}
