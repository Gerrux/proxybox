/** Настройки: всё, что читают раз в месяц, а не раз в минуту, — и потому лежит
 *  за кнопкой в титульной полосе, а не занимает постоянную полку в окне. Пока
 *  настройки открыты, списки не показываются: окно маленькое, и две вещи разом
 *  в нём всё равно не прочитать.
 *
 *  Сюда же уехал охват. Он не про список приложений, хотя и стоял над ним:
 *  «весь компьютер» — это отсутствие отбора, и список в этом режиме не
 *  применяется вовсе. Панель приложений об этом говорит и отсылает сюда.
 *
 *  Четыре настройки службы (сверка подписок, страна, цель пробы, путь к
 *  sing-box) до этого жили только в переменных окружения — то есть были у того,
 *  кто продукт собрал, и не были у того, кто его установил. Переменная
 *  по-прежнему сильнее: окно показывает действующее значение, а о перебивке
 *  служба говорит строкой в журнале.
 *
 *  Запрос к GitHub ручной и никогда не уходит сам — принцип «наружу ничего» тут
 *  тот же, что и у остального окна: пока не нажали, приложение с api.github.com
 *  не разговаривает. Отправляется при этом только сам GET, ничего о машине.
 *
 *  Ставит обновление человек: приложение живёт в Program Files и переустанавливает
 *  службу под LocalSystem, а сертификата у проекта пока нет — тихо подменять
 *  собственную привилегированную часть скачанным файлом без подписи нельзя.
 *  Поэтому окно доводит до установщика и останавливается. */
import { useEffect, useState, type ReactNode } from "react";
import {
  autostart as readAutostart,
  isTauri,
  openUrl,
  setAutostart,
  VERSION,
  type Act,
  type Lang,
  type Settings as ServiceSettings,
  type Status,
} from "./platform";
import { strings } from "./i18n";
import { Button, FIELD, Panel } from "./ui";

const REPO = "Gerrux/proxybox";

type Release = {
  tag_name: string;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  assets: { name: string; browser_download_url: string }[];
};

/** Установщик из релиза, а если его не приложили — страница релиза: там
 *  разберётся человек, а окно не должно врать ссылкой в никуда. */
function target(r: Release): string {
  return r.assets.find((a) => a.name.toLowerCase().endsWith(".exe"))?.browser_download_url ?? r.html_url;
}

/** Состояние проверки живёт выше настроек: про вышедшую версию говорит кнопка в
 *  титульной полосе, а она видна и с закрытыми настройками. Закрыли и открыли
 *  снова — окно не ходит в GitHub второй раз. */
export function useReleases() {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      // Все релизы, а не /latest: список нужен целиком — и чтобы показать, что
      // вообще выходило, и чтобы можно было вернуться на прежнюю версию.
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (!r.ok) throw new Error(`GitHub: ${r.status}`);
      const all = (await r.json()) as Release[];
      setReleases(all.filter((x) => !x.draft));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReleases(null);
    } finally {
      setBusy(false);
    }
  };

  // ponytail: «новее» = верхний релиз в списке отличается от нашей версии,
  // semver не разбираем. Потолок — патч к старой ветке, выпущенный после новой
  // минорной: он окажется сверху, и окно предложит уйти назад. Понадобится —
  // сравнивать разобранным semver, это единственное место.
  const latest = releases?.[0] ?? null;
  const fresh = latest != null && latest.tag_name.replace(/^v/, "") !== VERSION;

  return { releases, error, busy, check, latest, fresh };
}

export type Releases = ReturnType<typeof useReleases>;

