import type { Request, Status } from "./platform";
import { AddField, Button, Empty, Panel } from "./ui";

export function Profiles({ status, act, className }: { status: Status | null; act: (req: Request) => void; className?: string }) {
  const profiles = status?.profiles ?? [];
  return (
    <Panel className={className} title="Профили" note={profiles.length > 0 && <span className="text-muted">{profiles.length}</span>}>
      <div className="flex flex-col gap-3">
        <AddField
          placeholder="Вставьте share-link или JSON узла"
          label="Импорт"
          onSubmit={(link) => act({ cmd: "add-profile", arg: { link } })}
        />
        {profiles.length === 0 ? (
          <Empty>Профилей нет. Вставьте share-link или JSON-конфиг — разберётся сам.</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {profiles.map((name) => {
              const active = status?.profile === name;
              return (
                <li
                  key={name}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-2 ${active ? "bg-surface-2" : ""}`}
                >
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? "font-medium" : "text-muted"}`}>
                    {name}
                  </span>
                  {active && status?.tunnel !== "off" ? (
                    <span className="text-xs text-muted">активен</span>
                  ) : (
                    <Button variant="quiet" onClick={() => act({ cmd: "on", arg: { profile: name } })}>
                      Включить
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    aria-label={`Удалить профиль ${name}`}
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
