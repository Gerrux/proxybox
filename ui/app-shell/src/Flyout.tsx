/** Плашка из трея — своя раскладка, а не главное окно, ужатое до 380 px.
 *
 *  Пока это было одно и то же окно в другой ширине, плашка получала всё сразу —
 *  вкладки, шапки панелей, «Импорт», журнал — и в 520 px высоты от списка
 *  профилей оставалось три строки. А открывают её ради трёх вещей: глянуть,
 *  защищено ли; включить или выключить; сменить узел. Ровно они здесь и есть:
 *  плита состояния со словом, тумблером и картой, текущая скорость и список
 *  узлов. Всё остальное — одна кнопка до главного окна.
 *
 *  Охват в плашке — полоской из трёх сегментов под карточкой состояния, по
 *  решению владельца: из трея его меняют мимоходом, и все три варианта должны
 *  быть видны сразу. Список и пояснения — общие с кнопкой в шапке окна
 *  (`scopeOptions` из `StatusBar.tsx`). Одним касанием машину это не запирает:
 *  белый список без единой отмеченной программы — единственный выбор, после
 *  которого сети нет ни у кого, — переспрашивает строкой под полоской
 *  (`scopeLocks`).
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
import type { Act, ProfileInfo, Scope, Status } from "./platform";
import { openMain } from "./platform";
import { strings } from "./i18n";
import { aliveCount, fastestProbe, groupProfiles, quotaExpired, subTitle } from "./groups";
import {
  bytes,
  CellSpark,
  describe,
  exitCode,
  latencyTone,
  scopeLocks,
  scopeOptions,
  splitExit,
  StateGlyph,
  tunnelState,
  useRates,
} from "./StatusBar";
import { Button, Icon, IconButton, SearchField, Segmented, Switch, flag, nodeFlag } from "./ui";
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
  const code = exitCode(status);
  const [country, city] = splitExit(status?.country);
  const profiles = status?.profiles ?? [];
  const probes = status?.probes ?? [];
  const subscriptions = status?.subscriptions ?? [];
  const probeOf = new Map(probes.map((p) => [p.name, p]));
  const rates = useRates(status);
  const last = rates.at(-1) ?? null;
  // Масштаб один на оба направления — по той же причине, что и в шапке окна.
  const peak = Math.max(1, ...rates.map((r) => Math.max(r.rx, r.tx)));
  const [needle, setNeedle] = useState("");
  // Разовый отклик на включение (`.sw-sweep` в `switch.css`), только от нажатия.
  const [swept, setSwept] = useState(0);
  // Переспрос перед белым списком без единой программы (`scopeLocks`).
  const [lockAsk, setLockAsk] = useState(false);
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

  // Группы: свои узлы первыми, затем подписки в порядке службы — то же деление,
  // что в главном окне, и считает его один и тот же `groupProfiles`.
  const members = groupProfiles(profiles, subscriptions);
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

  // Самый быстрый из измеренных — тот же выбор, что у «Быстрейшего» в главном
  // окне: делает его одна и та же функция.
  const fastest = fastestProbe(probes, profiles);

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
      <section data-state={state} className="st st-fly smooth relative shrink-0">
        {/* Отыграла — ушла из разметки (`will-change` не живёт вечно). */}
        {swept > 0 && <span key={swept} className="sw-sweep" aria-hidden="true" onAnimationEnd={() => setSwept(0)} />}
        {/* Карта — фон всей карточки, а не полоса между строками: так просил
            владелец. Стоит первой и под текстом (`.fly-map` — абсолютный слой,
            строки поверх — `relative`), а место под страну выхода держит
            пустой промежуток той же высоты, что была у полосы. */}
        {/* Страна правее середины (`focus`): слева над ней стоит слово
            состояния, а справа — пустое поле карты. */}
        <WorldMap className="fly-map" code={code} fit={0.5} focus={[0.64, 0.5]} />
        <div className="relative flex items-start gap-3 px-3 pt-2.5 pb-2">
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
            onChange={(next) => {
              if (next) setSwept((n) => n + 1);
              onToggle();
            }}
          />
        </div>
        <div className="h-16" aria-hidden="true" />
        {/* Точка выхода — строкой, числа — строкой ниже: в 356 px «Нидерланды ·
            Амстердам» и три числа рядом резались до «Нидерла… Амстер…». */}
        {/* Задержка — своим блоком справа на высоту обеих строк (страна и
            скорость), крупным числом: мелким хвостом строки страны она
            терялась, а это второе, за чем открывают плашку. */}
        <div className="relative flex items-center gap-3 px-3 pt-1.5 pb-2 text-sm">
          <div className="min-w-0 flex-1">
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
          {status?.tunnel === "up" && status.latency_ms != null && (
            <p
              className={`shrink-0 font-mono text-2xl font-medium leading-none tabular-nums ${latencyTone(status.latency_ms)}`}
              title={s.latency}
            >
              {status.latency_ms}
              <span className="ms-1 text-sm font-normal text-muted">ms</span>
            </p>
          )}
        </div>
        {busy && <div className="bar absolute inset-x-0 bottom-0 h-0.5 overflow-hidden text-[color:var(--tone)]" />}
      </section>

      {/* Охват — полоской сегментов, все три видны сразу: из трея его меняют
          мимоходом, и лишнее нажатие до меню здесь мешало бы. Список и
          пояснения — те же, что у кнопки в шапке (`scopeOptions`). */}
      <div className="shrink-0 px-2 pt-2">
        <Segmented
          label={s.scope}
          options={scopeOptions(s, status)}
          value={status?.scope ?? "all"}
          className="w-full"
          disabled={!status || busy}
          onPick={(v) => {
            const next = v as Scope;
            if (next === (status?.scope ?? "all")) return;
            if (scopeLocks(status, next)) return setLockAsk(true);
            setLockAsk(false);
            onScope(next);
          }}
        />
        {/* Белый список без единой отмеченной программы — ноль пропусков,
            то есть машина без сети. Одним касанием из трея этого не делаем:
            выбор переспрашивает строкой под полоской. */}
        {lockAsk && (
          <div role="alert" className="enter mt-1.5 flex items-center gap-2 rounded bg-closed-soft py-1 ps-2.5 pe-1 text-xs">
            <span className="min-w-0 flex-1">{s.scopeLockAsk}</span>
            <Button
              variant="quiet"
              onClick={() => {
                setLockAsk(false);
                onScope("whitelist");
              }}
            >
              {s.scopeWhitelist}
            </Button>
            <Button variant="quiet" onClick={() => setLockAsk(false)}>
              {s.cancel}
            </Button>
          </div>
        )}
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
            const alive = aliveCount(g.all, probeOf);
            const expired = quotaExpired(g.sub?.quota);
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
                      {g.sub ? subTitle(g.sub) : s.ownProfiles}
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
