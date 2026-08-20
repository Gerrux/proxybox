//! Туннель = процесс sing-box под присмотром службы.
//!
//! Своей реализации VLESS/VMESS/Trojan/SS/Hysteria2/WireGuard мы не пишем: этим
//! занимается sing-box, как в NekoBox, — мы генерируем ему конфиг и следим за
//! процессом. Перехват per-process тоже конфиг, а не драйвер: TUN + правила
//! маршрутизации по `process_path`. Приложения не из списка уходят в `direct`,
//! выбранные — только в `proxy`, без запасного маршрута. Это и есть fail-closed:
//! упал сервер — соединения выбранных приложений просто не устанавливаются.
//!
//! Второй охват — `Options::all`: маршрут по умолчанию сам становится `proxy`,
//! и отбирать некого. Это не «выбрать все приложения» списком: `process_path`
//! сверяется с путём процесса, а под `final` попадает и то, у чего пути нет.

use core_ipc::{t, Conn};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TAG_PROXY: &str = "proxy";
/// Имя нашего TUN-адаптера: по нему его видно в системе и не спутать с чужим.
pub const TUN_NAME: &str = "Privacy Gateway";
/// Наш адрес на TUN. 172.19.0.1/30 — умолчание sing-box, а значит и NekoBox,
/// Hiddify, v2rayN: с любым из них адрес и имя адаптера столкнулись бы лоб в
/// лоб. Берём свои, чтобы конфликт был виден как чужой туннель, а не как
/// загадочный отказ TUN.
const TUN_ADDR: &str = "172.27.234.1";
/// Адрес шлюза на TUN. Своим его никто не назначает: `sing-tun` выводит его на
/// Windows как «следующий за нашим» (`Inet4Address[0].Addr().Next()`), и
/// отвечать по нему некому. Отсюда и правило отбоя в `build_config` — см. там.
/// Сторож, связывающий эти две константы, — `the_gateway_is_next_to_our_address`.
const TUN_GATEWAY: &str = "172.27.234.2";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Столько ждём, прежде чем поверить, что sing-box действительно поднялся.
const STARTUP_GRACE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone)]
pub struct Options {
    /// Локальный mixed-порт: и проба здоровья, и headless-использование без TUN.
    pub socks_port: u16,
    /// Порт Clash API — единственный источник счётчиков трафика.
    pub api_port: u16,
    /// TUN поднимается только на Windows под службой; в разработке — без него.
    pub tun: bool,
    /// Полные пути к .exe, которым разрешён выход только через туннель.
    /// В режиме `all` не участвуют: там перехватывать поимённо нечего.
    pub apps: Vec<String>,
    /// Весь трафик машины в туннель — вместо перехвата по списку приложений.
    /// Это не «выбрать все»: маршрут по умолчанию просто становится `proxy`,
    /// и sing-box не сверяет ни одного `process_path`.
    pub all: bool,
    /// Чем sing-box разбирает пакеты из TUN: `mixed` (системный TCP плюс
    /// gVisor на UDP), `system` или `gvisor`. Перебивается `PG_STACK`.
    ///
    /// Ручка диагностическая, как `PG_TUN`, и в настройках её нет намеренно:
    /// человеку выбирать тут нечего, а замер показал, за чем следить. sing-box
    /// с поднятым TUN держит около полутора ядер вне зависимости от трафика —
    /// 158 тысяч лишних пакетов не прибавили ни секунды, — и стек первый на
    /// очереди из того, что мы вообще можем менять, не трогая сам sing-box.
    ///
    /// Значение уходит в конфиг как есть, без белого списка, и это осознанно:
    /// `sing-box check` имя стека не проверяет вовсе (проверено на 1.13), а
    /// подстановка `mixed` вместо непонятого значения означала бы замер,
    /// который врёт — человек думает, что сравнил `system`, а сравнил `mixed`
    /// сам с собой. Неверное имя ловит запуск: туннель не поднимается, отказ
    /// уходит в журнал, приложения остаются без сети. Громко и правильно.
    pub stack: String,
    /// Адрес профилировщика sing-box (`PG_PPROF=127.0.0.1:48294`), пусто — нет.
    ///
    /// Заведён затем, что спорить о причинах расхода ЦП больше нечем: три
    /// разбора по исходникам дали три разных механизма, и каждый выглядел
    /// убедительно. Профиль называет функцию, а не гипотезу. Сборочных тегов не
    /// требует — официальные сборки отдают его сразу.
    ///
    /// Ручка диагностическая, как `PG_STACK` и `PG_TUN`, и настройкой не
    /// продублирована намеренно: включённый по недосмотру профилировщик — это
    /// открытый порт в службе, которая ходит от LocalSystem.
    pub pprof: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            socks_port: 48292,
            api_port: 48293,
            tun: true,
            apps: Vec::new(),
            all: false,
            stack: std::env::var("PG_STACK").unwrap_or_else(|_| "mixed".into()),
            pprof: pprof_value(&std::env::var("PG_PPROF").unwrap_or_default()),
        }
    }
}

