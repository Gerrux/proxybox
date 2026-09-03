//! Парсер share-links → узел конфигурации sing-box.
//!
//! Раскладка полей повторяет NekoBox (`fmt/Link2Bean.cpp` + `fmt/Bean2CoreObj_box.cpp`):
//! это де-факто формат, на который ориентируются панели и генераторы ссылок.
//! Промежуточной модели протокола (Bean) у нас нет — редактировать узлы руками
//! пока негде, а значит и хранить их в двух видах незачем.

use base64::Engine;
use core_ipc::{t, tf};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use url::Url;

pub type Node = Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub name: String,
    /// Узел sing-box: `outbound` для всех протоколов, кроме WireGuard —
    /// у того в схеме 1.13 это `endpoint`. Различает по `type` core-tunnel.
    pub node: Node,
}

pub fn parse(link: &str) -> Result<Profile, String> {
    let link = link.trim();
    // JSON принимаем наравне со ссылкой: у продвинутых узлов (свои transport,
    // ECH, мультиплекс) share-link просто нет — их отдают конфигом.
    if link.starts_with('{') {
        return from_json(link);
    }
    // Строка без «://» — не ссылка вовсе, и звать её протоколом нельзя: до
    // этого причина отказа выходила вида «протокол не поддерживается: не ссылка
    // вовсе», то есть повторяла саму строку вместо объяснения. Раньше это
    // видел только тот, кто вставлял одну строку; теперь причины пропуска едут
    // в окно списком, и таких строк там бывает десяток.
    let Some((scheme, _)) = link.split_once("://") else {
        return Err(t("не ссылка: нет схемы"));
    };
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "vless" => vless(link),
        "trojan" => trojan(link),
        "vmess" => vmess(link),
        "ss" => shadowsocks(link),
        "hy2" | "hysteria2" => hysteria2(link),
        "tuic" => tuic(link),
        "wg" | "wireguard" => wireguard(link),
        "" => Err(t("не ссылка: нет схемы")),
        s => Err(tf!("протокол не поддерживается: {}", s)),
    }
}

/// Что вышло из тела: разобранные профили и причины по каждой строке, которая
/// профилем не стала.
///
/// Причины ездят рядом с находками, а не вместо них: терять всю подписку из-за
/// одного незнакомого протокола не за что, но и молчать о пропущенном нельзя —
/// вставили полсотни строк, приехало двенадцать, и куда делись остальные, до сих
/// пор нельзя было спросить нигде.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Batch {
    pub found: Vec<Profile>,
    /// По строке на пропущенную: обрезанное начало строки и причина отказа.
    /// Строка обрезана намеренно — в ней бывает пароль узла, а едет она в окно
    /// и в журнал.
    pub skipped: Vec<String>,
}

/// Начало строки для сообщения об отказе. Обрезаем по символам, а не по байтам:
/// в имени узла кириллица и эмодзи — норма, а срез посреди символа паникует.
fn head(line: &str) -> String {
    let short: String = line.chars().take(40).collect();
    if short.chars().count() < line.chars().count() {
        format!("{short}…")
    } else {
        short
    }
}

/// Тело подписки → профили. Панель отдаёт список ссылок либо открытым текстом,
/// либо целиком в base64 — второе встречается чаще.
pub fn parse_many(body: &str) -> Batch {
    // Переносы внутри base64 — норма для подписок, `b64` их не ждёт. Проверка
    // на `://` отсекает случай, когда открытый текст сам похож на base64.
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let decoded = b64_str(&compact).filter(|text| text.contains("://"));
    let mut out = Batch::default();
    for line in decoded
        .as_deref()
        .unwrap_or(body)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        match parse(line) {
            Ok(profile) => out.found.push(profile),
            Err(why) => out.skipped.push(format!("{}: {why}", head(line))),
        }
    }
    // Ни одной ссылки — либо адрес неверный, либо панель отдала Clash-YAML.
    // Разбор YAML стоит одного прохода по телу и отвечает пустым списком на
    // что угодно другое, так что различать эти случаи заранее не за чем.
    if out.found.is_empty() {
        let found = clash(body);
        // Пожаловаться на каждую строку YAML — это сотня одинаковых «не ссылка»
        // там, где всё разобралось: строки тела к ссылкам отношения не имеют.
        if !found.is_empty() {
            return Batch { found, skipped: Vec::new() };
        }
    }
    out
}

/// Типы узлов, которые мы согласны поднимать. Именно белый список, а не
/// «всё, кроме служебного»: узел едет в outbounds sing-box как есть, и профиль
/// `{"type":"direct"}` — из подписки или из вставленного JSON — стартовал бы
/// нормально, проба через локальный вход проходила бы, служба сняла бы
/// блокировку, а трафик выбранных приложений шёл бы в открытую сеть под
/// надписью «Защищено». Чёрный список этого не ловит: он и не мог, он про
/// служебные outbound'ы, да и работал только для конфига целиком — голый
/// объект проходил мимо него.
const NODES: [&str; 10] = [
    "vless", "vmess", "trojan", "shadowsocks", "hysteria", "hysteria2", "tuic", "anytls", "wireguard", "ssh",
];

/// Куда ведёт узел: тип sing-box и `host:port` сервера. Ровно это едет в окно
/// вместе с именем — имя профилю даёт чужая панель, и по нему не отличить два
/// одинаково названных узла от одного, заведённого дважды.
///
/// Живёт здесь, а не в службе: где у узла лежит адрес, знает разбор. У
/// WireGuard это первый пир, у остальных `server`/`server_port`.
pub fn describe(node: &Value) -> (String, String) {
    let kind = node["type"].as_str().unwrap_or_default().to_string();
    let (host, port) = match node["server"].as_str() {
        Some(host) => (host, node["server_port"].as_u64()),
        None => (node["peers"][0]["address"].as_str().unwrap_or_default(), node["peers"][0]["port"].as_u64()),
    };
    let server = match (host, port) {
        ("", _) => String::new(),
        (host, Some(port)) => format!("{host}:{port}"),
        (host, None) => host.to_string(),
    };
    (kind, server)
}

fn is_node(value: &Value) -> bool {
    value["type"].as_str().is_some_and(|kind| NODES.contains(&kind))
}

/// Конфиг sing-box: либо целиком (берём первый узел), либо один узел объектом.
/// Служебные outbound'ы (direct/block/dns и группы) узлами не считаются.
fn from_json(text: &str) -> Result<Profile, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| tf!("не разбирается как JSON: {}", e))?;

    let node = match value.get("outbounds").and_then(Value::as_array) {
        Some(outbounds) => outbounds
            .iter()
            .find(|o| is_node(o))
            .cloned()
            .ok_or_else(|| t("в конфиге нет ни одного узла — только служебные outbound"))?,
        None => value.clone(),
    };
    let kind = node["type"].as_str().ok_or_else(|| t("в узле нет поля type"))?.to_string();
    if !is_node(&node) {
        return Err(tf!("тип узла не поддерживается: {}", kind));
    }
    if node["server"].as_str().is_none() && node["peers"][0]["address"].as_str().is_none() {
        return Err(tf!("в узле {} не указан сервер", kind));
    }
    let name = match node["tag"].as_str() {
        Some(tag) if !tag.is_empty() && tag != "proxy" => tag.to_string(),
        _ => format!("{kind}-{}", node["server"].as_str().unwrap_or("узел")),
    };
    Ok(Profile { name, node })
}

// --- разбор общей части ссылки -------------------------------------------

