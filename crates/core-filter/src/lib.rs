//! Кому сеть положена, а кому нет. Запрещает политика, правила только разрешают.
//!
//! Маршрутизацией занимается sing-box, но отбирать по списку он больше не умеет
//! и не должен: конфиг у обоих охватов один, `final: proxy`, тега `direct` нет.
//! Разделение живёт здесь, и происходит оно на `connect`, до всякого TUN.
//!
//! Устройство одинаковое в обоих охватах и держится на том, что в Windows
//! блокировка сильнее разрешения. Значит «всех, кроме» запрещающим правилом не
//! выразить вовсе: запрещает политика по умолчанию
//! (`blockinbound,blockoutbound`), а наши правила её только перекрывают. Отсюда
//! и порядок — политика встаёт впереди всего, включая запуск sing-box, и стоит
//! всё время, пока включён приватный режим. Пропуска выдаются и снимаются под
//! ней; снимать саму политику ради пропуска нельзя — это открыло бы сеть всем.
//!
//! Пропусков три вида, и каждый узкий:
//!
//! - `sing-box.exe` — вместе с политикой, до запуска процесса, иначе туннелю
//!   нечем подняться (`set_killswitch`);
//! - выбранные приложения — только по подтверждённой пробе, и привязанные к
//!   адресу источника нашего TUN;
//! - `svchost.exe` UDP/53 с того же адреса — иначе заперт `dnscache`, и имена
//!   не разрешаются ни у кого, включая выбранных.
//!
//! Привязка к `localip` — это и есть «приложение не может уйти напрямую».
//! Пропуск совпадает, только когда пакет уже вышел из туннеля; связься
//! приложение с физическим интерфейсом, источник будет другой, правило не
//! совпадёт, и дальше его ждёт общий запрет. Тем же движением закрывается IPv6:
//! адреса v6 у нашего TUN нет, совпасть нечему. Сторож —
//! `the_pass_is_bound_to_the_tunnel_address`.
//!
//! В охвате «весь компьютер» пропусков нет вовсе: в туннель идёт всё, и делить
//! некого. Политика там нужна только на окно, пока туннель не подтверждён.
//!
//! ponytail: правила ставятся через `netsh advfirewall` — это тот же WFP, только
//! без драйвера, подписи и unsafe-FFI. Окно утечки — время между смертью
//! процесса и постановкой правил, то есть `DEATH_EVERY` (200 мс), а не период
//! пробы: живость проверяется отдельно и чаще. Собственный WFP-фильтр в ядре
//! службы закрыл бы и остаток, но это драйвер и подпись — а сокращение с трёх
//! секунд до двухсот миллисекунд не стоило ни того, ни другого. Разобрано до
//! кода — `docs/wfp.md`; уводить из туннеля там больше некого, так что от всего
//! разбора остаётся только этот потолок.

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

/// Стоят ли сейчас пропуска. Перечислением, а не флагом, потому что название
/// состояния тут важнее самого бита: «правил нет» — это не «правила
/// разрешающие, но пустые», а совсем другая жизнь, в которой всех держит одна
/// политика.
///
/// Запрещающего варианта здесь нет и быть не может: запрет — это политика.
/// Он был, пока существовал охват «выбранные приложения», и ушёл вместе с ним.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fence {
    /// Правил нет. Так живёт охват «весь компьютер» всегда и белый список,
    /// пока туннель не подтверждён: там за всех отвечает политика.
    Off,
    /// Пропуска сквозь запрет всего исходящего — выбранным приложениям и
    /// `dnscache`. Только для белого списка и только по подтверждённой пробе.
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

/// Общее начало имени у всех наших правил: по нему и только по нему они
/// снимаются. Путь входит в имя, чтобы правило было опознаваемо в брандмауэре
/// глазами, но искать по нему нельзя — см. `sweep`.
const RULE_PREFIX: &str = "proxybox: ";

/// Тот же префикс до переименования продукта. Метла обязана мести и его: наши
/// правила — разрешающие, запрещает политика по умолчанию. Осиротевшее
/// разрешение поэтому не запирает приложение, а наоборот — пускает в туннель
/// то, что человек из списка уже убрал, и делает это молча и навсегда.
/// Правила брандмауэра переживают перезагрузку и переустановку. Сторож —
/// `the_broom_sweeps_the_old_name_too`.
const LEGACY_RULE_PREFIX: &str = "Privacy Gateway: ";