/// Полный конфиг sing-box для одного узла.
pub fn build_config(node: &Value, opts: &Options) -> Value {
    let mut node = node.clone();
    node["tag"] = json!(TAG_PROXY);
    // WireGuard в схеме 1.13 живёт в endpoints, остальные протоколы — в outbounds.
    let wireguard = node["type"] == "wireguard";

    let mut inbounds = vec![json!({
        "type": "mixed",
        "tag": "local",
        "listen": "127.0.0.1",
        "listen_port": opts.socks_port,
    })];
    if opts.tun {
        inbounds.push(json!({
            "type": "tun",
            "tag": "tun-in",
            "interface_name": TUN_NAME,
            "address": [format!("{TUN_ADDR}/30")],
            "auto_route": true,
            "strict_route": true,
            "stack": opts.stack,
        }));
    }

    let mut rules = vec![json!({ "inbound": ["local"], "action": "route", "outbound": TAG_PROXY })];
    // Разбор имени из первых пакетов — только для TUN, и это не вкусовщина.
    // Со `sniff` sing-box отвечает входящему до того, как дозвонится наружу: он
    // ждёт первых байтов, чтобы прочитать имя. Проба же считает успехом именно
    // ответ на SOCKS-запрос — и мёртвый узел стал бы подтверждённым туннелем, а
    // `guard(false)` снял бы блокировку с выбранных приложений. Сторож —
    // `the_probe_path_is_never_sniffed`, он же ловит возврат правила на все входы.
    //
    // Отданное им имя дальше правил не идёт: цель соединения после сниффинга не
    // подменяется, и серверу уходит адрес, а не домен (проверено на 1.13.19 —
    // второй sing-box на том конце видит целью IP). Значит имя тут кормит одно:
    // строку в списке соединений (`parse_conn`, «домена нет — остаётся адрес»).
    // Кто соберётся сниффить меньше — знает, что теряет, и что имена туннелю
    // даёт не это правило, а `dns` ниже.
    if opts.tun {
        rules.insert(0, json!({ "inbound": ["tun-in"], "action": "sniff" }));
        // Отбой всему, что адресовано шлюзу TUN, и стоит он первым намеренно.
        //
        // По этому адресу не отвечает никто, а приложения его исправно
        // опрашивают: NAT-PMP/PCP на 5351, SSDP/UPnP на 1900 — так они ищут
        // домашний роутер. Без этого правила запрос уходит в маршрутизацию, и
        // дальше всё зависит от того, куда он попадёт. На `direct` sing-box
        // отбивает его сам и мгновенно (`isMyLoopbackAddress`: адрес внутри
        // нашей же подсети), приложение повторяет тут же — и получается шторм,
        // который упирает ядро в потолок при пустом трафике. На `proxy` тот же
        // запрос уходит к серверу, отказ стоит целого RTT, и повторы идут на
        // три порядка реже. Отсюда и разница в расходе между охватами, которую
        // долго списывали на объём трафика.
        //
        // Ровно это описано в sing-box#4415 на нашей же конфигурации; у #4236 и
        // mihomo#2382 та же болезнь и то же лекарство. Матчера по процессу
        // правило не заводит, поэтому цены за собой не тянет.
        //
        // Молча, а не отказом, и это важнее, чем выглядит. Обычный `reject`
        // отвечает ICMP unreachable — то есть тоже мгновенно, и шторм остаётся,
        // просто дешевеет каждая его итерация; вдобавок он держит замок и
        // перекладывает счётчик на каждый отказ, а после пятидесяти за полминуты
        // sing-box всё равно молча переходит на drop. `drop` заставляет
        // приложение ждать собственного таймаута, и частота повторов падает
        // сама. Заодно это честная эмуляция: на живой сети по несуществующему
        // адресу молчат, а не отвечают отказом.
        //
        // Порт 53 из-под отбоя выведен, и это не перестраховка: по нему идёт
        // весь DNS машины, и забирает его правило перехвата ниже. Сторож —
        // `the_tun_gateway_is_rejected_first`.
        //
        // Честно о размере пользы: на живой машине этот отбой ловил считаные
        // проценты шторма — остальное было DNS. Он страхует от того, что
        // описано в upstream (#4415, #4236, mihomo#2382), а не чинит замеренное.
        rules.insert(
            0,
            json!({
                "type": "logical",
                "mode": "and",
                "rules": [
                    { "ip_cidr": [format!("{TUN_GATEWAY}/32")] },
                    { "port": [53], "invert": true },
                ],
                "action": "reject",
                "method": "drop",
            }),
        );
        // Перехват DNS, и он первый, потому что чинит самое дорогое.
        //
        // Под `auto_route` `sing-tun` прописывает адаптеру DNS-сервером адрес
        // шлюза (`Inet4Address[0].Next()`), и Windows послушно шлёт запросы
        // туда. Обработать их без этого правила некому: запрос становится
        // обычным соединением, уходит в `final`, а на `direct` sing-box отбивает
        // его мгновенно как петлю в свою же подсеть — и `dnscache` повторяет
        // тут же. Замерено на живой машине: 1025 одновременных соединений на
        // `172.27.234.2:53` из 1047 всего, при нулевом сетевом трафике и 85% ЦП.
        // Это и есть та петля, что стоила полутора ядер и описана в CLAUDE.md;
        // тогда её починили наполовину — секцию `dns` завели, а перехват нет.
        //
        // С перехватом запрос уходит в DNS-модуль вместо маршрутизации, и
        // `dns.final: remote` наконец делает то, что про него написано: имена
        // разрешает сервер. Повторы съедает встроенный кэш.
        //
        // Только для TUN и только 53: вход `local` — это путь пробы, и трогать
        // его нельзя по той же причине, по какой его не сниффят.
        rules.insert(0, json!({ "inbound": ["tun-in"], "port": [53], "action": "hijack-dns" }));
    }
    // Это правило стоит не одного сравнения строк, и цена берётся не с тех, за
    // кого оно поставлено. Одного матчера по процессу где угодно в наборе
    // хватает, чтобы sing-box выяснял процесс для **каждого** соединения, и
    // делает он это до разбора правил: порядком, ранним совпадением и
    // `ip_cidr` впереди список не сократить (проверено на 1.13.19 — при
    // совпавшем нулевом правиле `found process path` в журнале всё равно
    // стоит, и стоит раньше `match[0]`). На Windows один такой поиск — снимок
    // всей системной таблицы TCP/UDP плюс открытие чужого процесса; в TUN под
    // `auto_route` заходит вся машина, значит платит за перехват по списку вся
    // машина, а не выбранные приложения.
    //
    // Дешевле в конфиге не делается: это и есть цена перехвата по списку через
    // TUN, и снимает её только свой WFP-фильтр — тот же потолок, что записан в
    // шапке `core-filter`. В охвате «весь компьютер» матчера нет ни одного, и
    // поиск не запускается ни разу; сторож — `all_traffic_takes_the_default_route`.
    if !opts.all && !opts.apps.is_empty() {
        rules.push(json!({ "process_path": opts.apps, "action": "route", "outbound": TAG_PROXY }));
    }
    // Весь компьютер в туннель — это один маршрут по умолчанию, а не список из
    // всех установленных .exe: правило по `process_path` сверяет каждое
    // соединение с путём процесса, а `final` не сверяет ничего. Заодно под
    // туннель попадает и то, у чего пути нет вовсе, — служба, драйвер, DNS.
    let default_route = if opts.all { TAG_PROXY } else { "direct" };

    let mut cfg = json!({
        "log": { "level": "warn" },
        "experimental": { "clash_api": { "external_controller": format!("127.0.0.1:{}", opts.api_port) } },
        "inbounds": inbounds,
        "outbounds": if wireguard { json!([{ "type": "direct", "tag": "direct" }]) }
                     else { json!([node, { "type": "direct", "tag": "direct" }]) },
        // Имена разрешает сервер на том конце, а не машина здесь. Секции не было
        // вовсе, и это стоило дороже всего: с `auto_route` запрос уходил
        // системному резолверу, попадал под маршрут по умолчанию, возвращался в
        // тот же TUN — и крутился там. Пятьдесят байт на пакет и полсотни
        // «соединений» в секунду при пустом трафике были именно этим.
        //
        // Заодно уходит и утечка имён мимо туннеля, и разъезд с CDN: раньше имя
        // разрешалось здесь, и сеть отдавала адрес узла рядом с человеком, а шёл
        // он туда из страны сервера — через полмира и обратно на каждый запрос.
        "dns": {
            "servers": [
                { "type": "udp", "tag": "remote", "server": "1.1.1.1", "detour": TAG_PROXY },
                // Второй резолвер нужен ровно для одного: разрешить адрес самого
                // сервера. Через `remote` это была бы курица с яйцом.
                //
                // Он обязан быть назван явно и ходить `direct`. Стоял `type:
                // local`, то есть резолвер операционной системы, — а после
                // `auto_route` резолвер системы это адрес нашего же шлюза TUN.
                // Ссылка на себя: тем, чем разрешаем адрес своего сервера,
                // оказываемся мы сами. Без перехвата DNS это давало мгновенный
                // отказ и повтор, с перехватом стало бы замкнутым циклом.
                // Сторож — `names_are_resolved_by_the_server_but_the_server_is_not`.
                //
                // По адресу, а не по имени, и по DoH, а не открытым UDP. Имя тут
                // разрешать нечем по определению — это и есть бутстрап; а
                // открытый UDP показал бы имя вашего сервера всей сети по пути,
                // причём у человека на адаптере DNS уже зашифрован, и мы бы
                // молча понизили ему уровень. Сертификат Google покрывает
                // 8.8.8.8 как адрес, поэтому TLS сходится без имени.
                //
                // Восьмёрки, а не Cloudflare, ровно по одной причине: это тот же
                // резолвер, что уже стоит у человека на адаптере. Новый третий
                // участник в приватном продукте заводится только когда без него
                // никак. Узел, заданный адресом, сюда не ходит вовсе — путь
                // только для узлов по имени.
                //
                // `detour` тут нет намеренно, и это не мелочь: `detour:
                // "direct"` выглядит как «явно мимо туннеля», но наш `direct` —
                // пустой outbound, и sing-box отвечает на это «detour to an
                // empty direct outbound makes no sense» и **не стартует**.
                // `sing-box check` такой конфиг пропускает: ошибка вылезает
                // только при запуске. Без `detour` резолвер и так ходит мимо
                // маршрутизации; запрещено ему ровно одно — идти через `proxy`,
                // и это сторожит тест.
                { "type": "https", "tag": "local", "server": "8.8.8.8" },
            ],
            "final": "remote",
        },
        "route": {
            "rules": rules,
            // Всё, что не выбрано, идёт напрямую: чужой трафик мы не трогаем.
            // В режиме «весь трафик» невыбранных не бывает.
            "final": default_route,
            "auto_detect_interface": true,
            // Адрес сервера разрешается системой, иначе поднять туннель нечем.
            "default_domain_resolver": { "server": "local" },
        },
    });
    if wireguard {
        cfg["endpoints"] = json!([node]);
    }
    if let Some(listen) = &opts.pprof {
        cfg["experimental"]["debug"] = json!({ "listen": listen });
    }
    cfg
}

