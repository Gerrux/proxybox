//! Личность окна Chromium через DevTools-канал: `Sec-CH-UA` под выбранную
//! строку UA, часовой пояс страны узла и запрет геолокации.
//!
//! Флагами командной строки этого не сделать. `--user-agent` меняет строку и
//! `navigator.userAgent`, а `Sec-CH-UA` и `navigator.userAgentData` Chromium
//! собирает из настоящей сборки — и сайт, который смотрит client hints, видит
//! macOS в строке и Windows в подсказках. Часовой пояс Chromium на Windows
//! берёт у системы и переменную `TZ` не читает (проверено на живом Chrome):
//! московское время при голландском адресе видно любому скрипту. Геолокацию
//! Chromium на Windows спрашивает у службы определения местоположения, то есть
//! по окрестным точкам Wi-Fi, — и через любой прокси это настоящий адрес.
//!
//! Канал — `--remote-debugging-pipe` на унаследованных дескрипторах, а не порт
//! на петле: к порту отладки может подключиться любой локальный процесс любого
//! пользователя и забрать все куки окна. Трубу видит только тот, кто её создал.
//!
//! Подмена ставится на каждую цель отдельно — вкладку, фрейм из чужого
//! процесса, воркер. Новая цель ждёт отладчика (`waitForDebuggerOnStart`) и
//! запускается только после того, как подмена на ней стоит: иначе первый
//! скрипт страницы успел бы прочитать настоящие значения. Цели, которые уже
//! были к моменту подключения (восстановленные вкладки), ждать не умеют — их
//! перезагружаем один раз.
//!
//! Потолок назван честно: это подмена значений, а не антидетект. Canvas,
//! WebGL, шрифты и экран остаются настоящими, а сама подмена через DevTools
//! заметна тому, кто её ищет. Строку UA у service worker'а `Emulation` не
//! трогает (замерено на Chrome 152) — для воркеров идёт `Network`.

use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Read, Write};

/// Что подменять. Пустое поле — не подменять.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Persona {
    /// Строка UA из профиля.
    pub ua: String,
    /// `Accept-Language`, уже раскрытый из «авто».
    pub lang: String,
    /// IANA-имя часового пояса, уже раскрытое из «авто».
    pub timezone: String,
}

/// Подсказки `Sec-CH-UA` под строку Chrome. Не Chrome (вписанная руками чужая
/// строка) — подсказок нет: выдумывать бренды браузера, которым строка себя не
/// называет, значило бы завести второе расхождение вместо первого.
///
/// Версия платформы выбрана так, как её отдаёт настоящий Chrome на обычной
/// машине: Windows 10 отдаёт `10.0.0`, macOS — свою настоящую версию, а не
/// замороженную в UA `10_15_7`. Бренд-«смазка» (`Not)A;Brand`) — та, что Chrome
/// ставит сам; её вид меняется от версии к версии, и ошибка тут стоит меньше,
/// чем её отсутствие.
pub fn ua_metadata(ua: &str) -> Option<Value> {
    let major = ua.split("Chrome/").nth(1)?.split('.').next()?.parse::<u32>().ok()?;
    let (platform, version) = if ua.contains("Windows NT") {
        ("Windows", "10.0.0")
    } else if ua.contains("Mac OS X") {
        ("macOS", "14.6.1")
    } else if ua.contains("Linux") {
        ("Linux", "")
    } else {
        return None;
    };
    let brands = |full: bool| {
        let v = |n: &str| if full { format!("{n}.0.0.0") } else { n.to_string() };
        json!([
            { "brand": "Not)A;Brand", "version": v("99") },
            { "brand": "Chromium", "version": v(&major.to_string()) },
            { "brand": "Google Chrome", "version": v(&major.to_string()) },
        ])
    };
    Some(json!({
        "brands": brands(false),
        "fullVersionList": brands(true),
        "fullVersion": format!("{major}.0.0.0"),
        "platform": platform,
        "platformVersion": version,
        "architecture": "x86",
        "model": "",
        "mobile": false,
        "bitness": "64",
        "wow64": false,
    }))
}

