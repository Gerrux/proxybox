import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hideWindow, isFlyout, isTauri, openMain, VERSION, type Lang } from "./platform";
import { strings } from "./i18n";
import { Button } from "./ui";

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
 * У плашки из трея своя полоса: сворачивать её некуда, разворачивать не во что,
 * а «закрыть» для неё значит спрятаться. Вместо трёх кнопок — «открыть окно» и
 * крестик, который прячет; перетаскивания нет вовсе, потому что плашка стоит у
 * значка, и сдвинутая оттуда перестаёт быть плашкой.
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
  const flyout = isFlyout();
  const s = strings(lang);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop || flyout) return;
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
  }, [desktop, flyout]);

  const run = (action: "minimize" | "toggleMaximize" | "close") => void getCurrentWindow()[action]();

  return (
    <header
      data-tauri-drag-region={!flyout}
      className="flex h-8 shrink-0 items-center gap-2 overflow-hidden border-b border-edge bg-surface pl-3"
    >
      <span data-tauri-drag-region={!flyout} className="tb-name engraved min-w-0 truncate text-muted">
        {title}
      </span>
      {/* Версия — такое же показание прибора, как задержка и байты: число
          моноширинное, подпись ушла в подсказку. */}
      <span className="tb-version shrink-0 font-mono text-[11px] tabular-nums text-muted" title={s.version}>
        {VERSION}
      </span>
      <span data-tauri-drag-region={!flyout} className="min-w-0 flex-1" />
      {/* Точка перед надписью: новость видно и краем глаза, не читая строку. */}
      {update != null && (
        <Button
          variant="ghost"
          className="h-6 gap-1.5 bg-transparent px-2.5 text-accent"
          title={s.updateTo(update)}
          onClick={onUpdate}
        >
          <span className="size-1.5 rounded-full bg-accent" />
          {s.updateTo(update)}
        </Button>
      )}
      <Button
        variant={settingsOpen ? "ghost" : "quiet"}
        aria-pressed={settingsOpen}
        aria-label={s.settings}
        title={s.settingsHint}
        onClick={onSettings}
        className="h-6 w-6 px-0"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2 4.5h10M2 9.5h10" />
          <circle cx="5" cy="4.5" r="1.6" fill="var(--pg-surface)" />
          <circle cx="9.5" cy="9.5" r="1.6" fill="var(--pg-surface)" />
        </svg>
      </Button>
      {/* Плашка: вместо трёх кнопок — уйти в главное окно и спрятаться. */}
      {flyout && (
        <>
          <WindowButton label={s.openWindow} onClick={() => void openMain()}>
            <rect x="2" y="4" width="6" height="6" />
            <path d="M4 4V2h6v6h-2" />
          </WindowButton>
          <WindowButton label={s.hidePanel} onClick={() => void hideWindow()}>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </WindowButton>
        </>
      )}
      {desktop && !flyout && (
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

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-8 w-11 shrink-0 place-items-center text-muted transition-colors ${
        danger ? "hover:bg-fault hover:text-bg" : "hover:bg-surface-2 hover:text-ink"
      }`}
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
