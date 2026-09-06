import { useEffect, useState } from "react";
import type { Act, Lang, ProfileInfo, Probe, Quota, Response, Status, Subscription } from "./platform";
import type { Strings } from "./i18n";
import { measuredAgo, strings, syncedAgo } from "./i18n";
import { bytes } from "./StatusBar";
import {
  AddField,
  Button,
  Empty,
  FIELD,
  flag,
  Menu,
  type MenuItem,
  Modal,
  type Outcome,
  Panel,
  SearchField,
} from "./ui";

/** Чем окажется набранное в поле импорта — по одному лишь префиксу и до
 *  отправки. Это подпись, а не разбор: разбирает служба, и спорить с ней
 *  нечем. Правило для `https` тут то же, по которому она уводит строку в
 *  подписку, — префикс, увиденный до всякого замка (`split_paste`).
 *
 *  Не узнали — молчим. Догадка «наверное, мусор» была бы враньём: base64-блоб
 *  подписки, сохранённый в файл, ни на что из перечисленного не похож, а
 *  импортируется прекрасно. */
function sniff(s: Strings, value: string): string | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length > 1) return s.sniffList(lines.length);
  if (/^https?:\/\//i.test(text)) return s.sniffSub;
  if (text.startsWith("{")) return s.sniffJson;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return s.sniffLink;
  return undefined;
}

/** Ответ на импорт — подписью под тем самым полем, куда вставляли.
 *
 *  «Заведено 12» без остального читалось бы как успех и на вставке из
 *  пятидесяти строк: тридцать восемь пропущенных исчезали молча, а причина у
 *  службы всё это время была на руках. */
function imported(s: Strings, r: Response | null): Outcome {
  // До службы не дошло вовсе — про это во весь рост говорит шапка, и повторять
  // её здесь незачем. Текст при этом остаётся в поле.
  if (r == null) return { ok: false };
  if (r.reply === "error") return { ok: false, note: r.data.message, bad: true };
  if (r.reply !== "imported") return { ok: true };
  const lines = [s.imported(r.data.added, r.data.kept, r.data.gone)];
  if (r.data.skipped_total > 0) {
    lines.push(s.skipped(r.data.skipped_total), ...r.data.skipped);
  }
  // Ничего нового при непустом пропуске — это не успех, а «вставили не то»:
  // цвет тут единственное, что читается боковым зрением.
  return { ok: true, note: lines.join("\n"), bad: r.data.added === 0 && r.data.skipped_total > 0 };
}

/** Остаток по подписке: сколько израсходовано из лимита и до какого числа.
 *
 *  Ноль в поле значит «панель не прислала», и то же значение стоит у
 *  безлимитных с бессрочными, — поэтому про непришедшее просто молчим, а не
 *  пишем «0 B из 0 B». Понять нечего вовсе — не рисуем ничего.
 *
 *  Израсходовано — это `upload + download`: панели считают их вместе, и два
 *  числа порознь тут никому не нужны.
 *
 *  Тревога двойная и по разным осям: осталось меньше десятой части лимита или
 *  меньше трёх суток до срока. Тон при этом `wait`, а не `fault`: это
 *  предупреждение, а не поломка, и красный тут обещал бы сработавшую защиту.
 *  Красный остаётся истёкшему сроку — он уже объясняет, почему узлы молчат. */
function Remaining({ s, quota, lang }: { s: Strings; quota: Quota; lang: Lang | undefined }) {
  const used = quota.upload + quota.download;
  const parts: string[] = [];
  if (quota.total > 0) parts.push(s.quotaOf(bytes(used), bytes(quota.total)));
  else if (used > 0) parts.push(bytes(used));
  const days = quota.expire > 0 ? (quota.expire * 1000 - Date.now()) / 86_400_000 : null;
  if (days != null) {
    parts.push(
      days < 0 ? s.quotaExpired : s.quotaUntil(new Date(quota.expire * 1000).toLocaleDateString(lang ?? "ru")),
    );
  }
  if (parts.length === 0) return null;
  const low = quota.total > 0 && quota.total - used < quota.total / 10;
  const tone =
    days != null && days < 0 ? "text-fault" : low || (days != null && days < 3) ? "text-wait" : "text-muted";
  return (
    <span
      title={s.quotaHint}
      className={`shrink-0 font-sans text-[11px] font-normal normal-case tracking-normal ${tone}`}
    >
      {parts.join(" · ")}
    </span>
  );
}

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

/** Где окно помнит порядок по задержке. Он остаётся способом посмотреть, а не
 *  свойством списка, — поэтому он в браузерном хранилище окна, а не в службе (в
 *  отличие от порядка, расставленного руками: тот про сам список, и держит его
 *  служба). Помнить его всё же надо: прогон затевают ровно ради выбора узла, а
 *  список после каждого открытия окна возвращался к порядку панели. */
const BY_LATENCY = "pg.profiles.byLatency";

