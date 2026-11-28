//! Общие для службы и CLI параметры туннеля: адреса, поиск sing-box и
//! канонический вид исключений. Поиск нужен `doctor` даже при недоступной
//! службе, а `bypass rm` сверяет запись по тем же правилам, что и служба.

use core_ipc::{t, tf};
use std::path::PathBuf;
use std::sync::Mutex;

/// Имя нашего TUN-адаптера: по нему его видно в системе и не спутать с чужим.
pub const TUN_NAME: &str = "proxybox";
/// Наш адрес на TUN — он же источник пакетов, вышедших из туннеля, и по нему
/// брандмауэр отличает их от прямых.
///
/// 172.19.0.1/30 — умолчание sing-box, а значит и NekoBox,
/// Hiddify, v2rayN: с любым из них адрес и имя адаптера столкнулись бы лоб в
/// лоб. Берём свои, чтобы конфликт был виден как чужой туннель, а не как
/// загадочный отказ TUN.
pub const TUN_ADDR: &str = "172.27.234.1";

/// Пул фальшивых адресов FakeIP. RFC 2544 отвёл `198.18.0.0/15` под замеры
/// оборудования, и по этой же причине его берут все — Clash, sing-box, NekoBox:
/// в живой сети такого адреса не встретить.
///
/// Диапазона IPv6 у пула нет намеренно, и это не экономия. Раздай мы фальшивый
/// AAAA — приложение пошло бы в IPv6, а адреса v6 у нашего TUN нет, и такое
/// соединение умерло бы, не начавшись. Пока TUN только IPv4, ответ на AAAA
/// обязан быть пустым, и делает это отдельное правило с действием
/// `predefined` — раньше тем же занимался `strategy: ipv4_only`, но 1.14
/// отвергает эту ручку фатально.
/// Сторож — `fake_addresses_are_handed_out_locally`.
pub const FAKE_RANGE: &str = "198.18.0.0/15";

/// Путь к sing-box из настроек службы. Глобальный на процесс по той же
/// причине, что и язык в `core-ipc`: он один на всю службу, а протаскивать его
/// параметром пришлось бы через каждую функцию, которая запускает sing-box, —
/// включая проверку конфига, которой до настроек дела нет.
static CONFIGURED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Пусто — забыть про настройку и искать как раньше.
pub fn set_binary(path: &str) {
    let value = (!path.trim().is_empty()).then(|| PathBuf::from(path.trim()));
    if let Ok(mut slot) = CONFIGURED.lock() {
        *slot = value;
    }
}

/// Где искать sing-box: переменная окружения → настройка → рядом с
/// бинарником → путь пакета (Linux) → PATH.
///
/// Сортировка вынесена в чистую функцию ради теста: гонять по-настоящему
/// `/usr/lib/proxybox/sing-box` (нужен root, чтобы туда что-то положить) или
/// временно подменять `current_exe()` вышло бы дороже, чем эта проверка на
/// `Option`-ах.
fn resolve_binary(
    env: Option<PathBuf>,
    configured: Option<PathBuf>,
    near_exe: Option<PathBuf>,
    packaged: Option<PathBuf>,
    name: &str,
) -> PathBuf {
    env.or(configured).or(near_exe).or(packaged).unwrap_or_else(|| PathBuf::from(name))
}

pub fn binary() -> PathBuf {
    let name = if cfg!(windows) { "sing-box.exe" } else { "sing-box" };
    let env = std::env::var_os("PG_SINGBOX").map(PathBuf::from);
    let configured = CONFIGURED.lock().ok().and_then(|s| s.clone());
    let near_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .filter(|p| p.exists());
    // Пакет .deb кладёт sing-box не рядом с pg-service (тот путь в /usr/bin
    // занят официальным пакетом SagerNet — installer/build.sh), а отдельно в
    // /usr/lib/proxybox. Это последний путь, который binary() проверяет сам,
    // и он же избавляет юнит от Environment=PG_SINGBOX: та переменная не
    // только дублировала этот путь второй раз в другом языке, но и перебивала
    // настройку из окна на каждом старте службы, и была невидима `doctor`,
    // запущенному руками.
    #[cfg(not(windows))]
    let packaged = Some(PathBuf::from("/usr/lib/proxybox/sing-box")).filter(|p| p.exists());
    #[cfg(windows)]
    let packaged: Option<PathBuf> = None;
    resolve_binary(env, configured, near_exe, packaged, name)
}

