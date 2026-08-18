//! Автообнаружение установленных приложений по стандартным путям.
//!
//! Каталог вшит в бинарник (`include_str!`): без сети, без установки, без
//! отдельного файла рядом с exe. Каталогов приложений мы не обходим — путь из
//! каталога раскрывается и проверяется одним `is_file()`. Обход `Program Files`
//! стоил бы секунды и всё равно не отличил бы главный exe от служебного.

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

pub fn discover() -> Vec<Found> {
    discover_from(&catalog())
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
}