struct Link {
    url: Url,
    query: HashMap<String, String>,
}

impl Link {
    fn new(link: &str) -> Result<Self, String> {
        let url = Url::parse(link).map_err(|e| tf!("ссылка не разбирается: {}", e))?;
        let query = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        Ok(Self { url, query })
    }

    fn host(&self) -> Result<String, String> {
        self.url.host_str().filter(|h| !h.is_empty()).map(str::to_owned).ok_or_else(|| t("нет адреса сервера"))
    }

    fn port(&self, default: u16) -> u16 {
        self.url.port().unwrap_or(default)
    }

    fn user(&self) -> String {
        decode(self.url.username())
    }

    fn name(&self, fallback: &str) -> String {
        match self.url.fragment() {
            Some(f) if !f.is_empty() => decode(f),
            _ => fallback.to_string(),
        }
    }

    fn q(&self, key: &str) -> Option<&str> {
        self.query.get(key).map(String::as_str).filter(|v| !v.is_empty())
    }
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// base64 в ссылках приходит во всех четырёх вариантах: url-safe и обычный,
/// с паддингом и без. Пробуем по очереди, как это делает DecodeB64IfValid.
fn b64(s: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose as g;
    let s = s.trim_end_matches('=');
    g::URL_SAFE_NO_PAD.decode(s).or_else(|_| g::STANDARD_NO_PAD.decode(s)).ok()
}

fn b64_str(s: &str) -> Option<String> {
    String::from_utf8(b64(s)?).ok()
}

// --- транспорт и TLS (общая часть vless/vmess/trojan) --------------------

/// v2ray-transport: ws / http / grpc / httpupgrade. `tcp` без headerType —
/// это отсутствие секции transport, а не отдельный тип.
fn transport(l: &Link) -> Option<Value> {
    let net = match l.q("type").unwrap_or("tcp") {
        "h2" => "http",
        other => other,
    };
    let path = l.q("path").unwrap_or_default();
    let host = l.q("host").unwrap_or_default();
    let mut t = Map::new();
    match net {
        "ws" => {
            t.insert("type".into(), json!("ws"));
            // ?ed=N в пути — ранние данные, а не часть пути.
            let (path, ed) = path.split_once("?ed=").unwrap_or((path, ""));
            if !path.is_empty() {
                t.insert("path".into(), json!(path));
            }
            if let Ok(ed) = ed.parse::<u32>() {
                t.insert("max_early_data".into(), json!(ed));
                t.insert("early_data_header_name".into(), json!("Sec-WebSocket-Protocol"));
            }
            if !host.is_empty() {
                t.insert("headers".into(), json!({ "Host": host }));
            }
        }
        "http" => {
            t.insert("type".into(), json!("http"));
            if !path.is_empty() {
                t.insert("path".into(), json!(path));
            }
            if !host.is_empty() {
                t.insert("host".into(), json!(host.replace('|', ",").split(',').collect::<Vec<_>>()));
            }
        }
        "httpupgrade" => {
            t.insert("type".into(), json!("httpupgrade"));
            if !path.is_empty() {
                t.insert("path".into(), json!(path));
            }
            if !host.is_empty() {
                t.insert("host".into(), json!(host));
            }
        }
        "grpc" => {
            t.insert("type".into(), json!("grpc"));
            if let Some(s) = l.q("serviceName") {
                t.insert("service_name".into(), json!(s));
            }
        }
        "tcp" if l.q("headerType") == Some("http") => {
            t.insert("type".into(), json!("http"));
            t.insert("method".into(), json!("GET"));
            t.insert("path".into(), json!(path));
            if !host.is_empty() {
                t.insert("headers".into(), json!({ "Host": host.split(',').collect::<Vec<_>>() }));
            }
        }
        _ => return None,
    }
    Some(Value::Object(t))
}

fn tls(l: &Link, default_on: bool) -> Option<Value> {
    let security = l.q("security").unwrap_or(if default_on { "tls" } else { "" });
    if !matches!(security, "tls" | "reality" | "xtls") {
        return None;
    }
    let mut t = Map::new();
    t.insert("enabled".into(), json!(true));
    if let Some(sni) = l.q("sni").or_else(|| l.q("peer")) {
        t.insert("server_name".into(), json!(sni));
    }
    if let Some(alpn) = l.q("alpn") {
        t.insert("alpn".into(), json!(alpn.split(',').collect::<Vec<_>>()));
    }
    if matches!(l.q("allowInsecure").or_else(|| l.q("insecure")), Some("1" | "true")) {
        t.insert("insecure".into(), json!(true));
    }
    let mut fp = l.q("fp").unwrap_or_default().to_string();
    if let Some(pbk) = l.q("pbk") {
        t.insert(
            "reality".into(),
            json!({
                "enabled": true,
                "public_key": pbk,
                "short_id": l.q("sid").unwrap_or_default().split(',').next().unwrap_or_default(),
            }),
        );
        if fp.is_empty() {
            fp = "chrome".into();
        }
    }
    if !fp.is_empty() {
        t.insert("utls".into(), json!({ "enabled": true, "fingerprint": fp }));
    }
    Some(Value::Object(t))
}

fn finish(node: &mut Value, l: &Link) {
    let obj = node.as_object_mut().expect("узел — объект");
    if let Some(t) = transport(l) {
        obj.insert("transport".into(), t);
    }
    let default_tls = obj["type"] == "trojan";
    if let Some(t) = tls(l, default_tls) {
        obj.insert("tls".into(), t);
    }
}

// --- протоколы ------------------------------------------------------------

fn vless(link: &str) -> Result<Profile, String> {
    let l = Link::new(link)?;
    let uuid = l.user();
    if uuid.is_empty() {
        return Err(t("нет UUID в ссылке vless"));
    }
    let mut node = json!({
        "type": "vless",
        "server": l.host()?,
        "server_port": l.port(443),
        "uuid": uuid,
        "packet_encoding": "xudp",
    });
    // flow=xtls-rprx-vision-udp443 и flow=none — формы записи «без flow».
    if let Some(flow) = l.q("flow") {
        let flow = flow.trim_end_matches("-udp443");
        if flow != "none" {
            node["flow"] = json!(flow);
        }
    }
    finish(&mut node, &l);
    Ok(Profile { name: l.name(&format!("vless-{}", l.host()?)), node })
}

fn trojan(link: &str) -> Result<Profile, String> {
    let l = Link::new(link)?;
    let password = l.user();
    if password.is_empty() {
        return Err(t("нет пароля в ссылке trojan"));
    }
    let mut node = json!({
        "type": "trojan",
        "server": l.host()?,
        "server_port": l.port(443),
        "password": password,
    });
    finish(&mut node, &l);
    Ok(Profile { name: l.name(&format!("trojan-{}", l.host()?)), node })
}

fn vmess(link: &str) -> Result<Profile, String> {
    // Формат v2rayN: vmess://base64(json). Если не разобралось — форма-ссылка.
    let body = link.split_once("://").map(|(_, b)| b).unwrap_or_default();
    let Some(obj) = b64_str(body).and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
        return vmess_url(link);
    };
    let str_of = |k: &str| obj.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    // port и aid приходят то числом, то строкой.
    let num_of = |k: &str| match obj.get(k) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or_default(),
        Some(Value::String(s)) => s.parse().unwrap_or_default(),
        _ => 0,
    };
    let server = str_of("add");
    if server.is_empty() || str_of("id").is_empty() {
        return Err(t("в vmess-конфиге нет add или id"));
    }
    let mut node = json!({
        "type": "vmess",
        "server": server,
        "server_port": num_of("port"),
        "uuid": str_of("id"),
        "alter_id": num_of("aid"),
        "security": if str_of("scy").is_empty() { "auto".into() } else { str_of("scy") },
        "packet_encoding": "xudp",
    });
    // Секция stream у v2rayN разложена по плоским ключам — собираем ссылку-эквивалент.
    let net = match str_of("net").as_str() {
        "" => "tcp".into(),
        "h2" => "http".into(),
        other => other.to_string(),
    };
    let mut q = format!("type={net}");
    for (k, v) in [("path", str_of("path")), ("host", str_of("host")), ("sni", str_of("sni")), ("headerType", str_of("type"))] {
        if !v.is_empty() {
            q += &format!("&{k}={v}");
        }
    }
    if str_of("tls") == "tls" {
        q += "&security=tls";
    }
    let synth = Link::new(&format!("vmess://x@{}:{}?{q}", node["server"].as_str().unwrap_or("x"), num_of("port")))?;
    finish(&mut node, &synth);
    let name = str_of("ps");
    Ok(Profile { name: if name.is_empty() { format!("vmess-{}", node["server"]) } else { name }, node })
}