fn rule_name(path: &str) -> String {
    format!("{RULE_PREFIX}{path}")
}

/// Маска, которой снимаются все наши правила разом.
fn sweep_mask() -> String {
    format!("{RULE_PREFIX}*")
}

/// Разрешающее правило: имя, программа и всё, чем оно сужено. `tail` — это и
/// есть сужение (`localip`, протокол, порт), и без него правило означало бы
/// «программе можно всё», то есть ровно то, чего мы не выдаём никому.
fn add_args(name: &str, path: &str, tail: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={name}"),
        "dir=out".into(),
        "action=allow".into(),
        format!("program={path}"),
        "enable=yes".into(),
    ];
    args.extend_from_slice(tail);
    args
}

/// Пропуск выбранному приложению: только с адреса источника нашего туннеля.
fn pass_args(path: &str, tun_addr: &str) -> Vec<String> {
    add_args(&rule_name(path), path, &[format!("localip={tun_addr}")])
}

/// Щель для имён. `dnscache` живёт в `svchost.exe`, и запертый `svchost`
/// оставит без имён и выбранные приложения тоже — а с ними и сам продукт:
/// адрес узла из подписки тоже надо разрешить.
///
/// Щель узкая настолько, насколько получается: только UDP/53 и только с адреса
/// туннеля. Сам запрос уходит в TUN и перехватывается там (`hijack-dns`) —
/// наружу мимо туннеля не идёт ничего.
///
/// Различить, какая служба внутри `svchost` попросила имя, нельзя ни здесь, ни
/// в WFP: `ALE_APP_ID` — это путь к `svchost.exe`, один на всех. Значит имя,
/// которое спросило запертое приложение, узлу всё-таки видно — но только если
/// это запрос из тех, что FakeIP не обслуживает локально (`HTTPS`, `TXT`,
/// `PTR`); A, AAAA и локальные имена до сервера не доходят. Записано в README.
fn dns_args(tun_addr: &str) -> Vec<String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    add_args(
        &format!("{RULE_PREFIX}DNS"),
        &format!(r"{root}\System32\svchost.exe"),
        &["protocol=udp".into(), "remoteport=53".into(), format!("localip={tun_addr}")],
    )
}

/// Пропуск браузеру, которым оболочка открывает окна профилей. Он не в списке
/// выбранных и быть в нём не обязан: разговаривает он только с нашим же
/// прокси на `127.0.0.1`, туда его и пускаем — не дальше.
///
/// Правило, возможно, лишнее: Windows петлевой трафик не фильтрует вовсе, и
/// тогда браузер прошёл бы и без него. Стоит оно ровно на время сеанса и
/// открывает только петлю, так что цена ошибки в любую сторону — одно
/// бесполезное правило.
fn browser_args(path: &str) -> Vec<String> {
    add_args(&format!("{RULE_PREFIX}browser"), path, &["remoteip=127.0.0.1".into()])
}

fn delete_args(name: &str) -> Vec<String> {
    vec!["advfirewall".into(), "firewall".into(), "delete".into(), "rule".into(), format!("name={name}")]
}