export function Settings({
  status,
  act,
  onClose,
  onError,
  rel,
  className,
}: {
  status: Status | null;
  act: Act;
  onClose: () => void;
  /** Автозапуск правит оболочка, а не служба: её отказ баннеру команд не
   *  достаётся, и рассказать о нём больше нечем. */
  onError: (message: string) => void;
  rel: Releases;
  className?: string;
}) {
  const lang = status?.lang;
  const s = strings(lang);
  const [expanded, setExpanded] = useState(false);
  const { releases, error, busy, check, latest, fresh } = rel;
  const settings = status?.settings;

  // Настройки уходят набором целиком: служба принимает их так, а собирать
  // разницу на клиенте не из чего — она и есть весь набор.
  const patch = (change: Partial<ServiceSettings>) => {
    if (!settings) return;
    void act({ cmd: "set-settings", arg: { settings: { ...settings, ...change } } });
  };

  return (
    <Panel
      className={className}
      title={s.settings}
      action={
        <Button variant="quiet" onClick={onClose}>
          {s.done}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Row title={s.language} note={s.languageHint}>
          <Segmented
            options={[
              ["ru", "ru", s.langRu],
              ["en", "en", s.langEn],
            ]}
            value={lang ?? "ru"}
            onPick={(v) => void act({ cmd: "set-lang", arg: { lang: v as Lang } })}
          />
        </Row>

        <Line />

        {/* Охват — самая тяжёлая настройка продукта: «весь компьютер» уносит в
            туннель и то, за чем нет процесса. Поэтому она первой из тех, что
            меняют поведение, а не оформление. */}
        <Row title={s.scope} note={s.scopeHint}>
          <Segmented
            options={[
              ["apps", s.scopeApps],
              ["all", s.scopeAll],
            ]}
            value={status?.all_traffic ? "all" : "apps"}
            disabled={!status}
            onPick={(v) => void act({ cmd: "set-all-traffic", arg: { enabled: v === "all" } })}
          />
        </Row>

        <Line />

        <Row title={s.autostartTitle} note={s.autostartHint}>
          <Autostart lang={lang} onError={onError} />
        </Row>

        <Line />

        <Row title={s.refreshSubs} note={s.refreshSubsHint}>
          <OnOff lang={lang} value={settings?.refresh ?? true} disabled={!settings} onPick={(refresh) => patch({ refresh })} />
        </Row>

        <Line />

        <Row title={s.geoTitle} note={s.geoHint}>
          <OnOff lang={lang} value={settings?.geo ?? true} disabled={!settings} onPick={(geo) => patch({ geo })} />
        </Row>

        <Line />

        <Row title={s.probeTitle} note={s.probeHint}>
          <TextSetting
            lang={lang}
            value={settings?.probe ?? ""}
            placeholder={s.probePlaceholder}
            disabled={!settings}
            onSubmit={(probe) => patch({ probe })}
          />
        </Row>

        <Line />

        <Row title={s.singboxTitle} note={s.singboxHint}>
          <TextSetting
            lang={lang}
            value={settings?.singbox ?? ""}
            placeholder={s.singboxPlaceholder}
            disabled={!settings}
            onSubmit={(singbox) => patch({ singbox })}
          />
        </Row>

        <Line />

        <Row
          title={s.versionAndUpdates}
          note={
            <>
              {s.version} <span className="font-mono text-[12px] text-ink">{VERSION}</span>
              {latest && fresh && <span className="text-accent"> · {s.updateAvailable(latest.tag_name)}</span>}
              {releases != null && !fresh && <span> · {s.upToDate}</span>}
              {/* Не дозвонились до GitHub — это поломка, а не запертый канал:
                  янтарь тут значил бы сработавшую защиту, которой здесь нет. */}
              {error != null && <span className="selectable text-fault"> · {error}</span>}
              <br />
              {s.updatesHint}
            </>
          }
        >
          {latest && fresh && (
            <Button variant="primary" onClick={() => void openUrl(target(latest))}>
              {s.download}
            </Button>
          )}
          {releases != null && releases.length > 0 && (
            <Button variant="quiet" onClick={() => setExpanded((v) => !v)}>
              {s.allReleases(releases.length)}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void check()}>
            {busy ? s.checking : s.checkUpdates}
          </Button>
        </Row>

        {expanded && releases != null && (
          <ul className="enter max-h-40 overflow-y-auto border-t border-edge pt-2 text-[13px]">
            {releases.map((r) => (
              <li key={r.tag_name} className="flex items-center gap-3 py-1">
                <span
                  className={`font-mono text-[12px] tabular-nums ${r.tag_name.replace(/^v/, "") === VERSION ? "text-accent" : ""}`}
                >
                  {r.tag_name}
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {r.published_at ? new Date(r.published_at).toLocaleDateString(lang ?? "ru") : ""}
                </span>
                <span className="flex-1" />
                <Button variant="quiet" onClick={() => void openUrl(target(r))}>
                  {s.download}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** Строка настройки: слева — что это и почему, справа — чем этим управляют.
 *  В узком окне управление уезжает под подпись, а не сплющивает её. */
function Row({ title, note, children }: { title: string; note: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="min-w-[200px] flex-1">
        <h3 className="engraved text-muted">{title}</h3>
        <p className="mt-1 text-[12.5px] text-muted">{note}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Line() {
  return <div className="h-px bg-edge" />;
}

/** Переключатель из нескольких значений. Один на язык, охват и тумблеры:
 *  выбранное различимо и без цвета (`aria-pressed`) — как у любой другой
 *  развилки в этом окне. */
function Segmented({
  options,
  value,
  onPick,
  disabled,
}: {
  /** `[значение, надпись]` либо `[значение, надпись, подсказка]`. */
  options: [string, string, string?][];
  value: string;
  onPick: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-0.5 rounded-md border border-edge bg-surface-2 p-0.5">
      {options.map(([id, label, hint]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          title={hint}
          disabled={disabled}
          onClick={() => onPick(id)}
          className={`smooth engraved rounded-[3px] px-3.5 py-1.5 disabled:opacity-40 ${
            value === id ? "bg-surface text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function OnOff({
  lang,
  value,
  onPick,
  disabled,
}: {
  lang: Lang | undefined;
  value: boolean;
  onPick: (value: boolean) => void;
  disabled?: boolean;
}) {
  const s = strings(lang);
  return (
    <Segmented
      options={[
        ["on", s.switchOn],
        ["off", s.switchOff],
      ]}
      value={value ? "on" : "off"}
      disabled={disabled}
      onPick={(v) => onPick(v === "on")}
    />
  );
}

/** Настройка строкой: путь и адрес правят вручную, и уходить в службу на каждое
 *  нажатие клавиши им нельзя — служба на каждую команду переписывает state.json.
 *  Отсюда кнопка, а не сохранение по вводу.
 *
 *  Черновик перечитывается, когда снаружи пришло другое значение: статус ходит
 *  по кругу каждые две секунды, и без этого поле стирало бы себя на каждом
 *  круге, — но и правку из-под рук уносить оно не должно. */
function TextSetting({
  lang,
  value,
  placeholder,
  onSubmit,
  disabled,
}: {
  lang: Lang | undefined;
  value: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  disabled?: boolean;
}) {
  const s = strings(lang);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft.trim() !== value;
  return (
    <form
      className="flex min-w-[240px] flex-1 gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSubmit(draft.trim());
      }}
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        className={`${FIELD} font-mono text-[11px]`}
      />
      <Button type="submit" variant="primary" disabled={disabled || !changed}>
        {s.apply}
      </Button>
    </form>
  );
}

/** Автозапуск спрашивается у оболочки один раз: ключ реестра под нами не
 *  меняется, а статус службы про него ничего не знает — это не её дело. */
function Autostart({ lang, onError }: { lang: Lang | undefined; onError: (message: string) => void }) {
  const s = strings(lang);
  const desktop = isTauri();
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    void readAutostart().then(setOn).catch(() => {});
  }, [desktop]);

  if (!desktop) {
    return <span className="text-[12.5px] text-muted">{s.autostartWindowsOnly}</span>;
  }
  return (
    <OnOff
      lang={lang}
      value={on}
      onPick={(want) => {
        void setAutostart(want)
          .then(setOn)
          // Реестр отказал — тумблер обязан вернуться туда, где он на самом
          // деле, а не остаться там, куда его нажали.
          .catch((e: unknown) => {
            onError(e instanceof Error ? e.message : String(e));
            void readAutostart().then(setOn).catch(() => {});
          });
      }}
    />
  );
}
