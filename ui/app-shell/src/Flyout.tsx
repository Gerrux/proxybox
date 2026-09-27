/** Плашка из трея — своя раскладка, а не главное окно, ужатое до 380 px.
 *
 *  Пока это было одно и то же окно в другой ширине, плашка получала всё сразу —
 *  вкладки, шапки панелей, «Импорт», журнал — и в 520 px высоты от списка
 *  профилей оставалось три строки. А открывают её ради трёх вещей: глянуть,
 *  защищено ли; включить или выключить; сменить узел. Ровно они здесь и есть:
 *  плита состояния со словом, тумблером и картой, охват и короткий список
 *  узлов. Всё остальное — одна кнопка до главного окна.
 *
 *  Выключатель — тумблер, а не круглая кнопка питания: круглая кнопка есть в
 *  каждом VPN-клиенте, а тумблер стоит у любого переключателя «Параметров»
 *  и честно показывает оба положения. Крупнее обычного: жмут его не глядя.
 *
 *  Свои здесь только раскладка и порядок строк. Заголовок и подсказку
 *  состояния считает `describe` из шапки, страну — `exitCode` оттуда же: одно
 *  и то же состояние не имеет права называться в двух окнах по-разному. */
import type { Act, Scope, Status } from "./platform";
import { openMain } from "./platform";
import { strings } from "./i18n";
import { bytes, describe, exitCode, latencyTone, splitExit, StateGlyph, tunnelState } from "./StatusBar";
import { Button, Icon, IconButton, Segmented, Switch, flag, nodeFlag } from "./ui";
import { WorldMap } from "./WorldMapView";

