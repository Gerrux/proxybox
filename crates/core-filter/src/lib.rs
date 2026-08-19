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

fn delete_args(name: &str) -> Vec<String> {
    vec!["advfirewall".into(), "firewall".into(), "delete".into(), "rule".into(), format!("name={name}")]
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

/// Снять все наши блокирующие правила — по маске имени, а не по списку путей.
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
/// Разрешение для sing-box метла обходит, хотя по маске подходит: у него своя
/// жизнь — оно снимается вместе с политикой, а не вместе со списком. `guard()`
/// зовёт `set_blocked` и в охвате «весь компьютер», перед `set_killswitch`;
/// снеси метла это правило, sing-box остался бы без сети под ещё действующим
/// `blockoutbound` — то есть туннель падал бы ровно на снятии блокировки.
///
/// Отказ метлы не возвращается наружу намеренно. Она зовётся и из ветки
/// «приватный режим выключен», а та проходит раз в PROBE_EVERY: сообщи мы об
/// отказе — вызывающий забыл бы применённое и звал бы метлу каждые три секунды.
/// Нет прав ставить правила — об этом скажет первый же `add`.
fn sweep() {
    powershell(&sweep_command());
}

fn sweep_command() -> String {
    format!(
        "Get-NetFirewallRule -DisplayName '{}' -ErrorAction SilentlyContinue \
         | Where-Object DisplayName -ne '{ALLOW_RULE}' | Remove-NetFirewallRule",
        sweep_mask()
    )
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
/// `ours` — имя нашего адаптера (`core_tunnel::TUN_NAME`). Передаётся, а не
/// зашито: у крейта нет зависимостей, и заводить их ради одной строки дороже,
/// чем принять её параметром.
pub fn foreign_tunnels(ours: &str) -> Vec<String> {
    detect(&adapters(), ours)
}

/// Строки приходят как «Имя\tОписание», и различать их обязательно: имя мы
/// задаём сами (`interface_name`), а описание ставит драйвер — у wintun это
/// «sing-tun Tunnel», нашего имени в нём нет вовсе. Пока сверялось одно
/// описание, служба на каждом запуске находила «чужой туннель» и жаловалась в
/// журнал на саму себя. Сторож — `our_own_adapter_is_not_a_stranger`.
fn detect(adapters: &str, ours: &str) -> Vec<String> {
    const MARKERS: [&str; 6] = ["wintun", "tap-", "tun", "wireguard", "openvpn", "vpn"];
    let ours = ours.to_lowercase();
    adapters
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| match l.split_once('\t') {
            Some((name, desc)) => Some((name.trim(), desc.trim())),
            // Без разделителя считаем строку описанием: так вывод старого
            // формата не превращается в поток ложных срабатываний.
            None => Some(("", l)),
        })
        .filter(|(name, desc)| {
            let name = name.to_lowercase();
            name != ours && !desc.to_lowercase().contains(&ours)
        })
        .filter(|(_, desc)| {
            let low = desc.to_lowercase();
            MARKERS.iter().any(|m| low.contains(m))
        })
        // Наружу идёт описание: «WireGuard Tunnel» человеку говорит больше, чем
        // имя подключения, которое у чужого клиента бывает и «Ethernet 3».
        .map(|(_, desc)| desc.to_string())
        .collect()
}

#[cfg(windows)]
fn adapters() -> String {
    powershell(
        "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {\"$($_.Name)`t$($_.InterfaceDescription)\"}",
    )
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

    const OURS: &str = "Privacy Gateway";

    #[test]
    fn only_tunnel_adapters_are_flagged() {
        let adapters = "Wi-Fi\tIntel(R) Wi-Fi 6 AX201 160MHz\n\
                        wg0\tWireGuard Tunnel\n\
                        Ethernet\tRealtek PCIe GbE Family Controller\n\
                        tap\tTAP-Windows Adapter V9\n\
                        Privacy Gateway\tsing-tun Tunnel\n\n";
        assert_eq!(detect(adapters, OURS), vec!["WireGuard Tunnel", "TAP-Windows Adapter V9"]);
        assert!(detect("Wi-Fi\tIntel(R) Wi-Fi 6 AX201 160MHz\n", OURS).is_empty());
    }

    /// Имя адаптера задаём мы, описание — драйвер, и у wintun это «sing-tun
    /// Tunnel»: нашего имени там нет. Пока сверялось описание, служба на каждом
    /// запуске писала в журнал, что рядом поднят чужой туннель, — и это была
    /// она сама. Замер охватов из-за этой записи выглядел испорченным.
    #[test]
    fn our_own_adapter_is_not_a_stranger() {
        assert!(detect("Privacy Gateway\tsing-tun Tunnel\n", OURS).is_empty());
        // И наоборот: настоящий второй sing-box рядом обязан быть виден.
        assert_eq!(detect("nekoray-tun\tsing-tun Tunnel\n", OURS), vec!["sing-tun Tunnel"]);
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
        let mask = sweep_mask();
        let prefix = mask.strip_suffix('*').unwrap();
        for path in [r"C:\Program Files\app.exe", "C:/Program Files/app.exe", "app.exe", ""] {
            let name = add_args(path).into_iter().find(|a| a.starts_with("name=")).unwrap();
            let name = name.strip_prefix("name=").unwrap();
            assert!(name.starts_with(prefix), "правило «{name}» не попадает под маску «{prefix}*»");
        }
    }

    /// Разрешение для sing-box под маску подходит, но сноситься метлой не
    /// должно: `guard()` зовёт `set_blocked` перед `set_killswitch` и в охвате
    /// «весь компьютер» — снесённое разрешение оставило бы sing-box без сети
    /// под ещё действующим запретом всего исходящего.
    #[test]
    fn sweep_spares_the_singbox_allowance() {
        assert!(ALLOW_RULE.starts_with(sweep_mask().strip_suffix('*').unwrap()), "иначе обход не нужен");
        assert!(sweep_command().contains(&format!("-ne '{ALLOW_RULE}'")));
        // Перенос в литерале обязан склеиться в одну строку: PowerShell получает
        // команду одним аргументом, и разорванная молча не сделала бы ничего.
        assert!(!sweep_command().contains('\n'), "{}", sweep_command());
        assert!(sweep_command().contains("SilentlyContinue | Where-Object"), "{}", sweep_command());
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
