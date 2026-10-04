//! Желаемое состояние стены: чистая функция входов, без единого системного
//! вызова.
//!
//! Это отдельный модуль, а не часть `wfp.rs`, ради сторожей: всё, что стена
//! обещает (замок без широких пропусков, привязка пропуска к адресу туннеля,
//! узкая щель для имён), проверяется здесь на данных и гоняется на Linux CI, где
//! никакого WFP нет. `wfp.rs` только приводит набор к этому виду.
//!
//! Направлений два, и замок закрывает оба: исходящие (`ALE_AUTH_CONNECT`) и
//! входящие (`ALE_AUTH_RECV_ACCEPT`). Входящие закрыты, потому что разрешающее
//! входящее правило Windows Firewall у невыбранного приложения (торрент, игровой
//! сервер) иначе принимало бы пиров на физической карте мимо туннеля. Цена
//! выбрана пользователем сознательно: пока замок стоит, на эту машину нельзя
//! зайти по RDP или SSH — и в охвате «весь компьютер», пока туннель не
//! подтверждён, тоже; гости WSL2 и Hyper-V, ходящие к службам хоста по
//! vEthernet, для хоста входящие и под замком тоже отбиваются.
//!
//! Личность фильтра — детерминированный ключ из канонического описания, а не
//! случайный GUID: так `apply()` сравнивает набор в WFP с желаемым по ключам и не
//! трогает неизменившееся. Лишняя пересадка фильтра на `ALE_AUTH_CONNECT`
//! запускает переавторизацию живых потоков, то есть рвёт SSH и загрузки ради
//! галочки, которая их не касается.

use std::collections::HashMap;
use std::io;
use std::net::Ipv4Addr;
use std::path::Path;

use crate::Fence;

/// Наш провайдер и подслой. Фиксированные: стена переживает перезапуск службы
/// (фильтры постоянные), и новая служба обязана найти старые по тем же ключам.
#[cfg_attr(not(windows), allow(dead_code))] // читает только wfp.rs
pub(crate) const PROVIDER: u128 = 0x84a577e5_d48e_4489_9c9f_5140ed145854;
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const SUBLAYER: u128 = 0x220f3a2a_5a5c_47d8_af32_e42b6701c240;

/// Вес запрета — самый низкий в подслое, веса пропусков — самый высокий из
/// 0..=15 (так `FWP_UINT8` читается WFP как диапазон весов). Внутри подслоя
/// первым побеждает самый тяжёлый совпавший фильтр: пропуск проверяется раньше
/// общего запрета, а запрет ловит всё, что пропуск не назвал.
pub(crate) const BLOCK_WEIGHT: u8 = 0;
pub(crate) const PERMIT_WEIGHT: u8 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Layer {
    /// Исходящие: `ALE_AUTH_CONNECT_V4`.
    V4,
    V6,
    /// Входящие: `ALE_AUTH_RECV_ACCEPT_V4` / `_V6`.
    RecvV4,
    RecvV6,
}

