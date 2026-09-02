import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, VERSION, type Lang } from "./platform";
import { strings } from "./i18n";

/**
 * Своя титульная полоса. Окно рисуется без системной рамки (`decorations:
 * false` в `tauri.conf.json`) — с ней над панелью состояния стояла бы вторая
 * полоса с тем же названием, и главное, что окно рассказывает, начиналось бы
 * со второго этажа сверху.
 *
 * Что рамка давала бесплатно и теперь наше:
 *  - перетаскивание — `data-tauri-drag-region` на пустых местах полосы. Именно
 *    на пустых: атрибут, накрывающий кнопки, отдал бы их нативному drag-циклу,
 *    а тот съедает клик. Двойной клик по тем же местам разворачивает окно —
 *    это tao делает сам;
 *  - тяга за края для ресайза остаётся нативной: `WM_NCHITTEST` у безрамочного
 *    окна tao обрабатывает сам, плагина для этого не нужно;
 *  - три кнопки — здесь.
 *
 * Права `core:window:allow-{start-dragging,minimize,toggle-maximize,
 * is-maximized,close}` дописаны в `capabilities/default.json`: в наборе
 * `core:default` их нет, и без них вызовы молча отклоняются.
 *
 * Здесь же живут версия, обновление и вход в настройки. Раньше это был подвал
 * окна — целая плита под тем, что читают раз в месяц, пока список профилей
 * делил остаток высоты с журналом. В полосе они занимают то место, которое всё
 * равно пустует, а на ширине плашки из трея имя и версия уходят совсем
 * (`.tb-name`, `.tb-version` в `index.css`): кнопки окна важнее.
 *
 * Значки — свои `<svg>`, а не глифы шрифта: `Segoe MDL2 Assets` есть не на
 * всякой системе, а отсутствующий глиф — это пустой квадрат вместо «закрыть».
 * «Закрыть» красится в `fault`, а не в `closed`: янтарь запертого канала —
 * штатное состояние продукта, а не разрушительное действие.
 *
 * В браузере (разработка без Tauri) полоса остаётся, но без трёх кнопок и без
 * перетаскивания: рамку там рисует сам браузер, а настройки и обновления нужны
 * и в разработке.
 *
 * У плашки из трея полосы нет вовсе (`App.tsx` её не рисует): сворачивать
 * некуда, разворачивать не во что, двигать нельзя — плашка стоит у значка.
 * Остальное у неё уже есть без полосы: «открыть окно» и «настройки» — в меню
 * значка, а прячут её Esc, потеря фокуса и повторный клик по значку.
 *
 * ponytail: системного меню окна по правому клику нет. У безрамочного окна
 * полоса лежит в клиентской области, куда Windows своё меню не приносит; чтобы
 * оно появилось, нужна команда в `src-tauri` с `TrackPopupMenu`. Потолок —
 * привычный жест не работает; апгрейд — по образцу Арбогео
 * (`src-tauri/src/window_menu.rs`).
 */
