//! Поиск сетевых адаптеров для диагностики конфликта туннелей. Список нужен
//! и службе, и `proxybox doctor`, который опрашивает систему без службы.

/// Поднятые адаптеры, похожие на чужой туннель. Два TUN в системе спорят за
/// маршрут по умолчанию, и выигравший забирает трафик себе — наш статус при
/// этом остаётся «Защищено», хотя приложения могут уйти в чужой туннель.
/// `ours` — имя своего адаптера, которое надо исключить из списка.
pub fn foreign_tunnels(ours: &str) -> Vec<String> {
    #[cfg(target_os = "linux")]
    return linux_tunnels(ours);
    #[cfg(not(target_os = "linux"))]
    {
        detect(&adapters(), ours)
    }
}

/// Строки приходят как «Имя\tОписание», и различать их обязательно: имя мы
/// задаём сами (`interface_name`), а описание ставит драйвер — у wintun это
/// «sing-tun Tunnel», нашего имени в нём нет вовсе. Пока сверялось одно
/// описание, служба на каждом запуске находила «чужой туннель» и жаловалась в
/// журнал на саму себя. Сторож — `our_own_adapter_is_not_a_stranger`.
#[cfg(any(not(target_os = "linux"), test))]
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

/// Список адаптеров спрашивает PowerShell: `netsh` его не отдаёт, а вывод
/// локализован. Отказ — пустой вывод: разбору нечего с ним делать, кроме как
/// считать, что ничего не нашлось.
#[cfg(windows)]
fn adapters() -> String {
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {\"$($_.Name)`t$($_.InterfaceDescription)\"}",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

#[cfg(all(not(windows), not(target_os = "linux")))]
fn adapters() -> String {
    String::new()
}

/// Поднятые интерфейсы, похожие на чужой туннель. Два TUN в системе спорят за
/// маршрут по умолчанию, и человеку об этом надо сказать.
///
/// Читается `/sys/class/net`, а не вывод чужой программы: тот же смысл, что у
/// разбора PowerShell на Windows, но без подпроцесса и без локализации.
#[cfg(target_os = "linux")]
fn linux_tunnels(ours: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/sys/class/net") else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name != ours)
        // Свой тип интерфейс называет сам: 65534 — это TUN/TAP.
        .filter(|name| {
            std::fs::read_to_string(format!("/sys/class/net/{name}/type")).is_ok_and(|t| t.trim() == "65534")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OURS: &str = "proxybox";

    #[test]
    fn only_tunnel_adapters_are_flagged() {
        let adapters = "Wi-Fi\tIntel(R) Wi-Fi 6 AX201 160MHz\n\
                        wg0\tWireGuard Tunnel\n\
                        Ethernet\tRealtek PCIe GbE Family Controller\n\
                        tap\tTAP-Windows Adapter V9\n\
                        proxybox\tsing-tun Tunnel\n\n";
        assert_eq!(detect(adapters, OURS), vec!["WireGuard Tunnel", "TAP-Windows Adapter V9"]);
        assert!(detect("Wi-Fi\tIntel(R) Wi-Fi 6 AX201 160MHz\n", OURS).is_empty());
    }

    /// Имя адаптера задаём мы, описание — драйвер, и у wintun это «sing-tun
    /// Tunnel»: нашего имени там нет. Пока сверялось описание, служба на каждом
    /// запуске писала в журнал, что рядом поднят чужой туннель, — и это была
    /// она сама. Замер охватов из-за этой записи выглядел испорченным.
    #[test]
    fn our_own_adapter_is_not_a_stranger() {
        assert!(detect("proxybox\tsing-tun Tunnel\n", OURS).is_empty());
        // И наоборот: настоящий второй sing-box рядом обязан быть виден.
        assert_eq!(detect("nekoray-tun\tsing-tun Tunnel\n", OURS), vec!["sing-tun Tunnel"]);
    }
}
