/** Плашка из трея — своя раскладка, а не главное окно, ужатое до 380 px.
 *
 *  Пока это было одно и то же окно в другой ширине, плашка получала всё сразу —
 *  вкладки, шапки панелей, «Импорт», журнал — и в 520 px высоты от списка
 *  профилей оставалось три строки. А открывают её ради трёх вещей: глянуть,
 *  защищено ли; включить или выключить; сменить узел. Ровно они здесь и есть:
 *  плита состояния со словом, тумблером и картой, текущая скорость и список
 *  узлов. Всё остальное — одна кнопка до главного окна.
 *
 *  Охвата в плашке нет, и это решение, а не недосмотр: одно касание из трея не
 *  должно уметь запереть машину. Белый список без галочек и «Раздельно» с
 *  неготовыми правилами выглядят со стороны как «интернет отвалился», а
 *  плашка открывается мимоходом, не глядя — на неё охват и не выбирают. Вместо
 *  переключателя состояние называет подсказка под словом (`describe`): в ней
 *  охват есть, менять его — в главном окне.
 *
 *  Выключатель — тумблер, а не круглая кнопка питания: круглая кнопка есть в
 *  каждом VPN-клиенте, а тумблер стоит у любого переключателя «Параметров»
 *  и честно показывает оба положения. Крупнее обычного: жмут его не глядя.
 *
 *  Узлы — по подпискам, как в главном окне: сотня узлов одним списком в
 *  520 px — это три экрана прокрутки до нужного. Раскрыта только группа с
 *  включённым узлом, остальные свёрнуты до заголовка с итогом «отвечают из
 *  всего». Над группами — «Быстрейший узел» одной строкой: прогон затевают
 *  ради этого выбора, и делать его глазами по сотне строк незачем.
 *
 *  Свои здесь только раскладка и порядок строк. Заголовок и подсказку
 *  состояния считает `describe` из шапки, страну — `exitCode` оттуда же: одно
 *  и то же состояние не имеет права называться в двух окнах по-разному. */
import { Fragment, useState } from "react";
import type { Act, ProfileInfo, Status } from "./platform";
import { openMain } from "./platform";
import { strings } from "./i18n";
import {
  bytes,
  CellSpark,
  describe,
  exitCode,
  latencyTone,
  splitExit,
  StateGlyph,
  tunnelState,
  useRates,
} from "./StatusBar";
import { Button, Icon, IconButton, SearchField, Switch, flag, nodeFlag } from "./ui";
import { WorldMap } from "./WorldMapView";

/** Со скольких профилей над списком появляется поиск. Порог тот же, что у
 *  главного окна: с меньшим числом строк глазом быстрее, чем набором. */
const SEARCH_FROM = 8;

