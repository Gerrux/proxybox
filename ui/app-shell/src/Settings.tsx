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
 *  Строки собраны в разделы, а не в один список через линейку: разделов восемь,
 *  и найти глазом «путь к sing-box» среди двадцати полос стоило чтения всех.
 *  Слева — оглавление (липкое), справа — разделы подряд; нажатие в оглавлении
 *  прокручивает к разделу, а подсвечивает текущий `IntersectionObserver`:
 *  опроса и таймеров нет, событие даёт сама прокрутка. Порядок — по частоте
 *  обращений: внешний вид и подписки открывают каждую неделю, диагностику и
 *  «о программе» — когда что-то сломалось. Пока ширины на колонку не хватает,
 *  оглавление ложится полосой сверху и прокручивается вбок. Ширину спрашиваем
 *  у самой панели, а не у окна: выше 1100 px рейка и панели делят окно иначе,
 *  и `max-width` про это молчит (тот же замер, что и у списка профилей).
 *
 *  Подсказка строки — две строки текста и «подробнее», а не весь абзац: четыре
 *  подсказки в пять строк каждая превращали экран в чтение. Нужна ли кнопка,
 *  решает замер (`Note`): подсказка, которая помещается, кнопки не получает.
 *  Подсказки при этом остались теми же строками — сокращён показ, не текст. */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  autostart as readAutostart,
  call,
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
import { strings, type Strings } from "./i18n";
import { Button, CopyButton, FIELD, Icon, Modal, Panel, SearchField, Segmented, Switch, useBoxWidth } from "./ui";
import { ruleSets } from "./ruleSets";

const REPO = "Gerrux/proxybox";

/** Ширина панели, с которой оглавление встаёт колонкой слева. Колонка в 176 px
 *  плюс отступы оставляют разделу около 500 px — строка настройки с полем в
 *  240 px и подписью в 200 помещается в один ряд; уже панели оглавление
 *  занимало бы место у самих настроек, и оно ложится полосой сверху. */
const INDEX_FROM = 720;

/** Верхний край полосы, в которой раздел считается «текущим»: полоса оглавления
 *  в узком виде (~44 px) и отступ раздела. Нижний — 55% высоты прокрутки, чтобы
 *  текущим был тот раздел, что занимает верх экрана, а не тот, что только
 *  показался внизу. */
const SPY_MARGIN = "-56px 0px -55% 0px";

/** Слова для подсказок строк. Строка настройки стоит глубоко в разметке, и
 *  тащить в неё `Strings` пропсом через каждую группу — шум; контекст у одной
 *  панели, и читают его только `Note` и оглавление. */
