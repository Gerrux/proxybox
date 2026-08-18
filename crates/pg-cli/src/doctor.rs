//! Проверка внешних причин, по которым приватный режим может не работать.
//!
//! Живёт в клиенте, а не в службе, намеренно: нужна она ровно тогда, когда
//! служба и не отвечает — гнать такую проверку через IPC значит потерять её в
//! единственном случае, ради которого она написана. Принцип «привилегии только
//! в службе» не нарушается: doctor ничего не меняет, не хранит состояния и
//! читает только то, что доступно обычному пользователю.
//!
//! ponytail: внешние состояния читаются готовыми утилитами Windows (sc, reg,
//! net, Get-NetAdapter), а не WinAPI через FFI. Разбор вывода вынесен в чистые
//! функции — они и покрыты тестами, запуск команд остаётся тонкой обёрткой.

use core_ipc::t;
use std::path::PathBuf;

pub enum Level {
    Ok,
    /// Работать может, но это частая причина странного поведения.
    Warn,
    /// Так работать не будет.
    Fail,
    /// Проверка только для Windows.
    #[cfg_attr(windows, allow(dead_code))]
    Skip,
}

impl Level {
    fn mark(&self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Warn => " ?",
            Level::Fail => " X",
            Level::Skip => " —",
        }
    }
}

pub struct Check {
    pub name: String,
    pub level: Level,
    pub note: String,
}

fn check(name: &str, level: Level, note: impl Into<String>) -> Check {
    Check { name: name.to_string(), level, note: note.into() }
}

/// Код состояния из вывода `sc query`: 4 — служба работает. Названия полей и
/// слово RUNNING на локализованной Windows переводятся, число — нет. TYPE у
/// служб всегда ≥ 16, а коды выхода печатаются после STATE, поэтому первое же
/// значение в диапазоне состояний (1..=7) и есть состояние.
fn sc_running(out: &str) -> bool {
    out.lines()
        .filter_map(|l| l.split_once(':'))
        .filter_map(|(_, v)| v.split_whitespace().next())
        .filter_map(|t| t.parse::<u32>().ok())
        .find(|n| (1..=7).contains(n))
        == Some(4)
}

/// `reg query … /v ProxyEnable` → включён ли системный прокси.
fn proxy_enabled(out: &str) -> bool {
    out.split_whitespace()
        .last()
        .and_then(|t| u32::from_str_radix(t.trim_start_matches("0x"), 16).ok())
        .is_some_and(|v| v != 0)
}

