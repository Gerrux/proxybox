// Единственная точка связи фронтенда со службой — та же core-ipc, что у CLI.
// ponytail: типы контракта продублированы с Rust вручную. Генератор (ts-rs)
// оправдан, когда типов станет заметно больше шести.
import { invoke } from "@tauri-apps/api/core";

export type Tunnel = "off" | "connecting" | "up" | "down";

export type Lang = "ru" | "en";

export type App = { path: string; name: string; enabled: boolean };

/** Строка журнала со временем записи (unix-секунды): возраст словами считает
 *  окно — служба не знает ни часового пояса того, кто смотрит, ни его языка. */
export type LogLine = { at: number; text: string };

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

export type Status = {
  tunnel: Tunnel;
  profile: string | null;
  latency_ms: number | null;
  country: string | null;
  rx: number;
  tx: number;
  apps: App[];
  /** Весь трафик машины в туннеле: список `apps` тогда не применяется. */
  all_traffic: boolean;
  profiles: string[];
  subscriptions: string[];
  lang: Lang;
  log: LogLine[];
  probes: Probe[];
  /** Профили, под которыми сейчас подняты прокси окон браузера. С `tunnel` не
   *  связаны: браузер ходит своим sing-box мимо общего режима, а сеансов бывает
   *  несколько разом — по одному на профиль. */
  browsers: string[];
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
  /** Охват: весь трафик машины либо только выбранные приложения. */
  | { cmd: "set-all-traffic"; arg: { enabled: boolean } }
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
  | { cmd: "browse-stop"; arg: { profile: string } };

export type Response =
  | { reply: "status"; data: Status }
  | { reply: "apps"; data: App[] }
  /** PNG в data-URL; null — иконки у файла нет. */
  | { reply: "icon"; data: string | null }
  | { reply: "done" }
  /** Порт локального прокси, поднятого под профиль. */
  | { reply: "proxy"; data: { port: number } }
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
export async function browse(profile: string): Promise<void> {
  const r = await call({ cmd: "browse", arg: { profile } });
  if (r.reply !== "proxy") {
    throw new Error(r.reply === "error" ? r.data.message : "служба не вернула порт");
  }
  // В браузере при разработке запускать нечем — показываем адрес как есть, он
  // и есть всё, что нужно: подставить в --proxy-server руками. Текст без слов
  // намеренно, строки живут в i18n, а тот импортирует типы отсюда.
  if (!isTauri()) {
    throw new Error(`socks5://127.0.0.1:${r.data.port}`);
  }
  await invoke("open_browser", { port: r.data.port, profile });
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

export async function call(req: Request): Promise<Response> {
  if (isTauri()) {
    return invoke<Response>("ipc", { req });
  }
  // Разработка в браузере: мост дев-сервера (vite.config.ts). В собранном
  // приложении сюда не попадаем — там всегда Tauri.
  const response = await fetch("/ipc", { method: "POST", body: JSON.stringify(req) });
  return response.json() as Promise<Response>;
}