/// `navigator.platform` под строку UA — то, что пишет настоящий браузер.
fn navigator_platform(ua: &str) -> Option<&'static str> {
    if ua.contains("Windows NT") {
        Some("Win32")
    } else if ua.contains("Mac OS X") {
        Some("MacIntel")
    } else if ua.contains("Linux") {
        Some("Linux x86_64")
    } else {
        None
    }
}

/// Команды, которые ставятся на цель данного типа. Вкладкам и фреймам —
/// `Emulation`, воркерам — `Network`: у воркера нет `Emulation`, а
/// `Network.setUserAgentOverride` принимает те же подсказки.
pub fn setup(kind: &str, persona: &Persona) -> Vec<(&'static str, Value)> {
    let page = matches!(kind, "page" | "iframe");
    let worker = matches!(kind, "worker" | "shared_worker" | "service_worker");
    if !page && !worker {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !persona.ua.is_empty() {
        let mut params = json!({ "userAgent": persona.ua });
        if !persona.lang.is_empty() {
            params["acceptLanguage"] = json!(persona.lang);
        }
        if let Some(platform) = navigator_platform(&persona.ua) {
            params["platform"] = json!(platform);
        }
        if let Some(meta) = ua_metadata(&persona.ua) {
            params["userAgentMetadata"] = meta;
        }
        out.push((if page { "Emulation.setUserAgentOverride" } else { "Network.setUserAgentOverride" }, params));
    }
    // Пояс в воркере тоже подменяется (замерено: service worker видит его),
    // а ошибку на цели, которая домена не знает, канал просто проглотит.
    if !persona.timezone.is_empty() {
        out.push(("Emulation.setTimezoneOverride", json!({ "timezoneId": persona.timezone })));
    }
    out
}

/// Автоподключение: ко всем целям, с ожиданием отладчика у новых и одним
/// сеансом на канал (`flatten`).
fn auto_attach() -> Value {
    json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })
}

struct Channel<W: Write> {
    write: W,
    next: u64,
}

