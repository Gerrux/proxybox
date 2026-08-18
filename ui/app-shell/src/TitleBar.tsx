import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, type Lang } from "./platform";
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
 * Значки — свои `<svg>`, а не глифы шрифта: `Segoe MDL2 Assets` есть не на
 * всякой системе, а отсутствующий глиф — это пустой квадрат вместо «закрыть».
 *
 * В браузере (разработка без Tauri) полосы нет вовсе — там рамку рисует сам
 * браузер.
 *
 * ponytail: системного меню окна по правому клику нет. У безрамочного окна
 * полоса лежит в клиентской области, куда Windows своё меню не приносит; чтобы
 * оно появилось, нужна команда в `src-tauri` с `TrackPopupMenu`. Потолок —
 * привычный жест не работает; апгрейд — по образцу Арбогео
 * (`src-tauri/src/window_menu.rs`).
 */
export function TitleBar({ title, lang }: { title: string; lang: Lang | undefined }) {
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

  if (!desktop) return null;

  const run = (action: "minimize" | "toggleMaximize" | "close") => void getCurrentWindow()[action]();

  return (
    <header
      data-tauri-drag-region
      className="flex h-8 shrink-0 items-center border-b border-edge bg-surface pl-3"
    >
      <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-xs text-muted">
        {title}
      </span>
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
      className={`grid h-8 w-11 place-items-center text-muted transition-colors ${
        danger ? "hover:bg-closed hover:text-bg" : "hover:bg-surface-2 hover:text-ink"
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