fn vmess_url(link: &str) -> Result<Profile, String> {
    let l = Link::new(link)?;
    let uuid = l.user();
    if uuid.is_empty() {
        return Err(t("нет UUID в ссылке vmess"));
    }
    let mut node = json!({
        "type": "vmess",
        "server": l.host()?,
        "server_port": l.port(443),
        "uuid": uuid,
        // Ссылка-форма alterId не несёт, но из Clash-YAML он приходит, и узел
        // со старым alterId молча не соединился бы.
        "alter_id": l.q("alterId").and_then(|a| a.parse::<u32>().ok()).unwrap_or(0),
        "security": l.q("encryption").unwrap_or("auto"),
        "packet_encoding": "xudp",
    });
    finish(&mut node, &l);
    Ok(Profile { name: l.name(&format!("vmess-{}", l.host()?)), node })
}

fn shadowsocks(link: &str) -> Result<Profile, String> {
    // Три формы: SIP002 (base64 userinfo), 2022 (открытый method:password)
    // и старая v2rayN — целиком base64 после схемы.
    let body = link.split_once("://").map(|(_, b)| b).unwrap_or_default();
    let link = if body.split('#').next().unwrap_or_default().contains('@') {
        link.to_string()
    } else {
        let (blob, frag) = body.split_once('#').unwrap_or((body, ""));
        let decoded = b64_str(blob).ok_or_else(|| t("ссылка ss не разбирается"))?;
        format!("ss://{decoded}{}{frag}", if frag.is_empty() { "" } else { "#" })
    };
    let l = Link::new(&link)?;
    let (method, password) = match l.url.password() {
        Some(p) => (l.user(), decode(p)),
        None => {
            let mp = b64_str(l.url.username()).ok_or_else(|| t("в ссылке ss нет method:password"))?;
            let (m, p) = mp.split_once(':').ok_or_else(|| t("в ссылке ss нет method:password"))?;
            (m.to_string(), p.to_string())
        }
    };
    if method.is_empty() || password.is_empty() {
        return Err(t("в ссылке ss нет method:password"));
    }
    let mut node = json!({
        "type": "shadowsocks",
        "server": l.host()?,
        "server_port": l.port(8388),
        "method": method,
        "password": password,
    });
    if let Some(plugin) = l.q("plugin") {
        let plugin = plugin.replace("simple-obfs;", "obfs-local;");
        let (name, opts) = plugin.split_once(';').unwrap_or((plugin.as_str(), ""));
        node["plugin"] = json!(name);
        node["plugin_opts"] = json!(opts);
    }
    Ok(Profile { name: l.name(&format!("ss-{}", l.host()?)), node })
}

fn hysteria2(link: &str) -> Result<Profile, String> {
    let l = Link::new(link)?;
    let password = match l.url.password() {
        Some(p) => format!("{}:{}", l.user(), decode(p)),
        None => l.user(),
    };
    if password.is_empty() {
        return Err(t("нет пароля в ссылке hysteria2"));
    }
    let mut tls = json!({ "enabled": true, "alpn": ["h3"] });
    if let Some(sni) = l.q("sni") {
        tls["server_name"] = json!(sni);
    }
    if matches!(l.q("insecure"), Some("1" | "true")) {
        tls["insecure"] = json!(true);
    }
    let mut node = json!({
        "type": "hysteria2",
        "server": l.host()?,
        "server_port": l.port(443),
        "password": password,
        "tls": tls,
    });
    if let Some(obfs) = l.q("obfs-password") {
        node["obfs"] = json!({ "type": "salamander", "password": obfs });
    }
    if let Some(ports) = l.q("mport") {
        node["hop_ports"] = json!(ports);
    }
    Ok(Profile { name: l.name(&format!("hy2-{}", l.host()?)), node })
}

/// TUIC v5. Узел этого типа продукт принимал только конфигом: в белом списке
/// `NODES` он был с самого начала, а разбора ссылки не было — и узел из
/// подписки пропадал молча, потому что переложить его в ссылку было не во что.
///
/// v4 сюда не подходит и подходить не должен: там вместо пары «uuid + пароль»
/// один `token`, а `tuic` в sing-box — это v5. Ссылка без одной из половин
/// отвергается, а не достраивается пустой: профиль, который молча не
/// соединяется, хуже пропущенной строки.
///
/// Имена параметров берём в обоих написаниях. Ссылку пишет чужая панель, и
/// пишет она то через подчёркивание (v2rayN, NekoBox), то через дефис —
/// последнее приезжает из Clash-YAML, который мы сами же в ссылку и
/// перекладываем.
fn tuic(link: &str) -> Result<Profile, String> {
    let l = Link::new(link)?;
    let (uuid, password) = (l.user(), l.url.password().map(decode).unwrap_or_default());
    if uuid.is_empty() || password.is_empty() {
        return Err(t("ссылка tuic: нужны UUID и пароль"));
    }
    let mut tls = json!({ "enabled": true });
    if let Some(sni) = l.q("sni") {
        tls["server_name"] = json!(sni);
    }
    if let Some(alpn) = l.q("alpn") {
        tls["alpn"] = json!(alpn.split(',').collect::<Vec<_>>());
    }
    if matches!(l.q("allow_insecure").or_else(|| l.q("insecure")), Some("1" | "true")) {
        tls["insecure"] = json!(true);
    }
    let mut node = json!({
        "type": "tuic",
        "server": l.host()?,
        "server_port": l.port(443),
        "uuid": uuid,
        "password": password,
        "tls": tls,
    });
    // Умолчания sing-box (`cubic`, `native`) не дублируем: узел, в котором
    // написано ровно то, что прислала панель, легче сверить с её карточкой.
    for from in ["congestion_control", "congestion-controller"] {
        if let Some(value) = l.q(from) {
            node["congestion_control"] = json!(value);
        }
    }
    for from in ["udp_relay_mode", "udp-relay-mode"] {
        if let Some(value) = l.q(from) {
            node["udp_relay_mode"] = json!(value);
        }
    }
    if matches!(l.q("zero_rtt_handshake").or_else(|| l.q("reduce-rtt")).or_else(|| l.q("reduce_rtt")), Some("1" | "true")) {
        node["zero_rtt_handshake"] = json!(true);
    }
    Ok(Profile { name: l.name(&format!("tuic-{}", l.host()?)), node })
}

