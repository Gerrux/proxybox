//! Парсер share-links → узел конфигурации sing-box.
//!
//! Раскладка полей повторяет NekoBox (`fmt/Link2Bean.cpp` + `fmt/Bean2CoreObj_box.cpp`):
//! это де-факто формат, на который ориентируются панели и генераторы ссылок.
//! Промежуточной модели протокола (Bean) у нас нет — редактировать узлы руками
//! пока негде, а значит и хранить их в двух видах незачем.

use base64::Engine;
use core_ipc::t;
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
    let scheme = link.split("://").next().unwrap_or_default().to_ascii_lowercase();
    match scheme.as_str() {
        "vless" => vless(link),
        "trojan" => trojan(link),
        "vmess" => vmess(link),
        "ss" => shadowsocks(link),
        "hy2" | "hysteria2" => hysteria2(link),
        "wg" | "wireguard" => wireguard(link),
        "" => Err(t("не ссылка: нет схемы", "not a link: no scheme")),
        s => Err(t(&format!("протокол не поддерживается: {s}"), &format!("unsupported protocol: {s}"))),
    }
}

/// Конфиг sing-box: либо целиком (берём первый рабочий outbound), либо один
/// узел объектом. Служебные outbound'ы (direct/block/dns и группы) — не узлы.
fn from_json(text: &str) -> Result<Profile, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| t(&format!("не разбирается как JSON: {e}"), &format!("not valid JSON: {e}")))?;
    const SERVICE: [&str; 6] = ["direct", "block", "dns", "selector", "urltest", "socks"];

    let node = match value.get("outbounds").and_then(Value::as_array) {
        Some(outbounds) => outbounds
            .iter()
            .find(|o| o["type"].as_str().is_some_and(|t| !SERVICE.contains(&t)))
            .cloned()
            .ok_or_else(|| t("в конфиге нет ни одного узла — только служебные outbound", "the config has no node, only service outbounds"))?,
        None => value.clone(),
    };
    let kind = node["type"].as_str().ok_or_else(|| t("в узле нет поля type", "the node has no type field"))?.to_string();
    if node["server"].as_str().is_none() && node["peers"][0]["address"].as_str().is_none() {
        return Err(t(&format!("в узле {kind} не указан сервер"), &format!("the {kind} node has no server")));
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
        let url = Url::parse(link).map_err(|e| t(&format!("ссылка не разбирается: {e}"), &format!("cannot parse link: {e}")))?;
        let query = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        Ok(Self { url, query })
    }

    fn host(&self) -> Result<String, String> {
        self.url.host_str().filter(|h| !h.is_empty()).map(str::to_owned).ok_or_else(|| t("нет адреса сервера", "no server address"))
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
        return Err(t("нет UUID в ссылке vless", "no UUID in the vless link"));
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
        return Err(t("нет пароля в ссылке trojan", "no password in the trojan link"));
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
        return Err(t("в vmess-конфиге нет add или id", "the vmess config has no add or id"));
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
        return Err(t("нет UUID в ссылке vmess", "no UUID in the vmess link"));
    }
    let mut node = json!({
        "type": "vmess",
        "server": l.host()?,
        "server_port": l.port(443),
        "uuid": uuid,
        "alter_id": 0,
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
        let decoded = b64_str(blob).ok_or_else(|| t("ссылка ss не разбирается", "cannot parse the ss link"))?;
        format!("ss://{decoded}{}{frag}", if frag.is_empty() { "" } else { "#" })
    };
    let l = Link::new(&link)?;
    let (method, password) = match l.url.password() {
        Some(p) => (l.user(), decode(p)),
        None => {
            let mp = b64_str(l.url.username()).ok_or_else(|| t("в ссылке ss нет method:password", "the ss link has no method:password"))?;
            let (m, p) = mp.split_once(':').ok_or_else(|| t("в ссылке ss нет method:password", "the ss link has no method:password"))?;
            (m.to_string(), p.to_string())
        }
    };
    if method.is_empty() || password.is_empty() {
        return Err(t("в ссылке ss нет method:password", "the ss link has no method:password"));
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
        return Err(t("нет пароля в ссылке hysteria2", "no password in the hysteria2 link"));
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

fn wireguard(link: &str) -> Result<Profile, String> {
    let l = Link::new(link)?;
    let private_key = l.user();
    let peer_key = l.q("publickey").or_else(|| l.q("pbk")).or_else(|| l.q("peer"));
    let (Some(peer_key), false) = (peer_key, private_key.is_empty()) else {
        return Err(t(
            "ссылка wg: нужны приватный ключ в userinfo и publickey в запросе",
            "wg link: needs a private key in userinfo and publickey in the query",
        ));
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

    #[test]
    fn errors_are_explained() {
        for (link, expect) in [
            ("", "нет схемы"),
            ("magnet://x", "не поддерживается"),
            ("vless://@a.com:443", "нет UUID"),
            ("ss://not-base64-at-all", "не разбирается"),
            ("{не json}", "не разбирается как JSON"),
            (r#"{"server":"a.com"}"#, "нет поля type"),
            (r#"{"type":"vless"}"#, "не указан сервер"),
            (r#"{"outbounds":[{"type":"direct"}]}"#, "нет ни одного узла"),
        ] {
            let err = parse(link).unwrap_err();
            assert!(err.contains(expect), "ссылка {link:?} дала {err:?}, ожидали {expect:?}");
        }
    }
}
