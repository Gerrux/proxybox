//! Страховка fail-closed на те моменты, когда sing-box не работает.
//!
//! Пока туннель поднят, маршрутизацию выбранных приложений держит сам sing-box
//! (TUN + правила по `process_path`). Но между падением процесса и его
//! перезапуском TUN исчезает, и выбранные приложения ушли бы напрямую — вот на
//! это окно и ставится блокирующее правило брандмауэра Windows.
//!
//! ponytail: правила ставятся через `netsh advfirewall` — это тот же WFP, только
//! без драйвера, подписи и unsafe-FFI. Окно утечки — время между смертью
//! процесса и постановкой правил (проверка раз в PROBE_EVERY). Собственный
//! WFP-фильтр в ядре службы закрыл бы и его, но это драйвер и подпись.

use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Приватный режим выключен — приложение ходит как обычно.
    Direct,
    /// Туннель поднят — трафик уходит в него.
    Tunnel,
    /// Приватный режим включён, туннеля нет — сети нет.
    Drop,
}

/// Единственное место, где решается судьба выбранных приложений.
pub fn policy(private_mode: bool, tunnel_up: bool) -> Policy {
    match (private_mode, tunnel_up) {
        (false, _) => Policy::Direct,
        (true, true) => Policy::Tunnel,
        (true, false) => Policy::Drop,
    }
}

fn rule_name(path: &str) -> String {
    format!("Privacy Gateway: {path}")
}

fn add_args(path: &str) -> Vec<String> {
    vec![
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={}", rule_name(path)),
        "dir=out".into(),
        "action=block".into(),
        format!("program={path}"),
        "enable=yes".into(),
    ]
}

fn delete_args(path: &str) -> Vec<String> {
    vec![
        "advfirewall".into(),
        "firewall".into(),
        "delete".into(),
        "rule".into(),
        format!("name={}", rule_name(path)),
    ]
}

/// Поставить/снять блокировку для списка приложений. Идемпотентна: перед
/// добавлением правило удаляется, чтобы не плодить дубликаты при рестартах.
///
/// Список проходится целиком, даже если на каком-то приложении netsh отказал:
/// выход по первой ошибке оставил бы весь хвост списка без правил — то есть в
/// открытой сети при включённом приватном режиме. Наружу отдаётся первый отказ,
/// и его достаточно: вызывающий всё равно не запоминает частичный успех и
/// повторит всю операцию.
pub fn set_blocked(paths: &[String], blocked: bool) -> io::Result<()> {
    let mut failure = None;
    for path in paths {
        let outcome = run(&delete_args(path)).and_then(|()| {
            if !blocked {
                return Ok(());
            }
            // В сообщение идёт приложение и причина, а не вся строка netsh:
            // читать её в журнале невозможно, а полезного в ней — хвост.
            run(&add_args(path)).map_err(|e| io::Error::other(format!("{path}: {e}")))
        });
        if let Err(e) = outcome {
            failure.get_or_insert(e);
        }
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(windows)]
fn run(args: &[String]) -> io::Result<()> {
    let out = std::process::Command::new("netsh").args(args).output()?;
    // «Ни одно правило не соответствует» при удалении — не ошибка.
    if !out.status.success() && args.contains(&"add".to_string()) {
        return Err(io::Error::other(String::from_utf8_lossy(&out.stdout).trim().to_string()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn run(_args: &[String]) -> io::Result<()> {
    // Брандмауэр есть только на целевой платформе; на разработке — пусто.
    Ok(())
}

/// Поднятые адаптеры, похожие на чужой туннель. Два TUN в системе спорят за
/// маршрут по умолчанию, и выигравший забирает трафик себе — наш статус при
/// этом остаётся «Защищено», хотя приложения могут уйти в чужой туннель.
pub fn foreign_tunnels() -> Vec<String> {
    detect(&adapters())
}

fn detect(adapters: &str) -> Vec<String> {
    const MARKERS: [&str; 6] = ["wintun", "tap-", "tun", "wireguard", "openvpn", "vpn"];
    adapters
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        // Свой адаптер в этот список попадать не должен: он именован явно.
        .filter(|l| !l.contains("Privacy Gateway"))
        .filter(|l| {
            let low = l.to_lowercase();
            MARKERS.iter().any(|m| low.contains(m))
        })
        .map(str::to_string)
        .collect()
}

#[cfg(windows)]
fn adapters() -> String {
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {$_.InterfaceDescription}",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn adapters() -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Прямого доступа при включённом приватном режиме не существует.
    #[test]
    fn no_direct_while_private() {
        assert_eq!(policy(false, false), Policy::Direct);
        assert_eq!(policy(false, true), Policy::Direct);
        assert_eq!(policy(true, true), Policy::Tunnel);
        assert_eq!(policy(true, false), Policy::Drop);
    }

    #[test]
    fn only_tunnel_adapters_are_flagged() {
        let adapters = "Intel(R) Wi-Fi 6 AX201 160MHz\nWireGuard Tunnel\nRealtek PCIe GbE Family Controller\nTAP-Windows Adapter V9\nPrivacy Gateway Tunnel\n\n";
        assert_eq!(detect(adapters), vec!["WireGuard Tunnel", "TAP-Windows Adapter V9"]);
        assert!(detect("Intel(R) Wi-Fi 6 AX201 160MHz\n").is_empty());
    }

    #[test]
    fn rules_are_per_app_and_blocking() {
        let add = add_args(r"C:\Program Files\app.exe");
        assert!(add.contains(&"action=block".to_string()));
        assert!(add.contains(&"dir=out".to_string()));
        assert!(add.contains(&r"program=C:\Program Files\app.exe".to_string()));
        // Имя правила совпадает у add и delete — иначе снять его нечем.
        let name = |v: &Vec<String>| v.iter().find(|a| a.starts_with("name=")).unwrap().clone();
        assert_eq!(name(&add), name(&delete_args(r"C:\Program Files\app.exe")));
    }
}
