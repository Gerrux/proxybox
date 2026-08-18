import type { Request, Status } from "./platform";
import { strings } from "./i18n";
import { AddField, Button, Empty, Panel } from "./ui";

export function Profiles({
  status,
  act,
  className,
}: {
  status: Status | null;
  act: (req: Request) => void;
  className?: string;
}) {
  const s = strings(status?.lang);
  const profiles = status?.profiles ?? [];
  const subscriptions = status?.subscriptions ?? [];
  return (
    <Panel
      className={className}
      title={s.profiles}
      note={profiles.length > 0 && <span className="text-muted">{profiles.length}</span>}
    >
      <div className="flex flex-col gap-3">
        <AddField
          placeholder={s.linkPlaceholder}
          label={s.importLink}
          onSubmit={(link) => act({ cmd: "add-profile", arg: { link } })}
        />
        {subscriptions.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{s.subscriptions}</h3>
            <ul className="flex flex-col">
              {subscriptions.map((url) => (
                <li key={url} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-surface-2">
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={url}>
                    {url}
                  </span>
                  {/* Обновление — тот же импорт: служба сама узнаёт адрес и
                      заменяет пришедшие с него профили. */}
                  <Button
                    variant="quiet"
                    aria-label={s.refreshSubscription(url)}
                    onClick={() => act({ cmd: "add-profile", arg: { link: url } })}
                  >
                    ⟳
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={s.removeSubscription(url)}
                    onClick={() => act({ cmd: "remove-subscription", arg: { url } })}
                  >
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {profiles.length === 0 ? (
          <Empty>{s.noProfiles}</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {profiles.map((name) => {
              const active = status?.profile === name;
              return (
                <li
                  key={name}
                  className={`enter smooth flex items-center gap-2 rounded-lg px-2.5 py-2 ${active ? "bg-surface-2" : ""}`}
                >
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? "font-medium" : "text-muted"}`}>
                    {name}
                  </span>
                  {active && status?.tunnel !== "off" ? (
                    <span className="text-xs text-muted">{s.active}</span>
                  ) : (
                    <Button variant="quiet" onClick={() => act({ cmd: "on", arg: { profile: name } })}>
                      {s.turnOn}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    aria-label={s.removeProfile(name)}
                    onClick={() => act({ cmd: "remove-profile", arg: { name } })}
                  >
                    ✕
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