/// Разбор отдельно от переменной: тесты идут в одном процессе, и `set_var`
/// из одного отравил бы соседние.
fn pprof_value(raw: &str) -> Option<String> {
    let value = raw.trim();
    (!value.is_empty()).then(|| value.to_string())
}

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

/// Где искать sing-box: переменная окружения → настройка → рядом с бинарником
/// → PATH.
pub fn binary() -> PathBuf {
    if let Some(p) = std::env::var_os("PG_SINGBOX") {
        return PathBuf::from(p);
    }
    if let Some(p) = CONFIGURED.lock().ok().and_then(|s| s.clone()) {
        return p;
    }
    let name = if cfg!(windows) { "sing-box.exe" } else { "sing-box" };
    match std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(name))) {
        Some(p) if p.exists() => p,
        _ => PathBuf::from(name),
    }
}

pub struct Tunnel {
    child: Child,
    pub socks_port: u16,
    pub api_port: u16,
}

impl Tunnel {
    pub fn start(config: &Value, dir: &Path) -> io::Result<Self> {
        let socks_port = config["inbounds"][0]["listen_port"].as_u64().unwrap_or(0) as u16;
        let api_port = config["experimental"]["clash_api"]["external_controller"]
            .as_str()
            .and_then(|a| a.rsplit(':').next())
            .and_then(|p| p.parse().ok())
            .unwrap_or(0);
        std::fs::create_dir_all(dir)?;
        reap_orphan(dir);
        let path = dir.join("singbox.json");
        std::fs::write(&path, serde_json::to_vec_pretty(config).map_err(io::Error::other)?)?;
        let log_path = dir.join("singbox.log");
        let log = std::fs::File::create(&log_path)?;
        let mut child = Command::new(binary())
            .arg("run")
            .arg("-c")
            .arg(&path)
            .arg("-D")
            .arg(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()
            .map_err(|e| io::Error::new(e.kind(), t(&format!("не запускается sing-box ({}): {e}", binary().display()), &format!("cannot start sing-box ({}): {e}", binary().display()))))?;

        // Занятый порт, битый конфиг, нет прав на TUN — всё это видно сразу.
        // Без этой паузы служба бесконечно докладывала бы «подключение».
        std::thread::sleep(STARTUP_GRACE);
        if !matches!(child.try_wait(), Ok(None)) {
            return Err(io::Error::other(t(&format!("sing-box завершился сразу: {}", last_line(&log_path)), &format!("sing-box exited immediately: {}", last_line(&log_path)))));
        }
        let _ = std::fs::write(dir.join("singbox.pid"), child.id().to_string());
        Ok(Self { child, socks_port, api_port })
    }

    /// Процесс жив? Мёртвый процесс = туннеля нет = выбранным приложениям DROP.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Последняя содержательная строка лога sing-box — она объясняет отказ запуска.
fn last_line(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(strip_ansi)
        .unwrap_or_else(|| t("причина не записана", "no reason recorded"))
}

/// Логгер sing-box красит уровень даже в файл — в журнале службы это мусор.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// Служба, убитая сигналом, не успевает выполнить Drop — и sing-box остаётся
/// жить с поднятым TUN, но без присмотра: упадёт сервер, и выбранные приложения
/// уйдут напрямую, потому что блокировать их некому. Поэтому при старте
/// добиваем процесс из прошлого запуска.
fn reap_orphan(dir: &Path) {
    let pid_file = dir.join("singbox.pid");
    let Ok(pid) = std::fs::read_to_string(&pid_file) else { return };
    let pid = pid.trim();
    if pid.parse::<u32>().is_err() {
        return;
    }
    // Проверка имени обязательна: PID мог быть переиспользован другим процессом.
    let killed = if cfg!(windows) {
        Command::new("taskkill").args(["/F", "/IM", "sing-box.exe", "/FI", &format!("PID eq {pid}")]).output()
    } else {
        match Command::new("ps").args(["-p", pid, "-o", "comm="]).output() {
            Ok(o) if String::from_utf8_lossy(&o.stdout).trim() == "sing-box" => {
                Command::new("kill").args(["-9", pid]).output()
            }
            other => other,
        }
    };
    let _ = killed;
    let _ = std::fs::remove_file(pid_file);
}

impl Drop for Tunnel {
    /// Служба падает — sing-box не остаётся сиротой с поднятым TUN.
    fn drop(&mut self) {
        self.stop();
    }
}

/// Проба здоровья: SOCKS5 CONNECT через локальный вход. Возвращает задержку в мс.
/// Свободная функция, а не метод: служба пробует туннель, не держа общий замок.
pub fn probe(socks_port: u16, target: (&str, u16)) -> io::Result<u32> {
    let started = Instant::now();
    let s = socks5_connect(socks_port, target)?;
    let _ = s.shutdown(Shutdown::Both);
    Ok(started.elapsed().as_millis() as u32)
}

/// Свободный порт у ядра. 48292/48293 занимает живой туннель, а проверочному
/// инстансу нужны свои.
///
/// ponytail: между тем, как порт освобождён здесь, и тем, как его займёт
/// sing-box, есть щель — влезший туда чужой процесс сорвёт запуск, и прогон
/// покажет это ошибкой профиля. По-настоящему зарезервировать порт нечем:
/// биндит его не наш процесс. Потолок — редкая ложная ошибка в прогоне;
/// апгрейд — передавать sing-box уже открытый сокет, чего он не умеет.
fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// Проверка профиля, не трогая живой туннель: отдельный sing-box без TUN, без
/// правил по `process_path`, на своих портах и в своём каталоге. Ни маршрутов
/// системы, ни брандмауэра он не касается — что бы в прогоне ни сломалось,
/// пользователь не останется без сети, а fail-closed основного туннеля не
/// сдвинется ни на такт.
///
/// Отдельный каталог обязателен: `Tunnel::start` добивает процесс из
/// `singbox.pid`, и общий каталог с основным туннелем означал бы, что прогон
/// убивает как раз тот туннель, который проверяет.
///
/// Трафик этого инстанса при поднятом основном туннеле уходит через TUN и
/// попадает под `final: direct` — цепочки из двух туннелей не выходит, и
/// задержка меряется настоящая.
///
/// `geo` — спрашивать ли заодно точку выхода. Решает это служба (`PG_GEO`):
/// адрес наружу один на весь проект, и распоряжаться им должно одно место.
pub fn measure(node: &Value, dir: &Path, target: (&str, u16), geo: bool) -> io::Result<(u32, Option<Exit>)> {
    // Стек берётся из умолчания и роли не играет: без TUN его некому читать.
    let opts = Options { socks_port: free_port()?, api_port: free_port()?, tun: false, apps: Vec::new(), all: false, ..Default::default() };
    let mut proc = Tunnel::start(&build_config(node, &opts), dir)?;
    let result = probe(opts.socks_port, target);
    // Пока инстанс жив, страна стоит одного запроса; поднимать ядро второй раз
    // ради неё дороже самой пробы. Спрашиваем только у ответившего профиля —
    // через мёртвый некого. Не узнали — не показываем: вердикт профиля решает
    // задержка, а не страна.
    let country = match (&result, geo) {
        (Ok(_), true) => exit_country(opts.socks_port).ok(),
        _ => None,
    };
    proc.stop();
    // Оставленный PID — это шанс, что следующий прогон добьёт по
    // переиспользованному номеру чужой процесс, а по имени sing-box проверочного
    // от sing-box живого туннеля не отличить.
    let _ = std::fs::remove_file(dir.join("singbox.pid"));
    result.map(|ms| (ms, country))
}

/// Инстанс под одно окно браузера: свой sing-box, свои порты, свой каталог.
/// Возвращается он живым — гасить его решает служба, а не мы.
///
/// TUN здесь не просто не нужен, а вреден: второй TUN с `auto_route` и
/// `strict_route` перехватил бы и исходящее соединение основного sing-box —
/// туннели выстроились бы в цепочку, и к задержке добавился бы целый RTT до
/// чужого сервера. TUN держит ровно один инстанс, общий режим.
///
/// Правил по `process_path` тоже нет: кто хочет в этот туннель, тот и указывает
/// прокси (`--proxy-server=socks5://127.0.0.1:<порт>`). Остального трафика
/// машины этот инстанс не касается вообще, а умрёт — браузер просто останется
/// без сети: прокси откажет, и мимо туннеля не уйдёт ничего.
///
/// Каталог свой по той же причине, что у прогона: `Tunnel::start` добивает
/// процесс из `singbox.pid`, и общий каталог означал бы, что окно браузера
/// гасит основной туннель.
pub fn sidecar(node: &Value, dir: &Path) -> io::Result<Tunnel> {
    // `all` тут бессмысленно: маршрута по умолчанию у инстанса без TUN нет,
    // в туннель идёт только тот, кто сам пришёл на его порт.
    // Стек берётся из умолчания и роли не играет: без TUN его некому читать.
    let opts = Options { socks_port: free_port()?, api_port: free_port()?, tun: false, apps: Vec::new(), all: false, ..Default::default() };
    Tunnel::start(&build_config(node, &opts), dir)
}

/// Хост, у которого спрашиваем точку выхода. Единственный внешний адрес,
/// который трогает служба.
pub const GEO_HOST: &str = "ip-api.com";

/// Страна точки выхода. Запрос идёт **через туннель**: спросить напрямую значит
/// узнать страну самого пользователя и заодно показать ему третью сторону.
///
/// Это единственное место, где проект ходит наружу, и сделано это по явному
/// решению: иначе точку выхода не узнать никак — она известна только тому, кто
/// видит наш адрес снаружи.
///
/// ponytail: обычный HTTP, а не TLS. Ответ содержит наш же исходящий адрес,
/// который и так стоит в заголовке пакета, поэтому шифрование тут почти ничего
/// не прячет. Чего оно бы дало — защиту от подмены ответа: по пути от выходного
/// узла до сервиса страну можно подделать. Если это станет важно, менять на
/// https://www.cloudflare.com/cdn-cgi/trace, но это тянет TLS-стек в зависимости.
pub fn exit_country(socks_port: u16) -> io::Result<Exit> {
    let mut s = socks5_connect(socks_port, (GEO_HOST, 80))?;
    s.write_all(
        format!(
            "GET /json/?fields=status,message,country,countryCode,city&lang=ru HTTP/1.0\r\n\
             Host: {GEO_HOST}\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    )?;
    let mut raw = String::new();
    s.read_to_string(&mut raw)?;
    parse_country(&raw)
}

/// Точка выхода: как её называет геосервис и её код ISO 3166-1 alpha-2. Код —
/// ради окна: из него рисуется флаг страны, а «Нидерланды, Амстердам» в строку
/// профиля не помещается и уходит в подсказку. Глифы флагов приезжают своим
/// шрифтом (`ui/app-shell/src/index.css`): в Windows их нет — Segoe UI Emoji
/// флагов не содержит, и система показала бы две буквы в квадратиках.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exit {
    pub name: String,
    /// None — сервис кода не прислал; тогда в окне остаётся полное название.
    pub code: Option<String>,
}

/// Из HTTP-ответа ip-api — «Страна, Город» и код страны. Сервис отвечает 200 и
/// на отказ, уводя причину в поле status, так что код ответа тут ничего не решает.
fn parse_country(raw: &str) -> io::Result<Exit> {
    // Ответ обязан начинаться со статусной строки. Иначе в потоке остался
    // невычитанный хвост SOCKS, и молча резать по первому \r\n\r\n нельзя:
    // тело разберётся как ни в чём не бывало, а ошибка уедет в тихую.
    if !raw.starts_with("HTTP/") {
        return Err(io::Error::other(t(&format!("{GEO_HOST}: ответ не похож на HTTP"), &format!("{GEO_HOST}: the reply is not HTTP"))));
    }
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or_default();
    let v: Value = serde_json::from_str(body.trim()).map_err(io::Error::other)?;
    if v["status"] != "success" {
        let why = v["message"].as_str().unwrap_or("—");
        return Err(io::Error::other(format!("{GEO_HOST}: {why}")));
    }
    let country = v["country"].as_str().unwrap_or_default();
    if country.is_empty() {
        return Err(io::Error::other(t(&format!("{GEO_HOST}: в ответе нет страны"), &format!("{GEO_HOST}: no country in the reply"))));
    }
    Ok(Exit {
        name: match v["city"].as_str().unwrap_or_default() {
            "" => country.to_string(),
            city => format!("{country}, {city}"),
        },
        code: match v["countryCode"].as_str().unwrap_or_default() {
            "" => None,
            code => Some(code.to_uppercase()),
        },
    })
}

/// Ответ Clash API `/connections` целиком: и суммарные счётчики, и список живых
/// соединений. Один запрос на обоих потребителей — надзор качал это тело каждые
/// три секунды и всё, кроме двух чисел, выбрасывал.
fn clash(api_port: u16) -> io::Result<Value> {
    let addr = SocketAddr::from(([127, 0, 0, 1], api_port));
    let mut s = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT)?;
    s.set_read_timeout(Some(PROBE_TIMEOUT))?;
    s.write_all(b"GET /connections HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")?;
    let mut raw = String::new();
    s.read_to_string(&mut raw)?;
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or_default();
    serde_json::from_str(body).map_err(io::Error::other)
}

/// Счётчики трафика из Clash API sing-box: (принято, отправлено) байт за сеанс.
pub fn traffic(api_port: u16) -> io::Result<(u64, u64)> {
    let v = clash(api_port)?;
    Ok((v["downloadTotal"].as_u64().unwrap_or(0), v["uploadTotal"].as_u64().unwrap_or(0)))
}

/// Живые соединения туннеля, самые говорливые первыми. Ничего не сохраняется:
/// список собирается на запрос и умирает вместе с ответом.
pub fn connections(api_port: u16) -> io::Result<Vec<Conn>> {
    let v = clash(api_port)?;
    let mut conns: Vec<Conn> = v["connections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|c| parse_conn(c))
        .collect();
    // Самые говорливые первыми: список живёт секунды, и первые строки — это
    // единственное, что человек успевает прочитать.
    conns.sort_by_key(|c| std::cmp::Reverse(c.rx + c.tx));
    Ok(conns)
}

/// Разбор одного соединения. Цепочка маршрутов, а не список приложений: список
/// — намерение, цепочка — то, что вышло на самом деле.
fn parse_conn(c: &Value) -> Conn {
    let meta = &c["metadata"];
    let str_of = |v: &Value| v.as_str().unwrap_or_default().to_string();
    // Домен известен не всегда: соединение по голому адресу так и остаётся
    // адресом, и подменять его нечем — DNS у нас никто не подслушивает.
    let host = match str_of(&meta["host"]) {
        empty if empty.is_empty() => str_of(&meta["destinationIP"]),
        host => host,
    };
    let port = str_of(&meta["destinationPort"]);
    Conn {
        process: str_of(&meta["processPath"]),
        host: if port.is_empty() { host } else { format!("{host}:{port}") },
        tunneled: c["chains"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .any(|tag| tag == TAG_PROXY),
        rx: c["download"].as_u64().unwrap_or(0),
        tx: c["upload"].as_u64().unwrap_or(0),
    }
}

/// SOCKS5 CONNECT через локальный вход sing-box. Отдаёт установленный поток:
/// проба его сразу закрывает, запрос страны — пишет в него дальше.
fn socks5_connect(port: u16, (host, target_port): (&str, u16)) -> io::Result<TcpStream> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT)?;
    s.set_read_timeout(Some(PROBE_TIMEOUT))?;
    s.set_write_timeout(Some(PROBE_TIMEOUT))?;

    s.write_all(&[0x05, 0x01, 0x00])?; // версия 5, один метод: без аутентификации
    let mut hello = [0u8; 2];
    s.read_exact(&mut hello)?;
    if hello != [0x05, 0x00] {
        return Err(io::Error::other(t(&format!("SOCKS5: неожиданный ответ {hello:?}"), &format!("SOCKS5: unexpected reply {hello:?}"))));
    }

    let host = host.as_bytes();
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host);
    req.extend_from_slice(&target_port.to_be_bytes());
    s.write_all(&req)?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head)?;
    if head[1] != 0x00 {
        return Err(io::Error::other(t(&format!("туннель не пропустил соединение (код {})", head[1]), &format!("the tunnel refused the connection (code {})", head[1]))));
    }
    // Хвост ответа (BND.ADDR + BND.PORT) обязателен к вычитыванию: иначе он
    // останется в потоке и слипнется с телом следующего чтения.
    let bnd = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len)?;
            len[0] as usize
        }
        atyp => return Err(io::Error::other(t(&format!("SOCKS5: неизвестный тип адреса {atyp}"), &format!("SOCKS5: unknown address type {atyp}")))),
    };
    s.read_exact(&mut vec![0u8; bnd + 2])?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Разбор соединения из Clash API. Проверяется главное: маршрут читается
    /// из цепочки, а не из имени процесса, и голый адрес не подменяется
    /// пустым доменом.
    #[test]
    fn conn_reads_its_route_from_the_chain() {
        let tunneled = parse_conn(&json!({
            "metadata": {
                "host": "example.com",
                "destinationIP": "93.184.216.34",
                "destinationPort": "443",
                "processPath": r"C:\Program Files\app.exe",
            },
            "chains": [TAG_PROXY],
            "download": 2048,
            "upload": 512,
        }));
        assert_eq!(tunneled.host, "example.com:443", "домен известен — показываем его");
        assert!(tunneled.tunneled);
        assert_eq!((tunneled.rx, tunneled.tx), (2048, 512));

        // Тот же процесс мимо туннеля — тихий промах правила по process_path,
        // ради которого весь список и заведён.
        let direct = parse_conn(&json!({
            "metadata": { "destinationIP": "1.1.1.1", "destinationPort": "53" },
            "chains": ["direct"],
        }));
        assert_eq!(direct.host, "1.1.1.1:53", "домена нет — остаётся адрес");
        assert!(!direct.tunneled);
        assert!(direct.process.is_empty(), "процесса за DNS не бывает");
    }

    #[test]
    fn country_from_reply() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n\
                  {\"status\":\"success\",\"country\":\"Нидерланды\",\"countryCode\":\"NL\",\"city\":\"Амстердам\"}";
        let exit = parse_country(ok).unwrap();
        assert_eq!(exit.name, "Нидерланды, Амстердам");
        assert_eq!(exit.code.as_deref(), Some("NL"));

        let no_city = "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"success\",\"country\":\"Нидерланды\",\"city\":\"\"}";
        let exit = parse_country(no_city).unwrap();
        assert_eq!(exit.name, "Нидерланды");
        // Кода в ответе нет — окно покажет полное название, а не пустую метку.
        assert_eq!(exit.code, None);
    }

    /// Хвост ответа SOCKS (BND.ADDR+BND.PORT) обязан быть вычитан до тела HTTP.
    /// Забудь это — и первые байты тела окажутся мусором из адреса привязки,
    /// причём молча: JSON просто перестанет разбираться.
    #[test]
    fn socks_reply_tail_does_not_leak_into_body() {
        use std::io::Read as _;
        use std::net::TcpListener;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            let mut greeting = [0u8; 3];
            c.read_exact(&mut greeting).unwrap();
            c.write_all(&[0x05, 0x00]).unwrap();

            let mut head = [0u8; 5];
            c.read_exact(&mut head).unwrap();
            let mut rest = vec![0u8; head[4] as usize + 2];
            c.read_exact(&mut rest).unwrap();

            // Отвечаем доменным BND.ADDR — самый длинный хвост из возможных.
            let bnd = b"proxy.local";
            let mut reply = vec![0x05, 0x00, 0x00, 0x03, bnd.len() as u8];
            reply.extend_from_slice(bnd);
            reply.extend_from_slice(&80u16.to_be_bytes());
            c.write_all(&reply).unwrap();

            // Запрос надо вычитать целиком: закрыть сокет с недочитанными
            // байтами — значит послать клиенту RST вместо FIN, и тест упадёт
            // на обрыве связи, а не на том, что проверяет.
            let mut req = Vec::new();
            let mut byte = [0u8; 1];
            while !req.ends_with(b"\r\n\r\n") && c.read_exact(&mut byte).is_ok() {
                req.push(byte[0]);
            }
            // Не байтовый литерал: кириллица в b"..." не помещается.
            c.write_all(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n\
                 {\"status\":\"success\",\"country\":\"Нидерланды\",\"city\":\"Амстердам\"}"
                    .as_bytes(),
            )
            .unwrap();
        });

        assert_eq!(exit_country(port).unwrap().name, "Нидерланды, Амстердам");
        server.join().unwrap();
    }

    /// Отказ приезжает с кодом 200 — разбирать надо тело, а не статус HTTP.
    #[test]
    fn refusal_is_an_error_not_a_country() {
        let quota = "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"fail\",\"message\":\"private range\"}";
        let e = parse_country(quota).unwrap_err().to_string();
        assert!(e.contains("private range"), "причина отказа должна дойти до журнала: {e}");

        assert!(parse_country("HTTP/1.1 200 OK\r\n\r\nне json").is_err());
        assert!(
            parse_country("HTTP/1.1 200 OK\r\n\r\n{\"status\":\"success\"}").is_err(),
            "успех без страны — всё равно нечего показывать"
        );
    }
    use std::net::TcpListener;

    fn node() -> Value {
        json!({ "type": "trojan", "server": "a.com", "server_port": 443, "password": "p" })
    }

    #[test]
    fn selected_apps_have_no_fallback() {
        let cfg = build_config(
            &node(),
            &Options { apps: vec![r"C:\app.exe".into()], ..Default::default() },
        );
        let rules = cfg["route"]["rules"].as_array().unwrap();
        let app_rule = rules.iter().find(|r| r["process_path"].is_array()).expect("правило для приложений");
        assert_eq!(app_rule["outbound"], TAG_PROXY);
        assert_eq!(app_rule["process_path"][0], r"C:\app.exe");
        assert_eq!(cfg["route"]["final"], "direct", "чужой трафик идёт мимо туннеля");
        // Единственный маршрут выбранного приложения — proxy: запасного нет.
        assert!(
            !rules.iter().any(|r| r["process_path"].is_array() && r["outbound"] != TAG_PROXY),
            "у выбранных приложений не должно быть маршрута мимо туннеля",
        );
        assert_eq!(cfg["outbounds"][0]["tag"], TAG_PROXY);
    }

    /// «Весь трафик» — не «выбрать все приложения»: правил по пути процесса
    /// нет вовсе, туннель забирает маршрут по умолчанию.
    ///
    /// Это же и вся разница в расходе между охватами. Один матчер по процессу —
    /// и sing-box выясняет процесс для каждого соединения всей машины, до
    /// разбора правил; вернётся сюда список приложений «заодно, для порядка» —
    /// и тихий охват станет таким же дорогим, как охват по списку.
    #[test]
    fn all_traffic_takes_the_default_route() {
        let cfg = build_config(&node(), &Options { all: true, apps: vec![r"C:\app.exe".into()], ..Default::default() });
        assert_eq!(cfg["route"]["final"], TAG_PROXY);
        let rules = cfg["route"]["rules"].as_array().unwrap();
        assert!(
            !rules.iter().any(|r| r["process_path"].is_array()),
            "в режиме «весь трафик» список приложений не попадает в конфиг",
        );
    }

    /// Адрес шлюза обязан быть следующим за нашим: именно так его выводит
    /// `sing-tun` на Windows, своим его никто не назначает. Разъедутся
    /// константы — правило отбоя встанет на чужой адрес, шторм вернётся, и
    /// заметить это будет нечем: конфиг останется валидным.
    #[test]
    fn the_gateway_is_next_to_our_address() {
        let ours: std::net::Ipv4Addr = TUN_ADDR.parse().expect("наш адрес");
        let gateway: std::net::Ipv4Addr = TUN_GATEWAY.parse().expect("адрес шлюза");
        let next = std::net::Ipv4Addr::from(u32::from(ours) + 1);
        assert_eq!(gateway, next, "шлюз — это адрес, следующий за нашим");
        // И оба обязаны лежать в одной /30, иначе `isMyLoopbackAddress` не
        // считает шлюз своим и вся затея теряет смысл.
        assert_eq!(u32::from(ours) & !3, u32::from(gateway) & !3, "разные подсети");
    }

    /// Шлюз TUN отбивается, и правило стоит раньше всех прочих: на него светят
    /// SSDP и NAT-PMP, отвечать по нему некому, а без отбоя мгновенный отказ на
    /// `direct` превращается в шторм повторов (sing-box#4415).
    ///
    /// И главное: порт 53 обязан остаться снаружи. Под `auto_route` `sing-tun`
    /// прописывает адаптеру DNS-сервером этот же адрес, так что безусловный
    /// отбой снёс бы разрешение имён всей машине — тише, чем шторм, и куда
    /// хуже.
    #[test]
    fn the_tun_gateway_is_rejected_first() {
        let cfg = build_config(&node(), &Options::default());
        let rules = cfg["route"]["rules"].as_array().unwrap();
        let at = |action: &str| rules.iter().position(|r| r["action"] == action);
        let reject = at("reject").unwrap_or_else(|| panic!("отбоя нет вовсе: {rules:#?}"));
        // Впереди отбоя стоит только перехват DNS — он забирает 53-й порт себе,
        // и отбой до него не должен дотянуться. Всё остальное — после.
        assert_eq!(at("hijack-dns"), Some(0), "перехват DNS обязан быть первым: {rules:#?}");
        assert_eq!(reject, 1, "отбой обязан идти сразу за перехватом: {rules:#?}");
        assert!(reject < at("sniff").unwrap(), "отбой обязан опережать разбор имени: {rules:#?}");
        let first = &rules[reject];
        // Молчание, а не отказ: отказ приходит так же мгновенно, как и отбой
        // самого sing-box, и шторм повторов от него не прекращается.
        assert_eq!(first["method"], "drop", "отбой обязан молчать, иначе повторы идут той же частотой");

        let inner = first["rules"].as_array().expect("отбой обязан быть составным: {first:#?}");
        assert_eq!(first["mode"], "and");
        assert!(inner.iter().any(|r| r["ip_cidr"][0] == format!("{TUN_GATEWAY}/32")), "{first:#?}");
        let dns = inner.iter().find(|r| r["port"][0] == 53).expect("порт 53 обязан быть назван: {first:#?}");
        assert_eq!(dns["invert"], true, "53 обязан быть исключён, а не пойман: {first:#?}");

        // Матчера по процессу правило не заводит — иначе лекарство стоило бы
        // дороже болезни. Проверяем и вложенные: `needFindProcess` включается
        // от любого правила в наборе, хоть трижды вложенного.
        assert!(first["process_path"].is_null());
        assert!(inner.iter().all(|r| r["process_path"].is_null()), "{first:#?}");

        // Без TUN шлюза не существует, и отбивать нечего.
        let bare = build_config(&node(), &Options { tun: false, ..Default::default() });
        let bare = bare["route"]["rules"].as_array().unwrap();
        assert!(bare.iter().all(|r| r["action"] != "reject"), "{bare:#?}");
    }

    /// Профилировщик появляется только по переменной и молчит без неё: открытый
    /// порт в службе, которая ходит от LocalSystem, — не та цена за удобство
    /// отладки. Пустая и пробельная строка — это «выключен», а не «слушать на
    /// пустом адресе»: иначе `PG_PPROF=` в скрипте поднял бы порт молча.
    #[test]
    fn the_profiler_is_off_unless_asked() {
        let off = build_config(&node(), &Options { pprof: None, ..Default::default() });
        assert!(off["experimental"]["debug"].is_null(), "без PG_PPROF отладочного порта нет");
        assert_eq!(pprof_value(""), None);
        assert_eq!(pprof_value("  "), None);
        assert_eq!(pprof_value(" 127.0.0.1:48294 "), Some("127.0.0.1:48294".to_string()));

        let on = build_config(&node(), &Options { pprof: Some("127.0.0.1:48294".into()), ..Default::default() });
        assert_eq!(on["experimental"]["debug"]["listen"], "127.0.0.1:48294");
        // Счётчики Clash при этом остаются на месте: обе секции живут в
        // `experimental`, и подстановка одной не должна затирать другую.
        assert!(on["experimental"]["clash_api"]["external_controller"].is_string());
    }

    #[test]
    fn tun_optional() {
        let with = build_config(&node(), &Options::default());
        assert_eq!(with["inbounds"][1]["type"], "tun");
        assert_eq!(with["inbounds"][1]["interface_name"], TUN_NAME);
        assert_ne!(with["inbounds"][1]["address"][0], "172.19.0.1/30", "умолчание чужих клиентов");
        let without = build_config(&node(), &Options { tun: false, ..Default::default() });
        assert_eq!(without["inbounds"].as_array().unwrap().len(), 1);
    }

    /// Проба подтверждает туннель ответом на SOCKS-запрос, а `sniff` заставляет
    /// sing-box отвечать раньше, чем он дозвонится наружу: он ждёт первых байтов,
    /// чтобы прочитать имя. Накрой сниффинг вход `local` — и мёртвый узел станет
    /// подтверждённым туннелем, а `guard(false)` снимет блокировку с выбранных
    /// приложений. Поймано тестом `measure_fails_on_a_dead_node`, когда правило
    /// стояло без указания входа.
    #[test]
    fn the_probe_path_is_never_sniffed() {
        for opts in [Options::default(), Options { tun: false, ..Default::default() }] {
            let cfg = build_config(&node(), &opts);
            for rule in cfg["route"]["rules"].as_array().unwrap() {
                if rule["action"] == "sniff" {
                    let on = rule["inbound"].as_array().expect("у sniff обязан быть явный вход");
                    assert_eq!(on, &vec![json!("tun-in")], "сниффинг накрыл пробу: {rule}");
                }
            }
        }
        // Без TUN сниффить нечего, и правила быть не должно вовсе.
        let bare = build_config(&node(), &Options { tun: false, ..Default::default() });
        assert!(bare["route"]["rules"].as_array().unwrap().iter().all(|r| r["action"] != "sniff"));
    }

    /// Имена разрешает сервер: секции `dns` не было вовсе, и запрос уходил
    /// системному резолверу, попадал под маршрут по умолчанию и возвращался в
    /// тот же TUN. Адрес самого сервера обязан идти мимо — иначе поднять туннель
    /// нечем: чтобы спросить `remote`, нужен уже поднятый `proxy`.
    #[test]
    fn names_are_resolved_by_the_server_but_the_server_is_not() {
        let cfg = build_config(&node(), &Options::default());
        assert_eq!(cfg["dns"]["final"], "remote");
        let remote = &cfg["dns"]["servers"][0];
        assert_eq!(remote["tag"], "remote");
        assert_eq!(remote["detour"], TAG_PROXY, "иначе имена утекают мимо туннеля");
        assert_eq!(cfg["route"]["default_domain_resolver"]["server"], "local");

        // Бутстрап обязан быть назван явно и ходить мимо туннеля. `type: local`
        // здесь — это резолвер системы, а после `auto_route` резолвер системы
        // это адрес нашего же шлюза TUN: ссылка на себя, которая с перехватом
        // DNS становится замкнутым циклом.
        let local = &cfg["dns"]["servers"][1];
        assert_eq!(local["tag"], "local");
        assert_ne!(local["type"], "local", "системный резолвер после auto_route указывает на нас самих");
        assert!(local["server"].is_string(), "бутстрап обязан быть назван адресом: {local}");
        assert_ne!(local["detour"], TAG_PROXY, "иначе адрес сервера разрешается через сам сервер");
        // И `detour: "direct"` тоже нельзя: наш `direct` — пустой outbound, а на
        // такой `detour` sing-box отказывается стартовать вовсе. Проверкой
        // конфига это не ловится, только запуском — см. `the_config_actually_starts`.
        assert!(local["detour"].is_null(), "detour на пустой direct не даёт службе стартовать: {local}");
        // Шифрованным: открытый UDP показал бы имя сервера всей сети по пути, а
        // у человека DNS на адаптере уже зашифрован — понижать молча нельзя.
        assert_eq!(local["type"], "https", "бутстрап обязан идти по DoH: {local}");
        assert!(
            local["server"].as_str().unwrap().parse::<std::net::IpAddr>().is_ok(),
            "бутстрап обязан быть адресом, а не именем: разрешать его нечем — {local}",
        );
    }

    /// DNS машины обязан перехватываться, иначе он утыкается в адрес, который
    /// `sing-tun` сам же и прописал адаптеру, — и там его никто не ждёт. Замер
    /// на живой машине: 1025 соединений из 1047 висели на `172.27.234.2:53` при
    /// нулевом сетевом трафике и 85% ЦП.
    ///
    /// Перехват обязан быть только на TUN: вход `local` — путь пробы, и трогать
    /// его нельзя по той же причине, по которой его не сниффят.
    #[test]
    fn the_machine_dns_is_hijacked_on_the_tun_only() {
        let cfg = build_config(&node(), &Options::default());
        let rules = cfg["route"]["rules"].as_array().unwrap();
        let hijack = rules
            .iter()
            .find(|r| r["action"] == "hijack-dns")
            .unwrap_or_else(|| panic!("перехвата DNS нет — вернётся шторм: {rules:#?}"));
        assert_eq!(hijack["inbound"][0], "tun-in", "перехват обязан быть только на TUN: {hijack}");
        assert_eq!(hijack["port"][0], 53);
        assert!(hijack["process_path"].is_null(), "матчера по процессу правило заводить не должно");

        // Без TUN перехватывать нечего, и путь пробы обязан остаться чистым.
        let bare = build_config(&node(), &Options { tun: false, ..Default::default() });
        let bare = bare["route"]["rules"].as_array().unwrap();
        assert!(bare.iter().all(|r| r["action"] != "hijack-dns"), "{bare:#?}");
    }

    /// Стек доезжает до конфига: без этого `PG_STACK` молча ничего не менял бы,
    /// а замер сравнивал бы один и тот же `mixed` сам с собой.
    #[test]
    fn tun_stack_reaches_the_config() {
        for stack in ["system", "gvisor", "mixed"] {
            let cfg = build_config(&node(), &Options { stack: stack.into(), ..Default::default() });
            assert_eq!(cfg["inbounds"][1]["stack"], stack);
        }
    }

    #[test]
    fn wireguard_goes_to_endpoints() {
        let wg = json!({ "type": "wireguard", "address": ["10.0.0.2/32"], "private_key": "k", "peers": [] });
        let cfg = build_config(&wg, &Options::default());
        assert_eq!(cfg["endpoints"][0]["tag"], TAG_PROXY);
        assert!(!cfg["outbounds"].as_array().unwrap().iter().any(|o| o["type"] == "wireguard"));
    }

    /// Проба говорит с настоящим SOCKS5-байтовым протоколом — проверяем на заглушке.
    #[test]
    fn probe_speaks_socks5() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 3];
            s.read_exact(&mut buf).unwrap();
            assert_eq!(buf, [0x05, 0x01, 0x00]);
            s.write_all(&[0x05, 0x00]).unwrap();
            let mut head = [0u8; 5];
            s.read_exact(&mut head).unwrap();
            let mut host = vec![0u8; head[4] as usize + 2];
            s.read_exact(&mut host).unwrap();
            assert_eq!(&host[..head[4] as usize], b"a.com");
            s.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).unwrap();
        });
        socks5_connect(port, ("a.com", 443)).expect("проба должна пройти");
    }

    #[test]
    fn probe_reports_refusal() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 3];
            let _ = s.read_exact(&mut buf);
            let _ = s.write_all(&[0x05, 0x00]);
            let mut head = [0u8; 5];
            let _ = s.read_exact(&mut head);
            let mut host = vec![0u8; head[4] as usize + 2];
            let _ = s.read_exact(&mut host);
            // 0x05 — connection refused
            let _ = s.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        });
        let err = socks5_connect(port, ("a.com", 443)).unwrap_err().to_string();
        assert!(err.contains("не пропустил"), "{err}");
    }

    /// Прогон профиля не должен ни поднимать TUN, ни отдавать успех, когда
    /// узел недоступен. Работает и без sing-box: тогда падает запуск, а не проба.
    #[test]
    fn measure_fails_on_a_dead_node() {
        let dir = std::env::temp_dir().join("pg-measure-test");
        let dead = json!({ "type": "trojan", "server": "127.0.0.1", "server_port": 1, "password": "p" });
        assert!(measure(&dead, &dir, ("127.0.0.1", 1), false).is_err(), "мёртвый узел обязан стать ошибкой");
        assert_ne!(free_port().unwrap(), 0, "порт должен быть настоящим");
    }

    #[test]
    fn ansi_stripped() {
        assert_eq!(strip_ansi("\u{1b}[31mFATAL\u{1b}[0m[0000] порт занят"), "FATAL[0000] порт занят");
        assert_eq!(strip_ansi("  обычная строка "), "обычная строка");
    }

    /// Упавший на старте sing-box — это ошибка запуска, а не «подключение».
    #[test]
    fn start_reports_immediate_death() {
        if Command::new(binary()).arg("version").output().is_err() {
            return; // sing-box не установлен
        }
        let dir = std::env::temp_dir().join("pg-start-fail");
        let broken = json!({
            "inbounds": [{ "type": "mixed", "tag": "local", "listen": "127.0.0.1", "listen_port": 1 }],
            "outbounds": [{ "type": "direct", "tag": "direct" }],
            "route": { "final": "direct" },
        });
        let err = match Tunnel::start(&broken, &dir) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("порт 1 занять нельзя"),
        };
        assert!(err.contains("завершился сразу"), "{err}");
    }

    /// Конфиг проверяется настоящим sing-box, если он есть (PG_SINGBOX или PATH).
    #[test]
    fn config_passes_singbox_check() {
        let dir = std::env::temp_dir().join("pg-cfg-check");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.json");
        for link in [
            "vless://b831381d-6324-4d53-ad4f-8cda48b30811@a.com:443?security=tls&type=ws&path=/x&sni=a.com&fp=chrome",
            "vmess://b831381d-6324-4d53-ad4f-8cda48b30811@a.com:443?type=grpc&serviceName=s&security=tls",
            "trojan://p@a.com:443?alpn=h2,http/1.1",
            "ss://YWVzLTI1Ni1nY206cGFzcw@a.com:8388",
            "hy2://p@a.com:443?obfs-password=o&insecure=1&sni=a.com",
            "wg://QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNk@a.com:51820?publickey=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNk&address=10.0.0.2/32",
        ] {
            let node = core_config::parse(link).expect(link).node;
            let cfg = build_config(&node, &Options { tun: false, apps: vec!["/bin/true".into()], ..Default::default() });
            std::fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
            let out = match Command::new(binary()).arg("check").arg("-c").arg(&path).output() {
                Ok(o) => o,
                Err(_) => return, // sing-box не установлен — проверять нечем
            };
            assert!(out.status.success(), "{link}: {}", String::from_utf8_lossy(&out.stderr));
        }
    }

    /// Конфиг с включённым TUN тоже должен проходить проверку sing-box:
    /// именно его увидит Windows, а остальные тесты гоняют вариант без TUN.
    #[test]
    /// Конфиг обязан не только разбираться, но и **запускаться**, и это разные
    /// вещи. `sing-box check` проверяет разбор: `detour: "direct"` на нашем
    /// пустом `direct`-outbound он пропускает молча, а служба на нём падает при
    /// старте с «detour to an empty direct outbound makes no sense». Ровно так и
    /// случилось — поймано запуском уже после того, как проверка конфига дала
    /// зелёный свет.
    ///
    /// Без TUN и на свободных портах: прав на TUN у тестов нет, а постоянные
    /// порты столкнулись бы с живой службой на машине разработчика.
    #[test]
    fn the_config_actually_starts() {
        let Ok((socks_port, api_port)) = free_port().and_then(|a| Ok((a, free_port()?))) else {
            return;
        };
        let node = core_config::parse("trojan://p@127.0.0.1:1").unwrap().node;
        let opts = Options { tun: false, socks_port, api_port, ..Default::default() };
        let dir = std::env::temp_dir().join("pg-start-check");
        let _ = std::fs::remove_dir_all(&dir);
        match Tunnel::start(&build_config(&node, &opts), &dir) {
            Ok(mut live) => live.stop(),
            // sing-box не установлен — проверять нечем; отличаем по тексту,
            // потому что любой другой отказ здесь обязан валить тест.
            Err(e) if e.to_string().contains("не запускается") || e.to_string().contains("cannot start") => {}
            Err(e) => panic!("конфиг разбирается, но служба на нём не поднимается: {e}"),
        }
    }

    #[test]
    fn tun_config_passes_singbox_check() {
        let node = core_config::parse("trojan://p@a.com:443").unwrap().node;
        let dir = std::env::temp_dir().join("pg-tun-check");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.json");
        // Обе ветки: без профилировщика и с ним. Имя секции и поля внутри
        // компилятор не проверяет никак — ошибись в них, и служба узнает об
        // этом только на живой машине, отказом запуска.
        for pprof in [None, Some("127.0.0.1:48294".to_string())] {
            let cfg = build_config(&node, &Options { apps: vec![r"C:\app.exe".into()], pprof, ..Default::default() });
            std::fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
            let Ok(out) = Command::new(binary()).arg("check").arg("-c").arg(&path).output() else {
                return; // sing-box не установлен
            };
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
    }

}
