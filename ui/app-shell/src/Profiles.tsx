import { useState } from "react";
import type { Probe, Request, Status } from "./platform";
import { measuredAgo, strings } from "./i18n";
import { AddField, Button, Empty, Panel, SearchField } from "./ui";

/** Со скольких профилей список перестаёт читаться глазом. Порог тот же, что у
 *  приложений: одна подписка приносит десятки узлов, а подписок бывает
 *  несколько. */
const SEARCH_FROM = 8;

/** Итог прогона рядом с именем: задержка либо причина отказа. Отказ приезжает
 *  строкой от службы, поэтому он уже на нужном языке — и виден целиком по
 *  наведению, а не только в обрезке. */
function Verdict({ probe, failed, measured }: { probe: Probe | undefined; failed: string; measured?: string }) {
  if (!probe) return null;
  if (probe.latency_ms != null)
    return (
      // Возраст — в подсказке, а не в строке: цифра из прошлой недели выглядит
      // как сегодняшняя, но занимать место в строке этому знанию незачем.
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted" title={measured}>
        {probe.latency_ms} ms
      </span>
    );
  return (
    // Мёртвый профиль — поломка, которую чинит человек, а не запертый канал:
    // цвет тот же, что у «служба не отвечает».
    // Она же длиннее всего в строке и потому уступает место первой.
    <span className="min-w-0 truncate font-mono text-[11px] text-fault" title={probe.error ?? failed}>
      {failed}
    </span>
  );
}

/** Цвет строки. Рельс слева и подпись «активен» берут его отсюда: это одно и
 *  то же состояние, и разойтись им нельзя. */
const TONE = {
  up: { rail: "bg-open", text: "text-open" },
  connecting: { rail: "bg-wait", text: "text-wait" },
  down: { rail: "bg-closed", text: "text-closed" },
  // Выключено — и «профиль просто выбран» тоже: это не сигнал, цвета нет.
  off: { rail: "bg-transparent", text: "text-muted" },
} as const;

export function Profiles({
  status,
  act,
  browse,
  busy,
  className,
}: {
  status: Status | null;
  act: (req: Request) => void;
  /** Вкладка через отдельный туннель этого профиля — мимо общего режима. */
  browse: (profile: string) => void;
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
  // Поле не прячем, пока в нём что-то есть: иначе фильтр остался бы включённым
  // и невидимым, а строки просто пропали бы.
  const searchable = profiles.length > SEARCH_FROM || query !== "";
  return (
    <Panel
      className={className}
      title={s.profiles}
      note={
        profiles.length > 0 && (
          <span className="text-muted">
            {profiles.length}
            {query !== "" && ` · ${s.appsShown(shown.length)}`}
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
            <h3 className="engraved flex items-baseline gap-2 text-muted">
              {s.subscriptions}
              <span className="font-sans text-[11px] font-normal normal-case tracking-normal">
                {subscriptions.length}
              </span>
            </h3>
            <ul className="flex flex-col">
              {subscriptions.map((url) => (
                <li key={url} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-surface-2">
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
        {searchable && <SearchField value={query} onChange={setQuery} placeholder={s.searchProfiles} />}
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
              const live = active && status != null && status.tunnel !== "off";
              // Открытое окно браузера — состояние профиля, а не общего режима,
              // и в окне о нём больше не сказано нигде.
              const browsing = status?.browser === name;
              // Рельс профиля повторяет то, что показывает верх окна: выбран —
              // ещё не значит «несёт трафик», и путать это нельзя.
              const tone = TONE[live && status ? status.tunnel : "off"];
              return (
                <li
                  key={name}
                  className={`enter smooth relative flex items-center gap-2 rounded-md py-1.5 pl-3 pr-1 hover:bg-surface-2 ${active ? "bg-surface-2" : ""}`}
                >
                  <span className={`smooth absolute inset-y-1 left-0 w-[3px] rounded-full ${tone.rail}`} />
                  {/* Имя сверху, всё измеренное — строкой ниже, как в списке
                      приложений: в одну строку имя, состояние, страна, задержка
                      и кнопки не помещаются даже в окне минимальной ширины, и
                      первым обрубается имя — единственное, чем строки и
                      различаются. */}
                  <div className="min-w-0 flex-1 leading-tight">
                    <span
                      className={`block truncate text-[13px] ${active ? "font-medium" : "text-muted"}`}
                      title={name}
                    >
                      {name}
                    </span>
                    {(live || browsing || country || probe) && (
                      <span className="flex items-baseline gap-2 overflow-hidden text-[11px] text-muted">
                        {live && <span className={`engraved shrink-0 ${tone.text}`}>{s.active}</span>}
                        {browsing && (
                          <span className="engraved shrink-0" title={s.browserOnHint}>
                            {s.browserOn}
                          </span>
                        )}
                        {/* Страна — кодом: «NL» стоит двух знаков, «Нидерланды,
                            Амстердам» не помещается в строку вовсе. Название
                            целиком остаётся подсказкой. Кода нет (старое
                            состояние или сервис не прислал) — показываем как
                            есть, обрезкой. */}
                        {country &&
                          (probe?.code ? (
                            <span className="engraved shrink-0 tracking-[0.08em]" title={country}>
                              {probe.code}
                            </span>
                          ) : (
                            <span className="truncate" title={country}>
                              {country}
                            </span>
                          ))}
                        <Verdict probe={probe} failed={s.probeFailed} measured={measuredAgo(s, probe?.at ?? 0)} />
                      </span>
                    )}
                  </div>
                  {!live && (
                    <Button variant="quiet" onClick={() => act({ cmd: "on", arg: { profile: name } })}>
                      {s.turnOn}
                    </Button>
                  )}
                  {/* Окно браузера через этот профиль: общий режим не трогается,
                      трафик вкладки идёт своим sing-box без TUN. */}
                  <Button variant="quiet" aria-label={s.browseProfile(name)} onClick={() => browse(name)}>
                    ⧉
                  </Button>
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