/** Порядок, расставленный руками, в окне не живёт вовсе: его помнит служба
 *  (`Request::SetOrder`, `arrange` в службе), и список приезжает уже
 *  разложенным. Здесь остаётся только то, что видно на время самого
 *  перетаскивания: пока тянут строку, порядок обязан меняться под курсором, а
 *  служба узнаёт о нём один раз — когда строку отпустили. Слать команду на
 *  каждое `dragover` значило бы писать `state.json` на диск десятки раз за один
 *  перенос.
 *
 *  Расставить по этому временному порядку: известные — по своим местам,
 *  остальные — следом, в том порядке, в каком приехали. Сортировка устойчива,
 *  поэтому «следом» и означает «как пришли». */
function seated<T>(items: T[], name: (item: T) => string, order: string[] | undefined): T[] {
  if (!order?.length) return items;
  const seat = new Map(order.map((n, i) => [n, i] as const));
  return [...items].sort((a, b) => (seat.get(name(a)) ?? Infinity) - (seat.get(name(b)) ?? Infinity));
}

/** Перетащенное встаёт на место того, над кем его держат. Тащат вниз — встаёт
 *  под него, вверх — над ним: иначе строка на последнем месте недостижима. */
function moved(names: string[], from: string, to: string): string[] {
  if (from === to) return names;
  const out = names.filter((n) => n !== from);
  out.splice(out.indexOf(to) + (names.indexOf(from) < names.indexOf(to) ? 1 : 0), 0, from);
  return out;
}

/** Где открыть меню. Точка курсора, а если нажали с клавиатуры (координат нет)
 *  — под самой кнопкой. */
function spot(e: React.MouseEvent<HTMLElement>): [number, number] {
  if (e.clientX || e.clientY) return [e.clientX, e.clientY];
  const rect = e.currentTarget.getBoundingClientRect();
  return [rect.left, rect.bottom];
}