export function TitleBar({
  title,
  lang,
  /** Тег вышедшего релиза, если окно о нём уже спросило. Само оно наружу не
   *  ходит: кнопка появляется только после ручной проверки в настройках. */
  update,
  /** Открывает установщик вышедшего релиза — то же самое, что кнопка
   *  «Скачать» в настройках, одним нажатием. Раньше здесь открывались сами
   *  настройки: кнопка звала обновиться и показывала вместо обновления ещё
   *  одну кнопку. Действие живёт в `useReleases`. */
  onUpdate,
  settingsOpen,
  onSettings,
}: {
  title: string;
  lang: Lang | undefined;
  update: string | null;
  onUpdate: () => void;
  settingsOpen: boolean;
  onSettings: () => void;
}) {
  const desktop = isTauri();
  const s = strings(lang);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const win = getCurrentWindow();
    const sync = () =>
      void win.isMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      });
    sync();
    // Развернуть можно и мимо кнопки — двойным кликом, Win+↑, снапом к краю.
    // Иконка обязана следовать за окном, а не за своим кликом.
    void win.onResized(sync).then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  const run = (action: "minimize" | "toggleMaximize" | "close") => void getCurrentWindow()[action]();

  return (
    <header
      data-tauri-drag-region
      className="flex h-8 shrink-0 items-center gap-2 overflow-hidden border-b border-edge bg-surface pl-3"
    >
      <span data-tauri-drag-region className="tb-name engraved min-w-0 truncate text-muted">
        {title}
      </span>
      {/* Версия — такое же показание прибора, как задержка и байты: число
          моноширинное, подпись ушла в подсказку. */}
      <span className="tb-version shrink-0 font-mono text-[11px] tabular-nums text-muted" title={s.version}>
        {VERSION}
      </span>
      <span data-tauri-drag-region className="min-w-0 flex-1" />
      {/* Точка перед надписью: новость видно и краем глаза, не читая строку. */}
      {update != null && (
        <button
          type="button"
          className={`${TB_BUTTON} flex items-center gap-1.5 px-2.5 text-accent hover:bg-surface-2`}
          title={s.updateTo(update)}
          onClick={onUpdate}
        >
          <span className="size-1.5 rounded-full bg-accent" />
          {s.updateTo(update)}
        </button>
      )}
      {/* Настройки — такая же кнопка полосы, как «свернуть» и «закрыть»: одна
          высота, одна ширина, одна подсветка под курсором. Своя, поменьше и без
          подложки, рядом с ними читалась как пустое место. Открытые настройки
          кнопка держит нажатой — иначе полоса не отличает «там сейчас» от «туда
          можно».

          Шестерня, а не ползунки: ползунки значат «покрутить прямо здесь», а
          кнопка открывает целую панель.

          Шестернёй её делает отверстие, а не зубья — это проверено рисованием.
          Сплошная втулка с восемью штрихами наружу читается солнцем, сколько
          зубья ни укорачивай: у солнца ровно такой силуэт. Стоит проколоть
          середину, и та же картинка становится шестернёй. Поэтому здесь три
          окружности смысла: обод, дырка и зубья от обода наружу.

          Зубьев восемь, а не шесть: на 12 пикселях восемь сливаются в
          зубчатый обод, а шесть остаются шестью отростками, то есть звездой.
          Заливки нет нигде — под курсором подложка меняется, и залитое цветом
          поверхности показало бы прошлый фон. */}
      <WindowButton label={s.settings} title={s.settingsHint} onClick={onSettings} pressed={settingsOpen}>
        <circle cx="6" cy="6" r="3.4" />
        <circle cx="6" cy="6" r="1.2" />
        <path d="M9.4 6h1.1M8.4 8.4l.78.78M6 9.4v1.1M3.6 8.4l-.78.78M2.6 6H1.5M3.6 3.6L2.82 2.82M6 2.6V1.5M8.4 3.6l.78-.78" />
      </WindowButton>
      {desktop && (
        <>
          <WindowButton label={s.minimizeWindow} onClick={() => run("minimize")}>
            <path d="M2 6h8" />
          </WindowButton>
          <WindowButton label={maximized ? s.restoreWindow : s.maximizeWindow} onClick={() => run("toggleMaximize")}>
            {maximized ? (
              <>
                <rect x="2" y="4" width="6" height="6" />
                <path d="M4 4V2h6v6h-2" />
              </>
            ) : (
              <rect x="2.5" y="2.5" width="7" height="7" />
            )}
          </WindowButton>
          <WindowButton label={s.closeWindow} onClick={() => run("close")} danger>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </WindowButton>
        </>
      )}
    </header>
  );
}

/** Общий вид кнопки титульной полосы. Кнопки стоят вплотную и читаются как
 *  один ряд, поэтому высота, реакция на курсор и её плавность обязаны быть
 *  одной строкой на всех: разъедутся — и ряд рассыплется на разнородные
 *  детали. Подсветка сюда не входит намеренно, у «закрыть» она своя.
 *  Кнопка обновления берёт отсюда только контейнер: цвет у неё свой,
 *  акцентный, и под курсором он остаётся — им она и говорит, зачем она тут. */
const TB_BUTTON = "h-8 shrink-0 transition-colors";
const TB_HOVER = "hover:bg-surface-2 hover:text-ink";

function WindowButton({
  label,
  title,
  onClick,
  danger,
  pressed,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  danger?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      onClick={onClick}
      className={`${TB_BUTTON} grid w-11 place-items-center ${
        pressed ? "bg-surface-2 text-ink" : "text-muted"
      } ${danger ? "hover:bg-fault hover:text-bg" : TB_HOVER}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}
