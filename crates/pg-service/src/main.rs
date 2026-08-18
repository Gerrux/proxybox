//! Служба Privacy Gateway: единственный владелец состояния, процесса sing-box и
//! правил брандмауэра. Клиенты (GUI, CLI) только шлют команды и читают статус.
//!
//! ponytail: пока обычный консольный бинарник. Регистрация Windows Service нужна
//! ровно тогда, когда правила брандмауэра и TUN потребуют прав администратора
//! без ручного «запустить от имени».

#[cfg(windows)]
mod service;

use core_ipc::{t, App, Endpoint, Listener, Request, Response, Status, Stream, Tunnel as TunnelState, ADDR};
use core_tunnel::{build_config, Options, Tunnel as Process};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
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
    /// Адрес подписки → имена профилей, которые с неё пришли. Без этой памяти
    /// обновление подписки не смогло бы убрать узлы, которых в ней больше нет.
    #[serde(default)]
    subscriptions: BTreeMap<String, Vec<String>>,
    profile: Option<String>,
    #[serde(default)]
    lang: core_ipc::Lang,
    /// Был ли включён приватный режим. Переживает перезапуск намеренно: иначе
    /// после перезагрузки машины выбранные приложения молча оказались бы в
    /// сети напрямую — ровно то, чего продукт обещает не допускать.
    #[serde(default)]
    private: bool,
}

