//! Страховка fail-closed на те моменты, когда sing-box не работает.
//!
//! Пока туннель поднят, маршрутизацию выбранных приложений держит сам sing-box
//! (TUN + правила по `process_path`). Но между падением процесса и его
//! перезапуском TUN исчезает, и выбранные приложения ушли бы напрямую — вот на
//! это окно и ставится блокирующее правило брандмауэра Windows.
//!
//! В охвате «весь компьютер» блокировать поимённо нечего, и то же окно
//! закрывается политикой по умолчанию: весь исходящий запрещён, разрешён один
//! sing-box (`set_killswitch`).
//!
//! ponytail: правила ставятся через `netsh advfirewall` — это тот же WFP, только
//! без драйвера, подписи и unsafe-FFI. Окно утечки — время между смертью
//! процесса и постановкой правил (проверка раз в PROBE_EVERY). Собственный
//! WFP-фильтр в ядре службы закрыл бы и его, но это драйвер и подпись.

use std::io;
use std::path::Path;

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

fn delete_args(name: &str) -> Vec<String> {
    vec!["advfirewall".into(), "firewall".into(), "delete".into(), "rule".into(), format!("name={name}")]
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
        let outcome = run(&delete_args(&rule_name(path))).and_then(|()| {
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

/// Имя разрешающего правила для sing-box. Своё, отдельное от правил приложений:
/// снимается оно вместе с политикой, а не вместе со списком.
const ALLOW_RULE: &str = "Privacy Gateway: sing-box";

fn policy_args(outbound: &str) -> Vec<String> {
    vec!["advfirewall".into(), "set".into(), "allprofiles".into(), "firewallpolicy".into(), format!("blockinbound,{outbound}")]
}

fn allow_args(singbox: &Path) -> Vec<String> {
    vec![
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={ALLOW_RULE}"),
        "dir=out".into(),
        "action=allow".into(),
        format!("program={}", singbox.display()),
        "enable=yes".into(),
    ]
}

/// Fail-closed для режима «весь компьютер»: поимённо блокировать там нечего,
/// поэтому запрещается весь исходящий трафик, кроме самого sing-box.
///
/// Запрещающим правилом это не делается: в Windows блокировка сильнее
/// разрешения, и правило «запретить всё» перебило бы разрешение для sing-box —
/// туннелю нечем было бы подняться. Поэтому меняется политика по умолчанию:
/// её разрешающие правила как раз перекрывают.
///
/// ponytail: политика возвращается в умолчание Windows
/// (`blockinbound,allowoutbound`), а не в то, что стояло у пользователя, — свою
/// настройку исходящего он потеряет. Потолок снимается разбором вывода
/// `netsh advfirewall show allprofiles` перед первым включением.
pub fn set_killswitch(on: bool, singbox: &Path) -> io::Result<()> {
    let delete = delete_args(ALLOW_RULE);
    if !on {
        // Сначала политика, потом снятие правила: в обратном порядке sing-box
        // на мгновение остался бы без сети под ещё действующим запретом.
        run(&policy_args("allowoutbound"))?;
        return run(&delete);
    }
    run(&delete)?;
    run(&allow_args(singbox))?;
    run(&policy_args("blockoutbound"))
}

#[cfg(windows)]
fn run(args: &[String]) -> io::Result<()> {
    let out = std::process::Command::new("netsh").args(args).output()?;
    // «Ни одно правило не соответствует» при удалении — не ошибка; всё
    // остальное (add, set) обязано отработать.
    if !out.status.success() && !args.contains(&"delete".to_string()) {
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
        assert_eq!(name(&add), name(&delete_args(&rule_name(r"C:\Program Files\app.exe"))));
    }

    /// Kill-switch держится на политике по умолчанию, а не на запрещающем
    /// правиле: иначе он закрыл бы сеть и самому sing-box.
    #[test]
    fn killswitch_blocks_everything_but_singbox() {
        let allow = allow_args(Path::new(r"C:\pg\sing-box.exe"));
        assert!(allow.contains(&"action=allow".to_string()));
        assert!(allow.contains(&r"program=C:\pg\sing-box.exe".to_string()));
        assert!(policy_args("blockoutbound").contains(&"firewallpolicy".to_string()));
        assert_eq!(policy_args("blockoutbound").last().unwrap(), "blockinbound,blockoutbound");
        assert_eq!(policy_args("allowoutbound").last().unwrap(), "blockinbound,allowoutbound");
        // Снять правило нечем, если имена разойдутся.
        let name = |v: &Vec<String>| v.iter().find(|a| a.starts_with("name=")).unwrap().clone();
        assert_eq!(name(&allow), name(&delete_args(ALLOW_RULE)));
    }
}