export function Profiles({
  status,
  act,
  busy,
  className,
  onError,
}: {
  status: Status | null;
  act: Act;
  busy?: boolean;
  className?: string;
  /** Отказ, о котором сказать больше некому: копирование ссылки — единственное
   *  действие панели, которое делает не служба, а само окно, и ответа со
   *  статусом у него нет. */
  onError?: (message: string) => void;
}) {
  const s = strings(status?.lang);
  const profiles = status?.profiles ?? [];
  const subscriptions = status?.subscriptions ?? [];
  const [query, setQuery] = useState("");
  // Импорт — отдельным окном поверх панели, а не полем внутри неё. Полем оно и
  // было: две строки раздвигали список сверху, и всё, ради чего панель
  // открывали, уезжало вниз — в том числе строка, на которую человек уже
  // целился.
  const [adding, setAdding] = useState(false);
  const needle = query.trim().toLowerCase();
  const match = (p: ProfileInfo) =>
    !needle || p.name.toLowerCase().includes(needle) || p.server.toLowerCase().includes(needle);
  // Свёрнутые группы — здесь, а не в атрибуте <details>: статус приходит раз в
  // секунду, и открытое состояние, живущее только в DOM, спорило бы с каждой
  // перерисовкой. Имя группы — её адрес, поэтому переживает и подмену узлов.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Какую подписку сейчас переименовывают. Адресом, а не флагом: подписок
  // несколько, и открытых полей должно быть не больше одного.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Какой профиль правят и каким текстом. Узел приезжает отдельным запросом:
  // в статусе его нет намеренно — окно спрашивает статус каждые две секунды, а
  // подписка приносит сотни узлов с ключами и паролями внутри.
  const [editing, setEditing] = useState<{ name: string; text: string } | null>(null);
  // Правка и «скопировать ссылку» спрашивают одно и то же — узел целиком.
  const nodeOf = (name: string) =>
    act({ cmd: "profile-node", arg: { name } }).then((r) => (r?.reply === "profile-node" ? r.data : null));
  // В поле правки едет ссылка, если она у узла есть: сменить порт или пароль —
  // это правка одной строки, а тем же JSON человек до сих пор платил за неё
  // чтением всего узла. Ссылки нет — узел в неё не перекладывается без потерь,
  // и тогда JSON остаётся единственным честным видом.
  const openEditor = (name: string) =>
    void nodeOf(name).then((data) => data && setEditing({ name, text: data.link || data.json }));
  // Успех молчит: в буфере обмена лежит ссылка, и это и есть ответ. Говорить
  // приходится только об отказе — их два, и они про разное.
  const copyLink = (name: string) =>
    void nodeOf(name).then((data) => {
      if (!data) return;
      if (!data.link) return onError?.(s.noLink);
      return navigator.clipboard.writeText(data.link).catch(() => onError?.(s.copyFailed));
    });
  // Открытое меню — одно на панель: второе, оставшееся от прошлой строки,
  // делало бы вид, что относится к этой.
  const [menu, setMenu] = useState<{ at: [number, number]; items: MenuItem[] } | null>(null);
  const openMenu = (e: React.MouseEvent<HTMLElement>, items: MenuItem[]) => {
    e.preventDefault();
    // Клик по «⋯» внутри <summary> иначе сворачивал бы заодно и группу.
    e.stopPropagation();
    setMenu({ at: spot(e), items });
  };
  // Поле не прячем, пока в нём что-то есть: иначе фильтр остался бы включённым
  // и невидимым, а строки просто пропали бы.
  const searchable = profiles.length > SEARCH_FROM || query !== "";
  // Прогон запускают ровно затем, чтобы выбрать быстрый узел, — а в списке на
  // сотню строк 40 ms до сих пор искали глазами. Переключатель показывается,
  // только когда есть что упорядочивать: без единого измерения он не сделал бы
  // ничего.
  const [byLatency, setByLatency] = useState(() => {
    try {
      return localStorage.getItem(BY_LATENCY) === "1";
    } catch {
      // Хранилище бывает закрыто политикой — это не повод ронять панель.
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(BY_LATENCY, byLatency ? "1" : "0");
    } catch {
      // см. выше: порядок — украшение, а не состояние продукта.
    }
  }, [byLatency]);
  // Порядок на время переноса: пока строку тянут, список переставляется здесь,
  // а служба узнаёт о нём один раз — на `commit`. Пусто — показываем то, что
  // приехало от службы.
  const [pending, setPending] = useState<string[] | null>(null);
  const [pendingSubs, setPendingSubs] = useState<string[] | null>(null);
  // Что тащат прямо сейчас: подписку — здесь, профиль — внутри своего списка.
  const [dragged, setDragged] = useState<string | null>(null);
  const probes = status?.probes ?? [];
  const measured = probes.some((p) => p.latency_ms != null);
  const testing = status?.testing ?? null;
  const latency = (name: string) => probes.find((p) => p.name === name)?.latency_ms ?? Infinity;
  // Порядков три, и они не складываются друг с другом.
  //
  // По задержке — пока включён переключатель; там звёздочка по-прежнему
  // сильнее числа: отмечают ровно те три узла из сотни, которыми пользуются, и
  // уехать вниз из-за чужого замера они не должны.
  //
  // Расставленный руками — если эту группу тащили. Он перевешивает и
  // звёздочку, и это намеренно: звёздочка поднимает узел наверх за неимением
  // другого способа сказать «этот важнее», а перетаскивание и есть тот способ,
  // сказанный прямо. Возвращать строку на место сразу после того, как её туда
  // перенесли, — худшее, что может сделать список.
  //
  // Не мерили и не тащат прямо сейчас — как отдала служба: она же и держит
  // порядок, расставленный руками, и звёздочку.
  const arrange = (items: ProfileInfo[]): ProfileInfo[] => {
    if (byLatency)
      return [...items].sort(
        (a, b) => Number(b.favorite) - Number(a.favorite) || latency(a.name) - latency(b.name),
      );
    return pending ? seated(items, (p) => p.name, pending) : items;
  };
  // Тащить можно, только когда порядок и вправду принадлежит человеку. По
  // задержке список переставляет число, и перенесённая строка уехала бы
  // обратно тем же кадром. Под поиском видна половина списка, и записанный
  // порядок из половины имён смёл бы вторую половину в хвост.
  const draggable = !byLatency && needle === "";
  // Заведённое руками и пришедшее с панели — разные вещи, и в одном списке
  // десяток своих узлов тонет в сотне чужих. Своё — то, чего нет ни в одной
  // подписке: связь знает служба, окно её только показывает.
  const fromSubs = new Set(subscriptions.flatMap((sub) => sub.nodes));
  const byName = new Map(profiles.map((p) => [p.name, p]));
  // Подписки тоже переставляются, а своя группа остаётся первой: она не
  // подписка, и меняться местами ей не с кем.
  const subs = pendingSubs ? seated(subscriptions, (sub) => sub.url, pendingSubs) : subscriptions;
  const groups = [
    { sub: null, items: arrange(profiles.filter((p) => !fromSubs.has(p.name) && match(p))) },
    ...subs.map((sub) => ({
      sub,
      items: arrange(
        sub.nodes.flatMap((name) => {
          const p = byName.get(name);
          return p && match(p) ? [p] : [];
        }),
      ),
    })),
  ];
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  // Перенос внутри группы — это новый порядок всего списка: службе он уезжает
  // одной строкой имён, а группы в ней лежат подряд, поэтому чужие остаются
  // как есть.
  const reorder = (key: string, names: string[]) =>
    setPending(groups.flatMap((g) => ((g.sub?.url ?? "") === key ? names : g.items.map((i) => i.name))));
  // Строку отпустили — служба узнаёт порядок. Уезжает только то, что и вправду
  // переставляли: пустой список служба понимает как «этот порядок не трогать»,
  // и перенос подписки не замораживает в ручной порядок расстановку по
  // звёздочке. Временный порядок снимается только после того, как вернулся
  // статус: сними его раньше, и список моргнул бы прежним порядком.
  const commit = () => {
    if (pending === null && pendingSubs === null) return;
    void act({
      cmd: "set-order",
      arg: { profiles: pending ?? [], subscriptions: pendingSubs ?? [] },
    }).finally(() => {
      setPending(null);
      setPendingSubs(null);
    });
  };
  // Группы заводит только подписка: с одними своими узлами заголовок «Свои»
  // говорил бы о делении, которого нет.
  const grouped = subscriptions.length > 0;
  // Самый быстрый из измеренных и всё ещё живущих в списке. Прогон затевают
  // ради этого выбора, а делать его глазами по сотне строк — то же самое, что
  // не делать вовсе.
  const fastest = probes
    .filter((p) => p.latency_ms != null && byName.has(p.name))
    .sort((a, b) => (a.latency_ms ?? 0) - (b.latency_ms ?? 0))[0];
  // Действия подписки — тем же меню, что и у профиля: у неё их три, и три
  // значка в заголовке группы съедали ту самую ширину, в которой не помещался
  // адрес.
  const subMenu = (sub: Subscription): MenuItem[] => [
    {
      label: s.refresh,
      hint: s.refreshSubscription(sub.url),
      // Обновление — тот же импорт: служба сама узнаёт адрес и заменяет
      // пришедшие с него профили.
      onPick: () => void act({ cmd: "add-profile", arg: { link: sub.url } }),
    },
    { label: s.renameSubscription, onPick: () => setRenaming(sub.url) },
    {
      label: s.unsubscribe,
      hint: s.removeSubscription(sub.url),
      danger: true,
      // Отписка уносит с собой десятки профилей разом — по одному клику мимо
      // такое случаться не должно.
      ask: s.confirmRemove,
      onPick: () => void act({ cmd: "remove-subscription", arg: { url: sub.url } }),
    },
  ];
  return (
    <Panel
      className={className}
      title={s.profiles}
      note={
        profiles.length > 0 && (
          <span className="text-muted">
            {profiles.length}
            {query !== "" && ` · ${s.appsShown(shown)}`}
            {/* Возраст списка, а не адреса: узлы в подписке меняет панель, и по
                одному адресу не видно, пришли они час назад или лежат тут с
                прошлого месяца. Отметка одна на все подписки — сверяются они
                вместе, и повторять её над каждой было бы шумом. */}
            {grouped && ` · ${syncedAgo(s, status?.refreshed_at ?? null)}`}
          </span>
        )
      }
      action={
        <>
          {measured && (
            // Включённый порядок по задержке снимается той же кнопкой, и она
            // об этом говорит прямо: «сбросить» вместо «по задержке». Пока она
            // об этом молчала, порядок выглядел свойством списка, а не
            // включённым переключателем, — и вернуть свой человек не мог.
            <Button
              variant="quiet"
              aria-pressed={byLatency}
              title={s.byLatencyHint}
              onClick={() => setByLatency((v) => !v)}
            >
              {byLatency ? s.byLatencyOff : s.byLatency}
            </Button>
          )}
          {fastest && status?.profile !== fastest.name && (
            <Button
              variant="quiet"
              disabled={busy}
              title={s.fastestHint}
              onClick={() => void act({ cmd: "on", arg: { profile: fastest.name } })}
            >
              {s.fastest}
            </Button>
          )}
          {subscriptions.length > 1 && (
            <Button
              variant="quiet"
              disabled={busy}
              title={s.refreshAllHint}
              onClick={() => {
                // По одной, а не залпом: каждая — поход в сеть до двадцати
                // секунд, и пять параллельных закачек под общим замком службы
                // означали бы окно без статуса всё это время.
                void (async () => {
                  for (const sub of subscriptions) {
                    await act({ cmd: "add-profile", arg: { link: sub.url } });
                  }
                })();
              }}
            >
              {s.refreshAll}
            </Button>
          )}
          {profiles.length > 0 && (
            // Пока прогон идёт, кнопка заперта: второй прогон добил бы sing-box
            // первого — они делят каталог проверки. На ней же и бегунок: узел
            // стоит секунд, и на сотне это минуты, за которые панель обязана
            // отличаться от зависшей.
            <Button
              variant="quiet"
              disabled={busy}
              title={s.testProfilesHint}
              onClick={() => void act({ cmd: "test-profiles", arg: { only: null } })}
            >
              {testing ? s.testingProgress(testing.done, testing.total) : busy ? s.testing : s.testProfiles}
            </Button>
          )}
          <Button
            aria-haspopup="dialog"
            aria-label={s.importLink}
            title={s.linkPlaceholder}
            onClick={() => setAdding(true)}
            className="w-8 px-0 text-[15px] leading-none"
          >
            +
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {adding && (
          <Modal title={s.importLink} onClose={() => setAdding(false)}>
            {/* Окно не закрывается на удачный импорт: ответом приезжает счёт
                («заведено 12, пропущено 38»), и закрыть его вместе с окном
                значило бы снова не сказать, куда делись остальные. */}
            <AddField
              placeholder={s.linkPlaceholder}
              label={s.importLink}
              busyLabel={s.importing}
              fileLabel={s.fromFile}
              hint={(value) => sniff(s, value)}
              onSubmit={(link) => act({ cmd: "add-profile", arg: { link } }).then((r) => imported(s, r))}
            />
          </Modal>
        )}
        {searchable && <SearchField value={query} onChange={setQuery} placeholder={s.searchProfiles} />}
        {!grouped && profiles.length === 0 ? (
          // Пустому списку нужна не подпись, а дверь: поле импорта больше не
          // открыто само, и «+» в шапке — единственное, чем этот список
          // заводят.
          <div className="flex flex-col items-center gap-2">
            <Empty>{s.noProfiles}</Empty>
            <Button variant="primary" onClick={() => setAdding(true)}>
              {s.importLink}
            </Button>
          </div>
        ) : shown === 0 && needle !== "" ? (
          <Empty>{s.noMatches}</Empty>
        ) : !grouped ? (
          <Rows
            items={groups[0].items}
            status={status}
            act={act}
            s={s}
            busy={busy}
            editing={editing}
            onEdit={openEditor}
            onCopy={copyLink}
            onDone={() => setEditing(null)}
            onMenu={openMenu}
            onReorder={draggable ? (names) => reorder("", names) : undefined}
            onCommit={commit}
          />
        ) : (
          // Подписка показывается даже пустой: она могла не отдать ни одного
          // понятного нам узла, а отписаться больше неоткуда. Прячет группу
          // только поиск.
          groups.map(
            ({ sub, items }) =>
              (items.length > 0 || (sub !== null && needle === "")) && (
                // Сворачивается родным <details>: подписка на сотню узлов иначе
                // уводит все остальные группы за нижний край окна.
                <details
                  key={sub?.url ?? ""}
                  open={!collapsed.includes(sub?.url ?? "")}
                  onToggle={(e) => {
                    // Состояние снимаем здесь, а не внутри апдейтера: апдейтер
                    // React зовёт лениво, уже на фазе рендера, а к тому времени
                    // синтетическое событие обнулено — `currentTarget` там null.
                    // Прочитанное изнутри роняло `<Profiles>` целиком, и окно
                    // открывалось пустым: границы ошибок над панелями нет, и
                    // React вычищает контейнер.
                    const { open } = e.currentTarget;
                    setCollapsed((was) =>
                      open ? was.filter((u) => u !== (sub?.url ?? "")) : [...was, sub?.url ?? ""],
                    );
                  }}
                  className="group/sub"
                >
                  <summary
                    // Тащат подписку за её заголовок; своя группа не тащится
                    // вовсе — она всегда первая. Перетаскивание не кликает, и
                    // группа от него не сворачивается.
                    draggable={draggable && sub !== null}
                    onDragStart={(e) => {
                      if (sub === null) return;
                      setDragged(sub.url);
                      e.dataTransfer.effectAllowed = "move";
                      // Без полезной нагрузки Firefox не начинает перетаскивание
                      // вовсе; вебвью хватило бы и пустого.
                      e.dataTransfer.setData("text/plain", sub.url);
                    }}
                    onDragOver={(e) => {
                      if (sub === null || dragged === null || dragged === sub.url) return;
                      // Без preventDefault браузер считает, что бросать сюда
                      // нельзя, и возвращает строку на место.
                      e.preventDefault();
                      setPendingSubs(moved(subs.map((x) => x.url), dragged, sub.url));
                    }}
                    onDrop={(e) => e.preventDefault()}
                    onDragEnd={() => {
                      setDragged(null);
                      commit();
                    }}
                    onContextMenu={(e) => sub !== null && openMenu(e, subMenu(sub))}
                    className={`engraved flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-1.5 text-muted hover:bg-surface-2 [&::-webkit-details-marker]:hidden ${
                      dragged === sub?.url ? "opacity-40" : ""
                    }`}
                  >
                    {/* .smooth возит только цвет — повороту нужен свой переход, и он же
                        обязан замирать при prefers-reduced-motion. */}
                    <span className="shrink-0 text-[9px] motion-safe:transition group-open/sub:rotate-90">▶</span>
                    {sub === null ? (
                      <span className="min-w-0 flex-1 truncate">{s.ownProfiles}</span>
                    ) : renaming === sub.url ? (
                      // Поле стоит на месте подписи и по любому клику внутри
                      // себя не сворачивает группу: <summary> переключает
                      // <details> по всему, что в него попало.
                      <form
                        className="flex min-w-0 flex-1 items-center gap-2"
                        onClick={(e) => e.stopPropagation()}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = new FormData(e.currentTarget).get("name");
                          void act({
                            cmd: "rename-subscription",
                            arg: { url: sub.url, name: String(name ?? "") },
                          }).then(() => setRenaming(null));
                        }}
                      >
                        <input
                          name="name"
                          autoFocus
                          defaultValue={sub.name}
                          placeholder={s.subName}
                          spellCheck={false}
                          onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                          className={`${FIELD} font-sans text-[11px] font-normal normal-case tracking-normal`}
                        />
                        <Button type="submit" variant="quiet">
                          {s.save}
                        </Button>
                      </form>
                    ) : (
                      // Схема одинакова у всех подписок и съедает начало строки,
                      // а обрезается как раз хвост — то единственное, чем адреса
                      // и различаются. Имя, если его дали, читается вместо
                      // адреса; полный адрес остаётся по наведению в обоих
                      // случаях.
                      <span
                        className={`selectable min-w-0 flex-1 truncate ${
                          sub.name ? "" : "font-mono text-[11px] font-normal normal-case tracking-normal"
                        }`}
                        title={sub.url}
                      >
                        {sub.name || sub.url.replace(/^https?:\/\//, "")}
                      </span>
                    )}
                    {/* Остаток стоит `shrink-0`, а обрезается имя с адресом:
                        остаток короткий и постоянной длины, а схема с хвостом
                        адреса — длинная. Живёт он в <summary>, а не под ним: в
                        свёрнутом виде это единственное место, где его вообще
                        видно, а свёрнуты подписки как раз чаще всего. Пока
                        подписку переименовывают, его не видно — поле занимает
                        ту же строку, и два поля рядом не помещаются. */}
                    {sub?.quota && renaming !== sub.url && (
                      <Remaining s={s} quota={sub.quota} lang={status?.lang} />
                    )}
                    <span className="shrink-0 font-sans text-[11px] font-normal normal-case tracking-normal">
                      {items.length}
                    </span>
                    {sub !== null && renaming !== sub.url && (
                      <Button
                        variant="quiet"
                        aria-label={s.actions}
                        aria-haspopup="menu"
                        onClick={(e) => openMenu(e, subMenu(sub))}
                      >
                        ⋯
                      </Button>
                    )}
                  </summary>
                  <Rows
                    items={items}
                    status={status}
                    act={act}
                    s={s}
                    busy={busy}
                    editing={editing}
                    onEdit={openEditor}
                    onCopy={copyLink}
                    onDone={() => setEditing(null)}
                    onMenu={openMenu}
                    onReorder={draggable ? (names) => reorder(sub?.url ?? "", names) : undefined}
                    onCommit={commit}
                    fromSub={sub !== null}
                  />
                </details>
              ),
          )
        )}
      </div>
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </Panel>
  );
}
/** Форма правки: имя и узел. Узел — тем же текстом, что принимает импорт, и
 *  разбирает его тот же разбор: второму парсеру взяться неоткуда, а поля по
 *  протоколам — это десяток форм, которые расходятся с sing-box на каждой его
 *  версии.
 *
 *  Приезжает сюда ссылка, когда узел в неё перекладывается без потерь, и JSON,
 *  когда нет (`core_config::share_link`). Поле одно на оба вида: службе всё
 *  равно, чем его заполнили, а форма, которая показывает то ссылку, то JSON
 *  разными полями, — это две формы вместо одной.
 *
 *  Ошибка живёт здесь же, а не в общей рамке наверху окна: правят узел руками,
 *  и «в узле нет поля type» надо читать, не отводя глаз от самого узла. */
function Editor({
  s,
  name,
  text,
  act,
  onDone,
}: {
  s: Strings;
  name: string;
  text: string;
  act: Act;
  onDone: () => void;
}) {
  const [want, setWant] = useState(name);
  const [node, setNode] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 rounded-md bg-surface-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        void act({
          cmd: "edit-profile",
          // Нетронутый узел не отправляем вовсе: разбор вернул бы тот же самый,
          // но лишний повод перезапустить туннель на активном профиле здесь ни
          // к чему.
          arg: { name, rename: want.trim(), node: node.trim() === text.trim() ? "" : node.trim() },
        })
          .then((r) => (r?.reply === "error" ? setError(r.data.message) : onDone()))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex gap-2">
        <input
          value={want}
          autoFocus
          onChange={(e) => setWant(e.target.value)}
          placeholder={s.editName}
          aria-label={s.editName}
          spellCheck={false}
          className={FIELD}
        />
        <Button type="submit" variant="primary" disabled={busy || !want.trim()}>
          {s.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {s.cancel}
        </Button>
      </div>
      <textarea
        value={node}
        // Ссылка — одна строка, но длинная: в один ряд она переносом уезжает за
        // край поля, и правят её вслепую. Три ряда её показывают целиком, а
        // JSON и без того длиннее.
        rows={Math.min(14, Math.max(3, node.split("\n").length))}
        onChange={(e) => setNode(e.target.value)}
        aria-label={s.editNode}
        spellCheck={false}
        className={`${FIELD.replace("h-8", "h-auto")} resize-none py-[5px] font-mono text-[11px] leading-[18px]`}
      />
      <span className={`text-[11px] ${error ? "text-fault" : "text-muted"}`}>{error ?? s.editNodeHint}</span>
    </form>
  );
}


/** Строки списка. Отдельно от групп: под каждой подпиской и над ними лежит один
 *  и тот же список, и второй его копии быть не должно.
 *
 *  Порядок строк считают не здесь: он один на все группы (по задержке, руками
 *  или как отдала служба) и живёт там же, где память о нём. Сюда список
 *  приезжает готовым. */
function Rows({
  items,
  status,
  act,
  s,
  busy,
  editing,
  onEdit,
  onCopy,
  onDone,
  onMenu,
  onReorder,
  onCommit,
  fromSub,
}: {
  items: ProfileInfo[];
  status: Status | null;
  act: Act;
  s: Strings;
  busy?: boolean;
  editing: { name: string; text: string } | null;
  onEdit: (name: string) => void;
  /** Ссылку узла — в буфер обмена. Есть и у узла подписки: правка ему заказана,
   *  а перенести его на телефон или отдать соседу — нет. */
  onCopy: (name: string) => void;
  onDone: () => void;
  onMenu: (e: React.MouseEvent<HTMLElement>, items: MenuItem[]) => void;
  /** Переставили строки — сюда приезжает новый порядок имён этой группы.
   *  Не задан — тащить нельзя: список сейчас переставляет не человек. */
  onReorder?: (names: string[]) => void;
  /** Строку отпустили: пора рассказать порядок службе. */
  onCommit: () => void;
  /** Узлы пришли из подписки. Тогда у строки нет правки: сверка заменяет набор
   *  целиком, и переименованный вручную узел вернулся бы ближайшим же кругом —
   *  то есть кнопка обещала бы то, чего не делает. Удалить, в отличие от
   *  правки, можно: строка уходит сразу, а вернётся — только со следующей
   *  сверкой, и меню об этом говорит прямо. */
  fromSub?: boolean;
}) {
  const probes = status?.probes ?? [];
  // Что тащат прямо сейчас. Своё на каждый список: строку из чужой группы
  // сюда не переносят — узел подписки в «Свои» не переезжает.
  const [dragged, setDragged] = useState<string | null>(null);
  const names = items.map((i) => i.name);
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        const name = item.name;
        const active = status?.profile === name;
        const probe = probes.find((p) => p.name === name);
        // У активного профиля точка выхода известна и без прогона —
        // её спросил сам туннель.
        const country = probe?.country ?? (active && status?.tunnel === "up" ? status.country : null);
        const live = active && status != null && status.tunnel !== "off";
        // Окно браузера открыто через этот узел. Заводят и открывают их
        // на своей вкладке, но узнать об этом отсюда человек должен: узел
        // при этом несёт трафик, а в строке об этом иначе ни слова.
        const browsing =
          status?.browser_profiles.some((b) => b.node === name && status.browsers.includes(b.name)) ?? false;
        // Рельс профиля повторяет то, что показывает верх окна: выбран —
        // ещё не значит «несёт трафик», и путать это нельзя.
        const tone = TONE[live && status ? status.tunnel : "off"];
        // Каталоги сеансов зовутся по имени браузерного профиля, а не
        // узла: стирать тут нечего. Браузерные профили удаление узла
        // переживают намеренно — в их каталогах входы человека, и починка
        // это выбрать другой узел, а не заводить всё заново.
        const remove = () => void act({ cmd: "remove-profile", arg: { name } });
        // Включает строка сама, по нажатию: кнопки «Включить» у неё больше
        // нет. Выбор узла — единственное, ради чего в этот список ходят, и
        // отдельная кнопка под него означала лишь то, что попасть по строке
        // мало.
        const pick = () => !live && void act({ cmd: "on", arg: { profile: name } });
        // Всё, что строка умеет, — в меню по правой кнопке и по «⋯». Пять
        // кнопок в строке не помещались даже в широком окне: первым
        // обрубалось имя, единственное, чем строки и различаются.
        const rowMenu = (): MenuItem[] => [
          ...(live ? [] : [{ label: s.turnOn, onPick: pick }]),
          {
            // Прогон идёт по узлу за раз и стоит секунд на каждый, так что на
            // подписке в сотню «вот этот» — это минуты разницы. Заперт он тем
            // же прогоном, что и кнопка панели: каталог проверки у них общий.
            label: s.testOne,
            hint: s.testOneHint,
            disabled: busy,
            onPick: () => void act({ cmd: "test-profiles", arg: { only: name } }),
          },
          {
            // Звёздочка есть и у узла подписки: сверка заменяет её набор
            // целиком, но отметку не трогает — та про выбор человека, а не про
            // узел. Помнит её служба, а не окно.
            label: s.favoriteItem,
            hint: s.favorite,
            mark: item.favorite,
            onPick: () => void act({ cmd: "set-favorite", arg: { name, on: !item.favorite } }),
          },
          { label: s.copyLink, hint: s.copyLinkHint, onPick: () => onCopy(name) },
          ...(fromSub ? [] : [{ label: s.edit, hint: s.editProfile(name), onPick: () => onEdit(name) }]),
          {
            label: s.remove,
            // У узла подписки удаление честное, но недолгое: ближайшая сверка
            // принесёт его обратно. Про это и пишет само меню — иначе
            // вернувшаяся строка выглядит поломкой.
            hint: fromSub ? s.removeFromSubHint : s.removeProfile(name),
            danger: true,
            // У активного профиля удаление гасит туннель, и выбранные
            // приложения остаются без сети. То же и у узла, на который смотрит
            // открытое окно браузера: `forget_profile` зовёт `stop_sessions_on`.
            // Остальные уходят сразу — их человек вернёт вставкой за секунду.
            ask: live || browsing ? s.confirmRemove : undefined,
            onPick: remove,
          },
        ];
        return (
          <li
            key={name}
            className="flex flex-col"
            draggable={onReorder != null}
            onDragStart={(e) => {
              setDragged(name);
              e.dataTransfer.effectAllowed = "move";
              // Без полезной нагрузки Firefox не начинает перетаскивание вовсе.
              e.dataTransfer.setData("text/plain", name);
            }}
            onDragOver={(e) => {
              if (onReorder == null || dragged === null || dragged === name) return;
              // Без preventDefault браузер считает, что бросать сюда нельзя.
              e.preventDefault();
              onReorder(moved(names, dragged, name));
            }}
            onDrop={(e) => e.preventDefault()}
            onDragEnd={() => {
              setDragged(null);
              onCommit();
            }}
          >
            <div
              // Правая кнопка открывает меню по всей строке, включая её поля и
              // значки: целиться в «⋯» ради этого не нужно.
              onContextMenu={(e) => onMenu(e, rowMenu())}
              className={`enter smooth relative flex items-center gap-2 rounded-md py-1.5 ps-3 pe-1 hover:bg-surface-2 ${
                active ? "bg-surface-2" : ""
              } ${dragged === name ? "opacity-40" : ""}`}
            >
              <span className={`smooth absolute inset-y-1 start-0 w-[3px] rounded-full ${tone.rail}`} />
              {/* Имя сверху, всё измеренное — строкой ниже, как в списке
                  приложений: в одну строку имя, состояние, страна, задержка
                  и кнопки не помещаются даже в окне минимальной ширины, и
                  первым обрубается имя — единственное, чем строки и
                  различаются. */}
              {/* Само поле строки и есть кнопка «включить»: настоящий <button>,
                  а не строка с ролью, — иначе клавиатура до профиля не
                  добирается, а кнопка меню внутри роли ей же и мешает. Заняло
                  оно всё, кроме звёздочки и «⋯»: промахнуться мимо профиля в
                  строке профиля больше негде. */}
              <button
                type="button"
                aria-pressed={active}
                onClick={pick}
                className={`min-w-0 flex-1 text-start leading-tight ${live ? "" : "cursor-pointer"}`}
              >
                <span
                  className={`block truncate text-[13px] ${active ? "font-medium" : "text-muted"}`}
                  title={name}
                >
                  {name}
                </span>
                <span className="flex items-baseline gap-2 overflow-hidden text-[11px] text-muted">
                  {live && <span className={`engraved shrink-0 ${tone.text}`}>{s.active}</span>}
                  {browsing && (
                    <span className="engraved shrink-0" title={s.browserOnHint}>
                      {s.browserOn}
                    </span>
                  )}
                  {/* Куда ведёт узел. Стоит первым и обрезается первым: имя
                      профиля пишет чужая панель, и два одинаково названных
                      узла различаются только этим. Пароля и ключа тут нет —
                      их в окно не привозят вовсе. */}
                  {item.server && (
                    <span className="min-w-0 truncate font-mono" title={`${item.kind} → ${item.server}`}>
                      {item.server}
                    </span>
                  )}
                  {/* Страна — флагом: «Нидерланды, Амстердам» не
                      помещается в строку вовсе, а флаг читается быстрее
                      любой надписи. Название целиком остаётся подсказкой
                      и подписью для чтения с экрана. Кода нет (состояние
                      прошлых версий или сервис не прислал) — показываем
                      название, обрезкой. */}
                  {country &&
                    (flag(probe?.code) ? (
                      <span className="shrink-0 text-[13px] leading-none" title={country} aria-label={country}>
                        {flag(probe?.code)}
                      </span>
                    ) : (
                      <span className="truncate" title={country}>
                        {country}
                      </span>
                    ))}
                  {/* Число, снятое при поднятом туннеле, включает и его RTT:
                      прогон идёт цепочкой сквозь общий туннель, своего
                      маршрута мимо TUN у него нет. Сравнивать такие числа с
                      выключенным режимом нельзя, а выбирают узел именно
                      сравнением — значит, сказать об этом обязано само
                      число. */}
                  <Verdict
                    probe={probe}
                    failed={s.probeFailed}
                    measured={
                      status?.tunnel === "up"
                        ? `${measuredAgo(s, probe?.at ?? 0)} · ${s.latencyThroughTunnel}`
                        : measuredAgo(s, probe?.at ?? 0)
                    }
                  />
                </span>
              </button>
              {/* Звёздочка осталась в строке знаком, а не кнопкой: переключают
                  её теперь в меню, а видеть отмеченные надо, не открывая
                  ничего, — ради этого её и ставят. */}
              {item.favorite && (
                <span className="shrink-0 text-accent" title={s.favorite} aria-label={s.favoriteItem}>
                  ★
                </span>
              )}
              <Button
                variant="quiet"
                aria-label={s.actions}
                aria-haspopup="menu"
                onClick={(e) => onMenu(e, rowMenu())}
              >
                ⋯
              </Button>
            </div>
            {editing?.name === name && (
              <Editor s={s} name={name} text={editing.text} act={act} onDone={onDone} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
