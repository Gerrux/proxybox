import { useEffect, useRef, useState } from "react";
import { call, type Act, type App, type Scope, type Status, type Tunnel } from "./platform";
import { strings } from "./i18n";
import { AddField, Button, Empty, Panel, SearchField } from "./ui";

/** `id` для связки галочки с подписью. Путь к .exe в `id` класть нельзя: там
 *  пробелы, а `id` с пробелом невалиден — сейчас это сходит с рук только
 *  потому, что `htmlFor` сверяет строку целиком. */
function fieldId(path: string): string {
  return `app-${path.replace(/[^\w]+/g, "-")}`;
}

/** Список короче этого искать незачем — поле только мешало бы. */
const SEARCH_FROM = 8;

/** Включённые сверху, дальше по алфавиту: список после автообнаружения длинный,
 *  и важно видеть в первую очередь то, что реально под управлением. */
function ordered(apps: App[]): App[] {
  return [...apps].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
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

export function Apps({
  status,
  act,
  busy,
  className,
}: {
  status: Status | null;
  act: Act;
  /** Служба занята командой. Обход реестра и каталога пакетов идёт секундами,
   *  а полоска ожидания рисуется на шапке — далеко от нажатой кнопки. */
  busy?: boolean;
  className?: string;
}) {
  const s = strings(status?.lang);
  const all = status?.scope === "all";
  const apps = status?.apps ?? [];
  const on = apps.filter((a) => a.enabled).length;
  const icons = useIcons(apps);
  const [query, setQuery] = useState("");
  // Поле пути показывается по «+»: путь к .exe вписывают руками раз в жизни, а
  // строку у списка оно отнимало бы всегда. Пустому списку поле нужно сразу.
  const [importOpen, setImportOpen] = useState(false);
  // Абзац про галочку прячется под «?»: читают его один раз, а строку у списка
  // он отнимал всегда. Судьба конкретной строки остаётся в её подсказке.
  const [noteOpen, setNoteOpen] = useState(false);
  const adding = importOpen || apps.length === 0;
  const shown = matching(ordered(apps), query);
  // Поле не прячем, пока в нём что-то есть: иначе фильтр остался бы включённым
  // и невидимым, а строки просто пропали бы.
  const searchable = apps.length > SEARCH_FROM || query !== "";

  return (
    <Panel
      className={className}
      title={s.apps}
      note={
        apps.length > 0 && (
          <span className="text-muted">
            {s.appsCount(on, apps.length)}
            {query !== "" && ` · ${s.appsShown(shown.length)}`}
          </span>
        )
      }
      action={
        // Кнопки стоят в обоих охватах: список собирают до переключения на
        // белый, а не после — переключение и есть то действие, которое рубит
        // сеть всем неотмеченным.
        <>
          <Button variant="quiet" disabled={busy} onClick={() => void act({ cmd: "discover", arg: { env: {} } })}>
            {s.discover}
          </Button>
          <Button
            aria-pressed={noteOpen}
            aria-expanded={noteOpen}
            aria-label={s.whatIsCheck}
            onClick={() => setNoteOpen((v) => !v)}
            className="w-8 px-0 text-[15px] leading-none"
          >
            ?
          </Button>
          <Button
            aria-pressed={adding}
            aria-label={s.addApp}
            title={s.appPlaceholder}
            onClick={() => setImportOpen((v) => !v)}
            className="w-8 px-0 text-[15px] leading-none"
          >
            +
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Список виден в обоих охватах. Прятать его в «весь компьютер» —
            значит оставить единственным путём к нему само переключение охвата,
            а оно и есть то действие, которое рубит сеть всем неотмеченным:
            сначала стреляем, потом целимся. Раньше это оправдывали тем, что на
            виду список соврал бы про судьбу строк, — теперь про судьбу не врёт
            `fateHint`, он спрашивает охват. Строка над списком говорит прямо,
            что здесь он не применяется. */}
        {all && <p className="text-[13px] leading-snug text-muted">{s.scopeAllNote}</p>}
        {/* Галочка здесь значит не то, что значила в split-tunnel, и разница
            опасная: тогда снятая возвращала приложение в открытую сеть, а
            теперь оставляет его без интернета вовсе.

            Пока не выбрано ни одного — абзац открыт сам: это ровно тот случай,
            когда его ещё не читали, и ровно тот, в котором список оставляет без
            сети всю машину. Отмеченное появилось — прячется обратно под «?». */}
        {!all && (noteOpen || on === 0) && (
          <p className="enter text-[13px] leading-snug text-muted">{s.whitelistNote}</p>
        )}
        {/* Поле пути и поиск стоят в одной строке, а в узкой панели
            переносятся: два поля по полширины — это два обрубка. */}
        {(adding || searchable) && (
          <div className="flex flex-wrap gap-2">
            {adding && (
              <AddField
                className="min-w-[16rem] flex-1"
                placeholder={s.appPlaceholder}
                label={s.addApp}
                onSubmit={(path) => act({ cmd: "add-app", arg: { path } })}
              />
            )}
            {searchable && <SearchField value={query} onChange={setQuery} placeholder={s.searchApps} />}
          </div>
        )}
        {apps.length === 0 ? (
          <Empty>{s.noApps}</Empty>
        ) : shown.length === 0 ? (
          <Empty>{s.noMatches}</Empty>
        ) : (
          <ul className="flex flex-col">
            {shown.map((app) => (
              <li
                key={app.path}
                title={fateHint(s, app.enabled, status?.tunnel, status?.scope)}
                className="enter smooth flex items-center gap-3 rounded-md px-1 py-1.5 hover:bg-surface-2"
              >
                <input
                  id={fieldId(app.path)}
                  type="checkbox"
                  checked={app.enabled}
                  onChange={(e) => void act({ cmd: "set-app", arg: { path: app.path, enabled: e.target.checked } })}
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
                <label htmlFor={fieldId(app.path)} className="min-w-0 flex-1 cursor-pointer leading-tight">
                  <span className={`block truncate text-[13px] ${app.enabled ? "font-medium" : "text-muted"}`}>
                    {app.name}
                  </span>
                  <span className="selectable block truncate font-mono text-[11px] text-muted" title={app.path}>
                    {app.path}
                  </span>
                </label>
                <Button
                  variant="danger"
                  aria-label={s.removeApp(app.name)}
                  onClick={() => void act({ cmd: "remove-app", arg: { path: app.path } })}
                >
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
