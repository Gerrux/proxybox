// Единственная точка связи фронтенда со службой — та же core-ipc, что у CLI.
// ponytail: типы контракта продублированы с Rust вручную. Генератор (ts-rs)
// оправдан, когда типов станет заметно больше шести.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Tunnel = "off" | "connecting" | "up" | "down";

export type Lang = "ru" | "en";

/** Кого касается приватный режим. Три состояния взаимоисключающие: «весь
 *  компьютер и одновременно белый список» — состояние, которого не бывает.
 *  - `apps` — выбранные в туннель, остальные напрямую;
 *  - `whitelist` — выбранные в туннель, у остальных сети нет вовсе;
 *  - `all` — вся машина в туннель, список не участвует. */
export type Scope = "whitelist" | "all";

export type App = { path: string; name: string; enabled: boolean };

/** Строка журнала со временем записи (unix-секунды): возраст словами считает
 *  окно — служба не знает ни часового пояса того, кто смотрит, ни его языка. */
export type LogLine = { at: number; text: string; /** Сломалось, а не случилось. */ bad: boolean };

/** Последнее известное про профиль: либо задержка, либо причина отказа, плюс
 *  точка выхода. Точку выхода спрашивают у ответивших — при `PG_GEO=0` её не
 *  будет ни у кого. Переживает перезапуск службы, поэтому рядом едет `at`:
 *  вчерашняя задержка без возраста читается как сегодняшняя. */
export type Probe = {
  name: string;
  latency_ms: number | null;
  country: string | null;
  /** Код страны ISO 3166-1 alpha-2 («NL»): им подписана строка профиля. */
  code: string | null;
  error: string | null;
  /** Когда измерено, unix-секунды. 0 — неизвестно (состояние прошлых версий). */
  at: number;
};

/** Браузерный профиль — личность окна, отдельная от узла: узел даёт адрес,
 *  каталог сеанса — куки и входы, `ua` и `lang` — то, что видит сайт. На один
 *  узел их бывает несколько: два аккаунта через одну страну иначе не развести.
 *
 *  Чего этим не добиться: `--user-agent` меняет строку и `navigator.userAgent`,
 *  а `Sec-CH-UA` и `navigator.userAgentData` Chromium берёт из настоящей
 *  сборки. Canvas, шрифты, экран и GPU у профилей одной машины общие. Это
 *  разделение аккаунтов, а не антидетект. */
export type BrowserProfile = {
  name: string;
  /** Имя профиля узла. Узел могли удалить — профиль это переживает, открыть
   *  его тогда нечем. */
  node: string;
  /** Пусто — настоящий user-agent установленного браузера. */
  ua: string;
  /** `Accept-Language`; `auto` — по стране узла, пусто — системный. */
  lang: string;
};

/** Одно живое соединение туннеля. Смысл не в счётчиках, а в `tunneled`:
 *  правило по `process_path` сверяет путь побайтово, и промах у него тихий —
 *  приложение уходит мимо туннеля, не переставая считаться защищённым. Здесь
 *  этот промах видно глазами.
 *
 *  Ничего не хранится ни в службе, ни здесь: список спрашивается, пока панель
 *  открыта, и умирает вместе с ней. */
export type Conn = {
  /** Путь к процессу-владельцу целиком. Пусто — sing-box его не определил: так
   *  выглядит трафик без процесса за ним (DNS, служба, драйвер). */
  process: string;
  /** Куда: домен, если известен, иначе адрес назначения, и порт рядом. */
  host: string;
  /** Идёт ли соединение в туннель — по цепочке маршрутов, а не по списку
   *  приложений: список это намерение, цепочка — то, что вышло. */
  tunneled: boolean;
  /** Выбранное приложение, ушедшее мимо туннеля. Считает служба: в конфиг
   *  sing-box уходит до двух форм пути на приложение, а в списке живёт одна —
   *  своя сверка здесь красила бы серым ровно ту утечку, ради которой вторая
   *  форма и заведена. */
  leak: boolean;
  rx: number;
  tx: number;
};

/** Подписка вместе с узлами, которые с неё пришли. Имена — те же, что в
 *  `Status.profiles`: список профилей рисуется группами по подпискам. */
export type Subscription = {
  url: string;
  nodes: string[];
};

