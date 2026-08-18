//! Туннель = процесс sing-box под присмотром службы.
//!
//! Своей реализации VLESS/VMESS/Trojan/SS/Hysteria2/WireGuard мы не пишем: этим
//! занимается sing-box, как в NekoBox, — мы генерируем ему конфиг и следим за
//! процессом. Перехват per-process тоже конфиг, а не драйвер: TUN + правила
//! маршрутизации по `process_path`. Приложения не из списка уходят в `direct`,
//! выбранные — только в `proxy`, без запасного маршрута. Это и есть fail-closed:
//! упал сервер — соединения выбранных приложений просто не устанавливаются.

use core_ipc::t;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const TAG_PROXY: &str = "proxy";
/// Имя нашего TUN-адаптера: по нему его видно в системе и не спутать с чужим.
pub const TUN_NAME: &str = "Privacy Gateway";
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
    pub apps: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self { socks_port: 48292, api_port: 48293, tun: true, apps: Vec::new() }
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
            // 172.19.0.1/30 — умолчание sing-box, а значит и NekoBox, Hiddify,
            // v2rayN: с любым из них адрес и имя адаптера столкнулись бы лоб в
            // лоб. Берём свои, чтобы конфликт был виден как чужой туннель, а не
            // как загадочный отказ TUN.
            "interface_name": TUN_NAME,
            "address": ["172.27.234.1/30"],
            "auto_route": true,
            "strict_route": true,
            "stack": "mixed",
        }));
    }

    let mut rules = vec![json!({ "inbound": ["local"], "action": "route", "outbound": TAG_PROXY })];
    if !opts.apps.is_empty() {
        rules.push(json!({ "process_path": opts.apps, "action": "route", "outbound": TAG_PROXY }));
    }

    let mut cfg = json!({
        "log": { "level": "warn" },
        "experimental": { "clash_api": { "external_controller": format!("127.0.0.1:{}", opts.api_port) } },
        "inbounds": inbounds,
        "outbounds": if wireguard { json!([{ "type": "direct", "tag": "direct" }]) }
                     else { json!([node, { "type": "direct", "tag": "direct" }]) },
        "route": {
            "rules": rules,
            // Всё, что не выбрано, идёт напрямую: чужой трафик мы не трогаем.
            "final": "direct",
            "auto_detect_interface": true,
        },
    });
    if wireguard {
        cfg["endpoints"] = json!([node]);
    }
    cfg
}

/// Где искать sing-box: переменная окружения → рядом с бинарником → PATH.
pub fn binary() -> PathBuf {
    if let Some(p) = std::env::var_os("PG_SINGBOX") {
        return PathBuf::from(p);
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
pub fn measure(node: &Value, dir: &Path, target: (&str, u16)) -> io::Result<u32> {
    let opts = Options { socks_port: free_port()?, api_port: free_port()?, tun: false, apps: Vec::new() };
    let mut proc = Tunnel::start(&build_config(node, &opts), dir)?;
    let result = probe(opts.socks_port, target);
    proc.stop();
    // Оставленный PID — это шанс, что следующий прогон добьёт по
    // переиспользованному номеру чужой процесс, а по имени sing-box проверочного
    // от sing-box живого туннеля не отличить.
    let _ = std::fs::remove_file(dir.join("singbox.pid"));
    result
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
pub fn exit_country(socks_port: u16) -> io::Result<String> {
    let mut s = socks5_connect(socks_port, (GEO_HOST, 80))?;
    s.write_all(
        format!(
            "GET /json/?fields=status,message,country,city&lang=ru HTTP/1.0\r\n\
             Host: {GEO_HOST}\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    )?;
    let mut raw = String::new();
    s.read_to_string(&mut raw)?;
    parse_country(&raw)
}

/// Из HTTP-ответа ip-api — «Страна, Город». Сервис отвечает 200 и на отказ,
/// уводя причину в поле status, так что код ответа тут ничего не решает.
fn parse_country(raw: &str) -> io::Result<String> {
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
    Ok(match v["city"].as_str().unwrap_or_default() {
        "" => country.to_string(),
        city => format!("{country}, {city}"),
    })
}

/// Счётчики трафика из Clash API sing-box: (принято, отправлено) байт за сеанс.
pub fn traffic(api_port: u16) -> io::Result<(u64, u64)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], api_port));
    let mut s = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT)?;
    s.set_read_timeout(Some(PROBE_TIMEOUT))?;
    s.write_all(b"GET /connections HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")?;
    let mut raw = String::new();
    s.read_to_string(&mut raw)?;
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or_default();
    let v: Value = serde_json::from_str(body).map_err(io::Error::other)?;
    Ok((v["downloadTotal"].as_u64().unwrap_or(0), v["uploadTotal"].as_u64().unwrap_or(0)))
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

    #[test]
    fn country_from_reply() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n\
                  {\"status\":\"success\",\"country\":\"Нидерланды\",\"city\":\"Амстердам\"}";
        assert_eq!(parse_country(ok).unwrap(), "Нидерланды, Амстердам");

        let no_city = "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"success\",\"country\":\"Нидерланды\",\"city\":\"\"}";
        assert_eq!(parse_country(no_city).unwrap(), "Нидерланды");
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

        assert_eq!(exit_country(port).unwrap(), "Нидерланды, Амстердам");
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

    #[test]
    fn tun_optional() {
        let with = build_config(&node(), &Options::default());
        assert_eq!(with["inbounds"][1]["type"], "tun");
        assert_eq!(with["inbounds"][1]["interface_name"], TUN_NAME);
        assert_ne!(with["inbounds"][1]["address"][0], "172.19.0.1/30", "умолчание чужих клиентов");
        let without = build_config(&node(), &Options { tun: false, ..Default::default() });
        assert_eq!(without["inbounds"].as_array().unwrap().len(), 1);
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
        assert!(measure(&dead, &dir, ("127.0.0.1", 1)).is_err(), "мёртвый узел обязан стать ошибкой");
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
    fn tun_config_passes_singbox_check() {
        let node = core_config::parse("trojan://p@a.com:443").unwrap().node;
        let cfg = build_config(&node, &Options { apps: vec![r"C:\app.exe".into()], ..Default::default() });
        let dir = std::env::temp_dir().join("pg-tun-check");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
        let Ok(out) = Command::new(binary()).arg("check").arg("-c").arg(&path).output() else {
            return; // sing-box не установлен
        };
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

}