impl Layer {
    /// Короткое имя: идёт и в ключ фильтра, и в имя для глаз.
    fn tag(self) -> &'static str {
        match self {
            Layer::V4 => "v4",
            Layer::V6 => "v6",
            Layer::RecvV4 => "in-v4",
            Layer::RecvV6 => "in-v6",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    Block,
    Permit,
}

/// Условие фильтра. Только то, что стене нужно: ни диапазонов, ни масок.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Cond {
    /// Путь к exe в нормализованном написании (см. `norm_path`).
    App(String),
    /// `FWP_CONDITION_FLAG_IS_LOOPBACK` в `FWPM_CONDITION_FLAGS`.
    Loopback,
    LocalAddr(Ipv4Addr),
    Proto(u8),
    LocalPort(u16),
    RemotePort(u16),
    /// Тип ICMPv6. В WFP он лежит в поле локального порта
    /// (`FWPM_CONDITION_ICMP_TYPE` — другое имя `IP_LOCAL_PORT`).
    IcmpType(u16),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rule {
    pub key: u128,
    pub layer: Layer,
    pub action: Action,
    pub weight: u8,
    pub conds: Vec<Cond>,
    /// Имя для глаз в `netsh wfp show filters`; в личность не входит.
    pub name: String,
    /// Правило, которое молча пропускается, если файла приложения нет на диске:
    /// список обычно несёт два написания пути, и одно может не находиться.
    /// У sing-box этого нет — без него туннелю не подняться, и отсутствие
    /// файла обязано быть ошибкой, а не тишиной.
    pub optional: bool,
}

impl Rule {
    pub fn apps(&self) -> impl Iterator<Item = &str> {
        self.conds.iter().filter_map(|c| match c {
            Cond::App(p) => Some(p.as_str()),
            _ => None,
        })
    }
}

/// Путь в единственном написании: прямые слэши в обратные, `\\?\C:\…` в
/// `C:\…`. Реестр, проводник и canonicalize дают разные формы одного файла, и
/// без этого один и тот же пропуск ставился бы дважды под разными ключами.
pub(crate) fn norm_path(p: &str) -> String {
    let p = p.replace('/', "\\");
    match p.strip_prefix(r"\\?\") {
        // `\\?\UNC\…` не трогаем: это сетевой путь, и без префикса он другой.
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => p,
    }
}

fn describe(c: &Cond) -> String {
    match c {
        Cond::App(p) => format!("app={}", p.to_lowercase()),
        Cond::Loopback => "loopback".into(),
        Cond::LocalAddr(a) => format!("laddr={a}"),
        Cond::Proto(n) => format!("proto={n}"),
        Cond::LocalPort(n) => format!("lport={n}"),
        Cond::RemotePort(n) => format!("rport={n}"),
        Cond::IcmpType(n) => format!("icmp={n}"),
    }
}

/// FNV-1a на 128 бит. Не криптография: нужен стабильный и хорошо
/// размазанный ключ из короткой строки, а отдельный крейт ради этого — это
/// зависимость, которой у крейта не было.
fn fnv128(s: &str) -> u128 {
    const OFFSET: u128 = 0x6c62272e07bb0142_62b821756295c58d;
    const PRIME: u128 = 0x0000000001000000_000000000000013b;
    s.bytes().fold(OFFSET, |h, b| (h ^ b as u128).wrapping_mul(PRIME))
}

/// Версия схемы ключа. Она входит в каноническое описание, и поднять её надо,
/// когда меняется то, как условие уходит в WFP, а `describe` остаётся прежним
/// (другой тип значения, другое поле, другой вес): без этого новая сборка
/// считала бы старый постоянный фильтр «тем же» по ключу и не пересадила бы его,
/// а он живёт в ядре и переживает и службу, и перезагрузку. С новой версией все
/// ключи другие: старые снимутся как лишние, новые встанут одной транзакцией.
/// Ни одна сборка пока не ставила фильтров на живую машину, поэтому миграции от
/// безверсионных ключей нет.
const KEY_SCHEMA: &str = "v1";

fn rule(layer: Layer, action: Action, weight: u8, conds: Vec<Cond>, what: &str, optional: bool) -> Rule {
    let canon = format!(
        "{}|{}|{}|{}|{}",
        KEY_SCHEMA,
        layer.tag(),
        if action == Action::Block { "block" } else { "permit" },
        weight,
        conds.iter().map(describe).collect::<Vec<_>>().join(";")
    );
    let name = format!("proxybox: {} {}", what, layer.tag());
    Rule { key: fnv128(&canon), layer, action, weight, conds, name, optional }
}

/// Желаемый набор фильтров. Пустой при снятом замке: стена либо стоит целиком,
/// либо её нет, промежуточных состояний с прямым доступом не существует.
///
/// `Fence::Allow` без замка не бывает (служба это гарантирует), а если бы
/// случился — набор остался бы пустым: пропуск без запрета ничего не пропускает.
pub(crate) fn wall(fence: Fence, lock: bool, tun: Ipv4Addr, apps: &[String], singbox: &Path) -> Vec<Rule> {
    if !lock {
        return Vec::new();
    }
    use Action::{Block, Permit};
    use Layer::{RecvV4, RecvV6, V4, V6};
    let singbox = norm_path(&singbox.to_string_lossy());
    let mut out = Vec::new();
    // Оба направления одним набором: входящие закрыты так же, как исходящие.
    for layer in [V4, V6, RecvV4, RecvV6] {
        out.push(rule(layer, Block, BLOCK_WEIGHT, vec![], "block", false));
        // sing-box, пробные экземпляры прогона профилей и сеансы браузера — всё
        // один и тот же бинарник; без пропуска ему нечем дозваться до узла.
        out.push(rule(layer, Permit, PERMIT_WEIGHT, vec![Cond::App(singbox.clone())], "sing-box", false));
        // Петля: Windows Firewall её не фильтрует, а наш запрет без пропуска
        // сломал бы пробу службы на 127.0.0.1, Clash API и языковые серверы IDE.
        out.push(rule(layer, Permit, PERMIT_WEIGHT, vec![Cond::Loopback], "loopback", false));
    }
    // Адрес машине выдаёт DHCP. Раньше это делали встроенные правила Core
    // Networking, но в нашем подслое они уже не помогают, а без аренды машина
    // теряет адрес на первом же продлении.
    out.push(rule(V4, Permit, PERMIT_WEIGHT, vec![Cond::Proto(17), Cond::LocalPort(68), Cond::RemotePort(67)], "dhcp", false));
    out.push(rule(V6, Permit, PERMIT_WEIGHT, vec![Cond::Proto(17), Cond::LocalPort(546), Cond::RemotePort(547)], "dhcp", false));
    // NDP: 133 router solicitation, 135/136 neighbor solicitation/advertisement.
    // Без них шлюз по IPv6 не находится. Тот же набор, что в wireguard-windows.
    for t in [133u16, 135, 136] {
        out.push(rule(V6, Permit, PERMIT_WEIGHT, vec![Cond::Proto(58), Cond::IcmpType(t)], &format!("ndp {t}"), false));
    }
    // То же входящими: аренда DHCP приходит ответом на запрос с 68 на 67, а
    // соседей и шлюз по IPv6 находит NDP, включая объявления роутера (134) и
    // перенаправления (137), которых в исходящих нет. Набор по
    // wireguard-windows (permitNdp).
    out.push(rule(RecvV4, Permit, PERMIT_WEIGHT, vec![Cond::Proto(17), Cond::LocalPort(68), Cond::RemotePort(67)], "dhcp", false));
    out.push(rule(RecvV6, Permit, PERMIT_WEIGHT, vec![Cond::Proto(17), Cond::LocalPort(546), Cond::RemotePort(547)], "dhcp", false));
    for t in [134u16, 135, 136, 137] {
        out.push(rule(RecvV6, Permit, PERMIT_WEIGHT, vec![Cond::Proto(58), Cond::IcmpType(t)], &format!("ndp {t}"), false));
    }
    if fence == Fence::Allow {
        // Только v4: у нашего TUN адреса v6 нет, и v6 остаётся под запретом —
        // это и есть закрытие IPv6.
        for app in apps {
            out.push(rule(V4, Permit, PERMIT_WEIGHT, vec![Cond::App(norm_path(app)), Cond::LocalAddr(tun)], "app", true));
            // Входящий пропуск той же формы: до выбранного приложения достучаться
            // можно только через туннель, на адрес туннеля. Тот же только-v4.
            out.push(rule(RecvV4, Permit, PERMIT_WEIGHT, vec![Cond::App(norm_path(app)), Cond::LocalAddr(tun)], "app", true));
        }
        // Входящей щели для имён нет и не нужна: ответ на запрос svchost идёт по
        // тому же потоку, что исходящий запрос, и новой авторизации не требует.
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        out.push(rule(
            V4,
            Permit,
            PERMIT_WEIGHT,
            vec![Cond::App(norm_path(&format!(r"{root}\System32\svchost.exe"))), Cond::Proto(17), Cond::RemotePort(53), Cond::LocalAddr(tun)],
            "dns",
            true,
        ));
    }
    // Два написания одного пути дают один ключ — оставляем первый.
    let mut seen = std::collections::HashSet::new();
    out.retain(|r| seen.insert(r.key));
    out
}

/// Запасная стена на случай, когда полный набор не встал: тот же замок без
/// единого пропуска приложениям (запрет, sing-box, петля, DHCP, NDP). Считает её
/// сам построитель, а не отдельный список: две копии замка разъехались бы.
///
/// Нужна для одного случая: первая постановка при включённом приватном режиме
/// не удалась целиком, транзакция откатилась, и в ядре нет вообще ничего — то
/// есть белый список открыт всем. Пустой результат — замка нет и запасной не
/// нужен.
#[cfg_attr(not(windows), allow(dead_code))] // читает только wfp.rs и lib.rs под windows
pub(crate) fn bare_lock(lock: bool, tun: Ipv4Addr, singbox: &Path) -> Vec<Rule> {
    wall(Fence::Off, lock, tun, &[], singbox)
}

/// Стоит ли пробовать запасную стену: только если желаемый набор содержит замок
/// (запрет), а сам он не равен запасному — иначе повтор ничего не изменит.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn wants_fallback(desired: &[Rule], bare: &[Rule]) -> bool {
    desired.iter().any(|r| r.action == Action::Block) && !bare.is_empty() && desired.len() != bare.len()
}