export type Status = {
  tunnel: Tunnel;
  profile: string | null;
  latency_ms: number | null;
  country: string | null;
  rx: number;
  tx: number;
  /** Когда счётчики сняли, миллисекунды с эпохи. Служба ходит за ними реже,
   *  чем окно спрашивает статус: по разнице двух отметок и считается скорость. */
  traffic_at: number;
  apps: App[];
  /** Кого касается приватный режим. В `all` список `apps` не применяется, в
   *  `whitelist` он же — единственный пропуск в сеть. */
  scope: Scope;
  profiles: string[];
  subscriptions: Subscription[];
  lang: Lang;
  log: LogLine[];
  /** Когда подписки последний раз пришли с панели, unix-секунды. */
  refreshed_at: number | null;
  probes: Probe[];
  /** Профили, под которыми сейчас подняты прокси окон браузера. С `tunnel` не
   *  связаны: браузер ходит своим sing-box мимо общего режима, а сеансов бывает
   *  несколько разом — по одному на браузерный профиль. */
  browsers: string[];
  /** Заведённые браузерные профили. */
  browser_profiles: BrowserProfile[];
  /** Настройки службы — уже действующие: переменные окружения к ним применены,
   *  и окно показывает то, что работает, а не то, что записано на диск. */
  settings: Settings;
};

/** Настройки службы. Всё, что до этого жило только в переменных окружения и
 *  потому было доступно тому, кто продукт собрал, а не тому, кто установил. */
export type Settings = {
  /** Сверять подписки в фоне. */
  refresh: boolean;
  /** Цель пробы, `host:port`. Пусто — сервер самого узла: сторонних адресов
   *  продукт по умолчанию не трогает. */
  probe: string;
  /** Путь к бинарнику sing-box. Пусто — рядом со службой либо `PATH`. */
  singbox: string;
  /** Спрашивать точку выхода у внешнего сервиса — единственный запрос службы
   *  наружу. */
  geo: boolean;
};

/** Отправить команду службе. Возвращает «приняли ли»: единственный, кому это
 *  нужно, — поле ввода, которое не должно терять текст, если его не приняли. */
export type Act = (req: Request) => Promise<boolean>;

export type Request =
  | { cmd: "status" }
  | { cmd: "on"; arg: { profile: string } }
  | { cmd: "off" }
  | { cmd: "list-apps" }
  /** Окружение пользователя подставляет оболочка (src-tauri): фронтенд в
   *  вебвью, окружения у него нет. В браузере при разработке уходит пустая
   *  карта — служба тогда перебирает все профили машины. */
  | { cmd: "discover"; arg: { env: Record<string, string> } }
  | { cmd: "add-app"; arg: { path: string } }
  | { cmd: "icon"; arg: { path: string } }
  | { cmd: "set-app"; arg: { path: string; enabled: boolean } }
  | { cmd: "remove-app"; arg: { path: string } }
  /** Охват: кого касается приватный режим. */
  | { cmd: "set-scope"; arg: { scope: Scope } }
  | { cmd: "set-lang"; arg: { lang: Lang } }
  | { cmd: "add-profile"; arg: { link: string } }
  | { cmd: "remove-profile"; arg: { name: string } }
  /** Подписки заводятся через add-profile с https-адресом; повторный импорт
   *  того же адреса её обновляет. Отдельная команда нужна только на «отписаться». */
  | { cmd: "remove-subscription"; arg: { url: string } }
  /** Прогон всех профилей: каждый проверяется отдельным подключением, живой
   *  туннель при этом не трогается. */
  | { cmd: "test-profiles" }
  /** Отдельный прокси под профиль — для окна браузера. Ответ: порт. */
  | { cmd: "browse"; arg: { profile: string } }
  /** Погасить сеанс браузера. Шлёт оболочка, дождавшись закрытия окна. */
  | { cmd: "browse-stop"; arg: { profile: string } }
  /** Завести браузерный профиль либо переписать такой же по имени. */
  | { cmd: "set-browser-profile"; arg: { profile: BrowserProfile } }
  | { cmd: "remove-browser-profile"; arg: { name: string } }
  /** Настройки службы приходят набором целиком: команда на поле означала бы
   *  четыре ветки в службе ради экрана, который отдаёт их разом. */
  | { cmd: "set-settings"; arg: { settings: Settings } }
  /** Живые соединения туннеля. Спрашивается только пока панель открыта. */
  | { cmd: "connections" };

export type Response =
  | { reply: "status"; data: Status }
  | { reply: "apps"; data: App[] }
  /** PNG в data-URL; null — иконки у файла нет. */
  | { reply: "icon"; data: string | null }
  | { reply: "done" }
  /** Порт локального прокси, поднятого под профиль. */
  | { reply: "proxy"; data: { port: number } }
  /** Живые соединения; `total` — сколько их всего: в списке едут только самые
   *  говорливые, и без этого числа обрезанный список читался бы как полный. */
  | { reply: "connections"; data: { conns: Conn[]; total: number } }
  | { reply: "error"; data: { message: string } };

