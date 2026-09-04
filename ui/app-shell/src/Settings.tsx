/** Настройки: всё, что читают раз в месяц, а не раз в минуту, — и потому лежит
 *  за кнопкой в титульной полосе, а не занимает постоянную полку в окне. Пока
 *  настройки открыты, списки не показываются: окно маленькое, и две вещи разом
 *  в нём всё равно не прочитать.
 *
 *  Охвата здесь нет: он не настройка, а главный выключатель продукта — им
 *  меняют, кого касается инвариант, и решают это глядя на состояние туннеля.
 *  Поэтому он стоит на шапке, у канала, чей левый конец и подписывает.
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
 *  Поэтому окно доводит до установщика и останавливается.
 *
 *  Строки собраны в группы, а не в один список через линейку. Список был
 *  ровный: девять одинаковых полос, у каждой подпись тем же гравированным
 *  шрифтом, что и у панели, — и найти в нём глазом «путь к sing-box» стоило
 *  чтения всех девяти. Теперь гравировкой подписана группа, а строка внутри —
 *  обычным текстом: разного размера подписи и есть то, чем список читается не
 *  подряд. Группы утоплены в плиту тем же пазом, что списки и поля, — новой
 *  поверхности ради настроек не заводится. */
import { useEffect, useState, type ReactNode } from "react";
import {
  autostart as readAutostart,
  isTauri,
  openLogs,
  openUrl,
  setAutostart,
  VERSION,
  type Act,
  type Lang,
  type Settings as ServiceSettings,
  type Status,
} from "./platform";
import { strings } from "./i18n";
import { Button, FIELD, Panel, Segmented } from "./ui";

const REPO = "Gerrux/proxybox";

type Release = {
  tag_name: string;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
};

/** Версия тега без `v`: тег `vX.Y.Z` собирает release.yml, а рядом с ним лежит
 *  та же версия из `tauri.conf.json` — уже без буквы. */
function version(tag: string): string {
  return tag.replace(/^v/, "");
}

/** Сравнение версий числами, а не строками: `0.10.0` больше `0.9.0`, хотя
 *  строкой меньше. Считает numeric-коллатор — свой разбор semver тут был бы
 *  тремя `parseInt` и одной ошибкой на ровном месте. */
const order = new Intl.Collator(undefined, { numeric: true });

function newer(tag: string, than: string): boolean {
  return order.compare(version(tag), version(than)) > 0;
}

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
      // Порядок GitHub — по дате, и это не порядок версий: патч к старой ветке,
      // выпущенный после новой минорной, лежит в списке сверху. Переставляем по
      // версии сами, потому что верхний релиз и есть то, что окно предлагает.
      //
      // Черновики и предрелизы не показываются вовсе: предлагать бету тому, кто
      // нажал «проверить обновления», — это предлагать её всем.
      const out = all.filter((x) => !x.draft && !x.prerelease);
      out.sort((a, b) => order.compare(version(b.tag_name), version(a.tag_name)));
      setReleases(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReleases(null);
    } finally {
      setBusy(false);
    }
  };

  // «Новее» — это именно больше нашей версии, а не «не равно ей»: на неравенстве
  // окно предлагало уйти назад, стоило выйти патчу к старой ветке. Список уже
  // переставлен по версии, поэтому наибольшая версия и есть верхний релиз.
  const latest = releases?.[0] ?? null;
  const fresh = latest != null && newer(latest.tag_name, VERSION);

  /** Само обновление — одно действие на оба места, где его предлагают: кнопку
   *  в титульной полосе и кнопку в настройках. Живёт здесь, рядом с `target`:
   *  полосе незачем знать, где у релиза лежит установщик. Полоса раньше вместо
   *  этого открывала настройки — то есть предлагала обновиться и вместо
   *  обновления показывала ещё одну кнопку «Скачать». */
  const openUpdate = () => {
    if (latest != null) void openUrl(target(latest));
  };

  return { releases, error, busy, check, latest, fresh, openUpdate };
}

export type Releases = ReturnType<typeof useReleases>;

/** Тема окна. Живёт в localStorage, а не в настройках службы: это привычка к
 *  окну, а не свойство туннеля, — как и запомненный выбор для крестика. Служба
 *  про цвета не знает ничего, и делить их с CLI не с кем.
 *
 *  «Системная» — это отсутствие атрибута, а не третье значение в CSS: пока его
 *  нет, `light-dark()` в `tokens.css` берёт то, что рисует Windows. Поэтому
 *  выбранная тема доезжает до окна одним атрибутом на корне документа, и ни
 *  одно правило стилей о ней не знает.
 *
 *  Мусор в ключе (правили руками, старая версия) читается как «системная»:
 *  неизвестное значение в `data-theme` попало бы мимо обоих правил и оставило
 *  бы то же самое, только молча.
 *
 *  Плашка из трея — отдельный документ, и localStorage у них общий, но
 *  прочитан он на её запуске: тему она подхватит следующим показом. */
const THEME = "pg.theme";

export type Theme = "system" | "light" | "dark";

export function useTheme() {
  const [theme, remember] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME);
    return saved === "light" || saved === "dark" ? saved : "system";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return {
    theme,
    pick: (next: Theme) => {
      localStorage.setItem(THEME, next);
      remember(next);
    },
  };
}

export type Themed = ReturnType<typeof useTheme>;

