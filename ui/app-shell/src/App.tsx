import { useCallback, useEffect, useState } from "react";
import { call, type Request, type Status, type Tunnel } from "./platform";

const LABEL: Record<Tunnel, string> = {
  off: "Приватный режим выключен",
  connecting: "Подключение…",
  up: "Туннель поднят",
  down: "Туннеля нет — выбранные приложения без сети",
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (req: Request) => {
    try {
      const r = await call(req);
      setError(r.reply === "error" ? r.data.message : null);
      if (r.reply === "status") setStatus(r.data);
      return r;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setStatus(null);
      return null;
    }
  }, []);

  const refresh = useCallback(() => send({ cmd: "status" }), [send]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const act = async (req: Request) => {
    await send(req);
    await refresh();
  };

  const ask = async (question: string, then: (value: string) => Request) => {
    const value = window.prompt(question);
    if (value) await act(then(value));
  };

  const on = status ? status.tunnel !== "off" : false;
  const profile = status?.profile ?? status?.profiles[0] ?? null;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between rounded-lg bg-panel p-5">
        <div>
          <h1 className="text-lg font-semibold">Privacy Gateway</h1>
          <p className={status?.tunnel === "up" ? "text-open" : "text-closed"}>
            {status ? LABEL[status.tunnel] : "Служба не отвечает"}
          </p>
          <p className="text-sm text-muted">
            {profile ?? "профиль не выбран"}
            {status?.latency_ms != null && ` · ${status.latency_ms} мс`}
            {status && ` · ↓${mb(status.rx)} ↑${mb(status.tx)}`}
          </p>
        </div>
        <button
          type="button"
          disabled={!status || (!on && !profile)}
          className="rounded-md bg-ink px-4 py-2 font-medium text-bg disabled:opacity-40"
          onClick={() => act(on ? { cmd: "off" } : { cmd: "on", arg: { profile: profile! } })}
        >
          {on ? "Выключить" : "Включить"}
        </button>
      </header>

      {error && <p className="rounded-lg bg-panel p-4 text-closed">{error}</p>}

      <section className="rounded-lg bg-panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Профили</h2>
          <button
            type="button"
            className="text-sm text-muted underline"
            onClick={() => ask("Share-link (vless://, vmess://, trojan://, ss://, hy2://, wg://)", (link) => ({ cmd: "add-profile", arg: { link } }))}
          >
            Импорт по ссылке
          </button>
        </div>
        {status?.profiles.length ? (
          <ul className="flex flex-col gap-2">
            {status.profiles.map((p) => (
              <li key={p} className="flex items-center gap-3">
                <span className={p === status.profile ? "flex-1" : "flex-1 text-muted"}>{p}</span>
                {p === status.profile && on ? (
                  <span className="text-xs text-muted">активен</span>
                ) : (
                  <button type="button" className="text-sm underline" onClick={() => act({ cmd: "on", arg: { profile: p } })}>
                    Включить
                  </button>
                )}
                <button type="button" className="text-sm text-muted underline" onClick={() => act({ cmd: "remove-profile", arg: { name: p } })}>
                  Удалить
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Профилей нет: импортируйте share-link.</p>
        )}
      </section>

      <section className="rounded-lg bg-panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Приложения под управлением</h2>
          <div className="flex gap-4">
            <button type="button" className="text-sm text-muted underline" onClick={() => act({ cmd: "discover" })}>
              Найти установленные
            </button>
            <button
              type="button"
              className="text-sm text-muted underline"
              onClick={() => ask("Путь к .exe", (path) => ({ cmd: "add-app", arg: { path } }))}
            >
              Добавить .exe
            </button>
          </div>
        </div>
        {status?.apps.length ? (
          <ul className="flex flex-col gap-2">
            {status.apps.map((a) => (
              <li key={a.path} className="flex items-center gap-3">
                <input
                  id={a.path}
                  type="checkbox"
                  checked={a.enabled}
                  onChange={(e) => act({ cmd: "set-app", arg: { path: a.path, enabled: e.target.checked } })}
                />
                <label htmlFor={a.path} className="flex-1">
                  {a.name}
                  <span className="block text-xs text-muted">{a.path}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Список пуст: трафик никого не перехватывается. Нажмите «Найти установленные».
          </p>
        )}
      </section>

      <section className="rounded-lg bg-panel p-5">
        <h2 className="mb-2 font-medium">Журнал</h2>
        <ul className="flex flex-col gap-1 text-sm text-muted">
          {status?.log.map((line, i) => (
            <li key={`${i}-${line}`}>{line}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
