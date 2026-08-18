//! Служба Privacy Gateway: единственный владелец состояния, процесса sing-box и
//! правил брандмауэра. Клиенты (GUI, CLI) только шлют команды и читают статус.
//!
//! ponytail: пока обычный консольный бинарник. Регистрация Windows Service нужна
//! ровно тогда, когда правила брандмауэра и TUN потребуют прав администратора
//! без ручного «запустить от имени».

#[cfg(windows)]
mod service;

use core_ipc::{App, Request, Response, Status, Tunnel as TunnelState, ADDR};
use core_tunnel::{build_config, Options, Tunnel as Process};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Как часто служба проверяет, жив ли туннель. Это же — окно, в котором
/// выбранные приложения могут успеть уйти напрямую после падения sing-box.
const PROBE_EVERY: Duration = Duration::from_secs(3);
/// Пауза перед повторной попыткой поднять туннель: удваивается до максимума.
/// Без неё отказ, который сам не пройдёт (нет прав, занят порт), превращается
/// в бесконечный поток одинаковых ошибок в журнале.
const RETRY_BASE: Duration = Duration::from_secs(3);
const RETRY_MAX: Duration = Duration::from_secs(60);

fn dir() -> PathBuf {
    // Служба работает под LocalSystem, и её %APPDATA% — это системный профиль
    // внутри System32. Состоянию службы место в ProgramData.
    let base = std::env::var("ProgramData")
        .or_else(|_| std::env::var("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"));
    base.join("privacy-gateway")
}

/// TUN — только на целевой платформе; в разработке хватает локального SOCKS.
fn tun_enabled() -> bool {
    cfg!(windows) && std::env::var("PG_TUN").as_deref() != Ok("0")
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    apps: Vec<App>,
    profiles: BTreeMap<String, Value>,
    profile: Option<String>,
}

struct Service {
    status: Status,
    profiles: BTreeMap<String, Value>,
    /// Приватный режим включён пользователем. Не то же самое, что «туннель жив»:
    /// именно расхождение этих двух флагов и означает DROP.
    private: bool,
    tunnel: Option<Process>,
    probe_target: (String, u16),
    retry_at: Option<Instant>,
    retry_delay: Duration,
    /// Что уже применено к брандмауэру. Без этой памяти надзор дёргал бы netsh
    /// каждые три секунды и засыпал журнал одинаковыми отказами.
    applied: Option<(bool, Vec<String>)>,
}

impl Service {
    fn load() -> Self {
        let raw = std::fs::read_to_string(dir().join("state.json")).unwrap_or_default();
        let saved: Saved = serde_json::from_str(&raw).unwrap_or_default();
        Self {
            status: Status {
                profile: saved.profile,
                apps: saved.apps,
                profiles: saved.profiles.keys().cloned().collect(),
                ..Default::default()
            },
            profiles: saved.profiles,
            private: false,
            tunnel: None,
            probe_target: (String::new(), 0),
            retry_at: None,
            retry_delay: RETRY_BASE,
            applied: None,
        }
    }

    fn save(&mut self) {
        self.status.profiles = self.profiles.keys().cloned().collect();
        let saved = Saved {
            apps: self.status.apps.clone(),
            profiles: self.profiles.clone(),
            profile: self.status.profile.clone(),
        };
        let _ = std::fs::create_dir_all(dir());
        if let Ok(raw) = serde_json::to_string_pretty(&saved) {
            let _ = std::fs::write(dir().join("state.json"), raw);
        }
    }

    fn log(&mut self, line: impl Into<String>) {
        let line = line.into();
        // Повтор в цикле перезапуска не должен вытеснять из журнала всё остальное.
        if self.status.log.first() == Some(&line) {
            return;
        }
        eprintln!("{line}");
        self.status.log.insert(0, line);
        self.status.log.truncate(30);
    }

    fn selected(&self) -> Vec<String> {
        self.status.apps.iter().filter(|a| a.enabled).map(|a| a.path.clone()).collect()
    }

    /// Блокировка выбранных приложений на всё время, пока туннель не подтверждён.
    fn guard(&mut self, blocked: bool) {
        let want = (blocked, self.selected());
        if self.applied.as_ref() == Some(&want) {
            return;
        }
        match core_filter::set_blocked(&want.1, blocked) {
            Ok(()) => self.applied = Some(want),
            Err(e) => {
                // Неудачу не запоминаем: на следующей смене состояния попробуем снова.
                self.applied = None;
                self.log(format!("правила брандмауэра не поставлены — {e}"));
            }
        }
    }

