import { useState } from "react";
import type { Act, Lang, Probe, Quota, Status } from "./platform";
import type { Strings } from "./i18n";
import { measuredAgo, strings, syncedAgo } from "./i18n";
import { bytes } from "./StatusBar";
import { AddField, Button, ConfirmButton, Empty, flag, Panel, SearchField } from "./ui";

/** Чем окажется набранное в поле импорта — по одному лишь префиксу и до
 *  отправки. Это подпись, а не разбор: разбирает служба, и спорить с ней
 *  нечем. Правило для `https` тут то же, по которому она уводит ссылку в
 *  подписку, — префикс, увиденный ещё до замка (`handle()`).
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
  // нет вовсе, добавить их больше нечем, и поле открыто само.
  const [importOpen, setImportOpen] = useState(false);
  const adding = importOpen || profiles.length === 0;
  const needle = query.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);
  // Заведённое руками и пришедшее с панели — разные вещи, и в одном списке
  // десяток своих узлов тонет в сотне чужих. Своё — то, чего нет ни в одной
  // подписке: связь знает служба, окно её только показывает.
  const fromSubs = new Set(subscriptions.flatMap((sub) => sub.nodes));
  const groups = [
    { url: null, names: profiles.filter((name) => !fromSubs.has(name) && match(name)), quota: null },
    ...subscriptions.map((sub) => ({ url: sub.url, names: sub.nodes.filter(match), quota: sub.quota })),
  ];
  const shown = groups.reduce((n, g) => n + g.names.length, 0);
  // Группы заводит только подписка: с одними своими узлами заголовок «Свои»
  // говорил бы о делении, которого нет.
  const grouped = subscriptions.length > 0;
  // Свёрнутые группы — здесь, а не в атрибуте <details>: статус приходит раз в
  // секунду, и открытое состояние, живущее только в DOM, спорило бы с каждой
  // перерисовкой. Имя группы — её адрес, поэтому переживает и подмену узлов.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Поле не прячем, пока в нём что-то есть: иначе фильтр остался бы включённым
  // и невидимым, а строки просто пропали бы.
  const searchable = profiles.length > SEARCH_FROM || query !== "";
  // Прогон запускают ровно затем, чтобы выбрать быстрый узел, — а в списке на
  // сотню строк 40 ms до сих пор искали глазами. Порядок живёт в окне и никуда
  // не сохраняется: это способ посмотреть, а не свойство списка. Переключатель
  // показывается, только когда есть что упорядочивать: без единого измерения он
  // не сделал бы ничего.
  const [byLatency, setByLatency] = useState(false);
  const measured = (status?.probes ?? []).some((p) => p.latency_ms != null);
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
          {profiles.length > 0 && (
            // Пока прогон идёт, кнопка заперта: второй прогон добил бы sing-box
            // первого — они делят каталог проверки.
            <Button
              variant="quiet"
              disabled={busy}
              title={s.testProfilesHint}
              onClick={() => void act({ cmd: "test-profiles" })}
            >
              {busy ? s.testing : s.testProfiles}
            </Button>
          )}
          <Button
            aria-pressed={adding}
            aria-label={s.importLink}
            title={s.linkPlaceholder}
            onClick={() => setImportOpen((v) => !v)}
            className="w-8 px-0 text-[15px] leading-none"
          >
            +
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {adding && (
          <AddField
            placeholder={s.linkPlaceholder}
            label={s.importLink}
            busyLabel={s.importing}
            hint={(value) => sniff(s, value)}
            onSubmit={(link) => act({ cmd: "add-profile", arg: { link } })}
          />
        )}
        {searchable && <SearchField value={query} onChange={setQuery} placeholder={s.searchProfiles} />}
        {!grouped && profiles.length === 0 ? (
          <Empty>{s.noProfiles}</Empty>
        ) : shown === 0 && needle !== "" ? (
          <Empty>{s.noMatches}</Empty>
        ) : !grouped ? (
          <Rows names={groups[0].names} status={status} act={act} s={s} byLatency={byLatency} />
        ) : (
          // Подписка показывается даже пустой: она могла не отдать ни одного
          // понятного нам узла, а отписаться больше неоткуда. Прячет группу
          // только поиск.
          groups.map(
            ({ url, names, quota }) =>
              (names.length > 0 || (url !== null && needle === "")) && (
                // Сворачивается родным <details>: подписка на сотню узлов иначе
                // уводит все остальные группы за нижний край окна.
                <details
                  key={url ?? ""}
                  open={!collapsed.includes(url ?? "")}
                  onToggle={(e) => {
                    // Состояние снимаем здесь, а не внутри апдейтера: апдейтер
                    // React зовёт лениво, уже на фазе рендера, а к тому времени
                    // синтетическое событие обнулено — `currentTarget` там null.
                    // Прочитанное изнутри роняло `<Profiles>` целиком, и окно
                    // открывалось пустым: границы ошибок над панелями нет, и
                    // React вычищает контейнер.
                    const { open } = e.currentTarget;
                    setCollapsed((was) =>
                      open ? was.filter((u) => u !== (url ?? "")) : [...was, url ?? ""],
                    );
                  }}
                  className="group/sub"
                >
                  <summary className="engraved flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-1.5 text-muted hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                    {/* .smooth возит только цвет — повороту нужен свой переход, и он же
                        обязан замирать при prefers-reduced-motion. */}
                    <span className="shrink-0 text-[9px] motion-safe:transition group-open/sub:rotate-90">▶</span>
                    {url === null ? (
                      <span className="min-w-0 flex-1 truncate">{s.ownProfiles}</span>
                    ) : (
                      // Схема одинакова у всех подписок и съедает начало строки,
                      // а обрезается как раз хвост — то единственное, чем адреса
                      // и различаются. Полный адрес остаётся по наведению.
                      <span
                        className="selectable min-w-0 flex-1 truncate font-mono text-[11px] font-normal normal-case tracking-normal"
                        title={url}
                      >
                        {url.replace(/^https?:\/\//, "")}
                      </span>
                    )}
                    {/* Остаток стоит `shrink-0`, а обрезается адрес: остаток
                        короткий и постоянной длины, а схема с хвостом адреса —
                        длинная. Живёт он в <summary>, а не под ним: в свёрнутом
                        виде это единственное место, где его вообще видно, а
                        свёрнуты подписки как раз чаще всего. */}
                    {quota && <Remaining s={s} quota={quota} lang={status?.lang} />}
                    <span className="shrink-0 font-sans text-[11px] font-normal normal-case tracking-normal">
                      {names.length}
                    </span>
                    {url !== null && (
                      // Клик по кнопке иначе сворачивал бы группу заодно: <summary>
                      // переключает <details> по любому клику внутри себя.
                      <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                        {/* Обновление — тот же импорт: служба сама узнаёт адрес и
                            заменяет пришедшие с него профили. */}
                        <Button
                          variant="quiet"
                          aria-label={s.refreshSubscription(url)}
                          onClick={() => void act({ cmd: "add-profile", arg: { link: url } })}
                        >
                          ⟳
                        </Button>
                        <ConfirmButton
                          label={s.removeSubscription(url)}
                          ask={s.confirmRemove}
                          onConfirm={() => void act({ cmd: "remove-subscription", arg: { url } })}
                        />
                      </span>
                    )}
                  </summary>
                  <Rows
                    names={names}
                    status={status}
                    act={act}
                    s={s}
                    byLatency={byLatency}
                    fromSub={url !== null}
                  />
                </details>
              ),
          )
        )}
      </div>
    </Panel>
  );
}