/// Выдать или снять пропуска. Идемпотентна: сначала метла снимает все наши
/// правила, потом ставятся заново по текущему списку.
///
/// `tun_addr` — адрес источника нашего туннеля (`core_tunnel::TUN_ADDR`).
/// Приходит параметром, а не зашит: зависимостей у крейта нет намеренно, ровно
/// как имя адаптера в `foreign_tunnels(ours)`.
///
/// `browser` — путь к браузеру, если сейчас открыт хоть один сеанс профиля.
///
/// `previous` — что было применено к брандмауэру до этого вызова, и нужно оно
/// ровно затем, чтобы не звать метлу впустую; см. `needs_sweep`.
///
/// Список проходится целиком, даже если на каком-то приложении netsh отказал:
/// выход по первой ошибке оставил бы весь хвост без пропусков — то есть без
/// сети при зелёном статусе. Наружу отдаётся первый отказ, и его достаточно:
/// вызывающий всё равно не запоминает частичный успех и повторит всю операцию.
pub fn set_fence(fence: Fence, previous: Option<Fence>, tun_addr: &str, apps: &[String], browser: Option<&str>) -> io::Result<()> {
    if needs_sweep(previous) {
        sweep();
    }
    if fence == Fence::Off {
        return Ok(());
    }
    let mut failure = None;
    let mut put = |args: Vec<String>, what: &str| {
        // В сообщение идёт приложение и причина, а не вся строка netsh: читать
        // её в журнале невозможно, а полезного в ней — хвост.
        if let Err(e) = run(&args).map_err(|e| io::Error::other(format!("{what}: {e}"))) {
            failure.get_or_insert(e);
        }
    };
    for path in apps {
        put(pass_args(path, tun_addr), path);
    }
    put(dns_args(tun_addr), "DNS");
    if let Some(path) = browser {
        put(browser_args(path), path);
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
/// зовёт `set_fence` и в охвате «весь компьютер», перед `set_killswitch`;
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

/// Нужна ли метла. Пропустить её можно ровно в одном случае: вызывающий помнит
/// применённое, и пропусков в нём не было — значит и снимать нечего.
///
/// Экономия тут не косметическая. Метла — самый дорогой вызов на всём пути
/// включения: PowerShell тянет модуль NetSecurity и перебирает все правила
/// машины через CIM, а зовётся она дважды на одно нажатие «Включить» —
/// в `guard(true)` перед запуском sing-box и в `guard(false)` по подтверждённой
/// пробе. Первый из этих двух вызовов снимает пустоту: приватный режим был
/// выключен, пропусков не стояло.
///
/// Незнание (`None`) метле не помеха, и это главное: так выглядят первый круг
/// после старта службы и круг после отказа netsh. Правила брандмауэра переживают
/// и перезапуск службы, и перезагрузку машины, так что сироты копятся — а сирота
/// это приложение, потерявшее сеть без причины, и лишний фильтр WFP на каждом
/// исходящем соединении в системе.
///
/// Сторож — `the_broom_is_skipped_only_when_there_was_nothing_to_sweep`.
fn needs_sweep(previous: Option<Fence>) -> bool {
    previous != Some(Fence::Off)
}

fn sweep_command() -> String {
    format!(
        "Get-NetFirewallRule -DisplayName '{}','{}*' -ErrorAction SilentlyContinue \
         | Where-Object DisplayName -ne '{ALLOW_RULE}' | Remove-NetFirewallRule",
        sweep_mask(),
        LEGACY_RULE_PREFIX
    )
}

/// Имя разрешающего правила для sing-box. Своё, отдельное от правил приложений:
/// снимается оно вместе с политикой, а не вместе со списком.
const ALLOW_RULE: &str = "proxybox: sing-box";

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

/// Наш ли сейчас замок на машине. Спрашиваем не политику, а своё разрешение для
/// sing-box: политика — это состояние машины, и точно такой же `blockoutbound`
/// бывает у другого клиента VPN или выставлен человеком руками. Правило с нашим
/// именем ставим только мы и только вместе с политикой.
///
/// Нужно ровно на одном переходе — первом `guard` после старта службы. Дальше
/// служба помнит применённое сама, и спрашивать систему незачем. Без этого
/// вопроса свежая установка на первом же круге надзора вернула бы политику в
/// умолчание Windows — то есть молча сняла бы чужой kill-switch, ничего при
/// этом не включив.
pub fn locked_by_us() -> bool {
    !powershell(&format!(
        "Get-NetFirewallRule -DisplayName '{ALLOW_RULE}' -ErrorAction SilentlyContinue \
         | Select-Object -First 1 -ExpandProperty DisplayName"
    ))
    .trim()
    .is_empty()
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

    const TUN: &str = "172.27.234.1";

    /// Пропуск обязан быть привязан к адресу источника туннеля, и это не
    /// украшение, а вся разница между «приложению можно ходить через туннель» и
    /// «приложению можно всё».
    ///
    /// Привязка совпадает только с пакетом, уже вышедшим из нашего TUN. Уйди
    /// приложение напрямую с физического интерфейса — источник другой, правило
    /// не совпало, дальше общий запрет. Тем же движением закрывается IPv6:
    /// адреса v6 у TUN нет, совпасть нечему. Снимут привязку — и «нет
    /// возможности уйти напрямую» превратится в «мы попросили не уходить».
    #[test]
    fn the_pass_is_bound_to_the_tunnel_address() {
        let app = r"C:\Program Files\app.exe";
        for args in [pass_args(app, TUN), dns_args(TUN)] {
            assert!(args.contains(&format!("localip={TUN}")), "пропуск без привязки — это «можно всё»: {args:?}");
            assert!(args.contains(&"action=allow".to_string()), "{args:?}");
            assert!(args.contains(&"dir=out".to_string()), "{args:?}");
        }
        assert!(pass_args(app, TUN).contains(&format!("program={app}")));
        // Запрещающего правила больше нет вовсе: запрещает политика. Правило
        // «запретить» перебило бы разрешение sing-box — блокировка в Windows
        // сильнее, и туннелю нечем было бы подняться.
        // Иголка собирается на месте: написанная целиком, она нашла бы себя.
        let block = format!("action={}", "block");
        assert!(!include_str!("lib.rs").contains(&block), "запрет — это политика, а не правило");
    }

    /// Щель для имён обязана оставаться щелью: только UDP/53 и только с адреса
    /// туннеля. Расширится до «svchost можно всё» — и запертые приложения
    /// получат обратно любой трафик, который умеет ходить через службу.
    #[test]
    fn the_names_gap_is_only_dns() {
        let args = dns_args(TUN);
        assert!(args.contains(&"protocol=udp".to_string()), "{args:?}");
        assert!(args.contains(&"remoteport=53".to_string()), "{args:?}");
        assert!(args.iter().any(|a| a.starts_with("program=") && a.to_lowercase().ends_with(r"\system32\svchost.exe")), "{args:?}");
    }

    /// Браузерный сеанс разговаривает только с нашим прокси на петле — туда его
    /// и пускаем. Правило без этой границы означало бы «браузеру можно всё»,
    /// причём браузеру, которого человек в списке не отмечал.
    #[test]
    fn the_browser_pass_reaches_no_further_than_the_loopback() {
        let args = browser_args(r"C:\Program Files\Google\Chrome\chrome.exe");
        assert!(args.contains(&"remoteip=127.0.0.1".to_string()), "{args:?}");
        assert!(!args.iter().any(|a| a.starts_with("localip=")), "петля из туннеля не выходит: {args:?}");
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
            for args in [pass_args(path, TUN), dns_args(TUN), browser_args(path)] {
                let name = args.into_iter().find(|a| a.starts_with("name=")).unwrap();
                let name = name.strip_prefix("name=").unwrap();
                assert!(name.starts_with(prefix), "правило «{name}» не попадает под маску «{prefix}*»");
            }
        }
    }

    /// Разрешение для sing-box под маску подходит, но сноситься метлой не
    /// должно: `guard()` зовёт `set_fence` перед `set_killswitch` и в охвате
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

    /// Переименование продукта не отменяет правил, поставленных под старым
    /// именем: они лежат в брандмауэре и переживают и перезагрузку, и
    /// переустановку. Наши правила разрешающие, поэтому сирота не запирает
    /// приложение, а пускает — то самое, которое человек из списка уже убрал.
    /// Метла обязана снимать оба префикса, пока на свете есть хоть одна машина
    /// с прошлой установкой.
    #[test]
    fn the_broom_sweeps_the_old_name_too() {
        let cmd = sweep_command();
        assert!(cmd.contains(&format!("'{LEGACY_RULE_PREFIX}*'")), "метла не метёт старое имя: {cmd}");
        assert!(cmd.contains(&format!("'{}'", sweep_mask())), "метла не метёт своё же имя: {cmd}");
        // Старое разрешение sing-box обязано уйти вместе с остальными: обход по
        // имени сделан для нынешнего, а прошлое разрешает чужой уже бинарник.
        assert!(!ALLOW_RULE.starts_with(LEGACY_RULE_PREFIX), "обход пощадил бы и старое разрешение");
    }

    /// Метла — самый дорогой вызов на пути включения, и пропустить её можно
    /// ровно в одном случае: применённое до нас известно и пропусков в нём не
    /// было. Незнание метле не помеха: правила брандмауэра переживают
    /// перезагрузку, и сироты копятся, а сирота — это приложение без сети без
    /// причины.
    #[test]
    fn the_broom_is_skipped_only_when_there_was_nothing_to_sweep() {
        assert!(needs_sweep(None), "применённого не помним — сироты могли пережить перезапуск");
        assert!(needs_sweep(Some(Fence::Allow)), "пропуска стояли — снять их обязаны");
        assert!(!needs_sweep(Some(Fence::Off)), "пропусков не было — мести нечего");
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