    fn start(&mut self, profile: &str) -> Result<(), String> {
        let node = self.profiles.get(profile).cloned().ok_or_else(|| format!("нет профиля «{profile}»"))?;
        self.tunnel = None; // старый процесс убивается Drop'ом до запуска нового
        self.private = true;
        self.status.profile = Some(profile.to_string());
        self.save();
        // Сначала блокируем, потом поднимаем: между командой и живым туннелем
        // выбранные приложения должны быть без сети, а не в обход него.
        self.guard(true);

        let opts = Options { tun: tun_enabled(), apps: self.selected(), ..Default::default() };
        let config = build_config(&node, &opts);
        self.probe_target = probe_target(&node);
        match Process::start(&config, &dir()) {
            Ok(t) => {
                self.tunnel = Some(t);
                self.status.tunnel = TunnelState::Connecting;
                self.retry_at = None;
                self.retry_delay = RETRY_BASE;
                self.log(format!("профиль «{profile}»: sing-box запущен, приложений в туннеле: {}", opts.apps.len()));
                Ok(())
            }
            Err(e) => {
                self.status.tunnel = TunnelState::Down;
                self.retry_at = Some(Instant::now() + self.retry_delay);
                let wait = self.retry_delay.as_secs();
                self.retry_delay = (self.retry_delay * 2).min(RETRY_MAX);
                let reason = explain(&e.to_string());
                self.log(format!("sing-box не запустился: {reason}; следующая попытка через {wait} с"));
                Err(reason)
            }
        }
    }

    fn stop(&mut self) {
        self.private = false;
        self.tunnel = None;
        self.status.tunnel = TunnelState::Off;
        self.status.latency_ms = None;
        (self.status.rx, self.status.tx) = (0, 0);
        self.guard(false);
        self.log("приватный режим выключен: правила сняты");
    }

    /// Перезапуск с новым списком приложений — иначе только что добавленное
    /// приложение продолжило бы ходить напрямую.
    fn reapply(&mut self) {
        if self.private {
            if let Some(profile) = self.status.profile.clone() {
                let _ = self.start(&profile);
            }
        }
    }
}

/// Есть ли у службы права администратора. Без них не поднять TUN и не тронуть
/// брандмауэр — а узнать об этом лучше сразу, а не из потока отказов.
#[cfg(windows)]
fn elevated() -> bool {
    std::process::Command::new("net")
        .arg("session")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(windows))]
fn elevated() -> bool {
    true
}

/// Отказ на стадии TUN означает одно: службу запустили без прав администратора.
/// Голый FATAL из sing-box об этом не говорит, а причина всегда одна и та же.
fn explain(error: &str) -> String {
    if !error.contains("tun") {
        return error.to_string();
    }
    // «Отказано в доступе» — это всегда права. Остальные отказы TUN — почти
    // всегда чужой туннель: занятое имя адаптера или пересечение адресов.
    let denied = ["Access is denied", "denied", "elevation", "Отказано в доступе"];
    if denied.iter().any(|d| error.contains(d)) {
        return format!("{error} — нужны права администратора: без них не поднять TUN и не поставить правила брандмауэра");
    }
    format!("{error} — проверьте, не поднят ли рядом другой VPN: два TUN спорят за имя адаптера и маршруты")
}

fn probe_target(node: &Value) -> (String, u16) {
    if let Some((h, p)) = std::env::var("PG_PROBE").ok().and_then(|v| {
        let (h, p) = v.rsplit_once(':')?;
        Some((h.to_string(), p.parse().ok()?))
    }) {
        return (h, p);
    }
    // По умолчанию пробуем сам сервер пользователя: сторонних адресов не трогаем.
    let server = node["server"].as_str().or_else(|| node["peers"][0]["address"].as_str()).unwrap_or("127.0.0.1");
    let port = node["server_port"].as_u64().or_else(|| node["peers"][0]["port"].as_u64()).unwrap_or(443);
    (server.to_string(), port as u16)
}

