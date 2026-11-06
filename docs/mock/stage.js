// Сцена для скриншотов: настоящее окно, вместо службы — демо-данные.
//
// Подключается только `shoot.mjs`: дев-сервер вставляет этот файл в <head>
// до бандла, и окно, которое в браузере ходит в службу через `fetch("/ipc")`,
// получает ответы отсюда. Своей вёрстки тут нет ни строки — всё, что видно на
// картинке, рисует `ui/app-shell`, поэтому новая версия окна переснимается
// без правки макета.
//
// Адрес: `?scene=up|failclosed|first-run|settings|browsers&lang=ru|en`,
// плашка — `?flyout&scene=up`. Данные вымышленные: домены example.net, адреса
// из документационных диапазонов RFC 5737.
(() => {
  const q = new URLSearchParams(location.search);
  const scene = q.get("scene") || "up";
  const en = q.get("lang") === "en";
  const L = (ru, eng) => (en ? eng : ru);

  // Карточка первого запуска живёт в localStorage окна: решаем до первого
  // рендера. Тему не трогаем — тёмную системную даёт `--force-dark-mode`, и в
  // настройках остаётся выбранной «Системная», как у всех.
  try {
    localStorage.removeItem("pg.theme");
    if (scene === "first-run") localStorage.removeItem("pg.welcome");
    else localStorage.setItem("pg.welcome", "1");
  } catch {}

  // В рамке (`frame.html`) виртуальное время headless до анимаций iframe не
  // доходит: вплыв заголовка и переходы застывают на полпути. Там они
  // выключаются — снимок показывает конечное состояние.
  if (window !== window.top) {
    const still = document.createElement("style");
    still.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
    document.head.append(still);
  }

  const now = Math.floor(Date.now() / 1000);
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;

  const AMS = "Amsterdam · Reality";
  const US = L("Резидентный US", "Residential US");
  const VPS = L("Мой VPS", "My VPS");
  const SUB = ["Frankfurt", "Helsinki", "Tokyo", "Singapore"];

  const profiles = [
    { name: AMS, kind: "vless", server: "ams.example.net:443", plain: false, favorite: true },
    { name: US, kind: "socks", server: "203.0.113.7:1080", plain: true, favorite: false },
    { name: VPS, kind: "wireguard", server: "198.51.100.4:51820", plain: false, favorite: false },
    { name: "Frankfurt", kind: "vless", server: "fra.example.net:443", plain: false, favorite: false },
    { name: "Helsinki", kind: "trojan", server: "hel.example.net:8443", plain: false, favorite: false },
    { name: "Tokyo", kind: "hysteria2", server: "tyo.example.net:443", plain: false, favorite: false },
    { name: "Singapore", kind: "vless", server: "sg.example.net:443", plain: false, favorite: false },
  ];

  const probe = (name, latency_ms, code, country, error = null, brief = null) => ({
    name, latency_ms, code, country, error, brief, at: now - 50 * 60,
  });
  const probes = [
    probe(AMS, 48, "NL", L("Нидерланды, Амстердам", "Netherlands, Amsterdam")),
    probe(US, 140, "US", L("США, Даллас", "United States, Dallas")),
    probe("Frankfurt", 61, "DE", L("Германия, Франкфурт-на-Майне", "Germany, Frankfurt am Main")),
    probe("Helsinki", 352, "FI", L("Финляндия, Хельсинки", "Finland, Helsinki")),
    probe("Tokyo", null, "JP", null, "i/o timeout", L("таймаут", "timeout")),
  ];

  const app = (path, enabled) => ({ path, name: path.split("\\").pop().replace(/\.exe$/i, ""), enabled });
  const apps = [
    app("C:\\Program Files\\Mozilla Firefox\\firefox.exe", true),
    app("C:\\Program Files\\Telegram Desktop\\Telegram.exe", true),
    app("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", false),
    app("C:\\Program Files\\qBittorrent\\qbittorrent.exe", false),
  ];

  const browser = (name, node, extra) => ({
    name, node, ua: "", lang: "auto", icon: "", tags: [], ephemeral: false,
    engine: "chromium", timezone: "auto", compatibility: false, ...extra,
  });

  // Журнал служба пишет на своём языке; строки — из `core-ipc::dict`.
  const log = [
    [now - 3 * 3600, L("служба слушает \\\\.\\pipe\\proxybox; приложений: 4, профилей: 7", "service listening on \\\\.\\pipe\\proxybox; apps: 4, profiles: 7")],
    [now - 50 * 60, L("подписка обновлена, узлов — 4", "subscription updated, nodes — 4")],
    [now - 49 * 60, L("прогон профилей: отвечают 4 из 6", "profile run: 4 of 6 alive")],
    [now - 12 * 60, L(
      `профиль «${AMS}»: sing-box запущен, приложений с сетью: 2, у остальных её нет`,
      `profile "${AMS}": sing-box started, apps with network: 2, everyone else is offline`,
    )],
    [now - 12 * 60 + 1, L("туннель поднят, задержка 48 мс", "tunnel is up, latency 48 ms")],
  ].map(([at, text]) => ({ at, text, bad: false }));

  const tunnel = { up: "up", settings: "up", browsers: "up", failclosed: "down", "first-run": "off" }[scene] ?? "up";
  const live = tunnel === "up";

  const status = {
    tunnel,
    profile: AMS,
    latency_ms: live ? 48 : null,
    country: live ? L("Нидерланды, Амстердам", "Netherlands, Amsterdam") : null,
    rx: Math.round(1.2 * GB),
    tx: 230 * MB,
    traffic_at: Date.now(),
    apps,
    scope: scene === "failclosed" ? "all" : "whitelist",
    profiles,
    subscriptions: [
      {
        url: "https://panel.example.net/sub/demo",
        name: L("Панель", "Panel"),
        nodes: SUB,
        quota: { upload: 4 * GB, download: 25 * GB, total: 93 * GB, expire: now + 76 * 86400 },
      },
    ],
    lang: en ? "en" : "ru",
    log,
    refreshed_at: now - 50 * 60,
    probes,
    browsers: [],
    browser_profiles: [
      browser(L("Работа", "Work"), "Frankfurt", { lang: "", tags: ["work"] }),
      browser("Shop", AMS, { ephemeral: true, engine: "firefox" }),
    ],
    browser_trash: [],
    settings: { refresh: true, refresh_hours: 12, probe: "", singbox: "", geo: true, failover: false },
    retry_in: scene === "failclosed" ? 4 : null,
    testing: null,
  };

  // Счётчики растут от пульса к пульсу: график скорости в линейке считается
  // окном по разнице снятий, и ровная волна читается как живой канал.
  let tick = 0;
  const pulse = () => {
    if (live) {
      tick += 1;
      const at = Date.now();
      const dt = (at - status.traffic_at) / 1000;
      const wave = 1 + 0.55 * Math.sin(tick / 2.3) + 0.3 * Math.sin(tick / 0.9 + 1);
      status.rx += Math.round(2.4 * MB * wave * dt);
      status.tx += Math.round(0.35 * MB * (1.4 - wave * 0.4 + 0.3 * Math.sin(tick / 1.3)) * dt);
      status.traffic_at = at;
    }
    const { tunnel, profile, latency_ms, country, rx, tx, traffic_at, retry_in, testing } = status;
    return { tunnel, profile, latency_ms, country, rx, tx, traffic_at, retry_in, testing, cold: 1 };
  };

  const answer = (req) => {
    switch (req.cmd) {
      case "status": return { reply: "status", data: structuredClone(status) };
      case "pulse": return { reply: "pulse", data: pulse() };
      case "icon": return { reply: "icon", data: null };
      case "list-apps": return { reply: "apps", data: apps };
      case "fenced": return { reply: "fenced", data: { apps: [] } };
      case "connections": return { reply: "connections", data: { conns: [], total: 0, matched: 0 } };
      case "singbox-log": return { reply: "singbox-log", data: { lines: [] } };
      default: return { reply: "done" };
    }
  };

  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/ipc" || url.endsWith("/ipc")) {
      const body = JSON.stringify(answer(JSON.parse(init.body)));
      return Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
    }
    return real(input, init);
  };

  // Настройки и браузерные профили открываются так же, как их открывает
  // человек, — когда окно уже получило статус.
  const drive = () => {
    const rail = document.querySelectorAll("nav.rail > button");
    if (rail.length < 6) return setTimeout(drive, 50);
    if (scene === "settings") {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Comma", ctrlKey: true, bubbles: true }));
    }
    // Пятый пункт рейки — браузерные профили (`App.tsx`).
    if (scene === "browsers") rail[4].click();
  };
  if (scene === "settings" || scene === "browsers") addEventListener("DOMContentLoaded", drive);
})();