/// Самое узкое исключение по адресу, какое принимаем, — /8. Шире это уже не
/// исключение, а выключенный туннель под надписью «Защищено»: `0.0.0.0/0` —
/// удалённый split-tunnel, только надетый на другой список.
const BYPASS_WIDEST: u8 = 8;

/// Привести строку исключения к тому виду, в каком она едет в конфиг, — или
/// объяснить человеку, почему её нет. Адрес становится сетью `a.b.c.d/n` (голый
/// адрес — `/32`, хвост маски обнуляется: `10.1.2.3/8` и `10.0.0.0/8` — одно и
/// то же исключение), имя — нижним регистром без `*.` и точки впереди: суффикс
/// и так ловит поддомены.
///
/// Отказы — ровно те случаи, где исключение сделало бы не то, что написано:
/// шире `/8` (выключенный туннель), IPv6 (у TUN адреса v6 нет, и такое
/// соединение до нас не доходит), пул FakeIP и подсеть самого TUN (под
/// исключение ушли бы все имена машины или её же шлюз). Сторож —
/// `a_bypass_entry_is_normalised_or_refused`.
pub fn bypass_entry(raw: &str) -> Result<String, String> {
    let entry = raw.trim().to_ascii_lowercase();
    if entry.is_empty() {
        return Err(t("пустое исключение"));
    }
    if entry.contains(':') {
        // IPv6 называется IPv6, только если это он: `158.160.144.110:22` —
        // ровно тот вид, в каком адрес показывает вкладка соединений, и
        // скопированный оттуда, он отказом «это IPv6» сбивал бы с толку.
        let bare = entry.split('/').next().unwrap_or(&entry).trim_matches(['[', ']']);
        if bare.parse::<std::net::Ipv6Addr>().is_ok() {
            return Err(tf!("«{}» — IPv6: у туннеля адреса v6 нет, исключать нечего", raw.trim()));
        }
        return Err(tf!("«{}» — не адрес и не имя", raw.trim()));
    }
    let looks_like_ip = entry.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '/');
    if looks_like_ip {
        let (addr, prefix) = entry.split_once('/').unwrap_or((&entry, "32"));
        let bad = || tf!("«{}» — не адрес и не сеть", raw.trim());
        let addr: std::net::Ipv4Addr = addr.parse().map_err(|_| bad())?;
        let prefix: u8 = prefix.parse().ok().filter(|p| *p <= 32).ok_or_else(bad)?;
        if prefix < BYPASS_WIDEST {
            return Err(tf!("«{}» — слишком широко: это уже не исключение, а туннель, выключенный целиком", raw.trim()));
        }
        let net = std::net::Ipv4Addr::from(u32::from(addr) & mask(prefix));
        for (reserved, len) in [("198.18.0.0", 15u8), (TUN_ADDR, 30)] {
            let reserved: std::net::Ipv4Addr = reserved.parse().expect("свой адрес");
            if overlaps((net, prefix), (reserved, len)) {
                return Err(tf!("«{}» задевает служебную сеть туннеля {}/{}", raw.trim(), std::net::Ipv4Addr::from(u32::from(reserved) & mask(len)), len));
            }
        }
        return Ok(format!("{net}/{prefix}"));
    }
    let name = entry.trim_start_matches("*.").trim_start_matches('.').trim_end_matches('.');
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    if name.is_empty() || name.len() > 253 || !name.split('.').all(label_ok) {
        return Err(tf!("«{}» — не адрес и не имя", raw.trim()));
    }
    // Имя без точки — это зона целиком (`ru`, `com`): суффикс увёл бы мимо
    // туннеля полстраны, и это та же ширина, что `/8` у адреса, только без
    // предела. Публичных имён без точки не бывает, а локальные и так идут
    // роутеру (`lan` в DNS).
    if !name.contains('.') {
        return Err(tf!("«{}» — слишком широко: это уже не исключение, а туннель, выключенный целиком", raw.trim()));
    }
    Ok(name.to_string())
}

