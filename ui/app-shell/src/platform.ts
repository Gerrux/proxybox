// Единственная точка связи фронтенда со службой — та же core-ipc, что у CLI.
// ponytail: типы контракта продублированы с Rust вручную. Генератор (ts-rs)
// оправдан, когда типов станет заметно больше шести.
import { invoke } from "@tauri-apps/api/core";

export type Tunnel = "off" | "connecting" | "up" | "down";

export type Lang = "ru" | "en";

export type App = { path: string; name: string; enabled: boolean };

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
};

export type Request =
  | { cmd: "status" }
  | { cmd: "on"; arg: { profile: string } }
  | { cmd: "off" }
  | { cmd: "list-apps" }
  | { cmd: "discover" }
  | { cmd: "add-app"; arg: { path: string } }
  | { cmd: "icon"; arg: { path: string } }
  | { cmd: "set-app"; arg: { path: string; enabled: boolean } }
  | { cmd: "remove-app"; arg: { path: string } }
  | { cmd: "set-lang"; arg: { lang: Lang } }
  | { cmd: "add-profile"; arg: { link: string } }
  | { cmd: "remove-profile"; arg: { name: string } }
  /** Подписки заводятся через add-profile с http(s)-адресом; повторный импорт
   *  того же адреса её обновляет. Отдельная команда нужна только на «отписаться». */
  | { cmd: "remove-subscription"; arg: { url: string } };

export type Response =
  | { reply: "status"; data: Status }
  | { reply: "apps"; data: App[] }
  /** PNG в data-URL; null — иконки у файла нет. */
  | { reply: "icon"; data: string | null }
  | { reply: "done" }
  | { reply: "error"; data: { message: string } };

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function call(req: Request): Promise<Response> {
  if (isTauri()) {
    return invoke<Response>("ipc", { req });
  }
  // Разработка в браузере: мост дев-сервера (vite.config.ts). В собранном
  // приложении сюда не попадаем — там всегда Tauri.
  const response = await fetch("/ipc", { method: "POST", body: JSON.stringify(req) });
  return response.json() as Promise<Response>;
}