/** Подставляется сборкой из src-tauri/tauri.conf.json (см. vite.config.ts). */
declare const __APP_VERSION__: string;
export const VERSION = __APP_VERSION__;

export const isTauri = () => "__TAURI_INTERNALS__" in window;

/** Ссылка открывается в браузере пользователя, а не в окне приложения: окно
 *  умеет показывать только свой фронтенд, а уводить его на github.com значило
 *  бы потерять интерфейс. */
export async function openUrl(url: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** Окно браузера через отдельный туннель профиля: служба поднимает прокси и
 *  отдаёт порт, браузер запускает оболочка — фронтенд живёт в вебвью, процессов
 *  ему не завести. Она же дожидается закрытия окна и гасит сеанс, поэтому
 *  «закрыть» отсюда не вызывается вовсе. */
export async function browse(profile: BrowserProfile, color: string): Promise<void> {
  const r = await call({ cmd: "browse", arg: { profile: profile.name } });
  if (r.reply !== "proxy") {
    throw new Error(r.reply === "error" ? r.data.message : "служба не вернула порт");
  }
  // В браузере при разработке запускать нечем — показываем адрес как есть, он
  // и есть всё, что нужно: подставить в --proxy-server руками. Текст без слов
  // намеренно, строки живут в i18n, а тот импортирует типы отсюда.
  if (!isTauri()) {
    throw new Error(`socks5://127.0.0.1:${r.data.port}`);
  }
  await invoke("open_browser", {
    port: r.data.port,
    profile: profile.name,
    ua: profile.ua,
    lang: profile.lang,
    // Цвет значка окна: считает его интерфейс, оболочка только красит.
    color,
  });
}

/** Стереть сохранённый сеанс браузера (входы, куки, закладки этого профиля).
 *  Каталог лежит в `%LOCALAPPDATA%` человека, поэтому это дело оболочки, а не
 *  службы: у той LocalSystem и чужой профиль. В разработке в браузере стирать
 *  нечего — и незачем. */
export async function forgetBrowser(profile: string): Promise<void> {
  if (isTauri()) {
    await invoke("forget_browser", { profile });
  }
}

/** Автозапуск окна с Windows: ключ `HKCU\…\Run` правит оболочка — фронтенд в
 *  вебвью, реестра ему не видно. Службы это не касается вовсе: она в SCM и
 *  стартует сама, автозапуск нужен значку в трее.
 *
 *  В разработке в браузере автозапуска нет: `false` и отказ на попытку. */
export async function autostart(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("autostart") : false;
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!isTauri()) throw new Error("autostart: Windows only");
  return invoke<boolean>("set_autostart", { enabled });
}

/** Плашка из трея — то же приложение во втором окне (`tray` в `src-tauri`).
 *  Отличать её надо: рамки у неё нет и быть не должно, разворачивать некуда, а
 *  «закрыть» для неё значит спрятаться. Метка окна, а не параметр адреса: окно
 *  заводит оболочка, и метка у неё уже есть. */
export const isFlyout = () => isTauri() && getCurrentWindow().label === "tray";

/** Спрятать своё окно. Главное так уходит в трей, плашка — гаснет. */
export async function hideWindow(): Promise<void> {
  if (isTauri()) await getCurrentWindow().hide();
}

/** Выйти из окна совсем. Служба остаётся работать: закрывается окно, а не
 *  продукт, — и диалог закрытия говорит об этом теми же словами. */
export async function quitApp(): Promise<void> {
  if (isTauri()) await invoke("quit_app");
}

/** События от оболочки: «нажали крестик» и «открой настройки» из меню значка.
 *  Возвращает отписку — слушателей заводят в эффектах. */
export function onShell(event: "close-requested" | "open-settings", run: () => void): () => void {
  if (!isTauri()) return () => {};
  let off: (() => void) | null = null;
  let dead = false;
  void listen(event, run).then((fn) => (dead ? fn() : (off = fn)));
  return () => {
    dead = true;
    off?.();
  };
}

export async function call(req: Request): Promise<Response> {
  if (isTauri()) {
    return invoke<Response>("ipc", { req });
  }
  // Разработка в браузере: мост дев-сервера (vite.config.ts). В собранном
  // приложении сюда не попадаем — там всегда Tauri.
  const response = await fetch("/ipc", { method: "POST", body: JSON.stringify(req) });
  return response.json() as Promise<Response>;
}