/// Оставить правила, чьи приложения есть на диске. Не пропущенное здесь
/// приложение, которого нет, превратило бы весь `apply` в ошибку из-за пути,
/// по которому всё равно никто не запустится.
pub(crate) fn present(rules: Vec<Rule>) -> Vec<Rule> {
    rules.into_iter().filter(|r| !r.optional || r.apps().all(|p| Path::new(p).exists())).collect()
}

/// Развести набор по отказам WFP: путь, который `FwpmGetAppIdFromFileName0` не
/// принял (`refused`: путь → код), уносит с собой только свои правила, а не всю
/// транзакцию. Возвращает то, что ставим, и то, что выпало.
///
/// Прежде отказ на одном пути отменял весь `apply`, и один кривой путь в списке
/// (на живой машине — `…\app/ChatGPT.exe` из MSIX со смешанными слэшами) не
/// давал встать самому замку: при включении белого списка машина оставалась
/// открытой, а при выключении — запертой без способа снять. Выпавший пропуск —
/// это fail-closed для одного приложения, а не fail-open для всех. Сторож —
/// `a_refused_app_path_never_takes_the_wall_down`.
pub(crate) fn split(rules: Vec<Rule>, refused: &HashMap<String, u32>) -> (Vec<Rule>, Vec<Rule>) {
    rules.into_iter().partition(|r| r.apps().all(|p| !refused.contains_key(p)))
}