fn mask(prefix: u8) -> u32 {
    if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) }
}

/// Пересекаются ли две сети: у префиксов одна из них всегда содержит другую.
fn overlaps((a, la): (std::net::Ipv4Addr, u8), (b, lb): (std::net::Ipv4Addr, u8)) -> bool {
    let m = mask(la.min(lb));
    u32::from(a) & m == u32::from(b) & m
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Порядок поиска sing-box сильнее к слабее: переменная окружения,
    /// настройка, место рядом с pg-service, путь пакета (заведён вместе с
    /// C1 упаковки .deb — Environment=PG_SINGBOX из юнита убран, и без этого
    /// шага служба, поднятая из свежего пакета, не находила бы sing-box
    /// вовсе), и только потом голое имя — искать его в PATH пойдёт уже ОС.
    #[test]
    fn binary_prefers_env_then_setting_then_near_exe_then_packaged_path() {
        let env = Some(PathBuf::from("/env/sing-box"));
        let setting = Some(PathBuf::from("/setting/sing-box"));
        let near_exe = Some(PathBuf::from("/near-exe/sing-box"));
        let packaged = Some(PathBuf::from("/usr/lib/proxybox/sing-box"));

        assert_eq!(
            resolve_binary(env.clone(), setting.clone(), near_exe.clone(), packaged.clone(), "sing-box"),
            PathBuf::from("/env/sing-box")
        );
        assert_eq!(
            resolve_binary(None, setting.clone(), near_exe.clone(), packaged.clone(), "sing-box"),
            PathBuf::from("/setting/sing-box")
        );
        assert_eq!(
            resolve_binary(None, None, near_exe.clone(), packaged.clone(), "sing-box"),
            PathBuf::from("/near-exe/sing-box")
        );
        assert_eq!(resolve_binary(None, None, None, packaged, "sing-box"), PathBuf::from("/usr/lib/proxybox/sing-box"));
        assert_eq!(resolve_binary(None, None, None, None, "sing-box"), PathBuf::from("sing-box"));
    }

    /// Строка исключения либо приводится к виду конфига, либо отклоняется с
    /// объяснением — и отклоняется ровно там, где сделала бы не то, что
    /// написано.
    #[test]
    fn a_bypass_entry_is_normalised_or_refused() {
        assert_eq!(bypass_entry(" 158.160.144.110 ").unwrap(), "158.160.144.110/32", "голый адрес — сеть из одного");
        assert_eq!(bypass_entry("158.160.0.0/16").unwrap(), "158.160.0.0/16");
        assert_eq!(bypass_entry("10.1.2.3/8").unwrap(), "10.0.0.0/8", "хвост маски обнуляется — повтор схлопнется");
        assert_eq!(bypass_entry("*.Yandex.Cloud").unwrap(), "yandex.cloud", "суффикс и так ловит поддомены");
        assert!(bypass_entry(".ru").is_err(), "зона целиком — то же, что шире /8");
        assert!(bypass_entry("com").is_err());
        // Шире /8 — это выключенный туннель, а не исключение.
        assert!(bypass_entry("0.0.0.0/0").is_err());
        assert!(bypass_entry("128.0.0.0/1").is_err());
        assert!(bypass_entry("10.0.0.0/7").is_err());
        // Служебные сети туннеля: пул FakeIP и подсеть TUN.
        assert!(bypass_entry("198.18.0.0/16").is_err(), "пул FakeIP");
        assert!(bypass_entry("198.0.0.0/8").is_err(), "сеть, накрывающая пул FakeIP");
        assert!(bypass_entry("172.27.234.2").is_err(), "шлюз TUN");
        assert!(bypass_entry("172.27.0.0/16").is_err(), "сеть, накрывающая TUN");
        assert!(bypass_entry("172.28.0.0/16").is_ok(), "соседняя сеть — можно");
        // Мусор и IPv6.
        for bad in ["", "  ", "1.2.3", "1.2.3.4/33", "300.1.1.1", "2a02:6b8::1", "a b.ru", "-x.ru", "x..ru", "http://x.ru"] {
            assert!(bypass_entry(bad).is_err(), "«{bad}» принят");
        }
    }
}