/** Строки списка. Отдельно от групп: под каждой подпиской и над ними лежит один
 *  и тот же список, и второй его копии быть не должно. */
function Rows({
  names,
  status,
  act,
  s,
  byLatency,
  fromSub,
}: {
  names: string[];
  status: Status | null;
  act: Act;
  s: Strings;
  /** Переставить по измеренной задержке. Неизмеренные и мёртвые уходят вниз
   *  общей кучей в том порядке, в каком пришли: «не знаем» и «не отвечает» —
   *  не числа, и делать вид, что они сравнимы, незачем. */
  byLatency?: boolean;
  /** Узлы пришли из подписки. Тогда у строки нет `✕`: набор здесь заменяет
   *  сверка целиком (`subscribe` вычищает прежние имена и кладёт найденные
   *  заново), и удалённый вручную узел вернулся бы ближайшим же кругом — то
   *  есть кнопка обещала бы то, чего не делает. Уходят они с отпиской. */
  fromSub?: boolean;
}) {
  const probes = status?.probes ?? [];
  const at = (name: string) => probes.find((p) => p.name === name)?.latency_ms ?? Infinity;
  // Сортировка устойчива, поэтому внутри «неизмеренных» порядок остаётся тем,
  // каким пришёл, — а пришёл он от службы и от подписки.
  const shown = byLatency ? [...names].sort((a, b) => at(a) - at(b)) : names;
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((name) => {
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
              )}
            </div>
            {!live && (
              <Button variant="quiet" onClick={() => void act({ cmd: "on", arg: { profile: name } })}>
                {s.turnOn}
              </Button>
            )}
            {/* У активного профиля удаление гасит туннель, и выбранные
                приложения остаются без сети — такое по одному клику мимо
                случаться не должно. То же и у узла, на который смотрит открытое
                окно браузера: `forget_profile` зовёт `stop_sessions_on`, то есть
                промах мыши оставляет это окно без сети. Признак уже посчитан
                строкой выше — спрашиваем. Неактивный и никем не занятый уходит
                сразу.

                У узла из подписки кнопки нет вовсе: набор здесь заменяет сверка
                целиком, и удалённый вручную узел вернулся бы ближайшим кругом.
                Кнопка, которую отменяет расписание, — это обещание, которого
                продукт не держит; уходят такие узлы с отпиской. */}
            {fromSub ? null : live || browsing ? (
              <ConfirmButton label={s.removeProfile(name)} ask={s.confirmRemove} onConfirm={remove} />
            ) : (
              <Button variant="danger" aria-label={s.removeProfile(name)} onClick={remove}>
                ✕
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