fn wireguard(link: &str) -> Result<Profile, String> {
    let l = Link::new(link)?;
    let private_key = l.user();
    let peer_key = l.q("publickey").or_else(|| l.q("pbk")).or_else(|| l.q("peer"));
    let (Some(peer_key), false) = (peer_key, private_key.is_empty()) else {
        return Err(t("ссылка wg: нужны приватный ключ в userinfo и publickey в запросе"));
    };
    let addresses: Vec<&str> = l.q("address").or_else(|| l.q("ip")).unwrap_or("10.0.0.2/32").split(',').collect();
    let mut peer = json!({
        "address": l.host()?,
        "port": l.port(51820),
        "public_key": decode(peer_key),
        "allowed_ips": ["0.0.0.0/0", "::/0"],
    });
    if let Some(psk) = l.q("presharedkey").or_else(|| l.q("psk")) {
        peer["pre_shared_key"] = json!(decode(psk));
    }
    if let Some(r) = l.q("reserved") {
        let reserved: Vec<u8> = r.split(',').filter_map(|v| v.trim().parse().ok()).collect();
        if reserved.len() == 3 {
            peer["reserved"] = json!(reserved);
        }
    }
    let mut node = json!({
        "type": "wireguard",
        "address": addresses,
        "private_key": private_key,
        "peers": [peer],
    });
    if let Some(mtu) = l.q("mtu").and_then(|m| m.parse::<u32>().ok()) {
        node["mtu"] = json!(mtu);
    }
    Ok(Profile { name: l.name(&format!("wg-{}", l.host()?)), node })
}

// --- Clash-YAML -----------------------------------------------------------

/// Панели отдают конфиг Clash тем, чей User-Agent им знаком, а некоторые — и
/// только его. Своей модели протоколов у нас нет (см. шапку модуля), поэтому
/// узел из YAML не собирается в sing-box напрямую, а превращается обратно в
/// share-link — дальше его разбирает ровно тот же код, что и обычную подписку.
///
/// ponytail: из YAML понимается подмножество, которым и написан `proxies:` —
/// вложенные отображения блоком и в фигурных скобках, списки в квадратных и
/// блоком, кавычки, метка якоря на узле и слияние по ней (`<<: *base`). За
/// границей остались якорь, объявленный вне `proxies:`, узел целиком из ссылки
/// (`- *node`) и многострочные скаляры: записанный так узел потеряет поле или
/// пропадёт целиком. Потолок виден по числу узлов в подписке, апгрейд — взять
/// saphyr.
fn clash(body: &str) -> Vec<Profile> {
    proxies(body).iter().filter_map(|node| parse(&link_of(node)?).ok()).collect()
}

/// Секция `proxies:` → по плоской карте на узел. Вложенность склеивается точкой
/// (`ws-opts.headers.host`), ключи приводятся к нижнему регистру: имена
/// заголовков и `alterId` панели пишут кто как.
fn proxies(body: &str) -> Vec<HashMap<String, String>> {
    let mut items: Vec<Vec<String>> = Vec::new();
    // Имя якоря на каждый узел, в том же порядке: по нему узлы находят друг
    // друга в `<<: *base`.
    let mut labels: Vec<Option<String>> = Vec::new();
    let mut inside = false;
    // Столбец, в котором стоят дефисы самих узлов. Дефис глубже — это список
    // внутри узла (`alpn:` и строки `- h3` под ним), и новым узлом он не
    // становится: пока столбец не запоминался, такой список расщеплял узел на
    // столько пустых, сколько в нём было значений.
    let mut dash = usize::MAX;
    for line in body.lines() {
        let text = line.trim_end();
        let bare = text.trim_start();
        if bare.is_empty() || bare.starts_with('#') {
            continue;
        }
        let indent = text.len() - bare.len();
        if !inside {
            inside = indent == 0 && bare.starts_with("proxies:");
            continue;
        }
        if indent == 0 {
            break; // начался следующий раздел конфига
        }
        match bare.strip_prefix("- ").filter(|_| indent <= dash) {
            // Дефис заменяем пробелами: тогда ключи первой строки узла стоят в
            // том же столбце, что и остальные, и вложенность считается отступом.
            //
            // От метки якоря на своей строке (`- &hk`, поля ниже) остаётся
            // строка из одних пробелов — её и не заводим: столбец у неё свой, и
            // разбор принял бы его за отступ всего узла, а поля — за чужие.
            Some(rest) => {
                dash = indent;
                labels.push(anchor_name(rest));
                let head = format!("{}  {}", " ".repeat(indent), unanchor(rest));
                items.push(if head.trim().is_empty() { Vec::new() } else { vec![head] });
            }
            None => {
                if let Some(item) = items.last_mut() {
                    item.push(text.to_string());
                }
            }
        }
    }
    let mut nodes: Vec<HashMap<String, String>> = items
        .iter()
        .map(|lines| {
            let mut node = HashMap::new();
            let joined = lines.join("\n");
            if joined.trim_start().starts_with('{') {
                flow(joined.trim(), "", &mut node);
            } else {
                let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
                block(&refs, "", &mut node);
            }
            node
        })
        .collect();
    // Слияние — вторым проходом, а не по дороге: якорь по правилам YAML стоит
    // раньше ссылки на него, но проверять это построчно значило бы разбирать
    // документ дважды и здесь же. Дешевле собрать всё, а потом дополнить.
    let anchors: HashMap<String, HashMap<String, String>> = labels
        .iter()
        .zip(nodes.iter())
        .filter_map(|(label, node)| Some((label.clone()?, node.clone())))
        .collect();
    for node in &mut nodes {
        merge(node, &anchors);
    }
    nodes
}

