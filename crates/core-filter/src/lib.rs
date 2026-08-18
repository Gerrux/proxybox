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

/// Общее начало имени у всех наших правил: по нему и только по нему они
/// снимаются. Путь входит в имя, чтобы правило было опознаваемо в брандмауэре
/// глазами, но искать по нему нельзя — см. `sweep`.
const RULE_PREFIX: &str = "Privacy Gateway: ";

fn rule_name(path: &str) -> String {
    format!("{RULE_PREFIX}{path}")
}

/// Маска, которой снимаются все наши правила разом.
fn sweep_mask() -> String {
    format!("{RULE_PREFIX}*")
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

/// Поставить/снять блокировку для списка приложений. Идемпотентна: сначала
/// снимаются все наши правила, потом ставятся заново по текущему списку.
///
/// Список проходится целиком, даже если на каком-то приложении netsh отказал:
/// выход по первой ошибке оставил бы весь хвост списка без правил — то есть в
/// открытой сети при включённом приватном режиме. Наружу отдаётся первый отказ,
/// и его достаточно: вызывающий всё равно не запоминает частичный успех и
/// повторит всю операцию.
pub fn set_blocked(paths: &[String], blocked: bool) -> io::Result<()> {
    sweep();
    if !blocked {
        return Ok(());
    }
    let mut failure = None;
    for path in paths {
        // В сообщение идёт приложение и причина, а не вся строка netsh: читать
        // её в журнале невозможно, а полезного в ней — хвост.
        if let Err(e) = run(&add_args(path)).map_err(|e| io::Error::other(format!("{path}: {e}"))) {
            failure.get_or_insert(e);
        }
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Снять все наши правила — по маске имени, а не по списку путей.
///
/// По списку и было: правило удалялось тем же именем, каким ставилось. Но путь
/// между постановкой и снятием успевает и уйти из списка (сняли галочку,
/// удалили приложение), и сменить написание — разделитель из реестра приводится
/// к родному уже после того, как правило поставлено. Имя не совпадало, netsh
/// молча отвечал «ни одно правило не соответствует», и правило оставалось в
/// брандмауэре навсегда: приложение теряло сеть без причины, а WFP разбирал
/// лишний фильтр на каждом исходящем соединении в системе — своём и чужом.
/// Правила брандмауэра переживают и перезапуск службы, и перезагрузку, так что
/// сироты только копились.
///
/// Отказ метлы не возвращается наружу намеренно. Она зовётся и из ветки
/// «приватный режим выключен», а та проходит раз в PROBE_EVERY: сообщи мы об
/// отказе — вызывающий забыл бы применённое и звал бы метлу каждые три секунды.
/// Нет прав ставить правила — об этом скажет первый же `add`.
fn sweep() {
    powershell(&format!(
        "Remove-NetFirewallRule -DisplayName '{}' -ErrorAction SilentlyContinue",
        sweep_mask()
    ));
}

#[cfg(windows)]
fn run(args: &[String]) -> io::Result<()> {
    let out = std::process::Command::new("netsh").args(args).output()?;
    if !out.status.success() {
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
    powershell("Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {$_.InterfaceDescription}")
}

#[cfg(not(windows))]
fn adapters() -> String {
    String::new()
}

/// Обе задачи, для которых netsh не годится, решает PowerShell: маска имени при
/// снятии правил и список адаптеров. Отказ — пустой вывод: и метле, и разбору
/// адаптеров нечего с ним делать, кроме как считать, что ничего не нашлось.
#[cfg(windows)]
fn powershell(command: &str) -> String {
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", command])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn powershell(_command: &str) -> String {
    // Брандмауэр и адаптеры есть только на целевой платформе.
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
    }

    /// Весь инвариант снятия: метла обязана покрывать имя, которым правило
    /// поставлено, — при любом написании пути. Разъедутся — правило останется в
    /// брандмауэре навсегда, а это и приложение без сети, и лишний фильтр WFP
    /// на каждом исходящем соединении в системе.
    #[test]
    fn sweep_covers_every_rule_it_puts_up() {
        let prefix = sweep_mask();
        let prefix = prefix.strip_suffix('*').unwrap();
        for path in [r"C:\Program Files\app.exe", "C:/Program Files/app.exe", "app.exe", ""] {
            let name = add_args(path).into_iter().find(|a| a.starts_with("name=")).unwrap();
            let name = name.strip_prefix("name=").unwrap();
            assert!(name.starts_with(prefix), "правило «{name}» не попадает под маску «{prefix}*»");
        }
    }
}