#[cfg(windows)]
fn out(cmd: &str, args: &[&str]) -> Option<String> {
    let o = std::process::Command::new(cmd).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// Есть ли у текущего процесса права администратора. Служба без них не поднимет
/// TUN и не поставит правила брандмауэра.
#[cfg(windows)]
fn elevated() -> bool {
    std::process::Command::new("net")
        .arg("session")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Полный путь к sing-box: переменная → рядом с бинарником → PATH.
/// `core_tunnel::binary()` отдаёт голое имя, когда рядом ничего нет, — PATH за
/// него досматриваем здесь, иначе «не найден» не отличить от «найден в PATH».
fn singbox() -> Option<PathBuf> {
    let p = core_tunnel::binary();
    if p.exists() {
        return Some(p);
    }
    if p.components().count() > 1 {
        return None; // путь задан явно, но его нет — в PATH такое не ищут
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(&p)).find(|c| c.exists())
}

#[cfg(windows)]
fn windows_checks() -> Vec<Check> {
    let mut v = Vec::new();

    v.push(if elevated() {
        check(&t("права", "rights"), Level::Ok, t("администратор", "administrator"))
    } else {
        check(
            &t("права", "rights"),
            Level::Warn,
            t(
                "обычный пользователь — службе нужны права администратора для TUN и правил брандмауэра",
                "ordinary user — the service needs administrator rights for TUN and firewall rules",
            ),
        )
    });

    v.push(match out("sc", &["query", core_ipc::SERVICE_NAME]) {
        Some(o) if sc_running(&o) => check(&t("служба Windows", "Windows service"), Level::Ok, t("зарегистрирована и работает", "registered and running")),
        Some(_) => check(
            &t("служба Windows", "Windows service"),
            Level::Warn,
            t(
                &format!("{} зарегистрирована, но остановлена — sc start {}", core_ipc::SERVICE_NAME, core_ipc::SERVICE_NAME),
                &format!("{} is registered but stopped — sc start {}", core_ipc::SERVICE_NAME, core_ipc::SERVICE_NAME),
            ),
        ),
        None => check(
            &t("служба Windows", "Windows service"),
            Level::Warn,
            t(
                "не зарегистрирована — переустановите приложение или выполните pg-service.exe install",
                "not registered — reinstall the app or run pg-service.exe install",
            ),
        ),
    });

    v.push(match out("sc", &["query", "BFE"]) {
        Some(o) if sc_running(&o) => check(&t("брандмауэр", "firewall"), Level::Ok, t("Base Filtering Engine работает", "Base Filtering Engine is running")),
        _ => check(
            &t("брандмауэр", "firewall"),
            Level::Fail,
            t(
                "служба Base Filtering Engine не работает — без неё блокирующие правила не встают, \
                 и при падении туннеля выбранные приложения уйдут напрямую",
                "the Base Filtering Engine service is not running — without it blocking rules do not apply, \
                 and selected apps will go direct when the tunnel drops",
            ),
        ),
    });

    const PROXY_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    v.push(match out("reg", &["query", PROXY_KEY, "/v", "ProxyEnable"]) {
        Some(o) if proxy_enabled(&o) => check(
            &t("системный прокси", "system proxy"),
            Level::Warn,
            t(
                "включён — трафик уходит в него до туннеля, проба может врать; выключите, если он не ваш",
                "on — traffic goes there before the tunnel and the probe may lie; turn it off if it is not yours",
            ),
        ),
        _ => check(&t("системный прокси", "system proxy"), Level::Ok, t("выключен", "off")),
    });

    // Разбор и запуск — в core-filter: тем же списком пользуется служба.
    let foreign = core_filter::foreign_tunnels();
    v.push(if foreign.is_empty() {
        check(&t("чужие туннели", "foreign tunnels"), Level::Ok, t("поднятых TUN/VPN-адаптеров нет", "no TUN/VPN adapters are up"))
    } else {
        check(
            &t("чужие туннели", "foreign tunnels"),
            Level::Warn,
            t(
                &format!(
                    "подняты: {} — они спорят за маршруты с нашим strict_route, выключите на время проверки",
                    foreign.join(", ")
                ),
                &format!("up: {} — they fight our strict_route for routes, turn them off while testing", foreign.join(", ")),
            ),
        )
    });

    v
}

#[cfg(not(windows))]
fn windows_checks() -> Vec<Check> {
    [
        t("права", "rights"),
        t("служба Windows", "Windows service"),
        t("брандмауэр", "firewall"),
        t("системный прокси", "system proxy"),
        t("чужие туннели", "foreign tunnels"),
    ]
    .into_iter()
    .map(|n| check(&n, Level::Skip, t("только для Windows", "Windows only")))
    .collect()
}

pub fn run() -> Vec<Check> {
    let mut v = vec![match core_ipc::call(&core_ipc::Request::Status) {
        Ok(_) => check(&t("служба", "service"), Level::Ok, t("отвечает", "responding")),
        Err(e) => check(
            &t("служба", "service"),
            Level::Fail,
            t(
                &format!("не отвечает ({e}) — запустите pg-service от администратора"),
                &format!("not responding ({e}) — start pg-service as administrator"),
            ),
        ),
    }];

    v.push(match singbox() {
        Some(p) => check("sing-box", Level::Ok, p.display().to_string()),
        None => check(
            "sing-box",
            Level::Fail,
            t(
                "не найден: ни в PG_SINGBOX, ни рядом с бинарником службы, ни в PATH",
                "not found: neither in PG_SINGBOX, nor next to the service binary, nor in PATH",
            ),
        ),
    });

    v.extend(windows_checks());
    v
}

/// Печать и итог: провал хотя бы одной проверки — ненулевой код возврата,
/// чтобы doctor можно было воткнуть в скрипт.
pub fn report(checks: &[Check]) -> bool {
    for c in checks {
        println!("[{}] {:<17} {}", c.level.mark(), c.name, c.note);
    }
    !checks.iter().any(|c| matches!(c.level, Level::Fail))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Локализованный вывод sc: переведены и ключи, и слово RUNNING.
    #[test]
    fn sc_state_read_by_number_not_word() {
        let running = "SERVICE_NAME: BFE\n        TYPE               : 20  WIN32_SHARE_PROCESS\n        STATE              : 4  RUNNING\n        WIN32_EXIT_CODE    : 0  (0x0)\n";
        let stopped = "SERVICE_NAME: BFE\n        TYPE               : 20  WIN32_SHARE_PROCESS\n        STATE              : 1  STOPPED\n        WIN32_EXIT_CODE    : 0  (0x0)\n";
        let ru = "SERVICE_NAME: BFE\n        ТИП                : 20  WIN32_SHARE_PROCESS\n        СОСТОЯНИЕ          : 4  РАБОТАЕТ\n        КОД_ВЫХОДА_WIN32   : 0  (0x0)\n";
        assert!(sc_running(running));
        assert!(!sc_running(stopped));
        assert!(sc_running(ru), "число состояния не переводится, на него и опираемся");
        assert!(!sc_running(""), "службы нет — считаем, что не работает");
    }

    #[test]
    fn proxy_flag_is_hex() {
        let on = "\r\nHKEY_CURRENT_USER\\...\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n";
        let off = "\r\nHKEY_CURRENT_USER\\...\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x0\r\n";
        assert!(proxy_enabled(on));
        assert!(!proxy_enabled(off));
        assert!(!proxy_enabled(""), "ключа нет — прокси не настроен");
    }

    /// Ненулевой код возврата — только на Fail: предупреждения скрипт не ломают.
    #[test]
    fn only_failures_are_fatal() {
        let ok = [check("a", Level::Ok, ""), check("b", Level::Warn, ""), check("c", Level::Skip, "")];
        assert!(report(&ok));
        assert!(!report(&[check("a", Level::Fail, "")]));
    }
}
