// Переснять картинки docs/: настоящее окно из ui/app-shell с демо-данными.
//
//   node docs/mock/shoot.mjs            # все картинки
//   node docs/mock/shoot.mjs flyout og  # только названные (имя без -en)
//   node docs/mock/shoot.mjs --serve    # не снимать, только показать сцены
//
// Поднимает дев-сервер Vite из этого чекаута на свободном порту, вставляет в
// страницу `stage.js` (подмена службы) и снимает каждую сцену headless-Chrome.
// Нужны `pnpm install` и установленный Chrome (или Edge; путь — PG_CHROME).
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as freePort } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const SHELL = join(REPO, "ui/app-shell");
const DOCS = join(REPO, "docs");

// Окно — 1000×700 (`tauri.conf.json`), плашка — 380×520; масштаб 1.5 даёт
// картинку, которая и на ретине чёткая, и в README весит десятки килобайт.
// Русский набор — для README.md, docs/*.md и сайта, английский (`-en`) — для
// остальных README.
const SHOTS = [
  { name: "interface", query: "scene=up" },
  { name: "interface-failclosed", query: "scene=failclosed" },
  { name: "first-run", query: "scene=first-run" },
  { name: "settings", query: "scene=settings" },
  { name: "browsers", query: "scene=browsers" },
  { name: "flyout", query: "flyout&scene=up", size: [380, 520] },
];
const OG = { name: "og", size: [1280, 640], scale: 1 };

const CHROME = [
  process.env.PG_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("не найден Chrome: укажите путь в PG_CHROME");

// Vite стоит в зависимостях ui/app-shell, а не в корне воркспейса.
const require = createRequire(join(SHELL, "package.json"));
const vite = await import(pathToFileURL(join(dirname(require.resolve("vite/package.json")), "dist/node/index.js")));

const port = await new Promise((ok) => {
  const s = freePort().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});

const stage = readFileSync(join(HERE, "stage.js"), "utf8");
const server = await vite.createServer({
  configFile: join(SHELL, "vite.config.ts"),
  root: SHELL,
  logLevel: "warn",
  server: { port, strictPort: true, host: "127.0.0.1" },
  plugins: [
    {
      name: "proxybox-stage",
      transformIndexHtml: () => [{ tag: "script", children: stage, injectTo: "head-prepend" }],
    },
  ],
});
await server.listen();
const base = `http://127.0.0.1:${port}`;

const run = promisify(execFile);

async function shoot(out, url, [w, h], scale) {
  // Каталог профиля свой на каждый снимок: недобитый прошлый Chrome держит
  // общий, и следующий запуск повисает на нём. Повисший снимаем по таймауту
  // и пробуем ещё раз.
  for (let attempt = 1; ; attempt++) {
    const profile = mkdtempSync(join(tmpdir(), "pb-shot-"));
    try {
      // Время виртуальное: опрос статуса раз в две секунды, перелёт карты и
      // полторы минуты графика скорости проходят за секунды настоящего.
      await run(CHROME, [
        "--headless=new",
        "--hide-scrollbars",
        "--disable-gpu",
        "--no-first-run",
        "--force-dark-mode",
        `--user-data-dir=${profile}`,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${w},${h}`,
        "--virtual-time-budget=90000",
        `--screenshot=${out}`,
        url,
      ], { cwd: tmpdir(), timeout: 30_000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`повтор ${out}: ${e.message.split("\n")[0]}`);
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  console.log(`${out.slice(REPO.length + 1)}  ${w}×${h} @${scale}`);
}

// Свои страницы макета Vite отдаёт по /@fs/: так у них одно происхождение с
// окном — его шрифты грузятся, а само окно встаёт в iframe.
const page = (file) => `${base}/@fs/${join(HERE, file).replaceAll("\\", "/").replace(/^\//, "")}`;

// --serve: только сервер, смотреть сцены глазами; гасится Ctrl+C.
if (process.argv.includes("--serve")) {
  for (const s of SHOTS) console.log(`${s.name.padEnd(22)} ${base}/?${s.query}&lang=ru`);
  console.log(`${OG.name.padEnd(22)} ${page("og.html")}`);
  await new Promise(() => {});
}

const SCALE = 1.5;
const only = new Set(process.argv.slice(2));
const wanted = (name) => only.size === 0 || only.has(name);
const taken = [];
try {
  for (const lang of ["ru", "en"]) {
    for (const s of SHOTS.filter((s) => wanted(s.name))) {
      const file = join(DOCS, `${s.name}${lang === "en" ? "-en" : ""}.png`);
      taken.push(file);
      const app = `/?${s.query}&lang=${lang}`;
      if (s.size) {
        // Уже 500 px окно headless не бывает: узкая сцена — в рамке.
        const [w, h] = s.size;
        const framed = `${page("frame.html")}?w=${w}&h=${h}&k=${SCALE}&src=${encodeURIComponent(app)}`;
        await shoot(file, framed, [w * SCALE, h * SCALE], 1);
      } else {
        await shoot(file, base + app, [1000, 700], SCALE);
      }
    }
  }
  if (wanted(OG.name)) await shoot(join(DOCS, "og.png"), page("og.html"), OG.size, OG.scale);
} finally {
  await server.close();
}

// Палитра втрое легче: окно плоское, и разницы глазом не видно (`squeeze.py`).
if (taken.length) {
  const squeeze = join(HERE, "squeeze.py");
  for (const python of ["python", "python3"]) {
    try {
      await run(python, [squeeze, ...taken]);
      console.log(`пережато палитрой: ${taken.length}`);
      break;
    } catch (e) {
      if (python === "python3") console.warn(`не пережато (нужен Python с Pillow): ${e.message.split("\n")[0]}`);
    }
  }
}
