import { useEffect, useRef, useState } from "react";
import { call, type Act, type App, type Scope, type Status, type Tunnel } from "./platform";
import { strings } from "./i18n";
import { AddField, Button, Empty, IconButton, Modal, Panel, SearchField } from "./ui";

/** `id` для связки галочки с подписью. Путь к .exe в `id` класть нельзя: там
 *  пробелы, а `id` с пробелом невалиден — сейчас это сходит с рук только
 *  потому, что `htmlFor` сверяет строку целиком. */
function fieldId(path: string): string {
  return `app-${path.replace(/[^\w]+/g, "-")}`;
}

/** Список короче этого искать незачем — поле только мешало бы. */
const SEARCH_FROM = 8;

/** По алфавиту внутри группы. Деление на «выбраны» и «остальные» делают сами
 *  группы: список после автообнаружения длинный, и важно видеть в первую
 *  очередь то, что реально под управлением, — оно стоит первой группой. */
function alphabetical(apps: App[]): App[] {
  return [...apps].sort((a, b) => a.name.localeCompare(b.name));
}

/** Ищем и по имени, и по пути: «chrome» находит браузер, «steamapps» — всё, что
 *  стоит в этой папке. Регистр не важен, слова ищутся по отдельности — «google
 *  chrome» находит и «Chrome (Google Inc.)». */
