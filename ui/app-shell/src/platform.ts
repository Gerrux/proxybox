// Единственная точка связи фронтенда со службой — та же core-ipc, что у CLI.
// ponytail: типы контракта продублированы с Rust вручную. Генератор (ts-rs)
// оправдан, когда типов станет заметно больше шести.
import { invoke } from "@tauri-apps/api/core";

export type Tunnel = "off" | "connecting" | "up" | "down";

export type Lang = "ru" | "en";

export type App = { path: string; name: string; enabled: boolean };

/** Итог прогона одного профиля: либо задержка, либо причина отказа. Точку
 *  выхода прогон спрашивает у ответивших — при `PG_GEO=0` её не будет ни у кого. */
export type Probe = { name: string; latency_ms: number | null; country: string | null; error: string | null };

export type Status = {
  tunnel: Tunnel;
  profile: string | null;
  latency_ms: number | null;
  country: string | null;
  rx: number;
  tx: number;
  apps: App[];
  profiles: string[];
  subscriptions: string[];
  lang: Lang;
  log: string[];
  probes: Probe[];
};

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
  | { cmd: "set-lang"; arg: { lang: Lang } }
  | { cmd: "add-profile"; arg: { link: string } }
  | { cmd: "remove-profile"; arg: { name: string } }
  /** Подписки заводятся через add-profile с http(s)-адресом; повторный импорт
   *  того же адреса её обновляет. Отдельная команда нужна только на «отписаться». */
  | { cmd: "remove-subscription"; arg: { url: string } }
  /** Прогон всех профилей: каждый проверяется отдельным подключением, живой
   *  туннель при этом не трогается. */
  | { cmd: "test-profiles" }
  /** Отдельный прокси под профиль — для окна браузера. Ответ: порт. */
  | { cmd: "browse"; arg: { profile: string } };

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

/** Вкладка браузера через отдельный туннель профиля: служба поднимает прокси и
 *  отдаёт порт, браузер запускает оболочка — фронтенд живёт в вебвью, процессов
 *  ему не завести. */
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

export async function call(req: Request): Promise<Response> {
  if (isTauri()) {
    return invoke<Response>("ipc", { req });
  }
  // Разработка в браузере: мост дев-сервера (vite.config.ts). В собранном
  // приложении сюда не попадаем — там всегда Tauri.
  const response = await fetch("/ipc", { method: "POST", body: JSON.stringify(req) });
  return response.json() as Promise<Response>;
}