impl<W: Write> Channel<W> {
    fn send(&mut self, method: &str, params: Value, session: Option<&str>) -> io::Result<()> {
        self.next += 1;
        let mut message = json!({ "id": self.next, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let mut bytes = serde_json::to_vec(&message).map_err(io::Error::other)?;
        bytes.push(0);
        self.write.write_all(&bytes)?;
        self.write.flush()
    }
}

/// Держать канал, пока браузер жив: ставить подмену на каждую новую цель.
/// Возвращается, когда браузер закрыл свой конец трубы.
///
/// Порядок на цели обязателен: сперва подмена, потом автоподключение к её
/// детям, и только потом `runIfWaitingForDebugger`. Команды одного сеанса
/// Chromium исполняет по порядку, поэтому ответов ждать не нужно. Отпустить
/// ждущую цель обязаны всегда, даже ту, подменять в которой нечего, — иначе
/// вкладка так и висела бы пустой. Сторож — `every_target_is_released_after_its_disguise`.
pub fn drive<R: Read, W: Write>(read: R, write: W, persona: &Persona) -> io::Result<()> {
    let mut channel = Channel { write, next: 0 };
    channel.send("Browser.setPermission", json!({ "permission": { "name": "geolocation" }, "setting": "denied" }), None)?;
    channel.send("Target.setAutoAttach", auto_attach(), None)?;
    let mut read = BufReader::new(read);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        if read.read_until(0, &mut raw)? == 0 {
            return Ok(());
        }
        if raw.last() == Some(&0) {
            raw.pop();
        }
        let Ok(message) = serde_json::from_slice::<Value>(&raw) else { continue };
        if message["method"] != "Target.attachedToTarget" {
            continue;
        }
        let params = &message["params"];
        let Some(session) = params["sessionId"].as_str() else { continue };
        let kind = params["targetInfo"]["type"].as_str().unwrap_or_default();
        let waiting = params["waitingForDebugger"] == true;
        for (method, args) in setup(kind, persona) {
            channel.send(method, args, Some(session))?;
        }
        if matches!(kind, "page" | "iframe") {
            channel.send("Target.setAutoAttach", auto_attach(), Some(session))?;
            // Цель уже работала до нас и успела отдать настоящие значения:
            // один перезапуск страницы — и она читает подменённые.
            if !waiting && kind == "page" {
                channel.send("Page.reload", json!({}), Some(session))?;
            }
        }
        if waiting {
            channel.send("Runtime.runIfWaitingForDebugger", json!({}), Some(session))?;
        }
    }
}

/// Трубы DevTools для запускаемого Chromium: аргументы командной строки и наши
/// концы. Концы ребёнка помечены наследуемыми, и после запуска их надо
/// отпустить (`spawned`) — пока они открыты у нас, конец файла не наступит
/// никогда, и `drive` не заметит закрытого браузера.
#[cfg(windows)]
pub struct Pipes {
    pub args: [String; 2],
    ours: (io::PipeReader, io::PipeWriter),
    theirs: (io::PipeReader, io::PipeWriter),
}

#[cfg(windows)]
impl Pipes {
    pub fn new() -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
        // Chromium читает из первой трубы и пишет во вторую.
        let (their_read, our_write) = io::pipe()?;
        let (our_read, their_write) = io::pipe()?;
        let inherit = |handle: std::os::windows::io::RawHandle| {
            unsafe { SetHandleInformation(HANDLE(handle), HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
                .map_err(io::Error::other)
        };
        inherit(their_read.as_raw_handle())?;
        inherit(their_write.as_raw_handle())?;
        let args = [
            "--remote-debugging-pipe".to_string(),
            format!(
                "--remote-debugging-io-pipes={},{}",
                their_read.as_raw_handle() as usize,
                their_write.as_raw_handle() as usize
            ),
        ];
        Ok(Self { args, ours: (our_read, our_write), theirs: (their_read, their_write) })
    }

    /// Ребёнок запущен и держит свои концы сам — наши копии закрываем.
    pub fn spawned(self) -> (io::PipeReader, io::PipeWriter) {
        drop(self.theirs);
        self.ours
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persona() -> Persona {
        Persona {
            ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36".into(),
            lang: "nl-NL,nl,en-US,en".into(),
            timezone: "Europe/Amsterdam".into(),
        }
    }

    fn frames(messages: &[Value]) -> Vec<u8> {
        messages.iter().flat_map(|m| serde_json::to_vec(m).unwrap().into_iter().chain([0])).collect()
    }

    fn sent(out: &[u8]) -> Vec<Value> {
        out.split(|b| *b == 0).filter(|f| !f.is_empty()).map(|f| serde_json::from_slice(f).unwrap()).collect()
    }

    /// Новая цель обязана запуститься только после подмены, а отпущена быть
    /// обязана всегда — даже служебная, подменять в которой нечего. Уже
    /// работавшая вкладка перезагружается, ждущая — нет.
    #[test]
    fn every_target_is_released_after_its_disguise() {
        let attached = |session: &str, kind: &str, waiting: bool| {
            json!({ "method": "Target.attachedToTarget", "params": {
                "sessionId": session, "targetInfo": { "type": kind }, "waitingForDebugger": waiting } })
        };
        let input = frames(&[
            json!({ "id": 1, "result": {} }),
            attached("old", "page", false),
            attached("new", "page", true),
            attached("ui", "browser_ui", true),
            attached("sw", "service_worker", true),
        ]);
        let mut out = Vec::new();
        drive(&input[..], &mut out, &persona()).unwrap();
        let sent = sent(&out);
        let calls = |session: &str| -> Vec<String> {
            sent.iter()
                .filter(|m| m["sessionId"] == session)
                .map(|m| m["method"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(sent[0]["method"], "Browser.setPermission", "геолокация запрещена до всего остального");
        assert_eq!(sent[0]["params"]["setting"], "denied");
        assert_eq!(
            calls("new"),
            [
                "Emulation.setUserAgentOverride",
                "Emulation.setTimezoneOverride",
                "Target.setAutoAttach",
                "Runtime.runIfWaitingForDebugger"
            ]
        );
        assert_eq!(
            calls("old"),
            ["Emulation.setUserAgentOverride", "Emulation.setTimezoneOverride", "Target.setAutoAttach", "Page.reload"]
        );
        assert_eq!(calls("ui"), ["Runtime.runIfWaitingForDebugger"], "служебную цель отпускаем, не трогая");
        assert_eq!(
            calls("sw"),
            ["Network.setUserAgentOverride", "Emulation.setTimezoneOverride", "Runtime.runIfWaitingForDebugger"]
        );
        let ua = sent.iter().find(|m| m["sessionId"] == "new").unwrap();
        assert_eq!(ua["params"]["userAgentMetadata"]["platform"], "macOS", "подсказки обязаны совпасть со строкой");
        assert_eq!(ua["params"]["platform"], "MacIntel");
        assert_eq!(ua["params"]["acceptLanguage"], "nl-NL,nl,en-US,en");
    }

    #[test]
    fn nothing_to_disguise_means_nothing_sent() {
        assert!(setup("page", &Persona::default()).is_empty());
        let only_tz = Persona { timezone: "Asia/Tokyo".into(), ..Persona::default() };
        assert_eq!(setup("page", &only_tz).len(), 1, "пояс без UA — без выдуманной строки");
    }

    #[test]
    fn hints_follow_the_string() {
        let win = ua_metadata("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36").unwrap();
        assert_eq!((win["platform"].as_str(), win["fullVersion"].as_str()), (Some("Windows"), Some("138.0.0.0")));
        assert_eq!(win["brands"][2]["version"], "138");
        assert!(ua_metadata("Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0").is_none(), "не Chrome — без подсказок");
    }

    /// Живой Chrome: подмена обязана доехать до страницы. Нужен установленный
    /// Chrome, поэтому по умолчанию не бежит — `cargo test -p core-apps -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn a_live_chrome_takes_the_disguise() {
        let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        let dir = std::env::temp_dir().join("pg-cdp-live");
        let _ = std::fs::remove_dir_all(&dir);
        let pipes = Pipes::new().unwrap();
        let mut child = std::process::Command::new(chrome)
            .args(["--headless=new", "--disable-gpu", "--no-first-run"])
            .arg(format!("--user-data-dir={}", dir.display()))
            .args(&pipes.args)
            .arg("about:blank")
            .spawn()
            .unwrap();
        let (read, mut write) = pipes.spawned();
        // Свой разговор поверх `drive` здесь не завести — трубу держит он. Поэтому
        // проверяем тем же каналом руками: подключаемся, подменяем, спрашиваем.
        let persona = persona();
        let mut ch = Channel { write: &mut write, next: 100 };
        ch.send("Target.setAutoAttach", auto_attach(), None).unwrap();
        let mut read = BufReader::new(read);
        let mut raw = Vec::new();
        let mut answer = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while answer.is_none() && std::time::Instant::now() < deadline {
            raw.clear();
            if read.read_until(0, &mut raw).unwrap() == 0 {
                break;
            }
            raw.pop();
            let Ok(m) = serde_json::from_slice::<Value>(&raw) else { continue };
            if m["method"] == "Target.attachedToTarget" && m["params"]["targetInfo"]["type"] == "page" {
                let s = m["params"]["sessionId"].as_str().unwrap().to_string();
                for (method, args) in setup("page", &persona) {
                    ch.send(method, args, Some(&s)).unwrap();
                }
                ch.send(
                    "Runtime.evaluate",
                    json!({ "expression": "Intl.DateTimeFormat().resolvedOptions().timeZone + ' ' + navigator.platform", "returnByValue": true }),
                    Some(&s),
                )
                .unwrap();
            }
            if let Some(v) = m["result"]["result"]["value"].as_str() {
                answer = Some(v.to_string());
            }
        }
        let _ = child.kill();
        assert_eq!(answer.as_deref(), Some("Europe/Amsterdam MacIntel"));
    }
}