export function Flyout({
  status,
  act,
  busy,
  error,
  onError,
  onToggle,
}: {
  status: Status | null;
  act: Act;
  busy: boolean;
  error: string | null;
  onError: (message: string | null) => void;
  onToggle: () => void;
}) {
  const s = strings(status?.lang);
  const state = tunnelState(status);
  const view = describe(s, status);
  const on = status != null && status.tunnel !== "off";
  const code = exitCode(status);
  const [country, city] = splitExit(status?.country);
  const profiles = status?.profiles ?? [];
  const probes = status?.probes ?? [];
  const subscriptions = status?.subscriptions ?? [];
  const probeOf = new Map(probes.map((p) => [p.name, p]));
  const byName = new Map(profiles.map((p) => [p.name, p]));
  const rates = useRates(status);
  const last = rates.at(-1) ?? null;
  // Масштаб один на оба направления — по той же причине, что и в шапке окна.
  const peak = Math.max(1, ...rates.map((r) => Math.max(r.rx, r.tx)));
  const [needle, setNeedle] = useState("");
  // Что человек раскрыл или свернул сам; нетронутые группы решает умолчание.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const q = profiles.length > SEARCH_FROM ? needle.trim().toLowerCase() : "";
  const match = (p: ProfileInfo) =>
    q === "" ||
    [p.name, p.server, p.kind, probeOf.get(p.name)?.country ?? ""].some((x) => x.toLowerCase().includes(q));
  // Отмеченные звёздочкой — наверх внутри группы, как и в главном окне;
  // остальной порядок — тот, что держит служба. Своего порядка у плашки нет:
  // он был бы вторым.
  const favouritesFirst = (list: ProfileInfo[]) => [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite));

  // Группы: свои узлы первыми, затем подписки в порядке службы. Своё — то,
  // чего нет ни в одной подписке; связь знает служба, плашка её только читает.
  const fromSubs = new Set(subscriptions.flatMap((sub) => sub.nodes));
  const members = [
    { key: "", sub: null, all: profiles.filter((p) => !fromSubs.has(p.name)) },
    ...subscriptions.map((sub) => ({
      key: sub.url,
      sub,
      all: sub.nodes.flatMap((name) => byName.get(name) ?? []),
    })),
  ];
  const groups = members
    .map((g) => ({ ...g, items: favouritesFirst(g.all.filter(match)) }))
    .filter((g) => g.items.length > 0);
  // Заголовки заводит только подписка: с одними своими узлами «Свои» говорило
  // бы о делении, которого нет.
  const grouped = subscriptions.length > 0;
  // Раскрыта группа с включённым узлом; узла нет — первая. Под поиском раскрыто
  // всё: нашедшееся в свёрнутой группе иначе не нашлось бы глазами.
  const holder = status?.profile
    ? members.find((g) => g.all.some((p) => p.name === status.profile))?.key
    : undefined;
  const openByDefault = holder ?? groups[0]?.key;
  const isOpen = (key: string) => q !== "" || (toggled[key] ?? key === openByDefault);

  // Самый быстрый из измеренных и всё ещё живущих в списке — тот же выбор, что
  // у «Включить быстрый» в главном окне.
  const fastest = probes
    .filter((p) => p.latency_ms != null && byName.has(p.name))
    .sort((a, b) => (a.latency_ms ?? 0) - (b.latency_ms ?? 0))[0];

  const row = (p: ProfileInfo) => {
    const probe = probeOf.get(p.name);
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
          {active && <span className={`row-pill smooth ${live ? "bg-[color:var(--tone)]" : "bg-accent"}`} />}
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
            <span
              className={`w-14 shrink-0 text-end font-mono text-xs tabular-nums ${latencyTone(probe.latency_ms) || "text-muted"}`}
            >
              {probe.latency_ms} ms
            </span>
          ) : (
            probe?.brief && <span className="max-w-20 shrink-0 truncate text-end text-xs text-fault">{probe.brief}</span>
          )}
        </button>
      </li>
    );
  };

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
              {status.tunnel === "up" && status.latency_ms != null && (
                <span
                  className={`ms-auto shrink-0 ps-2 font-mono text-xs font-normal tabular-nums ${latencyTone(status.latency_ms)}`}
                >
                  {status.latency_ms} ms
                </span>
              )}
            </p>
          ) : (
            <p className="truncate text-muted" title={s.exitUnknown}>
              {status?.profile ?? profiles[0]?.name ?? s.noProfile}
            </p>
          )}
          {/* Текущая скорость и её график вместо итогов сеанса: итог читают в
              главном окне, а в плашке спрашивают «идёт ли что-нибудь сейчас». */}
          {status?.tunnel === "up" && (
            <p className="mt-0.5 flex items-center gap-3 font-mono text-xs tabular-nums text-muted" title={s.speed}>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-open" title={s.received}>
                <Icon name="down" size={12} />
                {last ? `${bytes(last.rx)}${s.perSecond}` : "—"}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-accent" title={s.sent}>
                <Icon name="up" size={12} />
                {last ? `${bytes(last.tx)}${s.perSecond}` : "—"}
              </span>
              <span className="fly-chart" aria-hidden="true">
                <CellSpark values={rates.map((r) => r.rx)} peak={peak} id="pg-spark-down" tone="text-open" />
                <CellSpark values={rates.map((r) => r.tx)} peak={peak} id="pg-spark-up" tone="text-accent" />
              </span>
            </p>
          )}
        </div>
        {busy && <div className="bar absolute inset-x-0 bottom-0 h-0.5 overflow-hidden text-[color:var(--tone)]" />}
      </section>

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
        {profiles.length > SEARCH_FROM && (
          <div className="shrink-0 px-1.5 pb-1">
            <SearchField value={needle} onChange={setNeedle} placeholder={s.searchProfiles} />
          </div>
        )}
        <ul className="scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
          {profiles.length === 0 && <li className="px-2 py-4 text-center text-sm text-muted">{s.offNoProfiles}</li>}
          {fastest && (
            <li>
              <button
                type="button"
                disabled={busy}
                title={s.fastestHint}
                onClick={() => !(on && status?.profile === fastest.name) && void act({ cmd: "on", arg: { profile: fastest.name } })}
                className="row smooth flex h-9 w-full items-center gap-2.5 px-2.5 text-start"
              >
                <span className="grid w-5 shrink-0 place-items-center text-accent">
                  <Icon name="bolt" size={14} />
                </span>
                <span className="shrink-0 text-sm font-semibold text-accent">{s.fastestNode}</span>
                <span className="min-w-0 flex-1 truncate text-end text-xs text-muted">{fastest.name}</span>
                <span className={`shrink-0 font-mono text-xs tabular-nums ${latencyTone(fastest.latency_ms) || "text-muted"}`}>
                  {fastest.latency_ms} ms
                </span>
              </button>
            </li>
          )}
          {groups.map((g) => {
            const open = isOpen(g.key);
            if (!grouped) return g.items.map(row);
            const alive = g.all.filter((p) => probeOf.get(p.name)?.latency_ms != null).length;
            const quota = g.sub?.quota;
            const expired = quota != null && quota.expire > 0 && quota.expire * 1000 < Date.now();
            return (
              <Fragment key={`group:${g.key}`}>
                <li>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setToggled((t) => ({ ...t, [g.key]: !open }))}
                    className="row smooth flex h-8 w-full items-center gap-2 px-2.5 text-start text-sm font-semibold"
                  >
                    <Icon name="chevron" size={12} className={`shrink-0 text-muted ${open ? "rotate-90" : "rtl:rotate-180"}`} />
                    <span className="min-w-0 flex-1 truncate">
                      {g.sub ? g.sub.name || g.sub.url.replace(/^https:\/\//, "") : s.ownProfiles}
                    </span>
                    {expired && <span className="shrink-0 text-xs font-normal text-fault">{s.expiredShort}</span>}
                    <span
                      className="shrink-0 font-mono text-xs font-normal tabular-nums text-muted"
                      title={s.groupAlive(alive, g.all.length)}
                    >
                      {alive}/{g.all.length}
                    </span>
                  </button>
                </li>
                {open && g.items.map(row)}
              </Fragment>
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