export function Flyout({
  status,
  act,
  busy,
  error,
  onError,
  onToggle,
  onScope,
}: {
  status: Status | null;
  act: Act;
  busy: boolean;
  error: string | null;
  onError: (message: string | null) => void;
  onToggle: () => void;
  onScope: (scope: Scope) => void;
}) {
  const s = strings(status?.lang);
  const state = tunnelState(status);
  const view = describe(s, status);
  const on = status != null && status.tunnel !== "off";
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;
  const code = exitCode(status);
  const [country, city] = splitExit(status?.country);
  const profiles = status?.profiles ?? [];
  const probes = status?.probes ?? [];
  // Отмеченные звёздочкой — наверх, как и в главном окне; остальной порядок —
  // тот, что держит служба. Своего порядка у плашки нет: он был бы вторым.
  const rows = [...profiles].sort((a, b) => Number(b.favorite) - Number(a.favorite));

  return (
    <div className="flex h-full flex-col" data-state={state}>
      <section data-state={state} className="st smooth relative shrink-0">
        <div className="flex items-start gap-3 px-3 pt-2.5 pb-2">
          <div className="min-w-0 flex-1">
            <h1 key={view.title} className="st-word swap flex items-center gap-2 text-xl font-semibold">
              <StateGlyph state={state} size={18} />
              <span className="min-w-0">{view.title}</span>
            </h1>
            <p key={view.hint} className="swap mt-0.5 line-clamp-2 text-xs text-muted" title={view.hint}>
              {view.hint}
            </p>
          </div>
          <Switch
            size="lg"
            checked={on}
            label={on ? s.turnOff : s.turnOn}
            disabled={!status || (!on && !status.profile && profiles.length === 0)}
            onChange={() => onToggle()}
          />
        </div>
        <WorldMap className="fly-map" code={code} fit={0.5} />
        {/* Точка выхода — строкой, числа — строкой ниже: в 356 px «Нидерланды ·
            Амстердам» и три числа рядом резались до «Нидерла… Амстер…». */}
        <div className="px-3 pt-1.5 pb-2 text-sm">
          {status?.country ? (
            <p className="flex min-w-0 items-baseline gap-1.5 font-semibold">
              {flag(code) && <span aria-hidden="true">{flag(code)}</span>}
              <span className="truncate">{country}</span>
              {city && <span className="truncate font-normal text-muted">{city}</span>}
            </p>
          ) : (
            <p className="truncate text-muted" title={s.exitUnknown}>
              {status?.profile ?? profiles[0]?.name ?? s.noProfile}
            </p>
          )}
          {status?.tunnel === "up" && (
            <p className="flex gap-3 font-mono text-xs tabular-nums text-muted">
              {status.latency_ms != null && (
                <span className={latencyTone(status.latency_ms)}>{status.latency_ms} ms</span>
              )}
              <span className="inline-flex items-center gap-0.5" title={s.received}>
                <Icon name="down" size={12} />
                {bytes(status.rx)}
              </span>
              <span className="inline-flex items-center gap-0.5" title={s.sent}>
                <Icon name="up" size={12} />
                {bytes(status.tx)}
              </span>
            </p>
          )}
        </div>
        {busy && <div className="bar absolute inset-x-0 bottom-0 h-0.5 overflow-hidden text-[color:var(--tone)]" />}
      </section>

      <div className="shrink-0 border-b border-edge px-3 py-1.5">
        <Segmented
          label={s.scope}
          options={[
            ["whitelist", s.scopeWhitelist, inTunnel === 0 ? s.noAppsAhead : s.scopeHintWhitelist],
            ["all", s.scopeAll, s.scopeHint],
          ]}
          value={status?.scope ?? "all"}
          className="w-full"
          disabled={!status || busy}
          onPick={(v) => onScope(v as Scope)}
        />
      </div>

      {error && (
        <div className="enter flex shrink-0 items-start gap-2 border-b border-edge bg-fault-soft py-1.5 ps-3 pe-1 text-xs text-fault">
          <p className="selectable line-clamp-3 min-w-0 flex-1 py-1" title={error}>
            {error}
          </p>
          <IconButton icon="close" label={s.hideMessage} onClick={() => onError(null)} className="size-7" />
        </div>
      )}

      <section className="flex min-h-0 flex-1 flex-col">
        <h2 className="flex h-7 shrink-0 items-end justify-between px-3 pb-1 text-xs font-semibold text-muted">
          <span>{s.profiles}</span>
          <span className="font-normal tabular-nums">{profiles.length || ""}</span>
        </h2>
        <ul className="scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
          {rows.length === 0 && <li className="px-2 py-4 text-center text-sm text-muted">{s.offNoProfiles}</li>}
          {rows.map((p) => {
            const probe = probes.find((x) => x.name === p.name);
            const active = status?.profile === p.name;
            const live = active && on;
            const [mark, label] = nodeFlag(p.name, probe?.code);
            return (
              <li key={p.name} className="cv-row">
                <button
                  type="button"
                  aria-pressed={active}
                  data-selected={active}
                  disabled={busy}
                  onClick={() => !live && void act({ cmd: "on", arg: { profile: p.name } })}
                  className="row smooth flex h-9 w-full items-center gap-2.5 px-2.5 text-start"
                  title={p.server}
                >
                  {active && (
                    <span
                      className={`row-pill smooth ${live ? "bg-[color:var(--tone)]" : "bg-accent"}`}
                    />
                  )}
                  <span className="grid w-5 shrink-0 place-items-center text-base leading-none text-faint">
                    {mark ?? <Icon name="server" size={14} />}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${active ? "font-semibold" : ""}`}>{label}</span>
                  {p.plain && (
                    <span className="shrink-0 text-wait" title={s.plainHint}>
                      <Icon name="lockOpen" size={14} />
                      <span className="sr-only">{s.plain}</span>
                    </span>
                  )}
                  {p.favorite && <Icon name="star" size={12} className="text-accent" />}
                  {/* Число — правой колонкой, как в ведомости: столбец задержек
                      сравнивают взглядом сверху вниз. */}
                  {probe?.latency_ms != null ? (
                    <span className={`w-14 shrink-0 text-end font-mono text-xs tabular-nums ${latencyTone(probe.latency_ms) || "text-muted"}`}>
                      {probe.latency_ms} ms
                    </span>
                  ) : (
                    probe?.brief && <span className="max-w-20 shrink-0 truncate text-end text-xs text-fault">{probe.brief}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="flex h-10 shrink-0 items-center gap-1 border-t border-edge px-1">
        <Button variant="quiet" className="flex-1 justify-start" onClick={() => void openMain(false)}>
          <Icon name="launch" />
          {s.openApp}
        </Button>
        <IconButton icon="sliders" label={s.settings} onClick={() => void openMain(true)} />
      </footer>
    </div>
  );
}