fn handle(svc: &Mutex<Service>, req: Request) -> Response {
    let mut s = svc.lock().unwrap();
    match req {
        Request::Status => Response::Status(s.status.clone()),
        Request::ListApps => Response::Apps(s.status.apps.clone()),
        Request::Discover => {
            let found = core_apps::discover();
            let added: Vec<App> = found
                .into_iter()
                .filter(|f| !s.status.apps.iter().any(|a| a.path == f.path))
                // Выключенными: найдено — не значит выбрано.
                .map(|f| App { path: f.path, name: f.name, enabled: false })
                .collect();
            s.log(match added.len() {
                0 => "автообнаружение: ничего нового не найдено".to_string(),
                n => format!("автообнаружение: добавлено приложений — {n}"),
            });
            s.status.apps.extend(added);
            s.save();
            Response::Apps(s.status.apps.clone())
        }
        // Иконку не храним: она есть у системы, и спрашивают её один раз за окно.
        Request::Icon { path } => Response::Icon(core_apps::icon(&path)),
        Request::AddApp { path } => {
            if !s.status.apps.iter().any(|a| a.path == path) {
                let name = path
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or(&path)
                    .trim_end_matches(".exe")
                    .to_string();
                s.status.apps.push(App { path, name, enabled: true });
                s.save();
                s.reapply();
            }
            Response::Done
        }
        Request::SetApp { path, enabled } => match s.status.apps.iter_mut().find(|a| a.path == path) {
            Some(app) => {
                app.enabled = enabled;
                s.save();
                s.reapply();
                Response::Done
            }
            None => Response::Error { message: format!("приложение не в списке: {path}") },
        },
        Request::RemoveApp { path } => {
            s.status.apps.retain(|a| a.path != path);
            s.save();
            // Приложение выпало из списка — конфиг туннеля больше не должен его
            // упоминать, иначе оно останется в туннеле до перезапуска.
            s.reapply();
            Response::Done
        }
        Request::AddProfile { link } => match core_config::parse(&link) {
            Ok(p) => {
                s.profiles.insert(p.name.clone(), p.node);
                s.log(format!("профиль «{}» импортирован", p.name));
                s.save();
                Response::Done
            }
            Err(e) => Response::Error { message: e },
        },
        Request::RemoveProfile { name } => {
            s.profiles.remove(&name);
            if s.status.profile.as_deref() == Some(name.as_str()) {
                s.stop();
                s.status.profile = None;
            }
            s.save();
            Response::Done
        }
        Request::On { profile } => {
            // Команда пользователя — пробуем сразу, накопленная пауза не в счёт.
            s.retry_at = None;
            s.retry_delay = RETRY_BASE;
            match s.start(&profile) {
                Ok(()) => Response::Done,
                Err(message) => Response::Error { message },
            }
        }
        Request::Off => {
            s.stop();
            Response::Done
        }
    }
}

/// Присмотр за туннелем: живость, проба, счётчики. Замок на время пробы не
/// держим — иначе статус в GUI замирал бы на секунды.
fn supervise(svc: &Arc<Mutex<Service>>) {
    loop {
        std::thread::sleep(PROBE_EVERY);
        let probe = {
            let mut s = svc.lock().unwrap();
            if !s.private {
                continue;
            }
            let alive = s.tunnel.as_mut().map(Process::alive).unwrap_or(false);
            match (alive, s.tunnel.as_ref()) {
                (true, Some(t)) => Some((t.socks_port, t.api_port, s.probe_target.clone())),
                _ => None,
            }
        };
        let Some((socks_port, api_port, (host, port))) = probe else {
            // Процесса нет — значит DROP, и только потом попытка поднять заново.
            let mut s = svc.lock().unwrap();
            s.status.tunnel = TunnelState::Down;
            s.status.latency_ms = None;
            s.guard(true);
            if s.retry_at.is_some_and(|at| Instant::now() < at) {
                continue; // ждём паузы: отказ повторяется, а не проходит сам
            }
            s.log("sing-box не работает: выбранные приложения без сети, перезапуск");
            if let Some(profile) = s.status.profile.clone() {
                let _ = s.start(&profile);
            }
            continue;
        };

        let result = core_tunnel::probe(socks_port, (&host, port));
        let traffic = core_tunnel::traffic(api_port).ok();

        let mut s = svc.lock().unwrap();
        if !s.private {
            continue;
        }
        match result {
            Ok(latency) => {
                if s.status.tunnel != TunnelState::Up {
                    s.log(format!("туннель поднят, задержка {latency} мс"));
                    // Проверяем именно здесь: чужой туннель не мешает нам
                    // подняться, но может забрать маршруты — и тогда «Защищено»
                    // окажется правдой только про нас, а не про приложения.
                    for name in core_filter::foreign_tunnels() {
                        s.log(format!("рядом поднят чужой туннель «{name}» — выберите один: маршруты уйдут к тому, кто выиграет"));
                    }
                    s.guard(false); // дальше маршрутизацией занимается сам sing-box
                }
                s.status.tunnel = TunnelState::Up;
                s.status.latency_ms = Some(latency);
            }
            Err(e) => {
                if s.status.tunnel != TunnelState::Down {
                    s.log(format!("туннель недоступен ({e}): выбранные приложения без сети"));
                    s.guard(true);
                }
                s.status.tunnel = TunnelState::Down;
                s.status.latency_ms = None;
            }
        }
        if let Some((rx, tx)) = traffic {
            (s.status.rx, s.status.tx) = (rx, tx);
        }
    }
}