/// Слияние отображений (`<<: *base`) — так панели выносят общий кусок узла
/// (TLS, транспорт) в один якорь и повторяют его у полусотни узлов. Без этого
/// у каждого из них не хватало ровно вынесенного, и профиль либо пропадал, либо
/// заводился недособранным.
///
/// Своё сильнее общего: `entry().or_insert` не перебивает то, что у узла уже
/// написано, — в YAML `<<` и означает «остальное возьми оттуда».
///
/// Ключей у `<<` бывает несколько (`<<: [*a, *b]`), и наш `scalar` сводит
/// список к строке через запятую ещё до нас. Якорь, которого мы не видели
/// (объявлен вне `proxies:`), пропускается молча: узел останется неполным и не
/// пройдёт разбор — то же, что и было.
fn merge(node: &mut HashMap<String, String>, anchors: &HashMap<String, HashMap<String, String>>) {
    let Some(from) = node.remove("<<") else { return };
    for name in from.split(',') {
        let Some(base) = name.trim().strip_prefix('*').and_then(|n| anchors.get(n)) else { continue };
        for (key, value) in base {
            node.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
}

/// Имя якоря узла, если оно есть: по нему на узел ссылается `<<:` соседа.
fn anchor_name(rest: &str) -> Option<String> {
    let tail = rest.strip_prefix('&')?;
    let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
    Some(tail[..end].to_string())
}

/// Метка якоря в начале узла (`- &hk {server: …}`). Панели ставят её, чтобы
/// ссылаться на узел из `proxy-groups`, а тот раздел мы не читаем вовсе, —
/// значит метка тут лишняя, и узел из-за неё пропадал целиком.
///
/// Заменяется пробелами, а не выбрасывается: столбцы первой строки узла обязаны
/// совпадать со столбцами остальных — на них и держится вложенность.
///
/// Ссылку на якорь (`- *hk`) снимать нечем и не надо: узел она не описывает, а
/// повторяет соседний, и разбор без полей отбросит её сам.
fn unanchor(rest: &str) -> String {
    let Some(tail) = rest.strip_prefix('&') else { return rest.to_string() };
    let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
    format!("{}{}", " ".repeat(end + 1), &tail[end..])
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Список блоком (`alpn:`, а ниже строки `- h3`) → строка через запятую, ровно
/// та же, что выходит из списка в квадратных скобках: дальше их разбирают
/// одинаково. Так панели пишут `alpn` и `dns` не реже, чем скобками, а
/// вложенный разбор терял их целиком — в строке `- h3` нет двоеточия, и она
/// проходила мимо.
///
/// `None` — это не список, а вложенное отображение. Список отображений
/// (`- name: x`) тоже считается отображением: в `proxies:` его не бывает, а
/// склеить его в скаляр значило бы соврать значением вместо пропажи.
fn sequence(lines: &[&str]) -> Option<String> {
    let mut items = Vec::new();
    for line in lines {
        let item = line.trim().strip_prefix('-')?.trim();
        if item.contains(": ") || item.ends_with(':') {
            return None;
        }
        if !item.is_empty() {
            items.push(unquote(item));
        }
    }
    (!items.is_empty()).then(|| items.join(","))
}

fn block(lines: &[&str], prefix: &str, out: &mut HashMap<String, String>) {
    let base = lines.first().map(|l| indent(l)).unwrap_or(0);
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if indent(line) != base {
            continue; // строку глубже уже забрал вложенный разбор
        }
        let Some((key, value)) = line.trim().split_once(':') else { continue };
        let key = format!("{prefix}{}", unquote(key).to_lowercase());
        let value = value.trim();
        if value.is_empty() {
            // Вложенный блок — всё, что ниже и с бо́льшим отступом.
            let start = i;
            while i < lines.len() && indent(lines[i]) > base {
                i += 1;
            }
            let nested = &lines[start..i];
            match sequence(nested) {
                Some(list) => {
                    out.insert(key, list);
                }
                None => block(nested, &format!("{key}."), out),
            }
        } else if value.starts_with('{') {
            flow(value, &format!("{key}."), out);
        } else {
            out.insert(key, scalar(value));
        }
    }
}

fn flow(text: &str, prefix: &str, out: &mut HashMap<String, String>) {
    let inner = text.trim().trim_start_matches('{').trim_end_matches('}');
    for part in split_top(inner) {
        let Some((key, value)) = part.split_once(':') else { continue };
        let key = format!("{prefix}{}", unquote(key).to_lowercase());
        let value = value.trim();
        if value.starts_with('{') {
            flow(value, &format!("{key}."), out);
        } else {
            out.insert(key, scalar(value));
        }
    }
}

/// Разрез по запятым верхнего уровня: внутри скобок и кавычек запятая — часть
/// значения, а не разделитель (пароли, alpn, reserved).
fn split_top(text: &str) -> Vec<&str> {
    let (mut parts, mut depth, mut quote, mut start) = (Vec::new(), 0i32, None, 0);
    for (i, c) in text.char_indices() {
        match c {
            '"' | '\'' if quote == Some(c) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(c),
            '{' | '[' if quote.is_none() => depth += 1,
            '}' | ']' if quote.is_none() => depth -= 1,
            ',' if quote.is_none() && depth == 0 => {
                parts.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// Значение узла. Список в квадратных скобках сводится к строке через запятую:
/// alpn и reserved именно так и разбираются дальше.
fn scalar(value: &str) -> String {
    let value = value.trim();
    match value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        Some(list) => split_top(list).iter().map(|v| unquote(v)).collect::<Vec<_>>().join(","),
        None => unquote(value),
    }
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].replace(&format!("\\{quote}"), &quote.to_string());
        }
    }
    value.to_string()
}

/// Незарезервированные символы RFC 3986 — всё остальное кодируем: в пароле и в
/// пути законны и `&`, и `#`, и `?`, а собираем мы именно ссылку.
const KEEP: &percent_encoding::AsciiSet =
    &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

fn enc(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, KEEP).to_string()
}

fn add(q: &mut Vec<String>, key: &str, value: &str) {
    if !value.is_empty() {
        q.push(format!("{key}={}", enc(value)));
    }
}

/// Узел Clash → share-link. Узел, который так не переложить (ssr, snell,
/// socks5, tuic v4 с одним `token` или наш же протокол без обязательного поля),
/// пропускается: неполная ссылка дала бы профиль, который молча не соединяется.
fn link_of(node: &HashMap<String, String>) -> Option<String> {
    let get = |key: &str| node.get(key).map(String::as_str).unwrap_or_default();
    let server = match get("server") {
        // IPv6 в Clash без скобок, а в ссылке без них не отделить адрес от порта.
        s if s.contains(':') && !s.starts_with('[') => format!("[{s}]"),
        s => s.to_string(),
    };
    // У hysteria2 бывает вообще без `port` — только диапазон `ports`.
    let port = match get("port") {
        "" => get("ports").split(['-', ',']).next().unwrap_or_default(),
        port => port,
    };
    if server.is_empty() || port.is_empty() {
        return None;
    }
    let kind = get("type");
    let mut q: Vec<String> = Vec::new();
    let link = match kind {
        "vless" | "vmess" | "trojan" => {
            let user = if kind == "trojan" { get("password") } else { get("uuid") };
            if user.is_empty() {
                return None;
            }
            stream(node, &mut q, kind == "trojan");
            add(&mut q, "flow", get("flow"));
            if kind == "vmess" {
                add(&mut q, "encryption", get("cipher"));
                add(&mut q, "alterId", get("alterid"));
            }
            format!("{kind}://{}@{server}:{port}", enc(user))
        }
        "ss" => {
            let (method, password) = (get("cipher"), get("password"));
            if method.is_empty() || password.is_empty() {
                return None;
            }
            // Плагин, который не переложить, — это не «узел без плагина», а
            // другой узел: такому место в пропущенных.
            match get("plugin") {
                "" => {}
                "obfs" | "simple-obfs" => add(
                    &mut q,
                    "plugin",
                    &format!("obfs-local;obfs={};obfs-host={}", get("plugin-opts.mode"), get("plugin-opts.host")),
                ),
                _ => return None,
            }
            format!("ss://{}:{}@{server}:{port}", enc(method), enc(password))
        }
        "hysteria2" => {
            let password = get("password");
            if password.is_empty() {
                return None;
            }
            add(&mut q, "sni", get("sni"));
            // Обфускация в sing-box одна — salamander, и она же единственная,
            // которую несёт ссылка.
            if get("obfs") == "salamander" {
                add(&mut q, "obfs-password", get("obfs-password"));
            }
            if get("skip-cert-verify") == "true" {
                add(&mut q, "insecure", "1");
            }
            add(&mut q, "mport", get("ports"));
            format!("hy2://{}@{server}:{port}", enc(password))
        }
        "tuic" => {
            // v4 отдаёт `token` вместо пары, а `tuic` в sing-box — это v5:
            // собранная из половины ссылка дала бы профиль, который молча не
            // соединяется.
            let (uuid, password) = (get("uuid"), get("password"));
            if uuid.is_empty() || password.is_empty() {
                return None;
            }
            add(&mut q, "sni", get("sni"));
            add(&mut q, "alpn", get("alpn"));
            add(&mut q, "congestion-controller", get("congestion-controller"));
            add(&mut q, "udp-relay-mode", get("udp-relay-mode"));
            if get("skip-cert-verify") == "true" {
                add(&mut q, "allow_insecure", "1");
            }
            if get("reduce-rtt") == "true" {
                add(&mut q, "reduce-rtt", "1");
            }
            format!("tuic://{}:{}@{server}:{port}", enc(uuid), enc(password))
        }
        "wireguard" => {
            let private = get("private-key");
            if private.is_empty() || get("public-key").is_empty() {
                return None;
            }
            add(&mut q, "publickey", get("public-key"));
            add(&mut q, "psk", get("pre-shared-key"));
            add(&mut q, "reserved", get("reserved"));
            add(&mut q, "mtu", get("mtu"));
            // Адрес в Clash пишут без маски, а sing-box ждёт префикс.
            let address: Vec<String> = [("ip", "32"), ("ipv6", "128")]
                .into_iter()
                .map(|(key, bits)| (get(key), bits))
                .filter(|(value, _)| !value.is_empty())
                .map(|(value, bits)| if value.contains('/') { value.to_string() } else { format!("{value}/{bits}") })
                .collect();
            add(&mut q, "address", &address.join(","));
            format!("wg://{}@{server}:{port}", enc(private))
        }
        _ => return None,
    };
    let query = if q.is_empty() { String::new() } else { format!("?{}", q.join("&")) };
    Some(format!("{link}{query}#{}", enc(get("name"))))
}

/// Транспорт и TLS у vless/vmess/trojan описаны одинаково, а в ссылке это те же
/// ключи, что и у панелей: обратно их читают `transport()` и `tls()`.
fn stream(node: &HashMap<String, String>, q: &mut Vec<String>, tls_by_default: bool) {
    let get = |key: &str| node.get(key).map(String::as_str).unwrap_or_default();
    let net = get("network");
    match net {
        "ws" => {
            let mut path = get("ws-opts.path").to_string();
            // Ранние данные едут в пути: отдельного ключа для них в ссылке нет.
            if !get("ws-opts.max-early-data").is_empty() {
                path += &format!("?ed={}", get("ws-opts.max-early-data"));
            }
            add(q, "path", &path);
            add(q, "host", get("ws-opts.headers.host"));
        }
        "grpc" => add(q, "serviceName", get("grpc-opts.grpc-service-name")),
        "h2" | "http" => {
            add(q, "path", get(&format!("{net}-opts.path")));
            add(q, "host", get(&format!("{net}-opts.host")));
        }
        _ => {}
    }
    add(q, "type", net);

    let reality = get("reality-opts.public-key");
    if !(get("tls") == "true" || tls_by_default || !reality.is_empty()) {
        return;
    }
    if reality.is_empty() {
        add(q, "security", "tls");
    } else {
        add(q, "security", "reality");
        add(q, "pbk", reality);
        add(q, "sid", get("reality-opts.short-id"));
    }
    let sni = ["servername", "sni", "peer"].into_iter().map(get).find(|v| !v.is_empty()).unwrap_or_default();
    add(q, "sni", sni);
    add(q, "alpn", get("alpn"));
    add(q, "fp", get("client-fingerprint"));
    if get("skip-cert-verify") == "true" {
        add(q, "allowInsecure", "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "b831381d-6324-4d53-ad4f-8cda48b30811";

    #[test]
    fn vless_reality() {
        let p = parse(&format!(
            "vless://{UUID}@example.com:8443?security=reality&pbk=KEY&sid=ab&fp=chrome&flow=xtls-rprx-vision-udp443&type=tcp#%D0%A3%D0%B7%D0%B5%D0%BB"
        ))
        .unwrap();
        assert_eq!(p.name, "Узел", "имя берётся из фрагмента и раскодируется");
        assert_eq!(p.node["type"], "vless");
        assert_eq!(p.node["server_port"], 8443);
        assert_eq!(p.node["uuid"], UUID);
        assert_eq!(p.node["flow"], "xtls-rprx-vision", "суффикс -udp443 отбрасывается");
        assert_eq!(p.node["tls"]["reality"]["public_key"], "KEY");
        assert_eq!(p.node["tls"]["utls"]["fingerprint"], "chrome");
        assert!(p.node.get("transport").is_none(), "tcp без headerType — без transport");
    }

    #[test]
    fn vless_ws_early_data() {
        let p = parse(&format!("vless://{UUID}@a.com:443?type=ws&path=/x%3Fed%3D2048&host=a.com&security=tls")).unwrap();
        assert_eq!(p.node["transport"]["type"], "ws");
        assert_eq!(p.node["transport"]["path"], "/x");
        assert_eq!(p.node["transport"]["max_early_data"], 2048);
        assert_eq!(p.node["transport"]["headers"]["Host"], "a.com");
    }

    #[test]
    fn vless_flow_none_dropped() {
        let p = parse(&format!("vless://{UUID}@a.com:443?flow=none")).unwrap();
        assert!(p.node.get("flow").is_none());
    }

    #[test]
    fn trojan_tls_by_default() {
        let p = parse("trojan://pass@a.com:443?sni=b.com#T").unwrap();
        assert_eq!(p.node["password"], "pass");
        assert_eq!(p.node["tls"]["enabled"], true, "у trojan TLS включён и без ?security");
        assert_eq!(p.node["tls"]["server_name"], "b.com");
    }

    #[test]
    fn vmess_v2rayn_base64() {
        let raw = format!(
            r#"{{"v":"2","ps":"узел","add":"a.com","port":"443","id":"{UUID}","aid":"0","net":"ws","path":"/p","host":"h.com","tls":"tls","scy":"auto"}}"#
        );
        let link = format!("vmess://{}", base64::engine::general_purpose::STANDARD.encode(raw));
        let p = parse(&link).unwrap();
        assert_eq!(p.name, "узел");
        assert_eq!(p.node["server_port"], 443, "порт-строка приводится к числу");
        assert_eq!(p.node["uuid"], UUID);
        assert_eq!(p.node["alter_id"], 0);
        assert_eq!(p.node["transport"]["path"], "/p");
        assert_eq!(p.node["tls"]["enabled"], true);
    }

    #[test]
    fn vmess_url_form() {
        let p = parse(&format!("vmess://{UUID}@a.com:443?type=grpc&serviceName=svc&security=tls#V")).unwrap();
        assert_eq!(p.node["transport"]["service_name"], "svc");
        assert_eq!(p.node["alter_id"], 0);
    }

    #[test]
    fn ss_sip002_and_legacy_and_2022() {
        let userinfo = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("aes-256-gcm:pass");
        let sip002 = parse(&format!("ss://{userinfo}@a.com:8388#S")).unwrap();
        assert_eq!(sip002.node["method"], "aes-256-gcm");
        assert_eq!(sip002.node["password"], "pass");
        assert_eq!(sip002.node["server_port"], 8388);

        let blob = base64::engine::general_purpose::STANDARD.encode("aes-256-gcm:pass@a.com:8388");
        let legacy = parse(&format!("ss://{blob}#S")).unwrap();
        assert_eq!(legacy.node, sip002.node, "старая форма даёт тот же узел");
        assert_eq!(legacy.name, "S");

        let y2022 = parse("ss://2022-blake3-aes-128-gcm:key%3D@a.com:8388").unwrap();
        assert_eq!(y2022.node["method"], "2022-blake3-aes-128-gcm");
        assert_eq!(y2022.node["password"], "key=", "пароль раскодируется из percent-encoding");
    }

    #[test]
    fn hysteria2_obfs() {
        let p = parse("hy2://pass@a.com:443?obfs-password=o&sni=b.com&insecure=1#H").unwrap();
        assert_eq!(p.node["type"], "hysteria2");
        assert_eq!(p.node["obfs"]["type"], "salamander");
        assert_eq!(p.node["tls"]["insecure"], true);
        assert_eq!(p.node["tls"]["alpn"][0], "h3");
    }

    /// Строка «куда ведёт узел» обязана находить адрес у обоих раскладов:
    /// у WireGuard он в первом пире, у остальных в самом узле.
    #[test]
    fn a_node_says_where_it_goes() {
        let vless = parse("vless://u@a.com:443#N").unwrap();
        assert_eq!(describe(&vless.node), ("vless".into(), "a.com:443".into()));
        let wg = parse("wg://cHJpdmF0ZQ@a.com:51820?publickey=cHVibGlj&address=10.0.0.2/32").unwrap();
        assert_eq!(describe(&wg.node), ("wireguard".into(), "a.com:51820".into()));
        assert_eq!(describe(&serde_json::json!({})), (String::new(), String::new()), "пустой узел не паникует");
    }

    #[test]
    fn wireguard_endpoint() {
        let p = parse("wg://cHJpdmF0ZQ@a.com:51820?publickey=cHVibGlj&address=10.0.0.2/32&mtu=1408#W").unwrap();
        assert_eq!(p.node["type"], "wireguard");
        assert_eq!(p.node["peers"][0]["port"], 51820);
        assert_eq!(p.node["address"][0], "10.0.0.2/32");
        assert_eq!(p.node["mtu"], 1408);
    }

    #[test]
    fn json_node_and_full_config() {
        let node = parse(r#"{"type":"vless","tag":"Мой узел","server":"a.com","server_port":443,"uuid":"u"}"#).unwrap();
        assert_eq!(node.name, "Мой узел");
        assert_eq!(node.node["type"], "vless");

        let full = parse(
            r#"{"outbounds":[{"type":"direct","tag":"direct"},{"type":"trojan","server":"b.com","server_port":443,"password":"p"}]}"#,
        )
        .unwrap();
        assert_eq!(full.node["type"], "trojan", "служебные outbound пропускаются");
        assert_eq!(full.name, "trojan-b.com", "имени нет — собираем из типа и сервера");
    }

    /// Узел `direct` — это не туннель, а прямой выход: он поднимается, проба
    /// через него проходит, служба снимает блокировку, и трафик выбранных
    /// приложений идёт в открытую сеть под надписью «Защищено». Пройти он не
    /// должен ни объектом, ни строкой подписки, ни внутри конфига целиком.
    #[test]
    fn direct_is_not_a_node() {
        let err = parse(r#"{"type":"direct","server":"a.com"}"#).unwrap_err();
        assert!(err.contains("не поддерживается"), "{err}");
        let err = parse(r#"{"outbounds":[{"type":"direct","server":"a.com"}]}"#).unwrap_err();
        assert!(err.contains("нет ни одного узла"), "{err}");

        let list = "vless://u@a.com:443#Живой\n{\"type\":\"direct\",\"server\":\"b.com\"}\n";
        let got = parse_many(list);
        assert_eq!(got.found.len(), 1, "битый узел выбрасывается, живой остаётся: {got:?}");
        assert_eq!(got.found[0].name, "Живой");
        assert_eq!(got.skipped.len(), 1, "и о нём сказано: {got:?}");
    }

    /// Подписка приходит в двух видах, и оба должны дать один и тот же список.
    /// TUIC продукт принимал только конфигом: тип в `NODES` был, разбора ссылки
    /// не было — и узел из подписки пропадал молча.
    ///
    /// Половина ссылки хуже её отсутствия: `tuic` в sing-box — это v5, а v4
    /// отдаёт один `token` вместо пары. Собранный из половины профиль молча не
    /// соединялся бы, и человек искал бы причину в сервере.
    #[test]
    fn tuic_link() {
        let p = parse("tuic://11111111-2222-3333-4444-555555555555:pa%3Ass@a.com:8443?sni=a.com&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1#Узел").unwrap();
        assert_eq!(p.name, "Узел");
        assert_eq!(p.node["type"], "tuic");
        assert_eq!(p.node["server_port"], 8443);
        assert_eq!(p.node["uuid"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(p.node["password"], "pa:ss", "пароль раскодируется из percent-encoding");
        assert_eq!(p.node["congestion_control"], "bbr");
        assert_eq!(p.node["udp_relay_mode"], "native");
        assert_eq!(p.node["tls"]["server_name"], "a.com");
        assert_eq!(p.node["tls"]["alpn"], serde_json::json!(["h3"]));
        assert_eq!(p.node["tls"]["insecure"], true);
        assert!(p.node.get("zero_rtt_handshake").is_none(), "чего не просили, того в узле нет");

        // Порт по умолчанию и умолчания sing-box, которых мы не дублируем.
        let bare = parse("tuic://uuid:pass@b.com").unwrap();
        assert_eq!(bare.node["server_port"], 443);
        assert_eq!(bare.node["tls"]["enabled"], true, "tuic без TLS не бывает");
        assert!(bare.node.get("congestion_control").is_none());

        // v4 (`token`) и любая другая половина — не узел.
        assert!(parse("tuic://token@c.com:443").is_err(), "без пароля ссылка не собирается");
        assert!(parse("tuic://:pass@c.com:443").is_err(), "без UUID тоже");
    }

    #[test]
    fn subscription_plain_and_base64() {
        let list = "vless://u@a.com:443?security=none#Первый\n\
                    trojan://p@b.com:443#Второй\n";
        let plain = parse_many(list);
        assert_eq!(plain.found.len(), 2, "{plain:?}");
        assert_eq!(plain.found[0].name, "Первый");
        assert_eq!(plain.found[1].name, "Второй");

        // Панели переносят base64 по строкам — это не должно ничего ломать.
        let encoded = base64::engine::general_purpose::STANDARD.encode(list);
        let wrapped = format!("{}\n{}", &encoded[..20], &encoded[20..]);
        assert_eq!(parse_many(&wrapped), plain, "base64 разбирается так же, как текст");
    }

    #[test]
    fn subscription_survives_junk() {
        let body = "# комментарий\n\
                    \n\
                    magnet://не-протокол\n\
                    vless://u@a.com:443?security=none#Живой\n\
                    не ссылка вовсе\n";
        let found = parse_many(body);
        assert_eq!(found.found.len(), 1, "мусор пропускается, а не роняет подписку: {found:?}");
        assert_eq!(found.found[0].name, "Живой");
        // Пропущенное названо: обе строки мусора со своей причиной, а
        // комментарий и пустая строка — не мусор и в счёт не идут.
        assert_eq!(found.skipped.len(), 2, "{found:?}");
        assert!(found.skipped[0].starts_with("magnet://не-протокол:"), "{found:?}");
        assert!(parse_many("").found.is_empty(), "пустое тело — пустой список");
    }

    /// Clash-YAML: панель отдаёт его вместо списка ссылок, и подписка обязана
    /// пережить это так же, как base64.
    #[test]
    fn subscription_clash_yaml() {
        let body = "\
port: 7890
mode: rule
proxies:
  - name: \"Узел ①\"
    type: vless
    server: nl.example.com
    port: 443
    uuid: b831381d-6324-4d53-ad4f-8cda48b30811
    flow: xtls-rprx-vision
    client-fingerprint: chrome
    reality-opts:
      public-key: PUBKEY
      short-id: ab12
    network: ws
    ws-opts:
      path: /ray
      max-early-data: 2048
      headers:
        Host: cdn.example.com
  - {name: SS, type: ss, server: ss.example.com, port: 8388, cipher: aes-256-gcm, password: \"p@ss,word\"}
  - name: VM
    type: vmess
    server: vm.example.com
    port: 443
    uuid: b831381d-6324-4d53-ad4f-8cda48b30811
    alterId: 4
    cipher: auto
    tls: true
    skip-cert-verify: true
    network: grpc
    grpc-opts:
      grpc-service-name: svc
  - name: HY
    type: hysteria2
    server: hy.example.com
    ports: \"443-8443\"
    password: pass
    obfs: salamander
    obfs-password: obfspass
    sni: hy.example.com
  - name: WG
    type: wireguard
    server: wg.example.com
    port: 51820
    private-key: cHJpdmF0ZQ
    public-key: cHVibGlj
    ip: 10.0.0.2
    mtu: 1408
    reserved: [1, 2, 3]
  - &common
    type: trojan
    server: tr.example.com
    port: 443
    password: trpass
    sni: tr.example.com
  - <<: *common
    name: MERGED
  - name: TU
    type: tuic
    server: tu.example.com
    port: 8443
    uuid: 11111111-2222-3333-4444-555555555555
    password: tupass
    congestion-controller: bbr
    udp-relay-mode: native
    sni: tu.example.com
  - name: TU4
    type: tuic
    server: old.example.com
    port: 8443
    token: legacy-token
  - &anchored
    name: TR
    type: trojan
    server: tr.example.com
    port: 443
    password: trpass
    sni: tr.example.com
    alpn:
      - h2
      - http/1.1
  - *anchored
  - name: SSR
    type: ssr
    server: x.example.com
    port: 1234
proxy-groups:
  - name: PROXY
    type: select
";
        let found = parse_many(body).found;
        let names: Vec<&str> = found.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            ["Узел ①", "SS", "VM", "HY", "WG", "trojan-tr.example.com", "MERGED", "TU", "TR"],
            "ssr не наш, tuic v4 с одним token — половина узла, ссылка на якорь узла не описывает"
        );

        let vless = &found[0].node;
        assert_eq!(vless["type"], "vless");
        assert_eq!(vless["server_port"], 443);
        assert_eq!(vless["flow"], "xtls-rprx-vision");
        assert_eq!(vless["tls"]["reality"]["public_key"], "PUBKEY", "reality-opts включает и сам TLS");
        assert_eq!(vless["tls"]["reality"]["short_id"], "ab12");
        assert_eq!(vless["tls"]["utls"]["fingerprint"], "chrome");
        assert_eq!(vless["transport"]["type"], "ws");
        assert_eq!(vless["transport"]["path"], "/ray");
        assert_eq!(vless["transport"]["max_early_data"], 2048);
        assert_eq!(vless["transport"]["headers"]["Host"], "cdn.example.com", "вложенность в три уровня");

        let ss = &found[1].node;
        assert_eq!(ss["method"], "aes-256-gcm");
        assert_eq!(ss["password"], "p@ss,word", "запятая внутри кавычек — часть пароля");
        assert_eq!(ss["server_port"], 8388);

        let vmess = &found[2].node;
        assert_eq!(vmess["alter_id"], 4, "alterId из Clash не теряется");
        assert_eq!(vmess["transport"]["service_name"], "svc");
        assert_eq!(vmess["tls"]["insecure"], true, "skip-cert-verify");

        let hy = &found[3].node;
        assert_eq!(hy["server_port"], 443, "порта нет — берём начало диапазона ports");
        assert_eq!(hy["hop_ports"], "443-8443");
        assert_eq!(hy["obfs"]["password"], "obfspass");

        let wg = &found[4].node;
        assert_eq!(wg["address"][0], "10.0.0.2/32", "маску Clash не пишет, а sing-box ждёт");
        assert_eq!(wg["peers"][0]["reserved"], serde_json::json!([1, 2, 3]));
        assert_eq!(wg["mtu"], 1408);

        // Якорь без имени — тоже узел, и имя ему выдаётся из адреса: панели
        // так и пишут общий кусок, а `name` дают только наследникам.
        assert_eq!(found[5].node["type"], "trojan");

        // Слияние: у наследника своё имя, остальное — из якоря. Так панели
        // выносят TLS и транспорт в один кусок и повторяют его у полусотни
        // узлов; без слияния каждый из них терял ровно вынесенное.
        let merged = &found[6].node;
        assert_eq!(merged["type"], "trojan");
        assert_eq!(merged["server"], "tr.example.com");
        assert_eq!(merged["password"], "trpass");

        // TUIC: в белом списке типов он был с самого начала, а переложить его в
        // ссылку было не во что — узел пропадал молча.
        let tu = &found[7].node;
        assert_eq!(tu["type"], "tuic");
        assert_eq!(tu["uuid"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(tu["password"], "tupass");
        assert_eq!(tu["congestion_control"], "bbr", "дефисное написание Clash доезжает");
        assert_eq!(tu["udp_relay_mode"], "native");
        assert_eq!(tu["tls"]["server_name"], "tu.example.com");

        // Метка якоря — это ссылка для `proxy-groups`, которых мы не читаем.
        // Узел с ней раньше пропадал целиком, а список блоком (так панели
        // пишут alpn не реже, чем скобками) терялся полем.
        let tr = &found[8].node;
        assert_eq!(tr["type"], "trojan");
        assert_eq!(tr["server"], "tr.example.com");
        assert_eq!(tr["password"], "trpass");
        assert_eq!(tr["tls"]["alpn"], serde_json::json!(["h2", "http/1.1"]), "список блоком");
    }

    /// Разбор YAML — запасной путь, и включаться он должен только вместо ссылок.
    #[test]
    fn clash_yaml_is_a_fallback() {
        assert!(parse_many("proxies:\n").found.is_empty(), "пустая секция — пустой список");
        assert!(parse_many("не yaml и не ссылки").found.is_empty());
        // Узел без обязательного поля — пропуск, а не профиль, который молча не соединится.
        assert!(parse_many("proxies:\n  - {name: X, type: vless, server: a.com, port: 443}").found.is_empty(), "vless без uuid");
        assert!(
            parse_many("proxies:\n  - {name: X, type: ss, server: a.com, port: 8388, cipher: aes-256-gcm, password: p, plugin: shadow-tls}")
                .found
                .is_empty(),
            "плагин, который не переложить в ссылку"
        );
    }

    #[test]
    fn errors_are_explained() {
        for (link, expect) in [
            ("", "нет схемы"),
            ("не ссылка вовсе", "нет схемы"),
            ("://x", "нет схемы"),
            ("magnet://x", "не поддерживается"),
            ("vless://@a.com:443", "нет UUID"),
            ("ss://not-base64-at-all", "не разбирается"),
            ("{не json}", "не разбирается как JSON"),
            (r#"{"server":"a.com"}"#, "нет поля type"),
            (r#"{"type":"vless"}"#, "не указан сервер"),
            (r#"{"outbounds":[{"type":"direct"}]}"#, "нет ни одного узла"),
            (r#"{"type":"block","server":"a.com"}"#, "не поддерживается"),
        ] {
            let err = parse(link).unwrap_err();
            assert!(err.contains(expect), "ссылка {link:?} дала {err:?}, ожидали {expect:?}");
        }
    }
}
