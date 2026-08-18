import type { App, Request, Status } from "./platform";
import { AddField, Button, Empty, Panel } from "./ui";

/** Включённые сверху, дальше по алфавиту: список после автообнаружения длинный,
 *  и важно видеть в первую очередь то, что реально под управлением. */
function ordered(apps: App[]): App[] {
  return [...apps].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "ru"));
}

export function Apps({ status, act, className }: { status: Status | null; act: (req: Request) => void; className?: string }) {
  const apps = status?.apps ?? [];
  const on = apps.filter((a) => a.enabled).length;

  return (
    <Panel
      className={className}
      title="Приложения"
      note={apps.length > 0 && <span className="text-muted">{on} из {apps.length} в туннеле</span>}
      action={
        <Button variant="quiet" onClick={() => act({ cmd: "discover" })}>
          Найти установленные
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <AddField
          placeholder="C:\Program Files\…\app.exe"
          label="Добавить"
          onSubmit={(path) => act({ cmd: "add-app", arg: { path } })}
        />
        {apps.length === 0 ? (
          <Empty>Список пуст — трафик никого не перехватывается.</Empty>
        ) : (
          <ul className="flex flex-col">
            {ordered(apps).map((app) => (
              <li key={app.path} className="flex items-center gap-3 rounded-lg px-2.5 py-1.5 hover:bg-surface-2">
                <input
                  id={app.path}
                  type="checkbox"
                  checked={app.enabled}
                  onChange={(e) => act({ cmd: "set-app", arg: { path: app.path, enabled: e.target.checked } })}
                  className="size-4 shrink-0 accent-[var(--pg-open)]"
                />
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
                  aria-label={`Убрать ${app.name}`}
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
