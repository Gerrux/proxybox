import { useEffect, useRef, useState } from "react";
import { call, type App, type Lang, type Request, type Status, type Tunnel } from "./platform";
import { strings } from "./i18n";
import { AddField, Button, Empty, Panel, SearchField } from "./ui";

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

/** Цвет рельса строки — та же развилка, что и `core_filter::policy()`: приватный
 *  режим выключен — приложение идёт напрямую, туннель поднят — в туннель, всё
 *  остальное — без сети. Это единственное место в окне, где видна судьба
 *  конкретного приложения, и разойтись со службой ему нельзя. */
function railTone(tunnel: Tunnel | undefined): string {
  switch (tunnel) {
    case "up":
      return "bg-open";
    case "connecting":
    case "down":
      return "bg-closed";
    // Выключено или службы нет: приложение ходит само, и хвастаться нечем.
    default:
      return "bg-muted";
  }
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

/** Переключатель охвата. Две кнопки, а не галочка «выбрать все»: «весь
 *  компьютер» — это отсутствие отбора, а не отбор целиком. Служба в этом режиме
 *  не сверяет ни одного пути к .exe, поэтому и список приложений тут ни при чём.
 *
 *  Стоит над списком, а не в шапке: он этим списком и распоряжается, а в шапке
 *  вместе с подписью, счётчиком и «найти установленные» не помещался — в окне
 *  минимальной ширины первым уезжала как раз подпись панели. */
function Scope({ all, lang, onPick }: { all: boolean; lang: Lang | undefined; onPick: (all: boolean) => void }) {
  const s = strings(lang);
  return (
    <div className="flex rounded-md border border-edge bg-surface-2 p-0.5">
      {([false, true] as const).map((value) => (
        <button
          key={String(value)}
          type="button"
          aria-pressed={all === value}
          onClick={() => onPick(value)}
          className={`smooth engraved flex-1 rounded-[3px] px-2 py-1.5 ${
            all === value ? "bg-surface text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {value ? s.scopeAll : s.scopeApps}
        </button>
      ))}
    </div>
  );
}

export function Apps({ status, act, className }: { status: Status | null; act: (req: Request) => void; className?: string }) {
  const s = strings(status?.lang);
  const all = status?.all_traffic ?? false;
  const apps = status?.apps ?? [];
  const on = apps.filter((a) => a.enabled).length;
  const icons = useIcons(apps);
  const [query, setQuery] = useState("");
  const shown = matching(ordered(apps), query);
  // Поле не прячем, пока в нём что-то есть: иначе фильтр остался бы включённым
  // и невидимым, а строки просто пропали бы.
  const searchable = apps.length > SEARCH_FROM || query !== "";

  return (
    <Panel
      className={className}
      title={s.apps}
      note={
        !all &&
        apps.length > 0 && (
          <span className="text-muted">
            {s.appsCount(on, apps.length)}
            {query !== "" && ` · ${s.appsShown(shown.length)}`}
          </span>
        )
      }
      action={
        // Искать приложения, когда их всё равно не отбирают, незачем.
        !all && (
          <Button variant="quiet" onClick={() => act({ cmd: "discover", arg: { env: {} } })}>
            {s.discover}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Scope all={all} lang={status?.lang} onPick={(enabled) => act({ cmd: "set-all-traffic", arg: { enabled } })} />
        {/* Список не показывается вовсе, а не гасится: он сейчас ни на что не
            влияет, и оставить его на виду значило бы соврать про судьбу строк. */}
        {all ? (
          <Empty>{s.scopeAllNote}</Empty>
        ) : (
          <>
            <AddField
              placeholder={s.appPlaceholder}
              label={s.addApp}
              onSubmit={(path) => act({ cmd: "add-app", arg: { path } })}
            />
            {searchable && <SearchField value={query} onChange={setQuery} placeholder={s.searchApps} />}
            {apps.length === 0 ? (
              <Empty>{s.noApps}</Empty>
            ) : shown.length === 0 ? (
              <Empty>{s.noMatches}</Empty>
            ) : (
              <ul className="flex flex-col">
                {shown.map((app) => (
                  <li
                    key={app.path}
                    className="enter smooth relative flex items-center gap-3 rounded-md py-1.5 pl-3 pr-1 hover:bg-surface-2"
                  >
                    {/* Рельс слева: что происходит с приложением прямо сейчас,
                        видно по строке целиком, а не по состоянию мелкой галочки. */}
                    <span
                      className={`smooth absolute inset-y-1 left-0 w-[3px] rounded-full ${
                        app.enabled ? railTone(status?.tunnel) : "bg-transparent"
                      }`}
                    />
                    <input
                      id={app.path}
                      type="checkbox"
                      checked={app.enabled}
                      onChange={(e) => act({ cmd: "set-app", arg: { path: app.path, enabled: e.target.checked } })}
                      // Галочка — действие оператора, а не состояние канала:
                      // цвета состояний ей не положены, иначе зелёная галочка
                      // спорила бы с янтарным рельсом той же строки.
                      className="size-4 shrink-0 accent-[var(--pg-accent)]"
                    />
                    {/* Место под иконку держится всегда: без него строки без иконки
                        съезжали бы влево, а пустой квадрат — это шум. */}
                    {icons[app.path] ? (
                      <img src={icons[app.path]} alt="" className="size-5 shrink-0" />
                    ) : (
                      <span className="size-5 shrink-0" />
                    )}
                    <label htmlFor={app.path} className="min-w-0 flex-1 cursor-pointer leading-tight">
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
                      onClick={() => act({ cmd: "remove-app", arg: { path: app.path } })}
                    >
                      ✕
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