struct Service {
    status: Status,
    profiles: BTreeMap<String, Value>,
    subscriptions: BTreeMap<String, Vec<String>>,
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
        // Язык поднимается до первой строки журнала — иначе стартовые сообщения
        // выходили бы не на том языке, который выбрал пользователь.
        core_ipc::set_lang(saved.lang);
        Self {
            status: Status {
                lang: saved.lang,
                profile: saved.profile,
                apps: saved.apps,
                profiles: saved.profiles.keys().cloned().collect(),
                subscriptions: saved.subscriptions.keys().cloned().collect(),
                ..Default::default()
            },
            profiles: saved.profiles,
            subscriptions: saved.subscriptions,
            private: saved.private,
            tunnel: None,
            probe_target: (String::new(), 0),
            retry_at: None,
            retry_delay: RETRY_BASE,
            applied: None,
        }
    }

    fn save(&mut self) {
        self.status.profiles = self.profiles.keys().cloned().collect();
        self.status.subscriptions = self.subscriptions.keys().cloned().collect();
        let saved = Saved {
            apps: self.status.apps.clone(),
            profiles: self.profiles.clone(),
            subscriptions: self.subscriptions.clone(),
            profile: self.status.profile.clone(),
            lang: self.status.lang,
            private: self.private,
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

    /// Профиль уходит из списка — и из туннеля, если был активен. Держать
    /// поднятым узел, которого больше нет, не за что: это то же самое, что
    /// выключить приватный режим руками, и приложения остаются защищёнными.
    fn forget_profile(&mut self, name: &str) {
        self.profiles.remove(name);
        if self.status.profile.as_deref() == Some(name) {
            self.stop();
            self.status.profile = None;
        }
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
                self.log(t(&format!("правила брандмауэра не поставлены — {e}"), &format!("firewall rules not applied — {e}")));
            }
        }
    }

    fn start(&mut self, profile: &str) -> Result<(), String> {
        let node = self.profiles.get(profile).cloned().ok_or_else(|| t(&format!("нет профиля «{profile}»"), &format!("no profile \"{profile}\"")))?;
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
            Ok(process) => {
                self.tunnel = Some(process);
                self.status.tunnel = TunnelState::Connecting;
                self.retry_at = None;
                self.retry_delay = RETRY_BASE;
                let count = opts.apps.len();
                self.log(t(
                    &format!("профиль «{profile}»: sing-box запущен, приложений в туннеле: {count}"),
                    &format!("profile \"{profile}\": sing-box started, apps in the tunnel: {count}"),
                ));
                Ok(())
            }
            Err(e) => {
                self.status.tunnel = TunnelState::Down;
                self.retry_at = Some(Instant::now() + self.retry_delay);
                let wait = self.retry_delay.as_secs();
                self.retry_delay = (self.retry_delay * 2).min(RETRY_MAX);
                let reason = explain(&e.to_string());
                self.log(t(
                    &format!("sing-box не запустился: {reason}; следующая попытка через {wait} с"),
                    &format!("sing-box failed to start: {reason}; retrying in {wait} s"),
                ));
                Err(reason)
            }
        }
    }

    fn stop(&mut self) {
        self.private = false;
        self.save();
        self.tunnel = None;
        self.status.tunnel = TunnelState::Off;
        self.status.country = None;
        self.status.latency_ms = None;
        (self.status.rx, self.status.tx) = (0, 0);
        self.guard(false);
        self.log(t("приватный режим выключен: правила сняты", "private mode off: rules removed"));
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

/// Единственный запрос наружу должен выключаться: продукт про приватность, и
/// решение обращаться к третьей стороне принадлежит пользователю, а не нам.
fn geo_enabled() -> bool {
    std::env::var("PG_GEO").as_deref() != Ok("0")
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

/// Скачивание подписки. Напрямую, а не через туннель: первую подписку
/// импортируют ровно тогда, когда туннеля ещё нет.
/// ponytail: если панель заблокирована провайдером, это не поможет — тогда
/// нужен вариант «качать через уже поднятый туннель» на mixed-порт 48292.
fn fetch(url: &str) -> Result<String, String> {
    let fail = |e: &dyn std::fmt::Display| {
        t(&format!("подписка не скачалась: {e}"), &format!("subscription download failed: {e}"))
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        // TLS берём у системы (на Windows это SChannel): корни те же, что у
        // остальных программ на машине, и сборка не тянет за собой C-компилятор
        // ради rustls-ring — с ним `cargo check --target …-msvc` не проходит.
        .tls_config(
            ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build(),
        )
        // Глобальный тайм-аут, а не только на соединение: молчащий сервер не
        // должен держать импорт бесконечно.
        .timeout_global(Some(Duration::from_secs(20)))
        // Панели отдают формат по User-Agent. Своё имя — значит список ссылок,
        // а не clash-конфиг, которого мы не понимаем.
        .user_agent(concat!("privacy-gateway/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    agent.get(url).call().map_err(|e| fail(&e))?.body_mut().read_to_string().map_err(|e| fail(&e))
}

/// Занятое имя получает номер: в подписках узлы сплошь и рядом называются
/// одинаково, а профиль в списке — это ключ.
fn free_name(taken: &BTreeMap<String, Value>, want: &str) -> String {
    if !taken.contains_key(want) {
        return want.to_string();
    }
    (2..).map(|n| format!("{want} ({n})")).find(|name| !taken.contains_key(name)).expect("номер найдётся")
}

/// Импорт и обновление подписки — одно и то же действие: скачать и заменить
/// набор профилей целиком. Узла, которого в подписке больше нет, не должно
/// остаться и в списке.
fn subscribe(svc: &Mutex<Service>, url: &str) -> Response {
    // Сеть — до захвата замка. Иначе окно на все двадцать секунд перестало бы
    // получать статус, а служба — выглядеть живой.
    let body = match fetch(url) {
        Ok(body) => body,
        Err(message) => return Response::Error { message },
    };
    let found = core_config::parse_many(&body);
    let mut s = svc.lock().unwrap();
    if found.is_empty() {
        // Пустой ответ — это чаще всего не пустая подписка, а неверный адрес
        // или чужой формат. Старые профили в таком случае не трогаем.
        let message = t(
            "в ответе подписки нет ни одного узла — проверьте адрес",
            "the subscription returned no nodes — check the address",
        );
        s.log(message.clone());
        return Response::Error { message };
    }

    for name in s.subscriptions.remove(url).unwrap_or_default() {
        s.forget_profile(&name);
    }
    let names: Vec<String> = found
        .into_iter()
        .map(|p| {
            let name = free_name(&s.profiles, &p.name);
            s.profiles.insert(name.clone(), p.node);
            name
        })
        .collect();
    s.log(t(
        &format!("подписка обновлена, узлов — {}", names.len()),
        &format!("subscription updated, nodes — {}", names.len()),
    ));
    s.subscriptions.insert(url.to_string(), names);
    s.save();
    Response::Done
}

fn handle(svc: &Mutex<Service>, req: Request) -> Response {
    // Подписка ходит в сеть, поэтому разбирается до замка — остальные команды
    // работают с состоянием и берут его сразу.
    if let Request::AddProfile { link } = &req {
        let link = link.trim();
        if link.starts_with("http://") || link.starts_with("https://") {
            return subscribe(svc, link);
        }
    }
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
                0 => t("автообнаружение: ничего нового не найдено", "discovery: nothing new found"),
                n => t(&format!("автообнаружение: добавлено приложений — {n}"), &format!("discovery: {n} apps added")),
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
            None => Response::Error {
                message: t(&format!("приложение не в списке: {path}"), &format!("app is not in the list: {path}")),
            },
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
                s.log(t(&format!("профиль «{}» импортирован", p.name), &format!("profile \"{}\" imported", p.name)));
                s.save();
                Response::Done
            }
            Err(e) => Response::Error { message: e },
        },
        Request::SetLang { lang } => {
            // Язык переключает и журнал службы: сообщения пишет она, а читает
            // их пользователь в окне.
            s.status.lang = lang;
            core_ipc::set_lang(lang);
            s.save();
            Response::Done
        }
        Request::RemoveProfile { name } => {
            s.forget_profile(&name);
            s.save();
            Response::Done
        }
        Request::RemoveSubscription { url } => match s.subscriptions.remove(&url) {
            Some(names) => {
                for name in &names {
                    s.forget_profile(name);
                }
                s.log(t(
                    &format!("подписка отключена, профилей убрано — {}", names.len()),
                    &format!("subscription removed, profiles dropped — {}", names.len()),
                ));
                s.save();
                Response::Done
            }
            None => Response::Error {
                message: t(&format!("нет подписки {url}"), &format!("no subscription {url}")),
            },
        },
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
            s.status.country = None;
            s.guard(true);
            if s.retry_at.is_some_and(|at| Instant::now() < at) {
                continue; // ждём паузы: отказ повторяется, а не проходит сам
            }
            s.log(t(
                "sing-box не работает: выбранные приложения без сети, перезапуск",
                "sing-box is down: selected apps have no network, restarting",
            ));
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
        let mut just_up = false;
        match result {
            Ok(latency) => {
                if s.status.tunnel != TunnelState::Up {
                    s.log(t(&format!("туннель поднят, задержка {latency} мс"), &format!("tunnel is up, latency {latency} ms")));
                    // Проверяем именно здесь: чужой туннель не мешает нам
                    // подняться, но может забрать маршруты — и тогда «Защищено»
                    // окажется правдой только про нас, а не про приложения.
                    for name in core_filter::foreign_tunnels() {
                        s.log(t(
                            &format!("рядом поднят чужой туннель «{name}» — выберите один: маршруты уйдут к тому, кто выиграет"),
                            &format!("another tunnel \"{name}\" is up — keep one: routes go to whichever wins"),
                        ));
                    }
                    s.guard(false); // дальше маршрутизацией занимается сам sing-box
                    just_up = true;
                }
                s.status.tunnel = TunnelState::Up;
                s.status.latency_ms = Some(latency);
            }
            Err(e) => {
                if s.status.tunnel != TunnelState::Down {
                    s.log(t(
                        &format!("туннель недоступен ({e}): выбранные приложения без сети"),
                        &format!("tunnel unavailable ({e}): selected apps have no network"),
                    ));
                    s.guard(true);
                }
                s.status.tunnel = TunnelState::Down;
                s.status.latency_ms = None;
                s.status.country = None;
            }
        }
        if let Some((rx, tx)) = traffic {
            (s.status.rx, s.status.tx) = (rx, tx);
        }
        drop(s);

        // Единственный запрос наружу за всю работу службы — и только на переходе
        // в «поднят»: дёргать чужой сервис каждые три секунды незачем, он и сам
        // считает это флудом. Замок на это время отпущен: сеть медленная, а под
        // ним стоит весь GUI.
        if just_up && geo_enabled() {
            let found = core_tunnel::exit_country(socks_port);
            let mut s = svc.lock().unwrap();
            match found {
                Ok(country) => {
                    s.log(t(&format!("точка выхода: {country}"), &format!("exit point: {country}")));
                    s.status.country = Some(country);
                }
                // Страна — украшение статуса; не узнали, значит не показываем.
                // На fail-closed это не влияет никак.
                Err(e) => {
                    s.log(t(&format!("страну выхода узнать не удалось ({e})"), &format!("could not determine the exit country ({e})")));
                    s.status.country = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tun_failures_named_correctly() {
        let denied = explain("configure tun interface: Access is denied.");
        assert!(denied.contains("права администратора"), "{denied}");
        let busy = explain("configure tun interface: file already exists");
        assert!(busy.contains("другой VPN"), "{busy}");
        assert_eq!(explain("порт занят"), "порт занят", "не про TUN — не додумываем");
    }

    #[test]
    fn probe_goes_to_own_server() {
        std::env::remove_var("PG_PROBE");
        let vless = json!({ "type": "vless", "server": "a.com", "server_port": 8443 });
        assert_eq!(probe_target(&vless), ("a.com".to_string(), 8443));
        // У WireGuard сервер описан узлом peers, а не полем server.
        let wg = json!({ "type": "wireguard", "peers": [{ "address": "b.com", "port": 51820 }] });
        assert_eq!(probe_target(&wg), ("b.com".to_string(), 51820));
    }

    /// Перезапуск не должен ни тихо возвращать выбранные приложения в открытую
    /// сеть, ни поднимать туннель после того, как его выключили. Обе половины
    /// в одном тесте: они делят каталог состояния, а тесты идут параллельно.
    #[test]
    fn private_mode_survives_restart() {
        let tmp = std::env::temp_dir().join("pg-state-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("XDG_CONFIG_HOME", &tmp);
        std::env::set_var("ProgramData", &tmp);

        let mut s = Service::load();
        s.status.apps.push(App { path: "/bin/true".into(), name: "true".into(), enabled: true });
        s.profiles.insert("p".into(), json!({ "type": "trojan", "server": "a.com", "server_port": 443 }));
        s.status.profile = Some("p".into());
        s.private = true;
        s.save();

        let restored = Service::load();
        assert!(restored.private, "приватный режим обязан пережить перезапуск");
        assert_eq!(restored.status.profile.as_deref(), Some("p"));
        assert_eq!(restored.status.apps.len(), 1);
        assert_eq!(restored.status.tunnel, TunnelState::Off, "туннель после старта ещё не поднят");
        assert_eq!(restored.status.rx, 0, "счётчики трафика не переносятся");

        let mut s = restored;
        s.stop();
        assert!(!Service::load().private, "выключение — тоже решение, и оно тоже запоминается");
    }
}

fn serve(svc: &Mutex<Service>, mut conn: Stream) {
    let Ok(clone) = conn.try_clone() else { return };
    for line in BufReader::new(clone).lines().map_while(Result::ok) {
        let resp = match serde_json::from_str(&line) {
            Ok(req) => handle(svc, req),
            Err(e) => Response::Error {
                message: t(&format!("неразбираемый запрос: {e}"), &format!("unparsable request: {e}")),
            },
        };
        let out = serde_json::to_string(&resp).unwrap();
        if writeln!(conn, "{out}").is_err() || conn.flush().is_err() {
            return;
        }
    }
}

/// Тело службы. `stop` приходит от SCM; в консольном режиме его нет, и тогда
/// функция не возвращается — работу заканчивает Ctrl+C.
fn run(stop: Option<mpsc::Receiver<()>>) -> std::io::Result<()> {
    let svc = Arc::new(Mutex::new(Service::load()));
    let (listener, endpoint) = Listener::bind()?;
    {
        let mut s = svc.lock().unwrap();
        let (apps, profiles) = (s.status.apps.len(), s.profiles.len());
        let where_ = match endpoint {
            Endpoint::Pipe => format!("канал {}", core_ipc::PIPE),
            Endpoint::Tcp => format!("сокет {ADDR}"),
        };
        s.log(t(
            &format!("служба слушает {where_}; приложений: {apps}, профилей: {profiles}"),
            &format!("service listening on {where_}; apps: {apps}, profiles: {profiles}"),
        ));
        if cfg!(windows) && endpoint == Endpoint::Tcp {
            // Канал ограничен списком доступа, сокет — нет: управлять службой
            // сможет любой процесс на машине. Молчать об этом нельзя.
            s.log(t(
                "ВНИМАНИЕ: именованный канал не создался, работаем через локальный сокет — доступ к службе не ограничен",
                "WARNING: the named pipe was not created, falling back to a local socket — access to the service is unrestricted",
            ));
        }
        if !elevated() {
            s.log(t(
                "ВНИМАНИЕ: служба запущена без прав администратора — TUN и правила брандмауэра работать не будут",
                "WARNING: the service is running without administrator rights — TUN and firewall rules will not work",
            ));
        }
        match (s.private, s.status.profile.clone()) {
            // Приватный режим пережил перезапуск — восстанавливаем его сами.
            // start() сначала блокирует, потом поднимает туннель, поэтому окна
            // прямого доступа между загрузкой системы и туннелем не возникает.
            (true, Some(profile)) => {
                s.log(t(
                    &format!("приватный режим был включён — восстанавливаю профиль «{profile}»"),
                    &format!("private mode was on — restoring profile \"{profile}\""),
                ));
                let _ = s.start(&profile);
            }
            // Служба, убитая прошлый раз, могла оставить блокирующие правила: без
            // этого выбранные приложения остались бы без сети и снять их было бы нечем.
            _ => s.guard(false),
        }
    }

    let watched = Arc::clone(&svc);
    std::thread::spawn(move || supervise(&watched));

    let accepting = Arc::clone(&svc);
    std::thread::spawn(move || loop {
        match listener.accept() {
            Ok(conn) => {
                let svc = Arc::clone(&accepting);
                std::thread::spawn(move || serve(&svc, conn));
            }
            // Отвалившееся соединение не должно останавливать приём следующих.
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
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
