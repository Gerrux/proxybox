import { useEffect, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import type { Act, Lang, ProfileInfo, Probe, Response, Status, Subscription } from "./platform";
import type { Strings } from "./i18n";
import { measuredAgo, strings, syncedAgo } from "./i18n";
import { aliveCount, fastestProbe, groupProfiles, quotaFacts, subTitle, type Group, type QuotaFacts } from "./groups";
import { bytes, latencyTone } from "./StatusBar";
import {
  AddField,
  Button,
  Empty,
  FIELD,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  Modal,
  type Outcome,
  Panel,
  SearchField,
  Segmented,
  nodeFlag,
  spot,
  useBoxWidth,
} from "./ui";

/** Чем окажется набранное в поле импорта — по одному лишь префиксу и до
 *  отправки. Это подпись, а не разбор: разбирает служба, и спорить с ней
 *  нечем. Правило для `http(s)` тут то же, по которому она уводит строку в
 *  подписку, — префикс, увиденный до всякого замка (`split_paste`).
 *
 *  Не узнали — молчим. Догадка «наверное, мусор» была бы враньём: base64-блоб
 *  подписки, сохранённый в файл, ни на что из перечисленного не похож, а
 *  импортируется прекрасно. */
/** Адрес прокси, а не подписки: `http(s)://` без пути и запроса, но с логином
 *  или явным портом. Копия `core_config::is_proxy_url` — там решение, здесь
 *  подпись, и разойдись они, окно лишь предложит лишний предпросмотр. */
function isProxyUrl(line: string): boolean {
  return /^https?:\/\/(?:[^/?#]*@[^/?#@]+|[^/?#@]+:\d+)\/?(?:#.*)?$/i.test(line.trim());
}

/** Строка прокси без схемы: `host:port`, `host:port:user:pass`,
 *  `user:pass@host:port`. Служба читает её как SOCKS5. */
function isBareProxy(line: string): boolean {
  return /^(?:[^\s:/@]+:\d+(?::[^\s:@]+:\S+)?|[^\s/@]+@[^\s:/@]+:\d+)$/.test(line.trim());
}

function sniff(s: Strings, value: string): string | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length > 1) return s.sniffList(lines.length);
  if (isProxyUrl(text) || isBareProxy(text) || /^socks5h?:\/\//i.test(text)) return s.sniffProxy;
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

/** Есть ли во вставке адрес подписки. Предпросмотр нужен только ей: подписка
 *  заменяет свой набор целиком, и «нашли 84 узла, три уйдут — применить?»
 *  спрашивается до замены, а не сообщается после. Голые ссылки заводятся сразу,
 *  как и раньше: у них нечему пропадать, а лишний шаг на каждую — это лишний
 *  шаг. */
function hasSubscription(text: string): boolean {
  return text.split("\n").some((line) => /^https?:\/\//i.test(line.trim()) && !isProxyUrl(line));
}

/** Ответ предпросмотра — тем же счётом, но в будущем времени и с кнопкой
 *  «Применить». `ok: false` здесь значит «поле не чистить»: текст ещё нужен
 *  второму шагу. */
function previewed(s: Strings, r: Response | null, apply: () => Promise<Outcome>): Outcome {
  if (r == null) return { ok: false };
  if (r.reply === "error") return { ok: false, note: r.data.message, bad: true };
  if (r.reply !== "imported") return { ok: false };
  const lines = [s.previewNote(r.data.added, r.data.kept, r.data.gone)];
  if (r.data.skipped_total > 0) lines.push(s.skipped(r.data.skipped_total), ...r.data.skipped);
  return {
    ok: false,
    note: lines.join("\n"),
    bad: r.data.added === 0 && r.data.skipped_total > 0,
    confirm: { label: s.previewApply, run: apply },
  };
}

/** Остаток по подписке словами: сколько израсходовано и до какого числа.
 *
 *  Считает `quotaFacts`: ноль в поле значит «панель не прислала», и то же
 *  значение стоит у безлимитных с бессрочными, — про непришедшее молчим, а не
 *  пишем «0 B из 0 B». Понять нечего вовсе — не рисуем ничего.
 *
 *  У подписки без лимита (`total == 0`) число — это то, что израсходовано, и
 *  так оно и подписано. Голое «284 GB» читалось остатком — ровно наоборот:
 *  человек видел «осталось много» там, где лимита нет вовсе.
 *
 *  Срок — словами, а не числом суток: «до 12.03.2027» читается без
 *  вычитания в уме, «подписка кончилась» — без вычитания и вовсе. */
function quotaParts(s: Strings, f: QuotaFacts, lang: Lang | undefined): { amount: string | null; expiry: string | null } {
  return {
    amount:
      f.total > 0
        ? s.quotaOf(bytes(f.used), bytes(f.total))
        : f.used > 0
          ? s.quotaUsedNoLimit(bytes(f.used))
          : null,
    expiry:
      f.days == null
        ? null
        : f.expired
          ? s.quotaExpired
          : s.quotaUntil(new Date(f.expire * 1000).toLocaleDateString(lang ?? "ru")),
  };
}

/** Тревога двойная и по разным осям: осталось меньше десятой части лимита или
 *  меньше трёх суток до срока. Тон при этом `wait`, а не `fault`: это
 *  предупреждение, а не поломка, и красный тут обещал бы сработавшую защиту.
 *  Красный остаётся истёкшему сроку — он уже объясняет, почему узлы молчат. */
function quotaTone(f: QuotaFacts): string {
  return f.expired ? "text-fault" : f.low || (f.days != null && f.days < 3) ? "text-wait" : "text-muted";
}

/** Остаток одной строкой в заголовке группы — когда полосы подписок нет (одна
 *  подписка). С полосой остаток живёт в её ячейке, а заголовок остаётся
 *  именем, счётом и действиями. */
function Remaining({ s, quota, lang }: { s: Strings; quota: Subscription["quota"]; lang: Lang | undefined }) {
  const f = quotaFacts(quota);
  if (!f) return null;
  const { amount, expiry } = quotaParts(s, f, lang);
  const parts = [amount, expiry].filter((x): x is string => x != null);
  if (parts.length === 0) return null;
  return (
    <span title={s.quotaHint} className={`shrink-0 text-xs font-normal ${quotaTone(f)}`}>
      {parts.join(" · ")}
    </span>
  );
}

/** Деления «сколько узлов отвечает»: не больше восьми, закрашены живые — доля,
 *  а не счёт (счёт стоит числом рядом). Узлов в подписке бывает сотня, и сотня
 *  делений не читается. */
function Ticks({ alive, total }: { alive: number; total: number }) {
  const n = Math.min(total, 8);
  const lit = alive === 0 ? 0 : Math.max(1, Math.round((alive / total) * n));
  return (
    <span className="flex shrink-0 gap-0.5" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={`block h-2.5 w-1.5 rounded-sm ${i < lit ? "bg-open" : "bg-edge-strong"}`} />
      ))}
    </span>
  );
}

/** Правка подписки: подпись и адрес в небольшом окне поверх панели. Стояло полем
 *  на месте подписи, пока править можно было только имя; с адресом полю тесно
 *  (адрес длинный, и ошибку скачивания негде показать), а окно и заголовок
 *  группы, и карточка полосы открывают одинаково — из меню подписки.
 *
 *  Новый адрес служба качает первой и без общего замка; не скачался — ответ
 *  ошибкой и подписка прежняя, поэтому окно не закрывается, а показывает
 *  причину рядом с полем, которое править. */
function SubEdit({ s, sub, act, onDone }: { s: Strings; sub: Subscription; act: Act; onDone: () => void }) {
  const [name, setName] = useState(sub.name);
  const [url, setUrl] = useState(sub.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = name.trim() !== sub.name.trim() || url.trim() !== sub.url;
  return (
    <Modal title={s.editSubscription} onClose={onDone}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          // `local`: причину показывает строка под полем, общая рамка её не дублирует.
          void act({ cmd: "edit-subscription", arg: { url: sub.url, new_url: url.trim(), name: name.trim() } }, { local: true })
            .then((r) => (r?.reply === "error" ? setError(r.data.message) : r && onDone()))
            .finally(() => setBusy(false));
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          {s.subName}
          <input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={s.subName}
            spellCheck={false}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {s.subAddress}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            dir="ltr"
            className={`${FIELD} font-mono text-xs`}
          />
        </label>
        <span className={`text-xs ${error ? "text-fault" : "text-muted"}`}>{error ?? s.subAddressHint}</span>
        <div className="flex justify-end gap-2">
          <Button onClick={onDone}>{s.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !changed || !url.trim()}>
            {s.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Подтверждение удаления пачки: число в заголовке и то, что произойдёт кроме
 *  удаления самих строк. Окно, а не «спросить дважды» в меню: у пачки есть что
 *  прочесть (туннель погаснет, узлы подписок вернутся), а меню для текста мало. */
function ConfirmRemove({
  s,
  title,
  notes,
  onCancel,
  onConfirm,
}: {
  s: Strings;
  title: string;
  notes: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-muted">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{s.cancel}</Button>
        <Button variant="primary" onClick={onConfirm}>
          {s.remove}
        </Button>
      </div>
    </Modal>
  );
}

/** Куда деть клик по строке, когда выделение в игре. Ctrl/⌘ переключает строку,
 *  Shift берёт диапазон от последней нажатой, а пока что-то выделено, обычный
 *  клик тоже переключает: «включить узел» посреди выделения было бы промахом,
 *  который включает туннель. */
type Pick = (name: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => boolean;

/** Печатное ли место: набирать в нём — значит не командовать списком. */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

/** vmess-ссылка в base64 несёт имя внутри — это поле `ps` вложенного JSON, а
 *  фрагмент ей не добавишь (служба читает именно `ps`). Раскрываем, ставим имя,
 *  собираем обратно; не раскрылась — `null`, и ссылка уходит как есть. */
function vmessWithName(link: string, want: string): string | null {
  try {
    const blob = link.slice("vmess://".length).trim().replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    const obj: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out = new TextEncoder().encode(JSON.stringify({ ...obj, ps: want }));
    return `vmess://${btoa(Array.from(out, (b) => String.fromCharCode(b)).join(""))}`;
  } catch {
    return null;
  }
}

/** Узел подписки, переименованный для «Изменить как свой»: имя ведёт тот же
 *  разбор, что и импорт (фрагмент ссылки, `tag` в JSON, `ps` в base64-vmess). */
function withName(text: string, want: string, was: string): string {
  if (text.startsWith("{")) {
    if (want === was) return text;
    try {
      const obj: unknown = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj) && !("outbounds" in obj)) {
        return JSON.stringify({ ...obj, tag: want });
      }
    } catch {
      // Битый JSON уходит как есть: ошибку скажет служба своим разбором.
    }
    return text;
  }
  const head = text.split("#")[0];
  if (/^vmess:\/\/[^@]*$/i.test(head)) return vmessWithName(head, want) ?? text;
  return `${head}#${encodeURIComponent(want)}`;
}

/** Полоса подписок под панелью инструментов: ряд карточек-ячеек; много подписок —
 *  прокручивается вбок. Первая ячейка — «Все», дальше по ячейке на подписку:
 *  имя, сколько узлов отвечает, остаток и срок. Нажатие отбирает список до
 *  этой подписки (состояние окна, как и поиск); повторное — снимает.
 *
 *  Отобранная карточка — заголовок группы: самого заголовка под отбором нет
 *  (он повторил бы её имя строкой ниже), и её действия — обновить и «⋯» с тем
 *  же меню подписки — стоят в ней. Меню открывает и правая кнопка по любой
 *  карточке: отписаться иначе можно было только из заголовка, которого под
 *  отбором нет. Подписки переставляются перетаскиванием карточки — тем же
 *  порядком и той же командой, что за заголовок группы (`reorder` внутри
 *  `Profiles`): пока тащат, порядок живёт в окне, остальные карточки
 *  сдвигаются, перетаскиваемая тускнеет. «Все» не тащится и всегда первая.
 *
 *  Заводится только с двумя подписками и больше: у одной полосе нечем
 *  отличаться от заголовка группы под ней, и остаток тогда стоит в нём. */
function SubStrip({
  s,
  lang,
  groups,
  probeOf,
  filter,
  onPick,
  note,
  busy,
  onRefresh,
  onMenu,
  draggable,
  dragged,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  s: Strings;
  lang: Lang | undefined;
  groups: Group[];
  probeOf: ReadonlyMap<string, Probe>;
  filter: string | null;
  onPick: (url: string | null) => void;
  /** Что сказала бы шапка панели помимо счёта — в ячейке «Все», пока шапки нет. */
  note: ReactNode;
  busy: boolean;
  onRefresh: (sub: Subscription) => void;
  onMenu: (e: React.MouseEvent<HTMLElement>, sub: Subscription) => void;
  draggable: boolean;
  dragged: string | null;
  onDragStart: (url: string) => void;
  onDragOver: (url: string) => void;
  onDragEnd: () => void;
}) {
  const subs = groups.filter((g): g is Group & { sub: Subscription } => g.sub !== null);
  // Отобранная карточка несёт действия заголовка, и стоять за краем ряда ей
  // нельзя: подвозим её в видимую часть, как только отбор сменился.
  const ul = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ul.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [filter]);
  // «Все» — вся машина, включая свои узлы: ячейка про список целиком.
  const every = groups.flatMap((g) => g.all);
  const measured = (all: ProfileInfo[]) => all.some((p) => probeOf.has(p.name));
  // Ячейка — до трёх строк (~63 px с рамкой): имя с делениями «живых узлов»,
  // остаток с полоской, срок. Прежние 62 px вернулись не случайно: ниже ячейка
  // не читалась как ячейка, а выше стоила списку строку. Тонкая полоска остатка
  // — единственное место, где доля видна глазом, а не числом.
  const cell = (
    key: string,
    url: string | null,
    title: string,
    all: ProfileInfo[],
    quota: Subscription["quota"] | null,
    sub: Subscription | null,
  ) => {
    const selected = sub !== null && filter === url;
    const alive = aliveCount(all, probeOf);
    const f = quotaFacts(quota);
    const q = f && quotaParts(s, f, lang);
    const tail = q ? [q.amount, q.expiry].filter((x): x is string => x != null).join(" · ") : "";
    const tip = [
      url === null ? s.allSubs : `${s.subFilter}: ${title}`,
      measured(all) ? s.groupAlive(alive, all.length) : "",
      tail,
    ]
      .filter((x) => x !== "")
      .join("\n");
    const inner = (
      <>
          <span className={`flex min-w-0 items-center gap-2 ${selected ? "pe-14" : ""}`}>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
            {measured(all) && all.length > 0 && <Ticks alive={alive} total={all.length} />}
            <span
              className="shrink-0 font-mono text-xs font-normal tabular-nums text-muted"
              title={s.groupAlive(alive, all.length)}
            >
              {alive}/{all.length}
            </span>
          </span>
          {f && q?.amount && (
            <span className="flex min-w-0 items-center gap-2 text-xs">
              {f.total > 0 && (
                <span className="block h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-[var(--pg-sunken)]">
                  <span
                    className={`block h-full rounded-full ${f.low ? "bg-wait" : "bg-muted"}`}
                    style={{ inlineSize: `${Math.round(Math.min(1, Math.max(0, f.used / f.total)) * 100)}%` }}
                  />
                </span>
              )}
              <span className={`min-w-0 truncate ${f.total > 0 ? "shrink-0" : "flex-1"} ${quotaTone(f)}`}>
                {q.amount}
              </span>
            </span>
          )}
          {f && q?.expiry && <span className={`truncate text-xs ${quotaTone(f)}`}>{q.expiry}</span>}
          {url === null && <span className="fold-only truncate text-xs text-muted">{note}</span>}
      </>
    );
    return (
      <li
        key={key}
        // Тащат за всю карточку, «Все» — нет. Перетаскивание не кликает: отбор
        // от него не меняется.
        draggable={draggable && sub !== null}
        onDragStart={(e) => {
          if (sub === null) return;
          onDragStart(sub.url);
          e.dataTransfer.effectAllowed = "move";
          // Без полезной нагрузки Firefox не начинает перетаскивание вовсе.
          e.dataTransfer.setData("text/plain", sub.url);
        }}
        onDragOver={(e) => {
          if (sub === null || dragged === null || dragged === sub.url) return;
          // Без preventDefault браузер считает, что бросать сюда нельзя.
          e.preventDefault();
          onDragOver(sub.url);
        }}
        onDrop={(e) => e.preventDefault()}
        onDragEnd={onDragEnd}
        onContextMenu={(e) => sub !== null && onMenu(e, sub)}
        className={`relative flex min-w-0 ${selected ? "flex-[1_0_16rem]" : "flex-[1_0_13rem]"} ${
          sub !== null && dragged === sub.url ? "opacity-40" : ""
        }`}
      >
        <button
          type="button"
          aria-pressed={filter === url}
          title={tip}
          onClick={() => onPick(filter === url ? null : url)}
          className="sub-cell smooth flex w-full min-w-0 flex-col items-stretch justify-center px-4 py-1.5"
        >
          {inner}
        </button>
        {/* Отобранная карточка несёт действия заголовка, которого под отбором
            нет: обновить (та же команда, что у пункта меню) и «⋯» с меню
            подписки. Рядом с кнопкой-карточкой, а не внутри: вложенных кнопок
            не бывает. */}
        {selected && (
          <div className="absolute end-1 top-1 flex items-center">
            <IconButton
              icon="refresh"
              label={s.refresh}
              title={s.refreshSubscription(sub.url)}
              disabled={busy}
              className="size-6"
              onClick={() => onRefresh(sub)}
            />
            <IconButton
              icon="more"
              label={s.actions}
              aria-haspopup="menu"
              className="size-6"
              onClick={(e) => onMenu(e, sub)}
            />
          </div>
        )}
      </li>
    );
  };
  return (
    <ul ref={ul} className="sub-strip scroll flex shrink-0 overflow-x-auto" aria-label={s.subFilter}>
      {cell("", null, s.allSubs, every, null, null)}
      {subs.map((g) => cell(g.key, g.key, subTitle(g.sub), g.all, g.sub.quota, g.sub))}
    </ul>
  );
}

/** Со скольких профилей список перестаёт читаться глазом. Порог тот же, что у
 *  приложений: одна подписка приносит десятки узлов, а подписок бывает
 *  несколько. */
const SEARCH_FROM = 8;

/** С какой ширины панели панель инструментов стоит целиком: поиск, переключатель
 *  порядка, «Проверить все», «Быстрейший», «Добавить» и «⋯» в одну строку.
 *  Меньше — только поиск, «⋯» со всеми действиями и «+». Число — сумма самих
 *  кнопок с минимальным полем поиска, а не вкус: пересчитайте, добавляя кнопку. */
const ROOMY = 760;

/** Итог прогона рядом с именем: задержка либо причина отказа. Отказ приезжает
 *  строкой от службы, поэтому он уже на нужном языке — и виден целиком по
 *  наведению, а не только в обрезке. */
function Verdict({ probe, failed, measured }: { probe: Probe | undefined; failed: string; measured?: string }) {
  if (!probe) return null;
  if (probe.latency_ms != null)
    return (
      // Возраст — в подсказке, а не в строке: цифра из прошлой недели выглядит
      // как сегодняшняя, но занимать место в строке этому знанию незачем.
      <span className="shrink-0 tabular-nums" title={measured}>
        {probe.latency_ms} ms
      </span>
    );
  return (
    // Мёртвый профиль — поломка, которую чинит человек, а не запертый канал:
    // цвет тот же, что у «служба не отвечает».
    // Она же длиннее всего в строке и потому уступает место первой.
    // В строке — причина в два слова, если служба её разобрала («таймаут»,
    // «отказ TLS»): «не отвечает» у всех одинаково, а чинят их по-разному.
    // Полная строка остаётся подсказкой.
    <span className="min-w-0 truncate text-fault" title={probe.error ?? failed}>
      {probe.brief ?? failed}
    </span>
  );
}

/** Цвет полоски выбранной строки — тон туннеля, пока узел несёт трафик. */
const TONE = {
  up: { rail: "bg-open", word: "text-open" },
  connecting: { rail: "bg-wait", word: "text-wait" },
  down: { rail: "bg-closed", word: "text-closed" },
  // Выключено — и «профиль просто выбран» тоже: это не сигнал, цвета нет.
  off: { rail: "bg-accent", word: "text-muted" },
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
  // Клавиши панели. Обе смотрят, видна ли панель: в узком окне она одна из
  // трёх, и Ctrl+F в открытом списке приложений не должен уводить фокус в
  // невидимое поле. `offsetParent` у скрытого `display: none` — null.
  // Вставка — с чем открыли поле; поиск по Ctrl+F показывается и в коротком
  // списке, где кнопки поиска нет.
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const visible = () => bodyRef.current?.offsetParent != null && document.querySelector("dialog[open]") == null;
    const editable = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
    const onPaste = (e: ClipboardEvent) => {
      if (!visible() || editable(e.target)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text.trim()) return;
      e.preventDefault();
      setPasted(text);
      setAdding(true);
    };
    // По коду клавиши, а не по символу: на русской раскладке это «а».
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.code !== "KeyF" || !visible()) return;
      e.preventDefault();
      // Пока что-то выделено, поля поиска на экране нет — его место занимает
      // панель выделения, и фокусу было бы некуда идти. Поиск важнее выделения
      // (сам Ctrl+F — это «хочу искать»), поэтому выделение снимается.
      setSelected(new Set());
      setSearchOpen(true);
      // Два кадра: первый перерисовывает панель инструментов вместо панели
      // выделения, второй застаёт поле уже на месте.
      requestAnimationFrame(() => requestAnimationFrame(() => searchRef.current?.focus()));
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
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
  // Отбор по подписке с полосы под панелью инструментов. Состояние окна, как и
  // поиск: служба о нём не знает и не должна — это способ смотреть, а не
  // свойство списка. Читается через `filter` ниже, который сверяет его с
  // тем, что в списке сейчас есть.
  const [subFilter, setSubFilter] = useState<string | null>(null);
  // Какую подписку сейчас правят (окно имени и адреса). Адресом, а не флагом:
  // подписок несколько, и открытых окон должно быть не больше одного.
  const [editingSub, setEditingSub] = useState<string | null>(null);
  // Выделенные строки — состояние окна и только окна: служба о нём не знает, а
  // исчезнувшие профили выпадают отсюда сами (эффект ниже). Якорь — последняя
  // нажатая строка, от неё Shift берёт диапазон.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  // Удаление пачки ждёт подтверждения здесь, пока окно читают.
  const [confirm, setConfirm] = useState<{ title: string; notes: string[]; names: string[] } | null>(null);
  // Итог экспорта: «Скопировано N, пропущено M». Гаснет сам — это ответ на
  // нажатие, а не состояние списка.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice]);
  // Какой профиль правят и каким текстом. Узел приезжает отдельным запросом:
  // в статусе его нет намеренно — окно спрашивает статус каждые две секунды, а
  // подписка приносит сотни узлов с ключами и паролями внутри.
  // `own` — узел подписки правят «как свой»: сохранение заводит копию профилем.
  const [editing, setEditing] = useState<{ name: string; text: string; own?: boolean } | null>(null);
  // Правка и «скопировать ссылку» спрашивают одно и то же — узел целиком.
  const nodeOf = (name: string) =>
    act({ cmd: "profile-node", arg: { name } }).then((r) => (r?.reply === "profile-node" ? r.data : null));
  // В поле правки едет ссылка, если она у узла есть: сменить порт или пароль —
  // это правка одной строки, а тем же JSON человек до сих пор платил за неё
  // чтением всего узла. Ссылки нет — узел в неё не перекладывается без потерь,
  // и тогда JSON остаётся единственным честным видом.
  const openEditor = (name: string, own = false) =>
    void nodeOf(name).then((data) => data && setEditing({ name, text: data.link || data.json, own }));
  // Успех молчит: в буфере обмена лежит ссылка, и это и есть ответ. Говорить
  // приходится только об отказе — их два, и они про разное.
  const copyLink = (name: string) =>
    void nodeOf(name).then((data) => {
      if (!data) return;
      if (!data.link) return onError?.(s.noLink);
      return navigator.clipboard.writeText(data.link).catch(() => onError?.(s.copyFailed));
    });
  // Ссылка, которую показывают кодом. Держим саму строку, а не имя профиля:
  // узел за время показа могли переписать, а на экране обязано остаться то,
  // что человек в этот код и снял.
  const [qr, setQr] = useState<string | null>(null);
  const showQr = (name: string) =>
    void nodeOf(name).then((data) => {
      if (!data) return;
      if (!data.link) return onError?.(s.noLink);
      setQr(data.link);
    });
  // Тесно — по ширине самой панели, а не окна: выше 1100 px три панели стоят
  // рядом, и профилям достаётся 300–450 px при любом окне. В тесноте действия
  // списка уходят под «⋯»: панель инструментов обязана остаться одной
  // строкой, иначе её второй ряд съедает строки профилей.
  const width = useBoxWidth(bodyRef);
  const compact = width < ROOMY;
  // Совсем тесно (плашка в 380 px): из строки уходят и метка типа с полоской
  // задержки, остаются флаг, имя и число.
  const tight = width < 440;
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
  const searchable = profiles.length > SEARCH_FROM || query !== "" || searchOpen;
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
  const probeOf = new Map(probes.map((p) => [p.name, p] as const));
  const measured = probes.some((p) => p.latency_ms != null);
  // Порядок по задержке без единого замера — это «звёздочка и порядок панели»,
  // а переключателя, который его снял бы, нет: он показывается только при
  // замерах. Поэтому включённым он считается лишь пока есть что упорядочивать.
  const byLat = byLatency && measured;
  const testing = status?.testing ?? null;
  const latency = (name: string) => probeOf.get(name)?.latency_ms ?? Infinity;
  // Полоса подписок — только с двумя и больше; без неё отбирать не по чему, и
  // отбор, оставшийся от прошлого набора подписок, не должен прятать строки
  // молча.
  const stripped = subscriptions.length > 1;
  const filter = stripped && subscriptions.some((sub) => sub.url === subFilter) ? subFilter : null;
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
    if (byLat)
      return [...items].sort(
        (a, b) => Number(b.favorite) - Number(a.favorite) || latency(a.name) - latency(b.name),
      );
    return pending ? seated(items, (p) => p.name, pending) : items;
  };
  // Тащить можно, только когда порядок и вправду принадлежит человеку. По
  // задержке список переставляет число, и перенесённая строка уехала бы
  // обратно тем же кадром. Под поиском видна половина списка, и записанный
  // порядок из половины имён смёл бы вторую половину в хвост. Тем же — под
  // отбором полосы подписок: он прячет остальные группы целиком, и порядок,
  // собранный из одной группы, оставил бы чужие без места.
  //
  // Пока что-то выделено, строки не тащатся вовсе: нажатие и движение у
  // выделения значат своё, и перенос начинался бы от промаха.
  const draggable = !byLat && needle === "" && filter === null && selected.size === 0;
  // Подписки в полосе тащатся и под отбором: перенос карточки меняет только
  // порядок самих подписок (`pendingSubs`), а полоса показывает их все, —
  // порядка профилей он не трогает, и пустой список профилей служба понимает
  // как «не трогать». Под порядком по задержке и под поиском — нельзя, как и за
  // заголовок: там порядок расставляет не человек.
  const stripDraggable = !byLat && needle === "" && selected.size === 0;
  // Заведённое руками и пришедшее с панели — разные вещи, и в одном списке
  // десяток своих узлов тонет в сотне чужих. Деление считает `groupProfiles`,
  // тот же, что у плашки из трея: связь знает служба, окно её только
  // показывает. Подписки тоже переставляются, а своя группа остаётся первой:
  // она не подписка, и меняться местами ей не с кем.
  const subs = pendingSubs ? seated(subscriptions, (sub) => sub.url, pendingSubs) : subscriptions;
  const members = groupProfiles(profiles, subs);
  const groups = members.map((g) => ({
    ...g,
    // Отобранная подписка прячет остальные группы, и свои тоже.
    items: filter !== null && g.key !== filter ? [] : arrange(g.all.filter(match)),
  }));
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  // Видимые строки подряд, как на экране: по ним берётся диапазон Shift и
  // «выделить всё». Свёрнутая группа не видна, и выделять её вслепую нельзя.
  const visibleNames = groups.flatMap((g) =>
    filter === null && collapsed.includes(g.key) ? [] : g.items.map((i) => i.name),
  );
  // Выделение держится только на видимых строках. Профиль исчез (сверка,
  // удаление из другого места), строку спрятал поиск, отбор полосы подписок
  // или свёрнутая группа — она выпадает из выделения: пачка («Удалить»,
  // «Измерить», экспорт) обязана действовать на то, что человек видит, а не на
  // строки, которых на экране нет. Исчезнувший профиль — частный случай:
  // видимые строки берутся из текущего списка. Ключ — состав и порядок
  // видимых имён: пересчитывать на каждый статус, не поменявший список, нечего.
  const visibleKey = JSON.stringify(visibleNames);
  useEffect(() => {
    setSelected((was) => {
      if (was.size === 0) return was;
      const live = new Set<string>(JSON.parse(visibleKey) as string[]);
      const kept = [...was].filter((n) => live.has(n));
      return kept.length === was.size ? was : new Set(kept);
    });
  }, [visibleKey]);
  const toggleRow = (name: string) =>
    setSelected((was) => {
      const next = new Set(was);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const rangeTo = (name: string) => {
    const from = anchor.current === null ? -1 : visibleNames.indexOf(anchor.current);
    const to = visibleNames.indexOf(name);
    if (from < 0 || to < 0) return setSelected(new Set([name]));
    setSelected(new Set(visibleNames.slice(Math.min(from, to), Math.max(from, to) + 1)));
  };
  // Правда о том, что нажатие значило, живёт здесь одним местом: строка и
  // флажок в ней спрашивают его же.
  const pickRow: Pick = (name, e) => {
    const handled = e.shiftKey || e.ctrlKey || e.metaKey || selected.size > 0;
    if (e.shiftKey) rangeTo(name);
    else if (handled) toggleRow(name);
    if (!e.shiftKey) anchor.current = name;
    return handled;
  };
  // Клавиши выделения смотрят свежее состояние через ссылку: слушатель на окне
  // заводится один раз, а перевешивать его на каждое нажатие строки незачем.
  const latest = useRef({ visibleNames, count: selected.size });
  latest.current = { visibleNames, count: selected.size };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const body = bodyRef.current;
      if (body?.offsetParent == null || typing(e.target)) return;
      // Esc у открытого окна или меню закрывает их, а не выделение под ними.
      if (document.querySelector("dialog[open], [role=menu]") != null) return;
      if (e.key === "Escape" && latest.current.count > 0) {
        setSelected(new Set());
      } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyA" && body.contains(document.activeElement)) {
        e.preventDefault();
        setSelected(new Set(latest.current.visibleNames));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Перенос внутри группы — это новый порядок всего списка: службе он уезжает
  // одной строкой имён, а группы в ней лежат подряд, поэтому чужие остаются
  // как есть.
  const reorder = (key: string, names: string[]) =>
    setPending(groups.flatMap((g) => (g.key === key ? names : g.items.map((i) => i.name))));
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
  // Самый быстрый из измеренных и всё ещё живущих в списке — выбор один на
  // окно и плашку (`fastestProbe`).
  const fastest = fastestProbe(probes, profiles);
  // Обновление подписки — тот же импорт: служба сама узнаёт адрес и заменяет
  // пришедшие с него профили. Одна функция на кнопку в заголовке группы и
  // пункт меню: два места, где написано одно и то же, разошлись бы молча.
  const refreshSub = (sub: Subscription) => void act({ cmd: "add-profile", arg: { link: sub.url } });
  // Экспорт: ссылки собирает служба (только сверенные), в буфер их кладёт окно.
  // Ссылки везут пароли и ключи, поэтому окно нигде их не хранит — они лежат в
  // буфере обмена и больше нигде.
  const exportLinks = async (names: string[]) => {
    const r = await act({ cmd: "export-links", arg: { names } });
    if (r?.reply !== "links") return;
    try {
      if (r.data.links.length > 0) await navigator.clipboard.writeText(r.data.links.join("\n"));
      setNotice(s.exported(r.data.links.length, r.data.skipped));
    } catch {
      onError?.(s.copyFailed);
    }
  };
  // Мёртвый — измеренный и не ответивший: задержки нет, а причина отказа есть.
  // Неизмеренный мёртвым не считается никогда — «не проверяли» не значит «не
  // работает».
  const deadOf = (names: string[]) =>
    names.filter((n) => {
      const p = probeOf.get(n);
      return p != null && p.latency_ms == null && (p.error != null || p.brief != null);
    });
  // Всё, что стоит сказать перед удалением пачки: туннель погаснет, окно
  // браузера закроется, узлы подписок вернутся со сверкой.
  // Одиночное удаление спрашивает, только когда есть что прочесть. Пачка из
  // двух и больше спрашивает всегда, с числом в заголовке: вернуть её вставкой
  // за секунду нельзя, а промах по Shift-диапазону стоит десятка строк.
  // «Нерабочие» спрашивают всегда (`always`) по той же причине: число заранее
  // никто не знает, и удалять его вслепую нельзя.
  const askRemove = (names: string[], title: (n: number) => string, always = false) => {
    const fromSubs = new Set(members.filter((g) => g.sub !== null).flatMap((g) => g.all.map((p) => p.name)));
    const notes: string[] = [];
    if (status?.profile != null && names.includes(status.profile)) notes.push(s.confirmActiveNote);
    if (status?.browser_profiles.some((b) => names.includes(b.node) && status.browsers.includes(b.name)))
      notes.push(s.confirmBrowserNote);
    if (names.some((n) => fromSubs.has(n))) notes.push(s.confirmSubNote);
    if (notes.length === 0 && !always && names.length < 2) return removeProfiles(names);
    setConfirm({ title: title(names.length), notes, names });
  };
  function removeProfiles(names: string[]) {
    setConfirm(null);
    setSelected(new Set());
    void act({ cmd: "remove-profiles", arg: { names } });
  }
  // Удалить нерабочие: из выделенного, а без выделения — из всех профилей.
  const askRemoveDead = (scope: string[]) => {
    const names = deadOf(scope);
    if (names.length > 0) askRemove(names, s.removeDeadTitle, true);
  };
  const deadScope = selected.size > 0 ? [...selected] : profiles.map((p) => p.name);
  const removeDead: MenuItem = {
    label: s.removeDead,
    hint: s.removeDeadHint,
    // Пока идёт прогон, цифры ещё меняются; а пока ничего не измерено, удалять
    // нечего по определению.
    disabled: busy || testing != null || deadOf(deadScope).length === 0,
    danger: true,
    onPick: () => askRemoveDead(deadScope),
  };
  // Действия подписки — тем же меню, что и у профиля: у неё их три, и три
  // значка в заголовке группы съедали ту самую ширину, в которой не помещался
  // адрес. Обновление при этом стоит и значком — оно нужно чаще остальных.
  const subMenu = (sub: Subscription): MenuItem[] => [
    {
      label: s.refresh,
      hint: s.refreshSubscription(sub.url),
      onPick: () => refreshSub(sub),
    },
    { label: s.editSubscription, onPick: () => setEditingSub(sub.url) },
    {
      label: s.exportLinks,
      hint: s.exportLinksHint,
      disabled: sub.nodes.length === 0,
      onPick: () => void exportLinks(sub.nodes),
    },
    {
      label: s.unsubscribe,
      hint: s.removeSubscription(sub.url),
      danger: true,
      // Удаление подписки уносит с собой десятки профилей разом — по одному
      // клику мимо такое случаться не должно.
      ask: s.confirmRemove,
      onPick: () => void act({ cmd: "remove-subscription", arg: { url: sub.url } }),
    },
  ];
  // Строки группы — одни и те же с заголовком и без него (под отбором одной
  // подпиской заголовка нет).
  const rowsOf = (sub: Subscription | null, items: ProfileInfo[]) => (
    <Rows
      items={items}
      status={status}
      act={act}
      s={s}
      busy={busy}
      editing={editing}
      onEdit={openEditor}
      onCopy={copyLink}
      onQr={showQr}
      onDone={() => setEditing(null)}
      onMenu={openMenu}
      onReorder={draggable ? (names) => reorder(sub?.url ?? "", names) : undefined}
      onCommit={commit}
      fromSub={sub !== null}
      probeOf={probeOf}
      tight={tight}
      selected={selected}
      onPickRow={pickRow}
    />
  );
  // Действия списка. В широкой панели инструментов они кнопки: «Проверить все»
  // и «Быстрейший» — на виду, «Обновить все» — под «⋯» в конце, порядок — свой
  // переключатель. В тесной панели (плашка в 380 px, одна из трёх панелей)
  // они не встают в строку и разворачивали бы её во второй ряд, а это 40 px —
  // почти строка профиля, ради которой список и открывают: там все они уходят
  // под один «⋯».
  //
  // Каждое действие описано один раз, а раскладка выбирает, кнопкой оно или
  // пунктом: одно и то же, написанное дважды, разъезжается на первой же правке —
  // и разъехалось бы молча.
  const toggleOrder: MenuItem = {
    // Включённый порядок по задержке снимается тем же пунктом, и он об этом
    // говорит прямо: «сбросить» вместо «по задержке». В широком виде то же
    // самое делает переключатель «Мой порядок | По задержке».
    label: byLat ? s.byLatencyOff : s.byLatency,
    hint: s.byLatencyHint,
    mark: byLat,
    onPick: () => setByLatency(!byLat),
  };
  const turnFastest: MenuItem | null =
    fastest && status?.profile !== fastest.name
      ? {
          label: s.fastest,
          hint: s.fastestHint,
          disabled: busy,
          onPick: () => void act({ cmd: "on", arg: { profile: fastest.name } }),
        }
      : null;
  const refreshAll: MenuItem | null =
    subscriptions.length > 1
      ? {
          label: s.refreshAll,
          hint: s.refreshAllHint,
          disabled: busy,
          // По одной, а не залпом: каждая — поход в сеть до двадцати секунд,
          // и пять параллельных закачек под общим замком службы означали бы
          // окно без статуса всё это время.
          onPick: () =>
            void (async () => {
              for (const sub of subscriptions) {
                await act({ cmd: "add-profile", arg: { link: sub.url } });
              }
            })(),
        }
      : null;
  const testAll: MenuItem | null =
    profiles.length > 0
      ? {
          // Пока прогон идёт, пункт заперт: второй прогон добил бы sing-box
          // первого — они делят каталог проверки. Счёт пройденного стоит на
          // самой подписи: узел стоит секунд, и на сотне это минуты, за
          // которые панель обязана отличаться от зависшей.
          label: testing ? s.testingProgress(testing.done, testing.total) : busy ? s.testing : s.testProfiles,
          hint: s.testProfilesHint,
          disabled: busy,
          onPick: () => void act({ cmd: "test-profiles", arg: { only: null } }),
        }
      : null;
  const exportAll: MenuItem | null =
    profiles.length > 0
      ? {
          label: s.exportLinks,
          hint: s.exportLinksHint,
          onPick: () => void exportLinks(profiles.map((p) => p.name)),
        }
      : null;
  // «Удалить нерабочие» стоит, только когда есть что мерить.
  const deadItem: MenuItem | null = profiles.length > 0 ? removeDead : null;
  const present = <T,>(...items: (T | null | false)[]): T[] => items.filter((x): x is T => !!x);
  // Всё разом — для тесной раскладки.
  const tools = present<MenuItem>(measured && toggleOrder, turnFastest, refreshAll, testAll, exportAll, deadItem);
  // Хвост широкой: то, чему в строке кнопки не нашлось.
  const overflow = present<MenuItem>(refreshAll, exportAll, deadItem);
  // Счёт и возраст списка. Живут в шапке панели (она ≥1100 px) и, пока шапки
  // нет (`folds`), в панели инструментов: в ячейке «Все» полосы подписок, а без
  // полосы — на месте распорки. Один узел, а не две копии текста: разойдясь,
  // они показывали бы разное в двух состояниях окна.
  const note =
    profiles.length > 0 ? (
      <span className="text-muted">
        {profiles.length}
        {query !== "" && ` · ${s.appsShown(shown)}`}
        {/* Возраст списка, а не адреса: узлы в подписке меняет панель, и по
            одному адресу не видно, пришли они час назад или лежат тут с
            прошлого месяца. Отметка одна на все подписки — сверяются они
            вместе, и повторять её над каждой было бы шумом. */}
        {grouped && ` · ${syncedAgo(s, status?.refreshed_at ?? null)}`}
      </span>
    ) : null;
  return (
    <Panel
      className={className}
      title={s.profiles}
      folds="narrow"
      note={note}
      bar={
        <>
          {/* Панель инструментов стоит вне прокрутки: поиск и «Добавить» нужны
              на любой глубине списка, а липкому заголовку группы она не
              мешает — он липнет к кромке самой прокрутки, которая начинается
              под ней. Высота — 41 px: поле в 32 и по 4 сверху и снизу. */}
          {selected.size > 0 ? (
            // Пока что-то выделено, панель инструментов уступает место панели
            // выделения: поиск и «Добавить» в это время не нужны, а те же 41 px
            // высоты держат список там, где он был.
            <div
              className="flex h-[41px] shrink-0 items-center gap-2 border-b border-edge ps-4 pe-1"
              role="group"
              aria-label={s.selectedCount(selected.size)}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-semibold" aria-live="polite">
                {s.selectedCount(selected.size)}
              </span>
              {!compact && (
                <Button
                  disabled={busy}
                  onClick={() => void act({ cmd: "test-profiles", arg: { only: [...selected] } })}
                >
                  {s.testOne}
                </Button>
              )}
              {!compact && (
                <Button onClick={() => void exportLinks([...selected])}>{s.exportShort}</Button>
              )}
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => askRemove([...selected], s.removeMany)}
              >
                {s.remove}
              </Button>
              <IconButton
                icon="more"
                label={s.actions}
                aria-haspopup="menu"
                onClick={(e) =>
                  openMenu(
                    e,
                    present<MenuItem>(
                      compact && {
                        label: s.testOne,
                        disabled: busy,
                        onPick: () => void act({ cmd: "test-profiles", arg: { only: [...selected] } }),
                      },
                      compact && { label: s.exportShort, onPick: () => void exportLinks([...selected]) },
                      removeDead,
                    ),
                  )
                }
              />
              <IconButton icon="close" label={s.clearSelection} onClick={() => setSelected(new Set())} />
            </div>
          ) : (
          <div className="flex h-[41px] shrink-0 items-center gap-2 border-b border-edge pe-1">
            {searchable && (
              <div className={compact ? "min-w-0 flex-[1_0_8rem]" : "min-w-32 flex-[1_1_18rem]"}>
                <SearchField flush inputRef={searchRef} value={query} onChange={setQuery} placeholder={s.searchProfiles} />
              </div>
            )}
            {/* Вид списка — переключатель, а не кнопка «сбросить»: оба порядка
                названы, и видно, какой включён. Только когда есть что
                упорядочивать: без замеров он не сделал бы ничего. В тесном виде
                тот же выбор — пункт меню. */}
            {!compact && measured && (
              <Segmented
                label={s.viewOrder}
                options={[
                  ["mine", s.viewMine],
                  ["latency", s.byLatency, s.byLatencyHint],
                ]}
                value={byLat ? "latency" : "mine"}
                onPick={(v) => setByLatency(v === "latency")}
              />
            )}
            {/* Распорка несёт счёт, когда шапки нет, а полосы подписок (где он
                стоит в ячейке «Все») тоже нет; места ему нет — обрезается.
                В тесной раскладке с полем поиска распорка раньше пропадала
                вовсе, и счёт с «сверено» исчезали вместе с ней: теперь она
                остаётся мелким бледным текстом справа от поля, а поле держит
                своё минимальное место (`flex-[1_0_8rem]` выше) и обрезает не
                себя, а подпись. */}
            {(!compact || !searchable || !stripped) && (
              <span className={`min-w-0 truncate text-xs ${compact && searchable ? "shrink" : "flex-1"}`}>
                {!stripped && <span className="fold-only">{note}</span>}
              </span>
            )}
            {compact ? (
              tools.length > 0 && (
                <IconButton
                  icon="more"
                  label={s.actions}
                  aria-haspopup="menu"
                  onClick={(e) => openMenu(e, tools)}
                />
              )
            ) : (
              <>
                {testAll && (
                  <Button disabled={testAll.disabled} title={testAll.hint} onClick={testAll.onPick}>
                    {testAll.label}
                  </Button>
                )}
                {turnFastest && (
                  <Button disabled={turnFastest.disabled} title={turnFastest.hint} onClick={turnFastest.onPick}>
                    {/* Молния — акцентом, как у той же строки в плашке: это
                        единственное действие ряда, которое сразу включает узел,
                        и его ищут взглядом, а не читают подпись. */}
                    <Icon name="bolt" size={14} className="text-accent" />
                    {s.fastestShort}
                  </Button>
                )}
                {overflow.length > 0 && (
                  <IconButton
                    icon="more"
                    label={s.actions}
                    aria-haspopup="menu"
                    onClick={(e) => openMenu(e, overflow)}
                  />
                )}
              </>
            )}
            {/* «Добавить» остаётся кнопкой в любой ширине и не уезжает в меню:
                пустой список заводят только им, и прятать единственную дверь
                под «⋯» значило бы не показать её тому, кому она и нужна. */}
            {compact ? (
              <IconButton
                icon="plus"
                variant="primary"
                aria-haspopup="dialog"
                label={s.importLink}
                title={s.linkPlaceholder}
                onClick={() => setAdding(true)}
              />
            ) : (
              <Button variant="primary" aria-haspopup="dialog" title={s.linkPlaceholder} onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                {s.addProfile}
              </Button>
            )}
          </div>
          )}
          {notice !== null && (
            <div role="status" className="shrink-0 border-b border-edge px-3 py-1 text-xs text-muted">
              {notice}
            </div>
          )}
          {stripped && (
            <SubStrip
              s={s}
              lang={status?.lang}
              groups={members}
              probeOf={probeOf}
              filter={filter}
              onPick={setSubFilter}
              // Счёт у ячейки «Все» уже есть (8/11), поэтому ей — только то, чего
              // в ней нет: отбор поиском и возраст списка.
              note={[query !== "" ? s.appsShown(shown) : "", syncedAgo(s, status?.refreshed_at ?? null)]
                .filter((x) => x !== "")
                .join(" · ")}
              busy={busy ?? false}
              onRefresh={refreshSub}
              onMenu={(e, sub) => openMenu(e, subMenu(sub))}
              draggable={stripDraggable}
              dragged={dragged}
              onDragStart={setDragged}
              onDragOver={(url) => dragged !== null && setPendingSubs(moved(subs.map((x) => x.url), dragged, url))}
              onDragEnd={() => {
                setDragged(null);
                commit();
              }}
            />
          )}
        </>
      }
    >
      {/* Группы стоят вплотную: разводит их не пустота между ними, а полоса
          заголовка (`.sub-head`). Пока разводила пустота, её приходилось
          держать в 12 px — и три подписки стоили целой строки профиля.

          Отступа у прокрутки нет вовсе (`pad` панели пуст), и это не экономия
          места: липкий заголовок липнет не к кромке прокрутки, а к её полю за
          вычетом отступа — с ним в полоске сверху были видны строки, уезжающие
          под заголовок, то есть липкое не закрывало собой ровно то, ради чего
          оно и липкое. Список поэтому идёт во всю ширину плиты, а поле поиска
          и пустые состояния просят отступ сами. */}
      <div ref={bodyRef} className="flex flex-col">
        {adding && (
          <Modal
            title={s.importLink}
            onClose={() => {
              setAdding(false);
              setPasted("");
            }}
          >
            {/* Окно не закрывается на удачный импорт: ответом приезжает счёт
                («заведено 12, пропущено 38»), и закрыть его вместе с окном
                значило бы снова не сказать, куда делись остальные. */}
            <AddField
              placeholder={s.linkPlaceholder}
              label={s.importLink}
              busyLabel={s.importing}
              fileLabel={s.fromFile}
              hint={(value) => sniff(s, value)}
              initial={pasted}
              onSubmit={(link) => {
                const apply = () => act({ cmd: "add-profile", arg: { link } }).then((r) => imported(s, r));
                // Подписка — сперва счёт без замены, потом «Применить»;
                // ссылки — сразу, у них нечему пропадать.
                if (!hasSubscription(link)) return apply();
                return act({ cmd: "preview", arg: { link } }).then((r) => previewed(s, r, apply));
              }}
            />
          </Modal>
        )}
        {!grouped && profiles.length === 0 ? (
          // Пустому списку нужна не подпись, а дверь: поле импорта больше не
          // открыто само, и «+» в шапке — единственное, чем этот список
          // заводят.
          <div className="flex flex-col items-center gap-2 p-3">
            <Empty>{s.noProfiles}</Empty>
            <Button variant="primary" onClick={() => setAdding(true)}>
              {s.importLink}
            </Button>
          </div>
        ) : shown === 0 && needle !== "" ? (
          <div className="p-3">
            <Empty>{s.noMatches}</Empty>
          </div>
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
            onQr={showQr}
            onDone={() => setEditing(null)}
            onMenu={openMenu}
            onReorder={draggable ? (names) => reorder("", names) : undefined}
            onCommit={commit}
            probeOf={probeOf}
            tight={tight}
            selected={selected}
            onPickRow={pickRow}
          />
        ) : (
          // Подписка показывается даже пустой: она могла не отдать ни одного
          // понятного нам узла, а отписаться больше неоткуда. Прячет группу
          // только поиск, а отобранная полосой подписка прячет остальные.
          groups.map(
            ({ sub, items }) =>
              (filter === null || sub?.url === filter) &&
              (items.length > 0 || (sub !== null && needle === "")) &&
              (filter !== null ? (
                // Список отобран одной подпиской: её карточка в полосе и есть
                // заголовок — с обновлением, «⋯» и правкой имени, — а второй
                // заголовок с тем же именем строкой ниже только повторил бы её.
                // Здесь заголовка нет вовсе; он живёт в ветке без отбора.
                // Сторож — `a_selected_subscription_has_no_second_header`.
                <div key={sub?.url ?? ""}>{rowsOf(sub, items)}</div>
              ) : (
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
                    className={`sub-head flex h-9 cursor-pointer list-none items-center gap-2 ps-4 pe-2 text-sm font-semibold [&::-webkit-details-marker]:hidden ${
                      dragged === sub?.url ? "opacity-40" : ""
                    }`}
                  >
                    {/* .smooth возит только цвет — повороту нужен свой переход, и он же
                        обязан замирать при prefers-reduced-motion. */}
                    <Icon
                      name="chevron"
                      size={12}
                      className="text-muted motion-safe:transition group-open/sub:rotate-90 rtl:-scale-x-100"
                    />
                    {sub === null ? (
                      <span className="min-w-0 flex-1 truncate">{s.ownProfiles}</span>
                    ) : (
                      // `https://` съедает начало строки, а обрезается как раз
                      // хвост — то единственное, чем адреса и различаются.
                      // `http://` при этом остаётся на виду: схема — единственное,
                      // чем подписка по открытому каналу отличается от остальных,
                      // и спрятать её значило бы спрятать это. Имя, если его
                      // дали, читается вместо адреса; полный адрес остаётся по
                      // наведению в обоих случаях.
                      <span
                        className={`selectable min-w-0 flex-1 truncate ${sub.name ? "" : "font-normal"}`}
                        title={sub.url}
                      >
                        {subTitle(sub)}
                      </span>
                    )}
                    {/* Остаток в заголовке — только когда полосы подписок нет
                        (подписка одна): с полосой он стоит в её ячейке, вместе
                        со сроком и долей узлов. Стоит `shrink-0`, а
                        обрезается имя с адресом: остаток короткий и постоянной
                        длины, а схема с хвостом адреса — длинная. Живёт он в
                        <summary>, а не под ним: в свёрнутом виде это единственное
                        место, где его вообще видно, а свёрнуты подписки как раз
                        чаще всего. */}
                    {!stripped && sub?.quota && (
                      <Remaining s={s} quota={sub.quota} lang={status?.lang} />
                    )}
                    <span className="shrink-0 text-xs font-normal text-muted">{items.length}</span>
                    {sub !== null && (
                      <>
                        {/* Обновление — значком: оно нужно чаще остального меню, а
                            идти за ним под «⋯» ради одной подписки — три нажатия.
                            Та же команда, что и у пункта меню (`refreshSub`).
                            Нажатие по значку внутри <summary> не должно
                            сворачивать группу. */}
                        <IconButton
                          icon="refresh"
                          label={s.refresh}
                          title={s.refreshSubscription(sub.url)}
                          disabled={busy}
                          className="size-7"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            refreshSub(sub);
                          }}
                        />
                        <IconButton
                          icon="more"
                          label={s.actions}
                          aria-haspopup="menu"
                          className="-me-1 size-7"
                          onClick={(e) => openMenu(e, subMenu(sub))}
                        />
                      </>
                    )}
                  </summary>
                  {rowsOf(sub, items)}
                </details>
              )),
          )
        )}
      </div>
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {editingSub !== null && subscriptions.some((sub) => sub.url === editingSub) && (
        <SubEdit
          s={s}
          sub={subscriptions.find((sub) => sub.url === editingSub) as Subscription}
          act={act}
          onDone={() => setEditingSub(null)}
        />
      )}
      {confirm && (
        <ConfirmRemove
          s={s}
          title={confirm.title}
          notes={confirm.notes}
          onCancel={() => setConfirm(null)}
          onConfirm={() => removeProfiles(confirm.names)}
        />
      )}
      {qr != null && (
        <Modal title={s.showQr} onClose={() => setQr(null)}>
          <div className="flex flex-col items-center gap-2">
            <Qr link={qr} />
            {/* Сама ссылка под кодом: код снимают телефоном, а глазами сверяют,
                что сняли тот узел. Выделяется и копируется как всякий текст. */}
            <p className="selectable w-full break-all text-center font-mono text-xs text-muted">
              {qr}
            </p>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

/** Ссылка узла кодом: перенести узел на телефон, не гоняя его через буфер и
 *  чужой мессенджер.
 *
 *  Рисуем сами по `isDark`, а не вставляем готовую разметку из библиотеки:
 *  вставка строкой — это `dangerouslySetInnerHTML` ради того, что собирается
 *  здесь же из чисел. Модули едут одним `path`, а не тысячей `rect`: у длинной
 *  ссылки их под четыре тысячи, и каждый был бы отдельным узлом дерева.
 *
 *  Код всегда тёмный на белом, в любой теме окна: инвертированный QR читают не
 *  все сканеры, а живёт эта картинка ровно до того мгновения, как её сняли.
 *
 *  Уровень коррекции M — тот же, что у панелей: L мельче, но на экране, с
 *  которого снимают в упор, разница только в устойчивости. */
function Qr({ link }: { link: string }) {
  const code = qrcode(0, "M");
  code.addData(link);
  code.make();
  const size = code.getModuleCount();
  let d = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (code.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  return (
    <svg
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      // Поле вокруг кода — часть самого кода: без тихой зоны сканер его не
      // находит. Потому и рисуется белым прямоугольником по всему viewBox.
      shapeRendering="crispEdges"
      role="img"
      aria-label={link}
      className="w-full max-w-[280px] rounded-md"
    >
      <rect x={-2} y={-2} width={size + 4} height={size + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
/** Форма правки: имя и узел. Узел уходит службе тем же текстом, что принимает
 *  импорт, и разбирает его тот же разбор — второму парсеру взяться неоткуда.
 *
 *  Приезжает сюда ссылка, когда узел в неё перекладывается без потерь, и JSON,
 *  когда нет (`core_config::share_link`). Ссылку показываем полями (`Fields`) —
 *  сменить порт или sni значит поправить поле, а не вычитать строку; JSON
 *  остаётся строкой, полей у него нет. Переключатель между видами стоит только
 *  там, где есть оба.
 *
 *  Ошибка живёт здесь же, а не в общей рамке наверху окна: правят узел руками,
 *  и «в узле нет поля type» надо читать, не отводя глаз от самого узла. */
function Editor({
  s,
  name,
  text,
  act,
  onDone,
  own = false,
}: {
  s: Strings;
  name: string;
  text: string;
  act: Act;
  onDone: () => void;
  /** Узел подписки правят «как свой»: сохранение идёт обычным импортом и
   *  заводит новый профиль с этим именем. Не изменили — служба откажет
   *  (тот же узел вторым профилем не заводится), и окно говорит об этом
   *  словами, а не молчит. */
  own?: boolean;
}) {
  const [want, setWant] = useState(name);
  const [node, setNode] = useState(text);
  // Узел по частям — то, чем правят поля. Держится здесь, а не считается из
  // строки на каждый кадр: стёртый на секунду адрес делает строку неразбираемой,
  // и форма исчезала бы из-под рук ровно тогда, когда поле начинают перебивать.
  const [p, setP] = useState<Parts | null>(() => linkParts(text));
  const [fields, setFields] = useState(p != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 rounded-md bg-surface-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        if (own) {
          // `local`: отказ (в том числе «узел уже есть») читают в форме, а не в рамке наверху.
          void act({ cmd: "add-profile", arg: { link: withName(node.trim(), want.trim(), name) } }, { local: true })
            .then((r) => {
              if (r?.reply === "error") return setError(r.data.message);
              if (r?.reply !== "imported") return;
              // Ничего нового при «уже есть» — это отказ дедупликации, а не
              // успех: закрыть форму молча значило бы сделать вид, что копия
              // появилась.
              if (r.data.added === 0) return setError(r.data.kept > 0 ? s.nodeExists : (r.data.skipped[0] ?? s.nodeExists));
              onDone();
            })
            .finally(() => setBusy(false));
          return;
        }
        void act(
          {
            cmd: "edit-profile",
            // Нетронутый узел не отправляем вовсе: разбор вернул бы тот же самый,
            // но лишний повод перезапустить туннель на активном профиле здесь ни
            // к чему.
            arg: { name, rename: want.trim(), node: node.trim() === text.trim() ? "" : node.trim() },
          },
          { local: true },
        )
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
      {/* Развилка показывается только тогда, когда есть что показывать: у JSON
          полей нет, и переключатель с одним рабочим положением — это кнопка,
          которая ничего не делает. */}
      {(p != null || linkParts(node) != null) && (
        <Segmented
          className="self-start"
          options={[
            ["fields", s.nodeFields],
            ["text", s.nodeText],
          ]}
          value={fields ? "fields" : "text"}
          onPick={(v) => {
            if (v === "text") return setFields(false);
            // Вернулись к полям после правки строкой — поля обязаны показать
            // то, что в строке сейчас, а не то, с чем форму открывали.
            const next = linkParts(node);
            if (next) {
              setP(next);
              setFields(true);
            }
          }}
          label={s.editNode}
        />
      )}
      {fields && p ? (
        <Fields
          s={s}
          value={p}
          onChange={(next) => {
            setP(next);
            setNode(assemble(next));
          }}
        />
      ) : (
        <textarea
          value={node}
          // Ссылка — одна строка, но длинная: в один ряд она переносом уезжает
          // за край поля, и правят её вслепую. Три ряда её показывают целиком,
          // а JSON и без того длиннее.
          rows={Math.min(14, Math.max(3, node.split("\n").length))}
          onChange={(e) => setNode(e.target.value)}
          aria-label={s.editNode}
          spellCheck={false}
          className={`${FIELD.replace("h-8", "h-auto")} resize-none py-[5px] font-mono text-xs`}
        />
      )}
      <span className={`text-xs ${error ? "text-fault" : "text-muted"}`}>
        {error ?? (own ? s.editAsOwnHint : s.editNodeHint)}
      </span>
    </form>
  );
}

/** Ссылка по частям — ровно теми, из которых её собирает служба:
 *  `схема://секрет@адрес:порт?параметры#имя`.
 *
 *  Разбирает и собирает родной `URL`: второго разбора ссылок в окне не
 *  заводится, а этот в браузере уже есть. Ошибётся человек в поле — скажет
 *  служба своим разбором, тем же, что читает импорт; окно тут не судья. */
type Parts = {
  scheme: string;
  user: string;
  password: string;
  host: string;
  port: string;
  params: [string, string][];
  /** Имя узла из ссылки. Правку имени ведёт поле выше и отдельным полем
   *  команды, поэтому фрагмент здесь только переносится как есть. */
  hash: string;
};

function linkParts(link: string): Parts | null {
  try {
    const url = new URL(link.trim());
    return {
      scheme: url.protocol.replace(":", ""),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: url.port,
      params: [...url.searchParams],
      hash: url.hash.replace("#", ""),
    };
  } catch {
    // Не ссылка (JSON узла, недописанная строка) — полей у неё нет.
    return null;
  }
}

function assemble(p: Parts): string {
  const secret = [p.user, p.password].filter((v) => v !== "").map(encodeURIComponent).join(":");
  const query = p.params
    .filter(([key]) => key !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const port = p.port === "" ? "" : `:${p.port}`;
  const at = secret === "" ? "" : "@";
  return `${p.scheme}://${secret}${at}${p.host}${port}${query === "" ? "" : `?${query}`}#${p.hash}`;
}

/** Как зовут секрет в userinfo. Это подпись, а не схема полей: сама пара в
 *  ссылке у всех устроена одинаково, и форма о протоколах ничего не знает —
 *  иначе это были бы те же десять форм, от которых мы и уходили. Незнакомая
 *  схема получает две безымянные половины и правится так же. */
const SECRET: Record<string, [string, string?]> = {
  vless: ["uuid"],
  vmess: ["uuid"],
  trojan: ["password"],
  hy2: ["password"],
  hysteria2: ["password"],
  ss: ["method", "password"],
  tuic: ["uuid", "password"],
  wg: ["private-key"],
  wireguard: ["private-key"],
  socks5: ["username", "password"],
  http: ["username", "password"],
  https: ["username", "password"],
};

/** Узел по полям — по тем самым, из которых состоит его ссылка.
 *
 *  Форм по протоколам (как у NekoBox) тут нет и не будет: это десяток схем,
 *  расходящихся с sing-box на каждой его версии, и каждая молча теряет поле,
 *  которого не знает. Здесь поля берутся из самой ссылки, поэтому форма знает
 *  ровно то же, что и она, — включая параметры, о которых мы никогда не
 *  слышали: они просто строки внизу списка.
 *
 *  Подписи параметров не переводятся: `sni`, `alpn`, `pbk` — словарь самих
 *  панелей, и по нему же карточку узла сверяют с формой. Секрет подписан тем
 *  же словарём (`SECRET`).
 *
 *  Ссылка пересобирается на каждую правку, но только на правку: открытая и
 *  закрытая форма оставляет текст нетронутым — иначе пересборка, отличающаяся
 *  от исходной одним знаком кодирования, выдавала бы себя за правку узла и
 *  зря перезапускала живой туннель.
 *
 *  Что пересборка возвращает ровно ту же строку, проверено на десяти ссылках,
 *  которые отдаёт `share_link`, — по одной на протокол, плюс IPv6, reality,
 *  ранние данные ws и `alpn` из двух значений: все десять пережили разбор и
 *  сборку без единого знака разницы. Своего прогона у окна для этого нет, а
 *  вторая копия этих же функций в тесте разъехалась бы с первой молча. */
function Fields({ s, value: p, onChange }: { s: Strings; value: Parts; onChange: (next: Parts) => void }) {
  const edit = (change: Partial<Parts>) => onChange({ ...p, ...change });
  const [user, password] = SECRET[p.scheme] ?? ["", ""];
  // Пустая строка в хвосте — она же и «добавить»: кнопки для этого не нужно,
  // а лишний параметр без имени в ссылку не попадает.
  const rows: [string, string][] = [...p.params, ["", ""]];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-xs font-semibold text-muted">{p.scheme}</span>
        <input
          value={p.host}
          onChange={(e) => edit({ host: e.target.value })}
          placeholder={s.nodeHost}
          aria-label={s.nodeHost}
          spellCheck={false}
          className={FIELD}
        />
        <input
          value={p.port}
          onChange={(e) => edit({ port: e.target.value.replace(/\D/g, "") })}
          placeholder={s.nodePort}
          aria-label={s.nodePort}
          inputMode="numeric"
          className={`${FIELD} w-20 flex-none text-center font-mono`}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 truncate font-mono text-xs text-muted" title={user}>
          {user}
        </span>
        <input
          value={p.user}
          onChange={(e) => edit({ user: e.target.value })}
          aria-label={user || s.editNode}
          spellCheck={false}
          className={`${FIELD} font-mono text-xs`}
        />
        {/* Вторая половина показывается только там, где она есть: у vless её
            нет вовсе, и пустое поле рядом означало бы забытый пароль. */}
        {password != null && (
          <input
            value={p.password}
            onChange={(e) => edit({ password: e.target.value })}
            placeholder={password}
            aria-label={password}
            spellCheck={false}
            className={`${FIELD} font-mono text-xs`}
          />
        )}
      </div>
      {rows.map(([key, value], i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={key}
            onChange={(e) => edit({ params: seatedParams(p.params, i, [e.target.value, value]) })}
            placeholder="sni"
            aria-label={s.nodeParam}
            spellCheck={false}
            className={`${FIELD} w-20 flex-none font-mono text-xs`}
          />
          <input
            value={value}
            onChange={(e) => edit({ params: seatedParams(p.params, i, [key, e.target.value]) })}
            aria-label={key || s.nodeParam}
            spellCheck={false}
            className={`${FIELD} font-mono text-xs`}
          />
          {i < p.params.length && (
            <IconButton
              icon="close"
              label={s.remove}
              onClick={() => edit({ params: p.params.filter((_, at) => at !== i) })}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Параметр на своё место, а последний — в хвост: та же строка внизу списка
 *  служит и «добавить», и её незачем заводить отдельной кнопкой. */
function seatedParams(params: [string, string][], at: number, row: [string, string]): [string, string][] {
  const out = [...params];
  out[at] = row;
  return out;
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
  onQr,
  onDone,
  onMenu,
  onReorder,
  onCommit,
  fromSub,
  probeOf,
  tight,
  selected,
  onPickRow,
}: {
  items: ProfileInfo[];
  /** Выделенные строки (окно, не служба) и обработчик нажатия по строке:
   *  возвращает `true`, если нажатие ушло на выделение и узел включать не надо. */
  selected: ReadonlySet<string>;
  onPickRow: Pick;
  /** Замеры по имени узла: одна карта на панель, а не поиск по списку в каждой
   *  из сотни строк на каждый опрос статуса. */
  probeOf: ReadonlyMap<string, Probe>;
  /** Панель тесная: метка типа и полоска задержки уходят из строки, остаются
   *  флаг, имя и число. */
  tight: boolean;
  status: Status | null;
  act: Act;
  s: Strings;
  busy?: boolean;
  editing: { name: string; text: string; own?: boolean } | null;
  /** `own` — узел подписки правят как свой: сохранение заводит копию. */
  onEdit: (name: string, own?: boolean) => void;
  /** Ссылку узла — кодом на экран: перенос на телефон без буфера и мессенджера.
   *  Как и «скопировать», есть у любой строки. */
  onQr: (name: string) => void;
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
  // Что тащат прямо сейчас. Своё на каждый список: строку из чужой группы
  // сюда не переносят — узел подписки в «Свои» не переезжает.
  const [dragged, setDragged] = useState<string | null>(null);
  const names = items.map((i) => i.name);
  return (
    // Отступ строк — на самом списке, а не на прокрутке: скруглённая подсветка
    // строки иначе упирается в кромку плиты. Заголовок группы при этом остаётся
    // во всю ширину — он рубеж списка, а не его строка.
    <ul className="flex flex-col px-2">
      {items.map((item) => {
        const name = item.name;
        const active = status?.profile === name;
        const probe = probeOf.get(name);
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
        const [mark, label] = nodeFlag(name, probe?.code);
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
        // Нажатие сперва спрашивает выделение (Ctrl/Shift или уже что-то
        // выделено) и только потом включает узел.
        const picked = selected.has(name);
        const anyPicked = selected.size > 0;
        const click = (e: React.MouseEvent) => {
          if (!onPickRow(name, e)) pick();
        };
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
            onPick: () => void act({ cmd: "test-profiles", arg: { only: [name] } }),
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
          { label: s.showQr, hint: s.showQrHint, onPick: () => onQr(name) },
          ...(fromSub
            ? // Узел подписки на месте не правится — сверка вернёт своё. Но
              // поправить копию можно: она станет обычным своим профилем.
              [{ label: s.editAsOwn, hint: s.editAsOwnHint, onPick: () => onEdit(name, true) }]
            : [{ label: s.edit, hint: s.editProfile(name), onPick: () => onEdit(name) }]),
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
            // `cv-row`: строка под прокруткой не раскладывается, пока не
            // видна (`index.css`) — подписка в сотни узлов иначе платила
            // раскладкой всех на каждый опрос.
            className="cv-row flex flex-col"
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
              data-selected={active}
              data-picked={picked}
              // Одна строка в 34 px: имя, метка, замер. `group/row` нужен
              // адресу, который показывается по наведению и по фокусу.
              className={`row enter smooth group/row flex h-[34px] items-center gap-2 ps-2 pe-1 ${
                dragged === name ? "opacity-40" : ""
              }`}
            >
              {/* Полоска выбранного — как в списках Windows, и в тон туннеля:
                  выбран — ещё не значит «несёт трафик», и путать это нельзя. */}
              {active && <span className={`row-pill smooth ${tone.rail}`} />}
              {/* Флаг — своей колонкой, одной на всю ширину списка: глаз ищет
                  страну по левому краю, а не в хвосте строки. Флаг из имени
                  («🇳🇱 Amsterdam») переезжает сюда же, а не повторяется рядом
                  с флагом замера. */}
              {/* Флажок выбора встаёт на место флага по наведению и по фокусу и
                  остаётся, пока что-то выделено. Обе вещи лежат в одной ячейке
                  и меняются прозрачностью, без перехода: пока список
                  простаивает, в нём ничего не движется. */}
              <span className="relative grid w-5 shrink-0 place-items-center">
                <span
                  className={`grid place-items-center text-base leading-none text-faint group-hover/row:opacity-0 group-focus-within/row:opacity-0 ${
                    anyPicked ? "opacity-0" : ""
                  }`}
                  title={country ?? undefined}
                  aria-label={country ?? undefined}
                >
                  {mark ?? <Icon name="server" size={14} />}
                </span>
                <input
                  type="checkbox"
                  checked={picked}
                  aria-label={s.selectRow(name)}
                  onChange={(e) => {
                    // Shift на самом флажке берёт диапазон, как и на строке.
                    const native = e.nativeEvent as MouseEvent;
                    onPickRow(name, { ctrlKey: true, metaKey: false, shiftKey: native.shiftKey === true });
                  }}
                  className={`absolute inset-0 m-auto size-4 cursor-pointer accent-[var(--pg-accent)] group-hover/row:opacity-100 group-focus-within/row:opacity-100 ${
                    anyPicked ? "" : "opacity-0"
                  }`}
                />
              </span>
              {/* Само поле строки и есть кнопка «включить»: настоящий <button>,
                  а не строка с ролью, — иначе клавиатура до профиля не
                  добирается, а кнопка меню внутри роли ей же и мешает.

                  Строка одна: имя, а у включённого — слово «подключён» тоном
                  туннеля. Адрес `host:port` из строки ушёл: он в подсказке и
                  проступает бледным справа от имени по наведению и по фокусу.
                  Имя профиля пишет чужая панель, и два одинаково названных
                  узла различаются только им — потому он не пропал, а прячется
                  до первого взгляда. Обрезается он первым (`shrink-[8]`), имя
                  — последним. Пароля и ключа тут нет — их в окно не привозят
                  вовсе. */}
              <button
                type="button"
                aria-pressed={active}
                onClick={click}
                title={item.server ? `${name} · ${item.kind} → ${item.server}` : name}
                className={`flex min-w-0 flex-1 items-baseline gap-2 py-1 text-start ${live ? "" : "cursor-pointer"}`}
              >
                <span className={`min-w-0 truncate text-sm ${active ? "font-semibold" : ""}`}>
                  {label}
                  {live && <span className="sr-only"> — {s.active}</span>}
                </span>
                {active && status?.tunnel === "up" && (
                  <span className={`shrink-0 text-xs font-normal ${tone.word}`} aria-hidden="true">
                    {s.rowConnected}
                  </span>
                )}
                {active && status?.tunnel === "connecting" && (
                  <span className={`shrink-0 text-xs font-normal ${tone.word}`} aria-hidden="true">
                    {s.connecting}
                  </span>
                )}
                {item.server && (
                  <span className="hidden min-w-0 shrink-[8] truncate font-mono text-xs font-normal text-faint group-hover/row:inline group-focus-within/row:inline">
                    {item.server}
                  </span>
                )}
              </button>
              {/* Тип узла меткой, моноширинно: по нему на глаз отличают vless от
                  wireguard, и это единственное, что в одной строке не
                  повторяет имя. В тесной панели её нет — остаётся в подсказке. */}
              {!tight && item.kind && (
                <span className="shrink-0 rounded-sm bg-control px-1.5 font-mono text-xs text-muted">{item.kind}</span>
              )}
              {/* Пометки — значками, а не словами: слово «без шифрования»
                  заглавными в каждой строке кричало громче имени узла. Смысл
                  остался в подсказке и для чтения с экрана, а жёлтый замок
                  видно боковым зрением — «Защищено» в шапке без оговорки
                  обещало бы больше, чем узел даёт. */}
              {item.plain && (
                <span className="shrink-0 text-wait" title={s.plainHint}>
                  <Icon name="lockOpen" size={14} />
                  <span className="sr-only">{s.plain}</span>
                </span>
              )}
              {/* Окно браузера открыто через этот узел: узел при этом несёт
                  трафик, а в строке об этом иначе ни слова. */}
              {browsing && (
                <span className="shrink-0 text-accent" title={s.browserOnHint}>
                  <Icon name="browser" size={14} />
                  <span className="sr-only">{s.browserOn}</span>
                </span>
              )}
              {/* Звёздочка — знак, а не кнопка: переключают её в меню, а видеть
                  отмеченные надо, не открывая ничего. */}
              {item.favorite && (
                <span className="shrink-0 text-accent" title={s.favorite}>
                  <Icon name="star" size={12} />
                  <span className="sr-only">{s.favoriteItem}</span>
                </span>
              )}
              {/* Задержка — правой колонкой, как в ведомости: столбец чисел
                  сравнивают взглядом сверху вниз, а в хвосте адреса числа
                  стояли вразнобой и сравнивались по одному. Число, снятое
                  при поднятом туннеле, включает и его RTT: прогон идёт
                  цепочкой сквозь общий туннель. Сравнивать такие числа с
                  выключенным режимом нельзя, а выбирают узел именно
                  сравнением — значит, сказать об этом обязано само число. */}
              {probe && (
                <span
                  className={`flex shrink-0 items-center justify-end gap-2 font-mono text-xs ${
                    tight ? "w-16" : "w-24"
                  } ${latencyTone(probe.latency_ms) || "text-muted"}`}
                >
                  {/* Полоска — длина задержки на шкале до 500 мс, цветом числа:
                      столбец полосок читается раньше столбца чисел. */}
                  {!tight && probe.latency_ms != null && (
                    <span className="block h-1 w-8 shrink-0 overflow-hidden rounded-full bg-edge" aria-hidden="true">
                      <span
                        className="block h-full rounded-full bg-current"
                        style={{ inlineSize: `${Math.min(100, Math.max(8, probe.latency_ms / 5))}%` }}
                      />
                    </span>
                  )}
                  <Verdict
                    probe={probe}
                    failed={s.probeFailed}
                    measured={
                      status?.tunnel === "up"
                        ? `${measuredAgo(s, probe.at)} · ${s.latencyThroughTunnel}`
                        : measuredAgo(s, probe.at)
                    }
                  />
                </span>
              )}
              <IconButton
                icon="more"
                label={s.actions}
                aria-haspopup="menu"
                onClick={(e) => onMenu(e, rowMenu())}
              />
            </div>
            {editing?.name === name && (
              <Editor s={s} name={name} text={editing.text} act={act} onDone={onDone} own={editing.own} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
