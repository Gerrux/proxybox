import { useState } from "react";
import type { Probe, Request, Status } from "./platform";
import { strings } from "./i18n";
import { AddField, Button, Empty, Panel, SearchField } from "./ui";

/** Со скольких профилей список перестаёт читаться глазом. Одна подписка обычно
 *  приносит десятки узлов, а подписок бывает несколько — искать руками там уже
 *  нечего. Меньше порога поле поиска только мешало бы. */
const SEARCHABLE = 8;

/** Итог прогона рядом с именем: задержка либо причина отказа. Отказ приезжает
 *  строкой от службы, поэтому он уже на нужном языке — и виден целиком по
 *  наведению, а не только в обрезке. */
function Verdict({ probe, failed }: { probe: Probe | undefined; failed: string }) {
  if (!probe) return null;
  if (probe.latency_ms != null) return <span className="text-xs tabular-nums text-muted">{probe.latency_ms} ms</span>;
  return (
    <span className="max-w-[10rem] truncate text-xs text-closed" title={probe.error ?? failed}>
      {failed}
    </span>
  );
}

export function Profiles({
  status,
  act,
  busy,
  className,
}: {
  status: Status | null;
  act: (req: Request) => void;
  busy?: boolean;
  className?: string;
}) {
  const s = strings(status?.lang);
  const profiles = status?.profiles ?? [];
  const subscriptions = status?.subscriptions ?? [];
  const probes = status?.probes ?? [];
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle ? profiles.filter((name) => name.toLowerCase().includes(needle)) : profiles;
  return (
    <Panel
      className={className}
      title={s.profiles}
      note={
        profiles.length > 0 && (
          <span className="text-muted tabular-nums">
            {shown.length === profiles.length ? profiles.length : `${shown.length}/${profiles.length}`}
          </span>
        )
      }
      action={
        profiles.length > 0 && (
          // Пока прогон идёт, кнопка заперта: второй прогон добил бы sing-box
          // первого — они делят каталог проверки.
          <Button
            variant="quiet"
            disabled={busy}
            title={s.testProfilesHint}
            onClick={() => act({ cmd: "test-profiles" })}
          >
            {s.testProfiles}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <AddField
          placeholder={s.linkPlaceholder}
          label={s.importLink}
          onSubmit={(link) => act({ cmd: "add-profile", arg: { link } })}
        />
        {subscriptions.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              {s.subscriptions}
              <span className="ml-2 font-normal normal-case tracking-normal">{subscriptions.length}</span>
            </h3>
            <ul className="flex flex-col">
              {subscriptions.map((url) => (
                <li key={url} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-surface-2">
                  {/* Схема одинакова у всех подписок и съедает начало строки,
                      а обрезается как раз хвост — то единственное, чем адреса и
                      различаются. Полный адрес остаётся по наведению. */}
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={url}>
                    {url.replace(/^https?:\/\//, "")}
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
        {profiles.length > SEARCHABLE && (
          <SearchField value={query} onChange={setQuery} placeholder={s.searchProfiles} />
        )}
        {profiles.length === 0 ? (
          <Empty>{s.noProfiles}</Empty>
        ) : shown.length === 0 ? (
          <Empty>{s.noMatches}</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {shown.map((name) => {
              const active = status?.profile === name;
              const probe = probes.find((p) => p.name === name);
              // У активного профиля точка выхода известна и без прогона —
              // её спросил сам туннель.
              const country = probe?.country ?? (active && status?.tunnel === "up" ? status.country : null);
              return (
                <li
                  key={name}
                  className={`enter smooth flex items-center gap-2 rounded-lg px-2.5 py-2 ${active ? "bg-surface-2" : ""}`}
                >
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? "font-medium" : "text-muted"}`}>
                    {name}
                  </span>
                  {country && (
                    <span className="max-w-[11rem] truncate text-xs text-muted" title={country}>
                      {country}
                    </span>
                  )}
                  <Verdict probe={probe} failed={s.probeFailed} />
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
