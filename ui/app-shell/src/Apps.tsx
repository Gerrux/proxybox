import { useEffect, useRef, useState } from "react";
import { call, type App, type Request, type Status } from "./platform";
import { strings } from "./i18n";
import { AddField, Button, Empty, Panel } from "./ui";

/** Включённые сверху, дальше по алфавиту: список после автообнаружения длинный,
 *  и важно видеть в первую очередь то, что реально под управлением. */
function ordered(apps: App[]): App[] {
  return [...apps].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

/** Иконки спрашиваются по одной и только раз за путь: в статусе их нет, потому
 *  что он ходит по кругу каждые две секунды, а картинка весит килобайты.
 *  Файл не меняется под нами — перечитывать нечего. */
function useIcons(apps: App[]): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    for (const { path } of apps) {
      if (asked.current.has(path)) continue;
      asked.current.add(path);
      call({ cmd: "icon", arg: { path } })
        // Нет иконки — не ошибка: строка просто остаётся с заглушкой.
        .then((r) => r.reply === "icon" && r.data && setIcons((prev) => ({ ...prev, [path]: r.data as string })))
        .catch(() => {});
    }
  }, [apps]);

  return icons;
}

export function Apps({ status, act, className }: { status: Status | null; act: (req: Request) => void; className?: string }) {
  const s = strings(status?.lang);
  const apps = status?.apps ?? [];
  const on = apps.filter((a) => a.enabled).length;
  const icons = useIcons(apps);

  return (
    <Panel
      className={className}
      title={s.apps}
      note={apps.length > 0 && <span className="text-muted">{s.appsCount(on, apps.length)}</span>}
      action={
        <Button variant="quiet" onClick={() => act({ cmd: "discover" })}>
          {s.discover}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <AddField
          placeholder={s.appPlaceholder}
          label={s.addApp}
          onSubmit={(path) => act({ cmd: "add-app", arg: { path } })}
        />
        {apps.length === 0 ? (
          <Empty>{s.noApps}</Empty>
        ) : (
          <ul className="flex flex-col">
            {ordered(apps).map((app) => (
              <li
                key={app.path}
                className="enter smooth flex items-center gap-3 rounded-lg px-2.5 py-1.5 hover:bg-surface-2"
              >
                <input
                  id={app.path}
                  type="checkbox"
                  checked={app.enabled}
                  onChange={(e) => act({ cmd: "set-app", arg: { path: app.path, enabled: e.target.checked } })}
                  className="size-4 shrink-0 accent-[var(--pg-open)]"
                />
                {icons[app.path] ? (
                  <img src={icons[app.path]} alt="" className="size-6 shrink-0" />
                ) : (
                  <span className="size-6 shrink-0 rounded bg-surface-2" />
                )}
                <label htmlFor={app.path} className="min-w-0 flex-1 cursor-pointer">
                  <span className={`block truncate text-[13px] ${app.enabled ? "font-medium" : "text-muted"}`}>
                    {app.name}
                  </span>
                  <span className="selectable block truncate font-mono text-[11px] text-muted" title={app.path}>
                    {app.path}
                  </span>
                </label>
                <Button
                  variant="danger"
                  aria-label={s.removeApp(app.name)}
                  onClick={() => act({ cmd: "remove-app", arg: { path: app.path } })}
                >
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
