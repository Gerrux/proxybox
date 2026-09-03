import { useEffect, useState } from "react";
import type { Act, Lang, ProfileInfo, Probe, Quota, Response, Status } from "./platform";
import type { Strings } from "./i18n";
import { measuredAgo, strings, syncedAgo } from "./i18n";
import { bytes } from "./StatusBar";
import { AddField, Button, ConfirmButton, Empty, FIELD, flag, type Outcome, Panel, SearchField } from "./ui";

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

/** Где окно помнит порядок списка. Порядок остаётся способом посмотреть, а не
 *  свойством списка, — поэтому он в браузерном хранилище окна, а не в службе:
 *  на другой машине с той же службой список снова придёт как есть. Помнить его
 *  всё же надо: прогон затевают ровно ради выбора узла, а список после каждого
 *  открытия окна возвращался к порядку панели. */
const BY_LATENCY = "pg.profiles.byLatency";

export function Profiles({
  status,
  act,
  busy,
  className,
}: {
  status: Status | null;
  act: Act;
  busy?: boolean;
  className?: string;
}) {
  const s = strings(status?.lang);
  const profiles = status?.profiles ?? [];
  const subscriptions = status?.subscriptions ?? [];
  const [query, setQuery] = useState("");
  // Поле импорта показывается по «+», а не стоит всегда: две строки под
  // редчайшим действием — это две строки, которых нет у списка. Пока профилей
  // нет вовсе, добавить их больше нечем, и поле открыто само — вместе с самой
  // кнопкой, которой в этом состоянии нечего переключать.
  const [importOpen, setImportOpen] = useState(false);
  const adding = importOpen || profiles.length === 0;
  const needle = query.trim().toLowerCase();
  const match = (p: ProfileInfo) =>
    !needle || p.name.toLowerCase().includes(needle) || p.server.toLowerCase().includes(needle);
  // Заведённое руками и пришедшее с панели — разные вещи, и в одном списке
  // десяток своих узлов тонет в сотне чужих. Своё — то, чего нет ни в одной
  // подписке: связь знает служба, окно её только показывает.
  const fromSubs = new Set(subscriptions.flatMap((sub) => sub.nodes));
  const byName = new Map(profiles.map((p) => [p.name, p]));
  const groups = [
    { sub: null, items: profiles.filter((p) => !fromSubs.has(p.name) && match(p)) },
    ...subscriptions.map((sub) => ({
      sub,
      items: sub.nodes.flatMap((name) => {
        const p = byName.get(name);
        return p && match(p) ? [p] : [];
      }),
    })),
  ];
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  // Группы заводит только подписка: с одними своими узлами заголовок «Свои»
  // говорил бы о делении, которого нет.
  const grouped = subscriptions.length > 0;
  // Свёрнутые группы — здесь, а не в атрибуте <details>: статус приходит раз в
  // секунду, и открытое состояние, живущее только в DOM, спорило бы с каждой
  // перерисовкой. Имя группы — её адрес, поэтому переживает и подмену узлов.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Какую подписку сейчас переименовывают. Адресом, а не флагом: подписок
  // несколько, и открытых полей должно быть не больше одного.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Какой профиль правят и с каким узлом. Узел приезжает отдельным запросом:
  // в статусе его нет намеренно — окно спрашивает статус каждые две секунды, а
  // подписка приносит сотни узлов с ключами и паролями внутри.
  const [editing, setEditing] = useState<{ name: string; json: string } | null>(null);
  const openEditor = (name: string) =>
    void act({ cmd: "profile-node", arg: { name } }).then((r) => {
      if (r?.reply === "profile-node") setEditing({ name, json: r.data.json });
    });
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
  const probes = status?.probes ?? [];
  const measured = probes.some((p) => p.latency_ms != null);
  // Самый быстрый из измеренных и всё ещё живущих в списке. Прогон затевают
  // ради этого выбора, а делать его глазами по сотне строк — то же самое, что
  // не делать вовсе.
  const fastest = probes
    .filter((p) => p.latency_ms != null && byName.has(p.name))
    .sort((a, b) => (a.latency_ms ?? 0) - (b.latency_ms ?? 0))[0];
  const testing = status?.testing ?? null;
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
            <Button
              variant="quiet"
              aria-pressed={byLatency}
              title={s.byLatencyHint}
              onClick={() => setByLatency((v) => !v)}
            >
              {s.byLatency}
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
          {profiles.length > 0 && (
            <Button
              aria-pressed={adding}
              aria-label={s.importLink}
              title={s.linkPlaceholder}
              onClick={() => setImportOpen((v) => !v)}
              className="w-8 px-0 text-[15px] leading-none"
            >
              +
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {adding && (
          <AddField
            placeholder={s.linkPlaceholder}
            label={s.importLink}
            busyLabel={s.importing}
            fileLabel={s.fromFile}
            hint={(value) => sniff(s, value)}
            onSubmit={(link) => act({ cmd: "add-profile", arg: { link } }).then((r) => imported(s, r))}
          />
        )}
        {searchable && <SearchField value={query} onChange={setQuery} placeholder={s.searchProfiles} />}
        {!grouped && profiles.length === 0 ? (
          <Empty>{s.noProfiles}</Empty>
        ) : shown === 0 && needle !== "" ? (
          <Empty>{s.noMatches}</Empty>
        ) : !grouped ? (
          <Rows
            items={groups[0].items}
            status={status}
            act={act}
            s={s}
            busy={busy}
            byLatency={byLatency}
            editing={editing}
            onEdit={openEditor}
            onDone={() => setEditing(null)}
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
                  <summary className="engraved flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-1.5 text-muted hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
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
                      // Клик по кнопке иначе сворачивал бы группу заодно: <summary>
                      // переключает <details> по любому клику внутри себя.
                      <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="quiet"
                          aria-label={s.renameSubscription}
                          onClick={() => setRenaming(sub.url)}
                        >
                          ✎
                        </Button>
                        {/* Обновление — тот же импорт: служба сама узнаёт адрес и
                            заменяет пришедшие с него профили. */}
                        <Button
                          variant="quiet"
                          aria-label={s.refreshSubscription(sub.url)}
                          onClick={() => void act({ cmd: "add-profile", arg: { link: sub.url } })}
                        >
                          ⟳
                        </Button>
                        <ConfirmButton
                          label={s.removeSubscription(sub.url)}
                          ask={s.confirmRemove}
                          onConfirm={() => void act({ cmd: "remove-subscription", arg: { url: sub.url } })}
                        />
                      </span>
                    )}
                  </summary>
                  <Rows
                    items={items}
                    status={status}
                    act={act}
                    s={s}
                    busy={busy}
                    byLatency={byLatency}
                    editing={editing}
                    onEdit={openEditor}
                    onDone={() => setEditing(null)}
                    fromSub={sub !== null}
                  />
                </details>
              ),
          )
        )}
      </div>
    </Panel>
  );
}