function matching(apps: App[], query: string): App[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return apps;
  return apps.filter((app) => {
    const haystack = `${app.name} ${app.path}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Судьба приложения словами — та же развилка, что и `core_filter::policy()`.
 *  Охват входит в неё наравне с галочкой, и без него строка врала дважды: в
 *  «весь компьютер» отбора нет вовсе, а в белом списке снятая галочка означает
 *  не «мимо туннеля», а «без сети» — прямого пути в продукте не осталось, и
 *  уйти этому приложению просто некуда. Читалось это ровно наоборот и прямо
 *  под абзацем, который говорит обратное.
 *
 *  Цветной полоски у строки больше нет: она повторяла галочку той же строки,
 *  а фазу туннеля — шапку окна. */
function fateHint(
  s: ReturnType<typeof strings>,
  enabled: boolean,
  tunnel: Tunnel | undefined,
  scope: Scope | undefined,
): string {
  // Приватный режим выключен — в сеть ходят все и напрямую, галочка ни при чём.
  if (tunnel == null || tunnel === "off") return s.fateDirect;
  // Диагностический охват: пропусков нет ни у кого, и галочка не меняет ничего.
  // Строка обязана говорить это прямо — иначе окно обещает сеть тому, у кого её
  // нет, а это ровно та ложь, ради которой у продукта и заведена эта колонка.
  if (scope === "none") return s.fateClosed;
  if (scope === "split") return tunnel === "up" ? (enabled ? s.fateDirect : s.splitDefault) : s.fateClosed;
  // «Весь компьютер» — это отсутствие отбора: судьба у всех строк одна.
  if (scope === "all" || enabled) return tunnel === "up" ? s.fateUp : s.fateClosed;
  return s.fateFenced;
}

/** Иконки спрашиваются по одной и только раз за путь: в статусе их нет, потому
 *  что он ходит по кругу каждые две секунды, а картинка весит килобайты.
 *  Файл не меняется под нами — перечитывать нечего. */
function useIcons(apps: App[]): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    for (const { path } of apps) {
      if (asked.current.has(path)) continue;
      asked.current.add(path);
      call({ cmd: "icon", arg: { path } })
        // Нет иконки — не ошибка: строка просто остаётся с заглушкой.
        .then((r) => r.reply === "icon" && r.data && setIcons((prev) => ({ ...prev, [path]: r.data as string })))
        .catch(() => {});
    }
  }, [apps]);

  return icons;
}

/** Накопленные галочки «Раздельно»: ключ — путь, значение — чего хочет человек.
 *  Живут в `App.tsx`, а не в панели: панель приложений размонтируется при
 *  переходе на браузеры, соединения и в настройки, и десять отмеченных, но не
 *  применённых галочек пропадали бы вместе с полосой «Применить» (сторож —
 *  `split_edits_outlive_a_tab_switch`). */
export type SplitPending = Record<string, boolean>;

/** Список приложений глазами охвата: в «Раздельно» галочка — это
 *  `direct_apps`, а не `enabled` белого списка. */
export function appsOf(status: Status | null): App[] {
  const split = status?.scope === "split";
  return (status?.apps ?? []).map((app) =>
    split ? { ...app, enabled: status?.settings.direct_apps?.includes(app.path) ?? false } : app,
  );
}

/** Правки, которые ещё не уехали службе. Запись, совпавшая с сохранённым, не
 *  считается, как и запись про приложение, которого уже нет в списке. Вне
 *  «Раздельно» накопленного нет по определению. */
export function splitEdits(status: Status | null, pending: SplitPending): App[] {
  if (status?.scope !== "split") return [];
  return appsOf(status).filter((a) => pending[a.path] != null && pending[a.path] !== a.enabled);
}

export function Apps({
  status,
  act,
  busy,
  className,
  pending,
  setPending,
}: {
  status: Status | null;
  act: Act;
  /** Служба занята командой. Обход реестра и каталога пакетов идёт секундами,
   *  а полоска ожидания рисуется на шапке — далеко от нажатой кнопки. */
  busy?: boolean;
  className?: string;
  /** Накопленные галочки «Раздельно» — состояние `App.tsx` (см. `SplitPending`). */
  pending: SplitPending;
  setPending: (next: SplitPending | ((prev: SplitPending) => SplitPending)) => void;
}) {
  const s = strings(status?.lang);
  const all = status?.scope === "all";
  const split = status?.scope === "split";
  const apps = appsOf(status);
  const on = apps.filter((a) => a.enabled).length;
  // «Раздельно»: каждая правка списка напрямую перезапускает туннель, и пока он
  // не подтверждён, машина заперта. Десять галочек подряд — десять запертых
  // машин, поэтому они копятся в окне и уходят одной правкой по «Применить».
  // Белый список так не делает: он туннель не трогает вовсе
  // (`editing_the_list_never_restarts_the_tunnel`), и его галочки сбываются
  // сразу. Сбрасывает накопленное смена охвата — в `App.tsx`: там оно и живёт.
  const edits = splitEdits(status, pending);
  const wants = (app: App) => (split && pending[app.path] != null ? pending[app.path] : app.enabled);
  const toggle = (app: App, value: boolean) =>
    setPending((prev) => {
      const next = { ...prev };
      if (value === app.enabled) delete next[app.path];
      else next[app.path] = value;
      return next;
    });
  const apply = () => {
    if (!status) return;
    const changed = new Map(edits.map((a) => [a.path, wants(a)]));
    // Поле у службы бывает не прислано — тот же случай, что в `apps` выше.
    const current = status.settings.direct_apps ?? [];
    const direct_apps = [
      ...current.filter((path) => changed.get(path) !== false),
      ...[...changed].filter(([path, value]) => value && !current.includes(path)).map(([path]) => path),
    ];
    void act({ cmd: "set-settings", arg: { settings: { ...status.settings, direct_apps } } }).then(
      (r) => r != null && r.reply !== "error" && setPending({}),
    );
  };
  const icons = useIcons(apps);
  const [query, setQuery] = useState("");
  // Путь вписывают отдельным окном, а не полем внутри панели: поле раздвигало
  // список сверху, и всё, ради чего панель открывали, уезжало вниз. Раз в жизни
  // вписанный путь такой цены не стоит.
  const [adding, setAdding] = useState(false);
  // Абзац про галочку прячется под «?»: читают его один раз, а строку у списка
  // он отнимал всегда. Судьба конкретной строки остаётся в её подсказке.
  //
  // `null` — «человек не решал», и тогда за него решает срочность: в «весь
  // компьютер» абзац объясняет, почему список сейчас не применяется, а в белом
  // списке без единой галочки — почему машина осталась без сети. Оба случая
  // открывают абзац сами, но закрыть его можно тем же «?».
  //
  // Пока состояние было простым `false`, «?» переключал не то, что на экране:
  // в «весь компьютер» абзац рисовался по охвату и на `noteOpen` не смотрел
  // вовсе, а в пустом белом списке его держало открытым `on === 0`. В обоих
  // случаях кнопка нажималась и не делала ничего — то есть выглядела сломанной,
  // потому что и была.
  const [noteOpen, setNoteOpen] = useState<boolean | null>(null);
  // Охват сменился — решение о прошлом абзаце к новому не относится: там другой
  // текст и другая срочность. Закрытая заметка «весь компьютер» не имеет права
  // унести с собой предупреждение пустого белого списка.
  useEffect(() => setNoteOpen(null), [status?.scope]);
  // Срочность: «Раздельно» и «весь компьютер» меняют смысл галочки (или
  // отменяют его), а пустой белый список — это машина без сети.
  const urgent = split || all || (status?.scope === "whitelist" && on === 0);
  const shown = matching(apps, query);
  // Две группы: отмеченные первой и остальные под ней. Поиск режет обе, и
  // пустая группа под поиском не рисуется — без поиска рисуется, даже пустая:
  // «Выбраны (0)» в белом списке и есть предупреждение.
  const groups = [
    { key: "picked", title: s.appsPicked(shown.filter((a) => a.enabled).length), items: alphabetical(shown.filter((a) => a.enabled)) },
    { key: "rest", title: s.appsRest(shown.filter((a) => !a.enabled).length), items: alphabetical(shown.filter((a) => !a.enabled)) },
  ].filter((g) => g.items.length > 0 || query === "");
  // Поле не прячем, пока в нём что-то есть: иначе фильтр остался бы включённым
  // и невидимым, а строки просто пропали бы.
  const searchable = apps.length > SEARCH_FROM || query !== "";
  // Своё ожидание, а не общее `busy`: обход реестра, меню «Пуск» и каталога
  // WindowsApps идёт секундами, и надпись обязана говорить про него, а не про
  // любую команду в полёте — иначе кнопка писала бы «Ищу…» на снятую галочку.
  const [finding, setFinding] = useState(false);
  // Что показано под шапкой панели — одна заметка на оба охвата, а не две
  // независимые: кнопка у них общая, и переключать она обязана ровно то, что
  // видно.
  const noteShown = noteOpen ?? urgent;
  // Счёт и три кнопки. Стоят в шапке панели (≥1100 px) и, пока шапки нет
  // (`folds`), в строке поиска: один узел на оба места, а не две копии кнопок,
  // разошедшиеся при первой правке. Обе стоят в DOM, лишняя спрятана CSS-ом
  // (`.fold-only`, `.panel-head[data-folds]`) — порог один, в `index.css`.
  const count = apps.length > 0 && (
    <span className="text-muted">
      {/* «Весь компьютер»: счёт «в туннеле» там врал бы — список не
          применяется, а идёт всё. */}
      {all ? s.appsNotApplied : split ? s.splitAppsCount(on, apps.length) : s.appsCount(on, apps.length)}
      {query !== "" && ` · ${s.appsShown(shown.length)}`}
    </span>
  );
  const actions = (
    // Кнопки стоят в обоих охватах: список собирают до переключения на
    // белый, а не после — переключение и есть то действие, которое рубит
    // сеть всем неотмеченным.
    <>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => {
          setFinding(true);
          void act({ cmd: "discover", arg: { env: {} } }).finally(() => setFinding(false));
        }}
      >
        {finding ? s.searching : s.discover}
      </Button>
      <IconButton
        icon="help"
        aria-pressed={noteShown}
        aria-expanded={noteShown}
        label={s.whatIsCheck}
        onClick={() => setNoteOpen(!noteShown)}
        className={noteShown ? "bg-press" : ""}
      />
      <IconButton
        icon="plus"
        variant="ghost"
        aria-haspopup="dialog"
        label={s.addApp}
        title={s.appPlaceholder}
        onClick={() => setAdding(true)}
      />
    </>
  );

  return (
    <Panel
      // Отступа у прокрутки нет — по той же причине, что у списка профилей:
      // липкий заголовок группы липнет к кромке прокрутки, а не к её полю за
      // вычетом отступа. Поиск и заметка стоят вне прокрутки (`bar`), поля
      // раздают сами строки и пустые состояния.
      className={className}
      title={s.apps}
      folds="narrow"
      note={count}
      bar={
        <>
          {/* Строка инструментов: поиск, счёт и кнопки. Выше 1100 px счёт и
              кнопки стоят в шапке, и без поиска строка там пуста — тогда её
              нет вовсе, а не пустая полоса с линией. */}
          <div className={`${searchable ? "" : "fold-only "}flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1`}>
            {searchable && (
              <div className="min-w-24 flex-[1_0_7rem]">
                <SearchField value={query} onChange={setQuery} placeholder={s.searchApps} />
              </div>
            )}
            <span className={`fold-only min-w-0 truncate text-xs ${searchable ? "" : "flex-1"}`}>{count}</span>
            <div className="fold-only flex shrink-0 items-center gap-1">{actions}</div>
          </div>
          {/* Заметка одна, а текст в ней по охвату — и то и другое
              переключает «?» в шапке панели. Одной строкой говорит, что
              значит галочка в этом охвате: в белом списке — «в туннеле» (и
              что без неё сети нет вовсе), в «Раздельно» — «напрямую», в «весь
              компьютер» — что список не применяется.

              Открывается сама в «Раздельно», но закрывается по нажатию:
              постоянный абзац отнимал у списка строки в плашке из трея, а
              читают его один раз. Судьба конкретной строки остаётся в её
              подсказке (`fateHint`). */}
          {noteShown && (
            <div className="shrink-0 border-b border-edge p-2">
              <p className="enter rounded-md bg-hover px-3 py-1.5 text-sm text-muted">
                {split ? s.splitAppsNote : all ? s.scopeAllNote : s.whitelistNote}
              </p>
            </div>
          )}
        </>
      }
      foot={
        edits.length > 0 && (
          // Накопленные галочки «Раздельно»: одна правка вместо перезапуска
          // туннеля на каждую. Подсказка говорит, чем это оплачено.
          <div
            className="enter flex shrink-0 items-center gap-2 border-t border-edge p-2 ps-3"
            title={s.splitApplyHint}
          >
            <span className="min-w-0 flex-1 truncate text-sm">{s.splitPending(edits.length)}</span>
            <Button variant="ghost" disabled={busy} onClick={() => setPending({})}>
              {s.splitDiscard}
            </Button>
            <Button variant="primary" disabled={busy} onClick={apply}>
              {s.apply}
            </Button>
          </div>
        )
      }
      action={actions}
    >
      <div className="flex flex-col">
        {/* Список виден в обоих охватах. Прятать его в «весь компьютер» —
            значит оставить единственным путём к нему само переключение охвата,
            а оно и есть то действие, которое рубит сеть всем неотмеченным:
            сначала стреляем, потом целимся. Раньше это оправдывали тем, что на
            виду список соврал бы про судьбу строк, — теперь про судьбу не врёт
            `fateHint`, он спрашивает охват. Заметка над списком говорит прямо,
            что здесь он не применяется. */}
        {adding && (
          <Modal title={s.addApp} onClose={() => setAdding(false)}>
            <AddField
              placeholder={s.appPlaceholder}
              label={s.addApp}
              busyLabel={s.adding}
              onSubmit={(path) =>
                act({ cmd: "add-app", arg: { path } }).then((r) => ({ ok: r != null && r.reply !== "error" }))
              }
            />
          </Modal>
        )}
        {apps.length === 0 ? (
          // Тот же случай, что и у профилей: поле пути больше не открыто само.
          <div className="flex flex-col items-center gap-2 p-3">
            <Empty>{s.noApps}</Empty>
            <Button variant="primary" onClick={() => setAdding(true)}>
              {s.addApp}
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <div className="p-3">
            <Empty>{s.noMatches}</Empty>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key}>
              {/* Заголовок группы — рубеж списка и липкий, как у подписок в
                  профилях (`.sub-head`): список после автообнаружения длиннее
                  любого окна, и посреди прокрутки ответить «это выбранные или
                  остальные» было бы нечем. */}
              <h3 className="sub-head flex h-9 items-center gap-2 ps-4 pe-2 text-sm font-semibold">{group.title}</h3>
          <ul className="flex flex-col px-2">
            {group.items.map((app) => (
              <li
                key={app.path}
                // Путь — в подсказке строки и бледно справа от имени по
                // наведению; судьба приложения (`fateHint`) — второй строкой
                // подсказки, а не вместо пути.
                title={`${app.path}\n${fateHint(s, wants(app), status?.tunnel, status?.scope)}`}
                className="row enter smooth group/row flex h-[34px] items-center gap-2.5 ps-2 pe-1"
              >
                <input
                  id={fieldId(app.path)}
                  type="checkbox"
                  checked={wants(app)}
                  disabled={busy}
                  onChange={(e) =>
                    split
                      ? toggle(app, e.target.checked)
                      : void act({ cmd: "set-app", arg: { path: app.path, enabled: e.target.checked } })
                  }
                  // Галочка — действие оператора, а не состояние канала:
                  // цвета состояний ей не положены. Состояние читается на
                  // шапке, и красить им ещё и галочку — обещать состояние
                  // там, где нажимают.
                  className="size-4 shrink-0 accent-[var(--pg-accent)]"
                />
                {/* Место под иконку держится всегда: без него строки без иконки
                    съезжали бы влево, а пустой квадрат — это шум. */}
                {icons[app.path] ? (
                  <img src={icons[app.path]} alt="" className="size-5 shrink-0" />
                ) : (
                  <span className="size-5 shrink-0" />
                )}
                {/* Одна строка: имя, а путь проступает справа бледным по
                    наведению. Обрезается он первым (`shrink-[8]`): двух
                    приложений с одним именем путь и различает. */}
                <label
                  htmlFor={fieldId(app.path)}
                  className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2"
                >
                  <span className={`min-w-0 truncate text-sm ${app.enabled ? "font-semibold" : ""}`}>
                    {app.name}
                  </span>
                  {/* Правка ещё не применена: точка вместо цвета строки —
                      цвета состояний галочке не положены. */}
                  {edits.some((e) => e.path === app.path) && (
                    <span className="size-1.5 shrink-0 self-center rounded-full bg-accent" title={s.unapplied}>
                      <span className="sr-only">{s.unapplied}</span>
                    </span>
                  )}
                  <span className="selectable hidden min-w-0 shrink-[8] truncate font-mono text-xs text-faint group-hover/row:inline group-focus-within/row:inline">
                    {app.path}
                  </span>
                </label>
                <IconButton
                  icon="close"
                  variant="danger"
                  label={s.removeApp(app.name)}
                  onClick={() => void act({ cmd: "remove-app", arg: { path: app.path } })}
                />
              </li>
            ))}
          </ul>
            </section>
          ))
        )}
      </div>
    </Panel>
  );
}
