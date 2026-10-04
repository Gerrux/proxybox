//! Кому сеть положена, а кому нет: стена в пользовательском WFP.
//!
//! Маршрутизацией занимается sing-box, но отбирать по списку он больше не умеет
//! и не должен: конфиг у обоих охватов один, `final: proxy`, тега `direct` нет.
//! Разделение живёт здесь, и происходит оно на `connect`, до всякого TUN.
//!
//! Стена — свои провайдер и подслой в WFP с фильтрами на
//! `ALE_AUTH_CONNECT_V4/V6` (`wfp.rs`), а не политика брандмауэра. Подслой
//! решает дело: запрет в нём сильнее разрешений Windows Firewall, поэтому
//! сотни чужих разрешающих правил (MSIX, AppContainer, всё, что поставил
//! установщик) замок больше не открывают, а выключенный профиль брандмауэра
//! или чужой брандмауэр его не снимают. Политики машины мы не касаемся вовсе.
//!
//! Желаемый набор — чистая функция входов (`wall.rs`), и ради неё же сторожа
//! крейта гоняются без WFP. Под замком в нём:
//!
//! - запрет всего с самым низким весом;
//! - `sing-box.exe` — до запуска процесса, иначе туннелю нечем подняться;
//! - петля, DHCP и NDP: без них запертая машина теряет и пробу службы, и адрес;
//! - выбранные приложения — только по подтверждённой пробе и привязанные к
//!   адресу источника нашего TUN;
//! - `svchost.exe` UDP/53 с того же адреса — иначе заперт `dnscache`, и имена
//!   не разрешаются ни у кого, включая выбранных.
//!
//! Замок закрыт и на вход: то же самое стоит зеркалом на
//! `ALE_AUTH_RECV_ACCEPT_V4/V6` (запрет, sing-box, петля, DHCP и NDP входящими,
//! выбранным — пропуск на адрес туннеля). Иначе невыбранное приложение с
//! разрешающим входящим правилом Windows Firewall (торрент, игровой сервер)
//! принимало бы пиров на физической карте мимо туннеля. Цена выбрана
//! сознательно: под замком нет входящих RDP и SSH, в том числе в охвате «весь
//! компьютер», пока туннель не подтверждён, а гости WSL2 и Hyper-V, ходящие к
//! службам хоста по vEthernet, отбиваются как входящие. Сторож —
//! `the_lock_closes_the_door_inbound_too`.
//!
//! Привязка к локальному адресу — это и есть «приложение не может уйти
//! напрямую». Пропуск совпадает, только когда пакет уже вышел из туннеля;
//! связься приложение с физическим интерфейсом, источник будет другой, правило
//! не совпадёт, и дальше его ждёт общий запрет. Тем же движением закрывается
//! IPv6: адреса v6 у нашего TUN нет, пропусков по v6 нет вовсе. Сторож —
//! `the_pass_is_bound_to_the_tunnel_address`.
//!
//! В охвате «весь компьютер» пропусков приложениям нет: в туннель идёт всё, и
//! делить некого. Стена там нужна, пока туннель не подтверждён.
//!
//! ponytail: окно утечки — время между смертью процесса sing-box и постановкой
//! стены, то есть `DEATH_EVERY` (200 мс), а не период пробы: живость
//! проверяется отдельно и чаще. В белом списке этого окна нет — запрет стоит
//! всё время, пока включён приватный режим, и умерший туннель никого не
//! выпускает. В охвате «весь компьютер» стена ставится по смерти процесса, и
//! остаток — те же `DEATH_EVERY`. Закрыть его целиком можно, держа запрет и
//! там постоянно; пока это не сделано, потолок честный — двести миллисекунд.

use std::io;
use std::path::Path;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(any(windows, test))]
mod wall;

#[cfg(windows)]
mod wfp;

#[cfg(any(windows, test))]
mod legacy;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Приватный режим выключен — приложение ходит как обычно.
    Direct,
    /// Туннель поднят — трафик уходит в него.
    Tunnel,
    /// Приватный режим включён, туннеля нет — сети нет.
    Drop,
}

/// Стоят ли сейчас пропуска. Перечислением, а не флагом, потому что название
/// состояния тут важнее самого бита: «пропусков нет» — это не «пропуски
/// пустые», а совсем другая жизнь, в которой всех держит один запрет.
///
/// Запрещающего варианта здесь нет и быть не может: запрет — это дно стены, оно
/// стоит под замком всегда. Он был, пока существовал охват «выбранные
/// приложения», и ушёл вместе с ним.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fence {
    /// Пропусков нет. Так живёт охват «весь компьютер» всегда и белый список,
    /// пока туннель не подтверждён: там за всех отвечает запрет.
    Off,
    /// Пропуска сквозь запрет — выбранным приложениям и `dnscache`. Только для
    /// белого списка и только по подтверждённой пробе.
    Allow,
}

/// Единственное место, где решается судьба выбранных приложений.
pub fn policy(private_mode: bool, tunnel_up: bool) -> Policy {
    match (private_mode, tunnel_up) {
        (false, _) => Policy::Direct,
        (true, true) => Policy::Tunnel,
        (true, false) => Policy::Drop,
    }
}