/** Форма правки: имя и узел. Узел — тем же текстом, что принимает импорт, и
 *  разбирает его тот же разбор: второму парсеру взяться неоткуда, а поля по
 *  протоколам — это десяток форм, которые расходятся с sing-box на каждой его
 *  версии.
 *
 *  Ошибка живёт здесь же, а не в общей рамке наверху окна: правят JSON руками,
 *  и «в узле нет поля type» надо читать, не отводя глаз от самого узла. */
function Editor({
  s,
  name,
  json,
  act,
  onDone,
}: {
  s: Strings;
  name: string;
  json: string;
  act: Act;
  onDone: () => void;
}) {
  const [want, setWant] = useState(name);
  const [node, setNode] = useState(json);
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
          arg: { name, rename: want.trim(), node: node.trim() === json.trim() ? "" : node.trim() },
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
        rows={Math.min(14, node.split("\n").length)}
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
 *  и тот же список, и второй его копии быть не должно. */
function Rows({
  items,
  status,
  act,
  s,
  busy,
  byLatency,
  editing,
  onEdit,
  onDone,
  fromSub,
}: {
  items: ProfileInfo[];
  status: Status | null;
  act: Act;
  s: Strings;
  busy?: boolean;
  /** Переставить по измеренной задержке. Неизмеренные и мёртвые уходят вниз
   *  общей кучей в том порядке, в каком пришли: «не знаем» и «не отвечает» —
   *  не числа, и делать вид, что они сравнимы, незачем. */
  byLatency?: boolean;
  editing: { name: string; json: string } | null;
  onEdit: (name: string) => void;
  onDone: () => void;
  /** Узлы пришли из подписки. Тогда у строки нет ни `✕`, ни правки: набор здесь
   *  заменяет сверка целиком (`subscribe` вычищает прежние имена и кладёт
   *  найденные заново), и удалённый или переименованный вручную узел вернулся
   *  бы ближайшим же кругом — то есть кнопка обещала бы то, чего не делает.
   *  Уходят они с отпиской. */
  fromSub?: boolean;
}) {
  const probes = status?.probes ?? [];
  const at = (name: string) => probes.find((p) => p.name === name)?.latency_ms ?? Infinity;
  // Сортировка устойчива, поэтому внутри «неизмеренных» порядок остаётся тем,
  // каким пришёл, — а пришёл он от службы и от подписки.
  const shown = byLatency ? [...items].sort((a, b) => at(a.name) - at(b.name)) : items;
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((item) => {
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
        return (
          <li key={name} className="flex flex-col">
            <div
              className={`enter smooth relative flex items-center gap-2 rounded-md py-1.5 ps-3 pe-1 hover:bg-surface-2 ${active ? "bg-surface-2" : ""}`}
            >
              <span className={`smooth absolute inset-y-1 start-0 w-[3px] rounded-full ${tone.rail}`} />
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
              </div>
              {/* Проверить один узел: прогон идёт по узлу за раз и стоит секунд
                  на каждый, так что на подписке в сотню «вот этот» — это минуты
                  разницы. Заперта та же кнопка тем же прогоном: каталог
                  проверки у них общий. */}
              <Button
                variant="quiet"
                disabled={busy}
                aria-label={s.testOne}
                title={s.testOneHint}
                onClick={() => void act({ cmd: "test-profiles", arg: { only: name } })}
              >
                ⏱
              </Button>
              {!live && (
                <Button variant="quiet" onClick={() => void act({ cmd: "on", arg: { profile: name } })}>
                  {s.turnOn}
                </Button>
              )}
              {/* Правка своего узла: имя из подписки или опечатка в ссылке
                  чинились только удалением и вставкой заново. У узла подписки
                  кнопки нет по той же причине, что и `✕`. */}
              {!fromSub && (
                <Button
                  variant="quiet"
                  aria-label={s.editProfile(name)}
                  aria-pressed={editing?.name === name}
                  onClick={() => (editing?.name === name ? onDone() : onEdit(name))}
                >
                  ✎
                </Button>
              )}
              {/* У активного профиля удаление гасит туннель, и выбранные
                  приложения остаются без сети — такое по одному клику мимо
                  случаться не должно. То же и у узла, на который смотрит открытое
                  окно браузера: `forget_profile` зовёт `stop_sessions_on`, то есть
                  промах мыши оставляет это окно без сети. Признак уже посчитан
                  строкой выше — спрашиваем. Неактивный и никем не занятый уходит
                  сразу. */}
              {fromSub ? null : live || browsing ? (
                <ConfirmButton label={s.removeProfile(name)} ask={s.confirmRemove} onConfirm={remove} />
              ) : (
                <Button variant="danger" aria-label={s.removeProfile(name)} onClick={remove}>
                  ✕
                </Button>
              )}
            </div>
            {editing?.name === name && (
              <Editor s={s} name={name} json={editing.json} act={act} onDone={onDone} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