/// Что сказать службе о выпавших правилах, когда остальное уже стоит.
///
/// Выпал пропуск приложения — `Ok` с путями: стена цела, а повторять отказ
/// каждые три секунды незачем, путь от повтора не исправится; служба
/// запоминает применённое и говорит об отказе один раз. Выпал пропуск sing-box
/// — `Err`: стена стоит без него (туннелю не подняться, все заперты — это и
/// есть инвариант), но служба обязана повторять, а повторяет она только на
/// незапомненном применённом. Повтор с тем же набором в WFP ничего не
/// переставляет: всё остальное уже стоит под теми же ключами.
pub(crate) fn outcome(dropped: &[Rule], refused: &HashMap<String, u32>) -> io::Result<Vec<String>> {
    let mut apps: Vec<String> = Vec::new();
    let mut fatal: Vec<String> = Vec::new();
    for r in dropped {
        for p in r.apps().filter(|p| refused.contains_key(*p)) {
            let list = if r.optional { &mut apps } else { &mut fatal };
            if !list.iter().any(|q| q == p) {
                list.push(p.to_string());
            }
        }
    }
    if fatal.is_empty() {
        return Ok(apps);
    }
    let what = fatal.iter().map(|p| format!("{p} (0x{:08X})", refused[p])).collect::<Vec<_>>().join("; ");
    Err(io::Error::other(format!("WFP FwpmGetAppIdFromFileName0: {what} — стена стоит без этого пропуска")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Layer; 4] = [Layer::V4, Layer::V6, Layer::RecvV4, Layer::RecvV6];
    const TUN: Ipv4Addr = Ipv4Addr::new(172, 27, 234, 1);
    const SB: &str = r"C:\pg\sing-box.exe";
    const APP: &str = r"C:\Program Files\app.exe";

    fn build(fence: Fence, lock: bool, apps: &[&str]) -> Vec<Rule> {
        let apps: Vec<String> = apps.iter().map(|s| s.to_string()).collect();
        wall(fence, lock, TUN, &apps, Path::new(SB))
    }

    fn permits(rules: &[Rule]) -> impl Iterator<Item = &Rule> {
        rules.iter().filter(|r| r.action == Action::Permit)
    }

    /// Пропуск обязан быть привязан к адресу источника туннеля, и это не
    /// украшение, а вся разница между «приложению можно ходить через туннель» и
    /// «приложению можно всё». Пакет с физического интерфейса несёт другой
    /// источник, под правило не попадает и падает в общий запрет. Тем же
    /// закрывается IPv6: адреса v6 у TUN нет, и пропусков по v6 нет вовсе.
    #[test]
    fn the_pass_is_bound_to_the_tunnel_address() {
        let rules = build(Fence::Allow, true, &[APP]);
        let apps: Vec<&Rule> = permits(&rules).filter(|r| r.name.contains("app")).collect();
        assert_eq!(apps.len(), 2, "один исходящий и один входящий");
        for r in permits(&rules).filter(|r| r.apps().any(|p| !p.eq_ignore_ascii_case(SB))) {
            assert!(matches!(r.layer, Layer::V4 | Layer::RecvV4), "пропуск приложению по v6 — это дыра мимо туннеля: {r:?}");
            assert!(r.conds.contains(&Cond::LocalAddr(TUN)), "пропуск без привязки — это «можно всё»: {r:?}");
        }
        for layer in [Layer::V4, Layer::RecvV4] {
            assert!(apps.iter().any(|r| r.layer == layer && r.conds.contains(&Cond::App(APP.into()))), "{layer:?}");
        }
    }

    /// Щель для имён обязана оставаться щелью: svchost, только UDP, только
    /// порт 53 и только с адреса туннеля. Расширится до «svchost можно всё» —
    /// и запертые приложения получат обратно любой трафик, что умеет ходить
    /// через службу.
    #[test]
    fn the_names_gap_is_only_dns() {
        let rules = build(Fence::Allow, true, &[]);
        let dns: Vec<&Rule> = permits(&rules)
            .filter(|r| r.apps().any(|p| p.to_lowercase().ends_with(r"\system32\svchost.exe")))
            .collect();
        assert_eq!(dns.len(), 1, "щель одна");
        let c = &dns[0].conds;
        assert_eq!(dns[0].layer, Layer::V4);
        assert!(c.contains(&Cond::Proto(17)) && c.contains(&Cond::RemotePort(53)) && c.contains(&Cond::LocalAddr(TUN)), "{c:?}");
        // И в охвате без пропусков её нет вовсе.
        assert!(build(Fence::Off, true, &[]).iter().all(|r| r.apps().all(|p| !p.to_lowercase().contains("svchost"))));
    }

    /// Замок — запрет всего с самым низким весом на обоих слоях, и единственный
    /// пропуск «приложению вообще» — sing-box. Запрещающего правила на
    /// приложение нет: «всех, кроме» запретом не выразить, выражает его вес.
    #[test]
    fn killswitch_blocks_everything_but_singbox() {
        let rules = build(Fence::Off, true, &[]);
        for layer in ALL {
            let blocks: Vec<&Rule> = rules.iter().filter(|r| r.layer == layer && r.action == Action::Block).collect();
            assert_eq!(blocks.len(), 1, "запрет на слой один");
            assert!(blocks[0].conds.is_empty(), "запрет без условий — это «всё»");
            assert_eq!(blocks[0].weight, BLOCK_WEIGHT);
            assert!(permits(&rules).filter(|r| r.layer == layer).all(|r| r.weight > BLOCK_WEIGHT), "пропуск обязан весить больше запрета");
        }
        let wide_apps: Vec<&Rule> = permits(&rules).filter(|r| r.conds.len() == 1 && r.apps().next().is_some()).collect();
        assert_eq!(wide_apps.len(), 4, "sing-box на v4 и v6, исходящих и входящих");
        assert!(wide_apps.iter().all(|r| r.apps().all(|p| p == SB)));
        assert!(rules.iter().all(|r| r.action == Action::Block || r.weight == PERMIT_WEIGHT));
    }

    /// Под замком ни один пропуск не адресован «всем и везде»: каждый сужен
    /// приложением, флагом петли или парой протокол-порт. Чужое разрешающее
    /// правило не откроет замок по правилу арбитража WFP (запрет в нашем
    /// подслое сильнее разрешений в подслое Windows Firewall), но сторож
    /// держит другое: мы сами не заводим в своём подслое широкого пропуска.
    #[test]
    fn the_lock_has_no_wide_permit() {
        for fence in [Fence::Off, Fence::Allow] {
            let rules = build(fence, true, &[APP]);
            assert!(permits(&rules).any(|r| matches!(r.layer, Layer::RecvV4 | Layer::RecvV6)), "входящие пропуска тоже проверяются");
            for r in permits(&rules) {
                let narrow = r.conds.iter().any(|c| matches!(c, Cond::App(_) | Cond::Loopback | Cond::Proto(_)));
                assert!(narrow, "широкий пропуск: {r:?}");
                // Адрес сам по себе сужением не считается: он «откуда», а не «кому».
                assert!(r.conds.iter().any(|c| !matches!(c, Cond::LocalAddr(_))), "{r:?}");
            }
        }
    }

    /// Без DHCP машина теряет адрес на первом продлении аренды, без NDP по
    /// IPv6 не находится шлюз — а запертая машина не должна терять ещё и
    /// адрес.
    #[test]
    fn the_lock_keeps_the_machine_addressable() {
        let rules = build(Fence::Off, true, &[]);
        let has = |layer: Layer, conds: &[Cond]| permits(&rules).any(|r| r.layer == layer && conds.iter().all(|c| r.conds.contains(c)));
        assert!(has(Layer::V4, &[Cond::Proto(17), Cond::LocalPort(68), Cond::RemotePort(67)]), "DHCPv4");
        assert!(has(Layer::V6, &[Cond::Proto(17), Cond::LocalPort(546), Cond::RemotePort(547)]), "DHCPv6");
        assert!(has(Layer::RecvV4, &[Cond::Proto(17), Cond::LocalPort(68), Cond::RemotePort(67)]), "DHCPv4 входящий");
        assert!(has(Layer::RecvV6, &[Cond::Proto(17), Cond::LocalPort(546), Cond::RemotePort(547)]), "DHCPv6 входящий");
        for t in [133, 135, 136] {
            assert!(has(Layer::V6, &[Cond::Proto(58), Cond::IcmpType(t)]), "NDP {t}");
        }
        for t in [134, 135, 136, 137] {
            assert!(has(Layer::RecvV6, &[Cond::Proto(58), Cond::IcmpType(t)]), "NDP входящий {t}");
        }
        for layer in ALL {
            assert!(has(layer, &[Cond::Loopback]), "петля: проба службы идёт на 127.0.0.1");
        }
    }

    /// Ключ — это личность фильтра: тот же вход обязан давать те же ключи
    /// (иначе `apply` пересаживал бы всё каждый раз), разные приложения и слои
    /// — разные, а регистр и написание пути ничего не меняют.
    #[test]
    fn filter_keys_are_stable_and_distinct() {
        let keys = |rules: &[Rule]| rules.iter().map(|r| r.key).collect::<Vec<_>>();
        let a = build(Fence::Allow, true, &[APP]);
        assert_eq!(keys(&a), keys(&build(Fence::Allow, true, &[APP])));
        let mut all = keys(&a);
        all.sort();
        all.dedup();
        assert_eq!(all.len(), a.len(), "ключи в наборе различны");

        let b = build(Fence::Allow, true, &[r"C:\Other\b.exe"]);
        let only = |r: &[Rule]| r.iter().filter(|r| r.name.contains("app")).map(|r| r.key).collect::<Vec<_>>();
        assert_ne!(only(&a), only(&b));

        // Регистр и написание пути: один файл — один ключ, и ровно один фильтр.
        for alt in [r"c:\program files\APP.EXE", "C:/Program Files/app.exe", r"\\?\C:\Program Files\app.exe"] {
            let c = build(Fence::Allow, true, &[alt]);
            assert_eq!(only(&a), only(&c), "{alt}");
        }
        let twice = build(Fence::Allow, true, &[APP, r"\\?\c:\program files\app.exe"]);
        assert_eq!(only(&twice).len(), 2, "два написания одного файла — один фильтр на направление");
    }

    #[test]
    fn no_lock_means_no_filters() {
        assert!(build(Fence::Off, false, &[APP]).is_empty());
        assert!(build(Fence::Allow, false, &[APP]).is_empty(), "пропуск без запрета ничего не пропускает");
    }

    /// Ключ берётся по семантике правила, а не по имени: переименование
    /// фильтра для глаз не должно пересаживать его в ядре.
    #[test]
    fn the_name_is_not_the_identity() {
        let mut r = rule(Layer::V4, Action::Block, 0, vec![], "block", false);
        let key = r.key;
        r.name = "что-то другое".into();
        assert_eq!(key, rule(Layer::V4, Action::Block, 0, vec![], "other", false).key);
    }

    /// Замок закрывает и вход: без запрета на `RECV_ACCEPT` невыбранное
    /// приложение с разрешающим входящим правилом брандмауэра принимало бы
    /// пиров на физической карте мимо туннеля. Без замка нет ничего.
    #[test]
    fn the_lock_closes_the_door_inbound_too() {
        for fence in [Fence::Off, Fence::Allow] {
            let rules = build(fence, true, &[APP]);
            for layer in [Layer::RecvV4, Layer::RecvV6] {
                assert!(rules.iter().any(|r| r.layer == layer && r.action == Action::Block && r.conds.is_empty()), "{layer:?}");
            }
        }
        assert!(build(Fence::Allow, false, &[APP]).is_empty());
        // Запасной замок тоже закрывает вход: он берётся из того же построителя.
        let bare = bare_lock(true, TUN, Path::new(SB));
        assert!(bare.iter().any(|r| r.layer == Layer::RecvV4 && r.action == Action::Block));
        assert!(bare.iter().any(|r| r.layer == Layer::RecvV6 && r.action == Action::Block));
    }

    /// Версия схемы входит в ключ: поднята версия — переехали все ключи, и старые
    /// постоянные фильтры снимутся как лишние.
    #[test]
    fn the_key_carries_its_schema() {
        let r = rule(Layer::V4, Action::Block, 0, vec![], "block", false);
        let canon = |schema: &str| format!("{schema}|v4|block|0|");
        assert_eq!(r.key, fnv128(&canon(KEY_SCHEMA)));
        assert_ne!(r.key, fnv128(&canon("v-next")), "другая версия — другой ключ");
    }

    /// Не вставший полный набор не оставляет машину без стены: запасной — тот же
    /// замок без пропусков приложениям, и считает его построитель.
    #[test]
    fn a_failed_wall_falls_back_to_the_bare_lock() {
        let full = build(Fence::Allow, true, &[APP]);
        let bare = bare_lock(true, TUN, Path::new(SB));
        let keys = |r: &[Rule]| r.iter().map(|r| r.key).collect::<Vec<_>>();
        assert_eq!(keys(&bare), keys(&build(Fence::Off, true, &[])));
        assert!(wants_fallback(&full, &bare));
        // Пропусков приложениям нет: из приложений остаётся один sing-box.
        assert!(bare.iter().flat_map(Rule::apps).all(|p| p == SB));
        assert!(bare.iter().all(|r| !r.conds.iter().any(|c| matches!(c, Cond::LocalAddr(_)))));
        for layer in [Layer::V4, Layer::V6] {
            assert!(bare.iter().any(|r| r.layer == layer && r.action == Action::Block));
        }
        // Запасной шаг не нужен без замка и когда набор уже и есть замок.
        assert!(!wants_fallback(&[], &bare_lock(false, TUN, Path::new(SB))));
        assert!(!wants_fallback(&bare, &bare));
    }

    /// Приложения, которого нет на диске, в наборе не будет, а sing-box
    /// пропустить так нельзя.
    #[test]
    fn a_missing_app_is_skipped_but_a_missing_singbox_is_not() {
        let rules = present(build(Fence::Allow, true, &[r"Z:\no\such\app.exe"]));
        assert!(rules.iter().all(|r| !r.name.contains("app")));
        assert!(rules.iter().any(|r| r.apps().any(|p| p == SB)), "sing-box остаётся: его отсутствие должно стать ошибкой в wfp");
    }

    /// Путь из живого журнала: MSIX-приложение, у которого кто-то по дороге
    /// склеил каталог прямым слэшем. netsh отвечал на него «invalid
    /// characters», и до WFP он обязан доезжать уже в одном написании — ключ
    /// и `FwpmGetAppIdFromFileName0` видят одну и ту же строку.
    const CODEX: &str = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.930.3930.0_x64__2p2nqsd0c76g0\app/ChatGPT.exe";

    #[test]
    fn a_mixed_separator_path_reaches_wfp_with_backslashes() {
        let rules = build(Fence::Allow, true, &[CODEX]);
        let apps: Vec<&str> = rules.iter().flat_map(Rule::apps).collect();
        assert!(apps.iter().all(|p| !p.contains('/')), "прямой слэш доехал до WFP: {apps:?}");
        assert!(apps.contains(&r"C:\Program Files\WindowsApps\OpenAI.Codex_26.930.3930.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"));
    }

    /// Один путь, который WFP не принял, не имеет права уронить стену: замок,
    /// пропуска sing-box, петли, DHCP, NDP, имён и остальных приложений обязаны
    /// встать, а выпасть — только пропуск этого приложения (оно остаётся
    /// запертым, то есть fail-closed для него одного). Пока отказ отменял всю
    /// транзакцию, этот же путь держал машину открытой при включении белого
    /// списка и запертой — при выключении.
    #[test]
    fn a_refused_app_path_never_takes_the_wall_down() {
        let rules = build(Fence::Allow, true, &[APP, CODEX]);
        let bad = norm_path(CODEX);
        let refused = HashMap::from([(bad.clone(), 0x8007_007Bu32)]);
        let (kept, dropped) = split(rules.clone(), &refused);
        assert_eq!(kept.len() + 2, rules.len(), "выпасть обязаны ровно два правила: исходящий и входящий пропуск");
        assert!(dropped.iter().all(|r| r.apps().any(|p| p == bad)));
        for layer in ALL {
            assert!(kept.iter().any(|r| r.layer == layer && r.action == Action::Block), "замок обязан встать");
            assert!(kept.iter().any(|r| r.layer == layer && r.apps().any(|p| p == SB)), "sing-box обязан получить пропуск");
            assert!(kept.iter().any(|r| r.layer == layer && r.conds == [Cond::Loopback]));
        }
        assert!(kept.iter().any(|r| r.apps().any(|p| p == APP)), "соседу по списку отказ чужого пути не помеха");
        assert!(kept.iter().any(|r| r.name.contains("dns")));
        assert_eq!(outcome(&dropped, &refused).unwrap(), vec![bad], "служба обязана узнать, кому пропуск не выдан");

        // Не принят sing-box: стена стоит без его пропуска (все заперты), но
        // это ошибка — служба её повторит.
        let refused = HashMap::from([(SB.to_string(), 0x8007_0002u32)]);
        let (kept, dropped) = split(rules, &refused);
        assert!(kept.iter().filter(|r| r.action == Action::Block).count() == 4, "замок стоит и без sing-box");
        assert!(kept.iter().all(|r| r.apps().all(|p| p != SB)));
        let err = outcome(&dropped, &refused).unwrap_err().to_string();
        assert!(err.contains(SB) && err.contains("0x80070002"), "{err}");

        // Нет отказов — нечего и говорить.
        assert_eq!(outcome(&[], &HashMap::new()).unwrap(), Vec::<String>::new());
    }
}
