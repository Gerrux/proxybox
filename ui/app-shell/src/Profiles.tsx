import { useState } from "react";
import type { Act, Probe, Status } from "./platform";
import type { Strings } from "./i18n";
import { measuredAgo, strings, syncedAgo } from "./i18n";
import { AddField, Button, ConfirmButton, Empty, flag, Panel, SearchField } from "./ui";

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
    { url: null, names: profiles.filter((name) => !fromSubs.has(name) && match(name)) },
    ...subscriptions.map((sub) => ({ url: sub.url, names: sub.nodes.filter(match) })),
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
          {profiles.length > 0 && (
            // Пока прогон идёт, кнопка заперта: второй прогон добил бы sing-box
            // первого — они делят каталог проверки.
            <Button
              variant="quiet"
              disabled={busy}
              title={s.testProfilesHint}
              onClick={() => void act({ cmd: "test-profiles" })}
            >
              {s.testProfiles}
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
            onSubmit={(link) => act({ cmd: "add-profile", arg: { link } })}
          />
        )}
        {searchable && <SearchField value={query} onChange={setQuery} placeholder={s.searchProfiles} />}
        {!grouped && profiles.length === 0 ? (
          <Empty>{s.noProfiles}</Empty>
        ) : shown === 0 && needle !== "" ? (
          <Empty>{s.noMatches}</Empty>
        ) : !grouped ? (
          <Rows names={groups[0].names} status={status} act={act} s={s} />
        ) : (
          // Подписка показывается даже пустой: узлы могли удалить по одному, а
          // отписаться больше неоткуда. Прячет группу только поиск.
          groups.map(
            ({ url, names }) =>
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
                  <Rows names={names} status={status} act={act} s={s} />
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
function Rows({ names, status, act, s }: { names: string[]; status: Status | null; act: Act; s: Strings }) {
  const probes = status?.probes ?? [];
  return (
    <ul className="flex flex-col gap-1">
      {names.map((name) => {
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
                  <Verdict probe={probe} failed={s.probeFailed} measured={measuredAgo(s, probe?.at ?? 0)} />
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
                случаться не должно. Неактивный уходит сразу. */}
            {live ? (
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