fn serve(svc: &Mutex<Service>, conn: TcpStream) {
    let Ok(clone) = conn.try_clone() else { return };
    for line in BufReader::new(clone).lines().map_while(Result::ok) {
        let resp = match serde_json::from_str(&line) {
            Ok(req) => handle(svc, req),
            Err(e) => Response::Error { message: format!("неразбираемый запрос: {e}") },
        };
        let out = serde_json::to_string(&resp).unwrap();
        if writeln!(&conn, "{out}").is_err() {
            return;
        }
    }
}

/// Тело службы. `stop` приходит от SCM; в консольном режиме его нет, и тогда
/// функция не возвращается — работу заканчивает Ctrl+C.
fn run(stop: Option<mpsc::Receiver<()>>) -> std::io::Result<()> {
    let svc = Arc::new(Mutex::new(Service::load()));
    let listener = TcpListener::bind(ADDR)?;
    {
        let mut s = svc.lock().unwrap();
        let (apps, profiles) = (s.status.apps.len(), s.profiles.len());
        s.log(format!("служба слушает {ADDR}; приложений: {apps}, профилей: {profiles}"));
        if !elevated() {
            s.log("ВНИМАНИЕ: служба запущена без прав администратора — TUN и правила брандмауэра работать не будут");
        }
        // Служба, убитая прошлый раз, могла оставить блокирующие правила: без
        // этого выбранные приложения остались бы без сети и снять их было бы нечем.
        s.guard(false);
    }

    let watched = Arc::clone(&svc);
    std::thread::spawn(move || supervise(&watched));

    let accepting = Arc::clone(&svc);
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let svc = Arc::clone(&accepting);
            std::thread::spawn(move || serve(&svc, conn));
        }
    });

    match stop {
        Some(rx) => {
            let _ = rx.recv();
            // Остановка по команде — гасим туннель и снимаем правила.
            svc.lock().unwrap().stop();
        }
        None => loop {
            std::thread::park();
        },
    }
    Ok(())
}

const USAGE: &str = "pg-service — служба Privacy Gateway

  (без аргументов)  работать консольным процессом (разработка)
  install           зарегистрировать службу Windows и включить автозапуск
  uninstall         остановить и удалить службу";

fn main() -> std::process::ExitCode {
    let arg = std::env::args().nth(1).unwrap_or_default();

    #[cfg(windows)]
    {
        let done = |r: windows_service::Result<()>| match r {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                std::process::ExitCode::FAILURE
            }
        };
        match arg.as_str() {
            service::ARG => return done(service::dispatch()),
            "install" => {
                let exe = match std::env::current_exe() {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("не удалось определить путь к себе: {e}");
                        return std::process::ExitCode::FAILURE;
                    }
                };
                return done(service::install(exe));
            }
            "uninstall" => return done(service::uninstall()),
            _ => {}
        }
    }

    if !arg.is_empty() {
        eprintln!("{USAGE}");
        return std::process::ExitCode::FAILURE;
    }
    match run(None) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("служба не запустилась: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