const Words = createContext<Strings>(strings(undefined));

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
  // Журнал sing-box поверх панели, а не полосой внутри неё: строк там сотни, и
  // раздвинутая ими настройка уехала бы за нижний край вместе со всем прочим.
  const [showLog, setShowLog] = useState(false);
  const { releases, error, busy, check, latest, fresh } = rel;
  const settings = status?.settings;

  // Настройки уходят набором целиком: служба принимает их так, а собирать
  // разницу на клиенте не из чего — она и есть весь набор.
  const patch = (change: Partial<ServiceSettings>) => {
    if (!settings) return;
    void act({ cmd: "set-settings", arg: { settings: { ...settings, ...change } } });
  };

  // Разделы в порядке частоты обращений. «Раздельно» есть, только когда
  // настройки пришли: без них нечего показать, а пустой раздел в оглавлении
  // вёл бы в никуда. Подпись в оглавлении короткая (`scopeSplit`), заголовок
  // раздела — полное имя режима.
  const sections: { key: string; label: string }[] = [
    { key: "look", label: s.groupLook },
    { key: "subs", label: s.groupNodes },
    { key: "tunnel", label: s.groupTunnel },
    ...(settings ? [{ key: "split", label: s.scopeSplit }] : []),
    { key: "bypass", label: s.bypassTitle },
    { key: "startup", label: s.groupStartup },
    { key: "diag", label: s.groupDiagnostics },
    { key: "about", label: s.groupAbout },
  ];
  const keys = sections.map((x) => x.key).join();

  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<HTMLElement>(null);
  const row = useBoxWidth(rootRef) < INDEX_FROM;
  const [active, setActive] = useState("look");

  // Подсветка текущего раздела. Наблюдатель за пересечением, а не слушатель
  // прокрутки: событие приходит, только когда раздел вошёл в полосу или вышел
  // из неё, а не на каждый пиксель. Ни одного раздела в полосе нет — остаётся
  // прежний: длинный раздел может занять её целиком, и подсветка не должна
  // гаснуть посреди него.
  //
  // Последний раздел короткий и до верха экрана не доезжает никогда, даже
  // когда прокручено до упора, — его «видит» отдельный наблюдатель за меткой
  // в конце списка, и только пока что-то прокручено: если всё помещается,
  // метка видна всегда и последним объявляться было бы нечестно.
  useEffect(() => {
    const root = rootRef.current;
    const box = root?.closest(".scroll");
    if (!root || !(box instanceof HTMLElement)) return;
    const order = keys.split(",");
    const seen = new Set<string>();
    let bottom = false;
    const decide = () => {
      if (bottom && box.scrollTop > 0) return setActive(order[order.length - 1]);
      const first = order.find((k) => seen.has(k));
      if (first) setActive(first);
    };
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const k = (e.target as HTMLElement).dataset.section;
          if (!k) continue;
          if (e.isIntersecting) seen.add(k);
          else seen.delete(k);
        }
        decide();
      },
      { root: box, rootMargin: SPY_MARGIN },
    );
    root.querySelectorAll("[data-section]").forEach((el) => spy.observe(el));
    const end = new IntersectionObserver(
      ([e]) => {
        bottom = !!e?.isIntersecting;
        decide();
      },
      { root: box },
    );
    if (endRef.current) end.observe(endRef.current);
    return () => {
      spy.disconnect();
      end.disconnect();
    };
  }, [keys]);

  // В полосе подсвеченный пункт обязан быть виден: полоса прокручивается вбок,
  // и текущий раздел, чей пункт ушёл за край, подсвечивался бы вслепую.
  // Двигаем саму полосу, а не зовём `scrollIntoView` у пункта: тот прокручивает
  // заодно и все предки, то есть обрывал плавную прокрутку разделов на первой
  // же смене подсветки (замерено: нажатие шло на 53 px и вставало). `scrollBy`
  // физический, поэтому одинаково работает и справа налево.
  useEffect(() => {
    const bar = indexRef.current;
    const item = bar?.querySelector('[aria-current="true"]');
    if (!row || !bar || !item) return;
    const b = bar.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (r.left < b.left) bar.scrollBy({ left: r.left - b.left });
    else if (r.right > b.right) bar.scrollBy({ left: r.right - b.right });
  }, [active, row]);

  const go = (key: string) => {
    setActive(key);
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rootRef.current
      ?.querySelector(`[data-section="${key}"]`)
      ?.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
  };

  const index = (
    <nav
      ref={indexRef}
      aria-label={s.settingsSections}
      className={row ? "scroll flex gap-1 overflow-x-auto px-3 py-1.5" : "flex w-44 flex-none flex-col gap-0.5"}
    >
      {sections.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-current={active === key ? "true" : undefined}
          onClick={() => go(key)}
          className={`set-item smooth h-8 px-3 text-start text-sm text-muted aria-[current=true]:text-ink ${
            row ? "shrink-0 whitespace-nowrap" : "truncate"
          }`}
          title={label}
        >
          {label}
        </button>
      ))}
    </nav>
  );

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
      <Words.Provider value={s}>
      <div ref={rootRef} className={row ? "set-narrow" : "flex items-start"}>
        {row ? <div className="set-bar">{index}</div> : <div className="sticky top-0 flex-none ps-3 pt-4">{index}</div>}
      <div className="mx-auto flex min-w-0 max-w-3xl flex-1 flex-col gap-8 p-4 pb-8">
        <Group id="look" title={s.groupLook}>
          <Row title={s.language} note={s.languageHint}>
            {/* Каждый язык назван на самом себе, а ниже мелко — на языке окна.
                Пока названия были только на языке окна, вернуть свой язык из
                чужого было нечем: китаец, по ошибке включивший персидский,
                искал «中文» в списке вязи. Самоназвание от языка окна не
                зависит, поэтому живёт константой здесь, а не словарём.

                Кнопками, а не выпадающим списком: язык меняют одним нажатием,
                и все шесть видны сразу — список прятал их за лишний щелчок.
                Колонок три, пока каждая не уже 9rem, иначе две: в 380 px
                «Bahasa Indonesia» в третьей колонке обрезалась. */}
            <div
              role="radiogroup"
              aria-label={s.language}
              className="grid w-full max-w-md grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1.5"
            >
              {(
                [
                  ["ru", "Русский", s.langRu],
                  ["en", "English", s.langEn],
                  ["fa", "فارسی", s.langFa],
                  ["zh", "中文", s.langZh],
                  ["tr", "Türkçe", s.langTr],
                  ["id", "Bahasa Indonesia", s.langId],
                ] as const
              ).map(([code, own, here]) => {
                const on = (lang ?? "ru") === code;
                return (
                  <button
                    key={code}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    title={here}
                    onClick={() => !on && void act({ cmd: "set-lang", arg: { lang: code as Lang } })}
                    className={`smooth flex min-w-0 flex-col items-start rounded border px-2.5 py-1.5 text-start ${
                      on
                        ? "border-accent bg-[color-mix(in_oklch,var(--pg-accent)_10%,transparent)]"
                        : "border-edge hover:bg-[var(--pg-hover)]"
                    }`}
                  >
                    {/* `lang` — чтобы вязь и иероглифы подбирали свой шрифт и в
                        русском окне; `<bdi>` — чтобы «فارسی» читалась справа
                        налево, но стояла по общему краю с соседями, а не
                        уезжала к правой кромке кнопки, как от `dir="auto"`. */}
                    <span lang={code} className="w-full truncate text-sm font-semibold">
                      <bdi>{own}</bdi>
                    </span>
                    {/* На своём языке второе название повторило бы первое. */}
                    <span className="w-full truncate text-xs text-muted">{own === here ? " " : here}</span>
                  </button>
                );
              })}
            </div>
          </Row>

          <Row title={s.themeTitle} note={s.themeHint}>
            <Segmented
              options={[
                ["system", s.themeSystem],
                ["light", s.themeLight],
                ["dark", s.themeDark],
              ]}
              value={theme.theme}
              onPick={(v) => theme.pick(v as Theme)}
            />
          </Row>
        </Group>

        <Group id="subs" title={s.groupNodes}>
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

        <Group id="tunnel" title={s.groupTunnel}>
          <Row title={s.probeTitle} note={s.probeHint}>
            <TextSetting
              lang={lang}
              value={settings?.probe ?? ""}
              placeholder={s.probePlaceholder}
              disabled={!settings}
              onSubmit={(probe) => patch({ probe })}
            />
          </Row>

          <Row title={s.failoverTitle} note={s.failoverHint}>
            <OnOff
              lang={lang}
              value={settings?.failover ?? false}
              disabled={!settings}
              onPick={(failover) => patch({ failover })}
            />
          </Row>

        </Group>

        {settings && (
          <Group id="split" title={s.splitTitle}>
            <p className="border-b border-edge py-3 text-sm text-muted">{s.splitSitesPointer}</p>
            <details className="border-b border-edge py-3">
              <summary className="cursor-pointer text-sm">{s.rulesReady} · {s.rulesSelected(settings.direct_rule_sets?.length ?? 0)}</summary>
              <div className="pt-3">
                <h4 className="text-sm">{s.splitRuleSets}</h4>
                <p className="mb-3 mt-0.5 text-xs text-muted">{s.splitRulesNote}</p>
                <RuleSets lang={lang} value={settings.direct_rule_sets ?? []} onSubmit={(direct_rule_sets) => patch({ direct_rule_sets })} />
              </div>
            </details>
          </Group>
        )}

        <Group id="bypass" title={s.bypassTitle}>
          <Bypass lang={lang} rules={status?.bypass ?? []} act={act} />
        </Group>

        <Group id="startup" title={s.groupStartup}>
          <Row title={s.autostartTitle} note={s.autostartHint}>
            <Autostart lang={lang} onError={onError} />
          </Row>
        </Group>

        <Group id="diag" title={s.groupDiagnostics}>
          <Row title={s.singboxTitle} note={s.singboxHint}>
            <TextSetting
              lang={lang}
              value={settings?.singbox ?? ""}
              placeholder={s.singboxPlaceholder}
              disabled={!settings}
              onSubmit={(singbox) => patch({ singbox })}
            />
          </Row>

          {/* Путь из окна к настоящей причине отказа: лента говорит, что туннель
              отвалился, а словами это объясняет только `singbox.log`. Дверей
              две, и вторая нужна не для красоты: каталог открывает оболочка,
              то есть только Windows и только с Проводником, — а хвост показывает
              сама служба, и он есть везде, включая разработку в браузере. */}
          <Row title={s.logsTitle} note={s.logsHint}>
            <Button variant="ghost" onClick={() => setShowLog(true)}>
              {s.logsShow}
            </Button>
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

        <Group id="about" title={s.groupAbout}>
          {/* Состояние обновления — не подсказка, а ответ на нажатие: он
              стоит отдельной строкой под именем и под сокращение не попадает,
              иначе «вышла новая версия» пряталась бы за «подробнее». */}
          <Row
            title={s.versionAndUpdates}
            status={
              <>
                {s.version} <span className="font-semibold text-ink">{VERSION}</span>
                {latest && fresh && <span className="text-accent"> · {s.updateAvailable(latest.tag_name)}</span>}
                {releases != null && !fresh && <span> · {s.upToDate}</span>}
                {/* Не дозвонились до GitHub — это поломка, а не запертый канал:
                    янтарь тут значил бы сработавшую защиту, которой здесь нет. */}
                {error != null && <span className="selectable text-fault"> · {error}</span>}
              </>
            }
            note={s.updatesHint}
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
            <ul className="scroll enter max-h-48 overflow-y-auto border-b border-edge px-2 py-1 text-sm">
              {releases.map((r) => (
                <li key={r.tag_name} className="row flex items-center gap-3 ps-2">
                  <span
                    className={`tabular-nums ${r.tag_name.replace(/^v/, "") === VERSION ? "font-semibold text-accent" : ""}`}
                  >
                    {r.tag_name}
                  </span>
                  <span className="text-xs text-muted">
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
          <Row title={s.shortcutsTitle} note={s.shortcutsHint} />

          <Row title={s.issueTitle} note={s.issueHint}>
            <Button variant="quiet" onClick={() => void openUrl(`https://github.com/${REPO}/issues/new`)}>
              {s.issueOpen}
            </Button>
          </Row>
        </Group>
        <div ref={endRef} aria-hidden className="-mt-8 h-px" />
      </div>
      </div>
      </Words.Provider>
      {showLog && <SingboxLog s={s} onClose={() => setShowLog(false)} />}
    </Panel>
  );
}

/** Хвост `singbox.log` прямо в окне — то, что пишет о себе сам sing-box.
 *
 *  Ленте службы этого не заменить и не поручить: она говорит, что туннель
 *  отвалился, а почему — знает только он, и до сих пор ответ лежал за словами
 *  «зайдите в %ProgramData%», то есть ровно тогда, когда у человека уже нет
 *  сети. Тридцати строк ленты тут мало и по другой причине: sing-box пишет
 *  сотнями, и в ленту из них попадает одна — последняя с `outbound/`.
 *
 *  Спрашивается, пока панель открыта, и по тому же правилу, что соединения:
 *  это чтение с диска в службе, и платить за него, когда никто не смотрит,
 *  незачем. Прячут окно в трей — опрос останавливается там же, где и статус.
 *
 *  Прокрутку вниз сама не тянет: строка, которую читают, уезжала бы из-под
 *  глаз каждые две секунды. Свежие внизу, и открытая панель уже там. */
function SingboxLog({ s, onClose }: { s: Strings; onClose: () => void }) {
  // `null` — ещё не спрашивали: пустой файл и неотвеченный запрос выглядят
  // одинаково, а сказать про них надо разное.
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let gone = false;
    const ask = () => {
      if (document.hidden) return;
      void call({ cmd: "singbox-log" })
        .then((r) => {
          if (!gone && r.reply === "singbox-log") setLines(r.data.lines);
        })
        // Служба замолчала — про это во весь рост говорит шапка окна, а
        // последнее известное честнее пустоты.
        .catch(() => {});
    };
    ask();
    const id = setInterval(ask, 2000);
    return () => {
      gone = true;
      clearInterval(id);
    };
  }, []);
  return (
    <Modal title={s.logsTitle} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <div className="field scroll max-h-[55vh] overflow-auto rounded-md p-2">
          {lines == null || lines.length === 0 ? (
            // Ответ идёт с местного диска и приходит мгновенно, так что
            // ожидание тут — не состояние, а мигание: своей строки, которую
            // пришлось бы переводить на шесть языков, оно не стоит.
            <p className="p-1 text-sm text-muted">{lines == null ? "…" : s.logsEmpty}</p>
          ) : (
            // Перенос по любому месту, а не по словам: в строках лога адреса и
            // пути без пробелов, и по словам они уезжали бы за правый край.
            <pre className="selectable whitespace-pre-wrap break-all font-mono text-xs text-muted">
              {lines.join("\n")}
            </pre>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{s.logsTail}</span>
          {lines != null && lines.length > 0 && (
            <CopyButton text={() => lines.join("\n")} label={s.copyLog} done={s.copied} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Группа настроек: подпись над группой, под ней строки, разделённые
 *  волосяными линиями, — как в плоских окнах системы, а не карточки
 *  «Параметров»: в стопке одинаковых карточек глаз не отличал группу от
 *  строки. Подпись стоит снаружи, а не внутри: внутри она стала бы ещё одной
 *  строкой и снова сравнялась бы с настройками, от которых её и отделяют. */
function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-section={id}>
      <h3 className="mb-1 text-base font-semibold">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

type RowProps = { title: string | null; note: ReactNode; status?: ReactNode; children?: ReactNode };

/** Строка настройки: слева — что это и почему, справа — чем этим управляют,
 *  под строкой волосяная линия. В узком окне управление уезжает под подпись,
 *  а не сплющивает её.
 *
 *  Уезжает — но переносом, а не выездом за край. `shrink-0` на блоке управления
 *  этого не различал: он запрещал сжатие вовсе, поэтому блок брал ширину по
 *  содержимому и держал её, даже когда содержимое шире окна. В плашке из трея
 *  строка «сверять подписки» так и делала: поле требует 240 px, полоска
 *  «вкл/выкл» рядом — ещё 125, и вторая уезжала на сотню пикселей за правый
 *  край. Горизонтальной прокрутки у окна нет (`overflow-hidden` на плите), так
 *  что переключатель не просто не был виден — до него нельзя было дотянуться.
 *
 *  Перенос от этого не пострадал: flex решает, переносить ли, по нужной ширине
 *  элемента, а не по сжатой, — управление по-прежнему уходит под подпись целиком
 *  вместо того, чтобы плющиться рядом с ней. Сжатие включается ступенью позже,
 *  когда и на своей строке блок не помещается, — и тогда внутренний `flex-wrap`
 *  раскладывает поле и переключатель на две строки. Сторож —
 *  `no_setting_is_out_of_reach_in_the_flyout`.
 *
 *  Строки разведены линиями, а не карточками: карточка на каждую настройку
 *  делала настройки неотличимыми от панелей, а окно — стопкой плиток.
 *
 *  Управление прижато к концу строки (`ms-auto`), а не к подписи: колонка
 *  управлений в разных строках ровная, и по ней глаз идёт сверху вниз. Заголовка
 *  у строки может не быть (`title` — `null`): у раздела «Исключения» он совпал
 *  бы с заголовком самого раздела. Не бывает и управления — строка «Клавиши»
 *  только читается, и пустой блок не рисуется. `status` — то, что отвечает на
 *  действие (версия, ошибка проверки), и под сокращение подсказки оно не
 *  попадает. */
function Row({ title, note, status, children }: RowProps) {
  return (
    <div className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-edge py-3">
      <div className="min-w-[200px] flex-1">
        {title != null && <h4 className="text-sm">{title}</h4>}
        {status != null && <p className="mt-0.5 text-xs text-muted">{status}</p>}
        <Note>{note}</Note>
      </div>
      {children != null && (
        <div className="ms-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
      )}
    </div>
  );
}

/** Подсказка строки: две строки и «подробнее». Кнопка появляется, только когда
 *  текст действительно не поместился, — это решает замер (`scrollHeight` против
 *  `clientHeight` свернутого абзаца), а не длина строки: ту же фразу в 380 px
 *  и в 900 px читают за разное число строк, и на длину глазом не угадать.
 *
 *  Замер повторяется на каждую отрисовку и на смену размера самого абзаца:
 *  язык, перенос под шириной панели и ответ GitHub меняют текст, не меняя
 *  числа строк в свернутом виде. В развёрнутом виде мерить нечем — клампа нет,
 *  — поэтому прежний ответ остаётся и кнопка «свернуть» не пропадает. */
function Note({ children }: { children: ReactNode }) {
  const s = useContext(Words);
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOver(el.scrollHeight > el.clientHeight + 1);
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const watch = new ResizeObserver(() => setOver(el.scrollHeight > el.clientHeight + 1));
    watch.observe(el);
    return () => watch.disconnect();
  }, [open]);
  return (
    <>
      <p ref={ref} className={`mt-0.5 text-xs text-muted ${open ? "" : "line-clamp-2"}`}>
        {children}
      </p>
      {(over || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs text-accent hover:underline"
        >
          {open ? s.noteLess : s.noteMore}
        </button>
      )}
    </>
  );
}

/** Да/нет — тумблером Fluent с подписью состояния слева, как в «Параметрах».
 *  Полоска «вкл | выкл», которой это было, в Windows значит выбор из
 *  вариантов, а не выключатель. */
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
    <label className={`flex items-center gap-3 text-sm ${disabled ? "opacity-40" : "cursor-pointer"}`}>
      <span className="min-w-8 text-end">{value ? s.switchOn : s.switchOff}</span>
      <Switch checked={value} disabled={disabled} label={value ? s.switchOn : s.switchOff} onChange={onPick} />
    </label>
  );
}

function RuleSets({ lang, value, onSubmit }: { lang: Lang | undefined; value: string[]; onSubmit: (value: string[]) => void }) {
  const s = strings(lang);
  const saved = value.join("\n");
  const [draft, setDraft] = useState(saved);
  const [query, setQuery] = useState("");
  useEffect(() => setDraft(saved), [saved]);
  const urls = [...new Set(draft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  const valid = urls.every((raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash
        && /\.(json|srs)$/.test(url.pathname);
    } catch { return false; }
  }) && urls.length <= 64;
  const catalog = ruleSets(s);
  const shown = catalog.filter((set) => `${set.name} ${set.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pick = (url: string, checked: boolean) => {
    setDraft((checked ? [...urls, url] : urls.filter((item) => item !== url)).join("\n"));
  };
  return (
    <form className="flex w-full min-w-0 flex-col items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit(urls); }}>
      <div className="w-full">
        <h5 className="mb-2 text-sm font-semibold">{s.rulesReady}</h5>
        <SearchField value={query} onChange={setQuery} placeholder={s.rulesSearch} />
        <ul aria-label={s.rulesReady} className="scroll mt-2 max-h-64 overflow-y-auto">
          {shown.map((set) => (
            <li key={set.url} className="row flex items-center gap-3 py-2">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3" title={set.url}>
                <input type="checkbox" checked={urls.includes(set.url)} onChange={(e) => pick(set.url, e.target.checked)} className="size-4 shrink-0 accent-[var(--pg-accent)]" />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{set.name}</span>
                  <span className="block truncate text-xs text-muted">{set.source}{set.kind === "ip" && ` · ${s.rulesIpTag}`}</span>
                </span>
              </label>
              <Button variant="quiet" onClick={() => void openUrl(`https://github.com/${set.source}`)}>{s.rulesSource}</Button>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="py-2 text-sm text-muted">{s.noMatches}</p>}
        {catalog.some((set) => set.kind === "ip" && urls.includes(set.url)) && (
          <p className="mt-2 text-xs text-muted">{s.rulesIpHint}</p>
        )}
        <details className="mt-3" open={urls.some((url) => !catalog.some((set) => set.url === url)) || undefined}>
          <summary className="cursor-pointer text-sm">{s.rulesCustom}</summary>
          <textarea aria-label={s.splitRuleSets} aria-invalid={!valid} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="https://example.com/rules.srs" spellCheck={false} rows={4} className={`${FIELD} mt-2 min-w-0 resize-y font-mono text-xs`} />
        </details>
      </div>
      {!valid && <p role="alert" className="text-xs text-fault">{s.splitRulesInvalid}</p>}
      <span className="text-xs text-muted">{s.rulesSelected(urls.length)}</span>
      <Button type="submit" variant="primary" disabled={!valid || urls.join("\n") === saved}>{s.apply}</Button>
    </form>
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
        className={`${FIELD} font-mono text-xs`}
      />
      <Button type="submit" variant="primary" disabled={disabled || !changed}>
        {s.apply}
      </Button>
    </form>
  );
}

/** Исключения: адреса и домены, которые идут мимо туннеля под настоящим
 *  адресом человека. Это единственное место продукта, где трафик выходит в
 *  открытую сеть осознанно, поэтому исключение — всегда явный и видимый выбор:
 *  заводит его только человек, а список лежит на виду целиком.
 *
 *  Список уходит службе целиком, а не по одному: она проверяет набор разом и
 *  при единственной плохой строке отказывает всему. Её отказ уже переведён и
 *  показывается здесь же, под полем, — баннер сверху про неё скажет тоже, но
 *  глаз человека в этот момент у поля, в которое он только что печатал.
 *
 *  Нормализует службу, а не окно: к `a.b.c.d/32` одиночный адрес приводит она,
 *  и список ниже показывает то, что она запомнила, а не то, что напечатано. */
function Bypass({
  lang,
  rules,
  act,
}: {
  lang: Lang | undefined;
  rules: string[];
  act: Act;
}) {
  const s = strings(lang);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = (next: string[], then?: () => void) => {
    setBusy(true);
    setError(null);
    void act({ cmd: "set-bypass", arg: { rules: next } })
      .then((r) => {
        if (r?.reply === "error") setError(r.data.message);
        else then?.();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Несколько записей разом — через пробел, запятую или перенос строки: так их
  // и вставляют из заметок.
  const entries = draft.split(/[\s,;]+/).filter(Boolean);

  return (
    <div>
      {/* Заголовка у строки нет: он совпал бы с заголовком раздела. */}
      <Row title={null} note={s.bypassHint}>
        <form
          className="flex min-w-[240px] flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (entries.length === 0 || busy) return;
            send([...rules, ...entries.filter((x) => !rules.includes(x))], () => setDraft(""));
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={s.bypassPlaceholder}
            aria-label={s.bypassTitle}
            spellCheck={false}
            className={`${FIELD} font-mono text-xs`}
          />
          <Button type="submit" variant="primary" disabled={busy || entries.length === 0}>
            {s.bypassAdd}
          </Button>
        </form>
      </Row>
      {error != null && <p className="selectable border-b border-edge py-2 ps-2 text-xs text-fault">{error}</p>}
      {rules.length === 0 ? (
        <p className="border-b border-edge py-2 ps-2 text-xs text-muted">{s.bypassEmpty}</p>
      ) : (
        <ul className="flex flex-col border-b border-edge py-1">
          {rules.map((rule) => (
            <li key={rule} className="row flex items-center gap-2 ps-2">
              <span className="selectable min-w-0 flex-1 truncate font-mono text-xs">{rule}</span>
              <Button
                variant="danger"
                disabled={busy}
                aria-label={s.bypassRemove(rule)}
                className="w-8 px-0"
                onClick={() => send(rules.filter((x) => x !== rule))}
              >
                <Icon name="close" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
    return <span className="text-sm text-muted">{s.autostartWindowsOnly}</span>;
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