/// Привести стену к нужному виду. Идемпотентна, одна транзакция WFP: окна без
/// пропусков между постановкой запрета и разрешений нет, на ошибке откатывается
/// всё.
///
/// `lock` — стоит ли стена вообще; `false` снимает наши фильтры целиком (и
/// только наши). `fence` без замка смысла не имеет и игнорируется. `tun_addr` —
/// адрес источника нашего туннеля (`core_tunnel::TUN_ADDR`), приходит
/// параметром: зависимостей от соседних крейтов у этого нет намеренно. `apps` —
/// пути в любом написании; тех, что нет на диске, стена не замечает. `singbox`
/// — бинарник, которому пропуск положен всегда; его отсутствие — ошибка.
///
/// `Ok` — стена стоит, а в векторе пути выбранных приложений, которым пропуск
/// не выдан: WFP не принял путь. Такое приложение просто остаётся запертым, а
/// стена и пропуска остальных стоят. Не принятый путь sing-box — `Err`, хотя
/// стена при этом тоже стоит (без его пропуска, то есть заперто всё): службе
/// его надо повторять. Сторож — `a_refused_app_path_never_takes_the_wall_down`.
///
/// Linux: `apps` и `fence` не значат ничего. Отбирать по приложению там нечем до
/// cgroup, и белый список на Linux совпадает с охватом «весь компьютер» — см.
/// шапку `linux.rs`.
pub fn apply(fence: Fence, lock: bool, tun_addr: &str, apps: &[String], singbox: &Path) -> io::Result<Vec<String>> {
    #[cfg(target_os = "linux")]
    {
        let _ = (fence, tun_addr, apps, singbox);
        extern "C" {
            fn geteuid() -> u32;
        }
        // Имя интерфейса совпадает с именем таблицы, и это не совпадение, а
        // одно имя продукта.
        return linux::apply(&linux::table(lock, "proxybox", unsafe { geteuid() })).map(|()| Vec::new());
    }
    #[cfg(windows)]
    {
        let tun: std::net::Ipv4Addr = tun_addr
            .parse()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("адрес туннеля не IPv4: {tun_addr}")))?;
        wfp::apply(wall::wall(fence, lock, tun, apps, singbox), wall::bare_lock(lock, tun, singbox))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        // Фильтра нет, а на разработке — пусто.
        let _ = (fence, lock, tun_addr, apps, singbox);
        Ok(Vec::new())
    }
}

/// Убрать из WFP всё, что мы когда-либо туда ставили: фильтры, подслой,
/// провайдер. Для деинсталляции службы. Постоянные фильтры переживают службу, и
/// без этого вызова удалённый продукт оставил бы машину запертой.
pub fn forget() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    return linux::apply(&linux::table(false, "proxybox", 0));
    #[cfg(windows)]
    return wfp::forget();
    #[cfg(not(any(target_os = "linux", windows)))]
    Ok(())
}

/// Разовый уход от эпохи netsh (только Windows; на Linux — `Ok(false)`).
///
/// `saved_policy` — строка, которую прошлая версия хранила в `state.json`. Если
/// стоит её разрешение для sing-box (под нынешним именем или прежним) либо
/// политика сохранена, снимаются все старые правила обоих префиксов, включая
/// разрешение для sing-box, возвращается сохранённая политика (запасной путь —
/// умолчание Windows, `allowoutbound`) и отдаётся `true`. Иначе `false`, и
/// кроме пары вопросов `netsh show rule` ничего не делается.
///
/// Звать после того, как стена уже стоит: тогда машина в этот момент без замка
/// не остаётся.
pub fn migrate_netsh(saved_policy: Option<&str>) -> io::Result<bool> {
    #[cfg(windows)]
    return legacy::migrate(saved_policy);
    #[cfg(not(windows))]
    {
        let _ = saved_policy;
        Ok(false)
    }
}

/// Поднятые адаптеры, похожие на чужой туннель. Два TUN в системе спорят за
/// маршрут по умолчанию, и выигравший забирает трафик себе — наш статус при
/// этом остаётся «Защищено», хотя приложения могут уйти в чужой туннель.
/// `ours` — имя нашего адаптера (`core_tunnel::TUN_NAME`). Передаётся, а не
/// зашито: у крейта нет зависимостей от соседей, и заводить их ради одной
/// строки дороже, чем принять её параметром.
pub fn foreign_tunnels(ours: &str) -> Vec<String> {
    #[cfg(target_os = "linux")]
    return linux::tunnels(ours);
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

    /// Иглой служит собранная строка: написанная целиком, она нашла бы саму
    /// себя. Стена не должна возвращаться к netsh на живом пути: подпроцесс на
    /// каждое нажатие — это те самые секунды под общим замком службы, ради
    /// ухода от которых она и переехала.
    #[test]
    fn the_live_path_never_shells_out_to_netsh() {
        let needle = format!("{}{}", "netsh", " advfirewall");
        for (name, src) in [("lib.rs", include_str!("lib.rs")), ("wfp.rs", include_str!("wfp.rs")), ("wall.rs", include_str!("wall.rs"))] {
            let code = src.split("#[cfg(test)]").next().unwrap();
            let live: Vec<&str> = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect();
            assert!(!live.iter().any(|l| l.contains(&needle) || l.contains("\"netsh\"")), "{name}: netsh на живом пути");
        }
    }
}