export function Settings({
  status,
  act,
  onClose,
  onError,
  rel,
  theme,
  className,
}: {
  status: Status | null;
  act: Act;
  onClose: () => void;
  /** Автозапуск правит оболочка, а не служба: её отказ баннеру команд не
   *  достаётся, и рассказать о нём больше нечем. */
  onError: (message: string) => void;
  rel: Releases;
  /** Тема живёт выше настроек: она красит всё окно, а не только эту панель, и
   *  обязана стоять и с закрытыми настройками. */
  theme: Themed;
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
      <div className="flex flex-col gap-5">
        <Group title={s.groupLook}>
          <Row title={s.language} note={s.languageHint}>
            <Segmented
              options={[
                ["ru", "ru", s.langRu],
                ["en", "en", s.langEn],
                ["fa", "fa", s.langFa],
                ["zh", "zh", s.langZh],
                ["tr", "tr", s.langTr],
                ["id", "id", s.langId],
              ]}
              value={lang ?? "ru"}
              className="well"
              onPick={(v) => void act({ cmd: "set-lang", arg: { lang: v as Lang } })}
            />
          </Row>

          <Row title={s.themeTitle} note={s.themeHint}>
            <Segmented
              options={[
                ["system", s.themeSystem],
                ["light", s.themeLight],
                ["dark", s.themeDark],
              ]}
              value={theme.theme}
              className="well"
              onPick={(v) => theme.pick(v as Theme)}
            />
          </Row>
        </Group>

        <Group title={s.groupStartup}>
          <Row title={s.autostartTitle} note={s.autostartHint}>
            <Autostart lang={lang} onError={onError} />
          </Row>
        </Group>

        <Group title={s.groupNodes}>
          <Row title={s.refreshSubs} note={s.refreshSubsHint}>
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              {/* Срок показывается только при включённой сверке: выключенной он
                  не значит ничего, а поле рядом с «выкл» читается как «а вот
                  через столько всё-таки сходим». */}
              {settings?.refresh && (
                <TextSetting
                  lang={lang}
                  value={String(settings.refresh_hours)}
                  placeholder={s.refreshHoursPlaceholder}
                  onSubmit={(hours) => {
                    // Мусор и ноль не отправляем вовсе: служба их всё равно
                    // подожмёт, но поле, вернувшееся другим числом без единого
                    // слова, читается как «не сохранилось».
                    const n = Number.parseInt(hours, 10);
                    patch({ refresh_hours: Number.isFinite(n) ? Math.min(720, Math.max(1, n)) : 6 });
                  }}
                />
              )}
              <OnOff lang={lang} value={settings?.refresh ?? true} disabled={!settings} onPick={(refresh) => patch({ refresh })} />
            </div>
          </Row>

          <Row title={s.geoTitle} note={s.geoHint}>
            <OnOff lang={lang} value={settings?.geo ?? true} disabled={!settings} onPick={(geo) => patch({ geo })} />
          </Row>
        </Group>

        <Group title={s.groupTunnel}>
          <Row title={s.probeTitle} note={s.probeHint}>
            <TextSetting
              lang={lang}
              value={settings?.probe ?? ""}
              placeholder={s.probePlaceholder}
              disabled={!settings}
              onSubmit={(probe) => patch({ probe })}
            />
          </Row>

          <Row title={s.singboxTitle} note={s.singboxHint}>
            <TextSetting
              lang={lang}
              value={settings?.singbox ?? ""}
              placeholder={s.singboxPlaceholder}
              disabled={!settings}
              onSubmit={(singbox) => patch({ singbox })}
            />
          </Row>

          {/* Единственный путь из окна к настоящей причине отказа: лента говорит,
              что туннель отвалился, а словами это объясняет только `singbox.log`.
              Открывает каталог оболочка — в браузере при разработке Проводника
              нет, поэтому там кнопка заперта. */}
          <Row title={s.logsTitle} note={s.logsHint}>
            <Button
              variant="ghost"
              disabled={!isTauri()}
              onClick={() => {
                void openLogs().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
              }}
            >
              {s.logsOpen}
            </Button>
          </Row>
        </Group>

        <Group title={s.groupAbout}>
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
              <Button variant="primary" onClick={rel.openUpdate}>
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
            <ul className="scroll enter max-h-40 overflow-y-auto border-t border-edge px-3.5 py-1.5 text-[13px]">
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

          {/* Дыры продукта видит тот, у кого он не работает, а до трекера от
              него дороги не было вовсе. Ведёт на форму заведения — снимок
              экрана человек прикладывает там же, перетаскиванием. */}
          <Row title={s.issueTitle} note={s.issueHint}>
            <Button variant="quiet" onClick={() => void openUrl(`https://github.com/${REPO}/issues/new`)}>
              {s.issueOpen}
            </Button>
          </Row>

        </Group>
      </div>
    </Panel>
  );
}

/** Группа настроек: гравированная подпись снаружи, сами строки — в утопленной
 *  плите, той же, в какой лежат списки и поля. Подпись стоит над плитой, а не
 *  внутри неё: внутри она стала бы ещё одной строкой и снова сравнялась бы с
 *  настройками, от которых её и отделяют. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="engraved mb-1.5 ps-1 text-muted">{title}</h3>
      <div className="overflow-hidden rounded-lg border border-edge bg-surface-2">{children}</div>
    </section>
  );
}

/** Строка настройки: слева — что это и почему, справа — чем этим управляют.
 *  В узком окне управление уезжает под подпись, а не сплющивает её.
 *
 *  Разделяет строки кромка самой строки, а не отдельная линейка между ними:
 *  первой она не нужна, и вычесть её из разметки — значит помнить про это в
 *  каждой группе. */
function Row({ title, note, children }: { title: string; note: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-edge px-3.5 py-3 first:border-t-0">
      <div className="min-w-[200px] flex-1">
        <h4 className="text-[13px] font-medium text-ink">{title}</h4>
        <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">{note}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Да/нет той же полоской, что и остальные развилки: галочка и тумблер — ещё
 *  два вида управления там, где хватает одного. */
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
      className="well"
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
        className={`${FIELD} well font-mono text-[11px]`}
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
