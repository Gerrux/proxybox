import { useCallback, useEffect, useState } from "react";
import {
  browse as openBrowser,
  call,
  hideWindow,
  isFlyout,
  onShell,
  quitApp,
  type Act,
  type BrowserProfile,
  type Lang,
  type Request,
  type Response,
  type Status,
} from "./platform";
import { strings } from "./i18n";
import { Apps } from "./Apps";
import { Browsers } from "./Browsers";
import { Conns } from "./Conns";
import { Journal } from "./Journal";
import { Profiles } from "./Profiles";
import { Settings, useReleases } from "./Settings";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Button } from "./ui";

/** Что делать с крестиком, если человек попросил больше не спрашивать. Живёт в
 *  localStorage окна, а не в настройках службы: это привычка к окну, а не
 *  свойство туннеля, и делить её с CLI не с кем. */
const CLOSE_CHOICE = "pg.close";

/** Опрос статуса. Служба тикает раз в 3 с, чаще спрашивать нечего. */
const POLL_MS = 2000;
/** Пока туннель поднимается, две секунды до обновления — целая вечность на
 *  глаз. Подключение длится секунды, а не часы, лишний трафик по петле дешёвый. */
const POLL_BUSY_MS = 600;

/** Что показано под шапкой. Одна панель за раз — окно у нас маленькое: 900×620
 *  это минимум, а из трея его открывают плашкой в 380 px, и делить эту высоту
 *  на четыре списка значит не показать ни одного. Шире 1100 px делить нечего,
 *  и первые три встают рядом (`.panes` в `index.css`); браузерные профили
 *  остаются вкладкой на любой ширине — четвёртой колонки нет. */
type Tab = "profiles" | "apps" | "journal" | "browsers" | "conns";

/** Вкладки, живущие во всю ширину: своей колонки в `.panes` у них нет, и на
 *  широком экране они закрывают собой все три панели разом. Соединения сюда
 *  попали не по размеру, а по смыслу: их читают, когда сомневаются в туннеле, —
 *  и тогда списки профилей рядом только мешают. */
const WIDE: Tab[] = ["browsers", "conns"];

/** Показана ли панель. Классом, а не атрибутом: className есть у всех трёх
 *  панелей и так, а `data-*` пришлось бы протаскивать через каждую из них и
 *  через сам `Panel`. */
function pane(tab: Tab, own: Tab): string {
  return tab === own ? "pane pane-on" : "pane";
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Сколько команд в полёте. Служба отвечает на команду только закончив работу
  // (reapply перезапускает sing-box, не отпуская мьютекс), поэтому «ждём» —
  // единственное, что окно может честно показать всё это время.
  const [busy, setBusy] = useState(0);
  const [tab, setTab] = useState<Tab>("profiles");
  // Настройки закрывают собой списки, а не приписываются к ним снизу: язык и
  // обновления читают раз в месяц, и постоянной полки в окне им не положено.
  const [settings, setSettings] = useState(false);
  // Про вышедшую версию говорит кнопка в титульной полосе, и знать о ней надо
  // с закрытыми настройками тоже — значит, состояние проверки живёт здесь.
  const rel = useReleases();
  // Крестик спрашивает, а не решает: свернуть в трей или закрыть совсем — это
  // выбор человека, и один раз сделанный он запоминается.
  const [closing, setClosing] = useState(false);
  // Плашка из трея — то же приложение во втором окне: раскладка у неё уже
  // сжата шириной, а вот титульная полоса и вопрос при закрытии ей ни к чему.
  const flyout = isFlyout();

  const send = useCallback(async (req: Request): Promise<Response | null> => {
    try {
      const r = await call(req);
      // Ошибку баннер только показывает, но никогда не снимает по своей воле:
      // сразу за командой идёт перечитывание статуса, и «успех» от него стирал
      // бы сообщение раньше, чем его успевали прочитать. Снимает ошибку
      // следующая команда или крестик.
      if (r.reply === "error") setError(r.data.message);
      if (r.reply === "status") setStatus(r.data);
      return r;
    } catch {
      // Служба не отвечает — про это во весь рост говорит шапка (status === null),
      // и повторять то же самое баннером незачем. Заодно такое сообщение
      // некому было бы снять: команды в этом состоянии не проходят.
      setStatus(null);
      return null;
    }
  }, []);

  const refresh = useCallback(() => send({ cmd: "status" }), [send]);

  const connecting = status?.tunnel === "connecting";
  useEffect(() => {
    void refresh();
    // Спрятанное в трей окно живёт сколько угодно долго, и спрашивать за него
    // некому: подпись значка обновляет оболочка сама. Показали обратно —
    // ближайший тик и вернёт свежий статус.
    const id = setInterval(() => {
      // Спрятанная плашка живёт в вебвью и дальше, а `document.hidden` про
      // спрятанное окно молчит: спрашиваем только пока она в руках.
      if (!document.hidden && (!flyout || document.hasFocus())) void refresh();
    }, connecting ? POLL_BUSY_MS : POLL_MS);
    return () => clearInterval(id);
  }, [refresh, connecting, flyout]);

  // Показали плашку — статус нужен сразу, а не через две секунды: её открывают
  // именно затем, чтобы посмотреть, что сейчас.
  useEffect(() => {
    if (!flyout) return;
    const wake = () => void refresh();
    // Esc — привычный способ закрыть выпадающую панель, и другого у плашки нет:
    // крестик в полосе делает то же самое.
    const key = (e: KeyboardEvent) => e.key === "Escape" && void hideWindow();
    window.addEventListener("focus", wake);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("focus", wake);
      window.removeEventListener("keydown", key);
    };
  }, [flyout, refresh]);

  // Настройки из меню значка: оболочка поднимает окно и говорит, что показать.
  useEffect(() => onShell("open-settings", () => setSettings(true)), []);

  // Крестик главного окна. Оболочка закрытие остановила и спросила нас —
  // отвечаем либо запомненным выбором, либо вопросом.
  useEffect(
    () =>
      // У плашки своего крестика нет, и чужой ей не адресован: закрытие она
      // отрабатывает в оболочке — просто прячется.
      flyout
        ? () => {}
        : onShell("close-requested", () => {
            const remembered = localStorage.getItem(CLOSE_CHOICE);
            if (remembered === "quit") return void quitApp();
            if (remembered === "hide") return void hideWindow();
            setClosing(true);
          }),
    [flyout],
  );

  // Команда и сразу перечитанный статус: окно не гадает, что получилось, —
  // единственный источник истины остаётся у службы.
  const act = useCallback<Act>(
    (req: Request) => {
      // Прошлая ошибка снимается здесь: новое действие — новый разговор.
      setError(null);
      setBusy((n) => n + 1);
      return send(req)
        .then((r) => refresh().then(() => r != null && r.reply !== "error"))
        .finally(() => setBusy((n) => n - 1));
    },
    [send, refresh],
  );

  // Браузер запускает оболочка, а не служба, поэтому это не обычная команда:
  // ответ со статусом сюда не приходит, и показать нечего, кроме отказа.
  const browse = useCallback((profile: BrowserProfile, color: string) => {
    setError(null);
    setBusy((n) => n + 1);
    void openBrowser(profile, color)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy((n) => n - 1));
  }, []);

  // Решение принято в момент нажатия, а служба ответит через секунды. Показываем
  // намерение сразу — ближайший статус всё равно перепишет его правдой, и врать
  // это не даёт: «подключение» и так означает «сети у выбранных приложений нет».
  const toggle = () => {
    if (!status) return;
    if (status.tunnel !== "off") {
      setStatus({ ...status, tunnel: "off" });
      return act({ cmd: "off" });
    }
    const profile = status.profile ?? status.profiles[0];
    if (!profile) return;
    setStatus({ ...status, tunnel: "connecting", profile });
    act({ cmd: "on", arg: { profile } });
  };

  const s = strings(status?.lang);
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <TitleBar
        title="Privacy Gateway"
        lang={status?.lang}
        update={rel.latest && rel.fresh ? rel.latest.tag_name : null}
        onUpdate={() => setSettings(true)}
        settingsOpen={settings}
        onSettings={() => setSettings((v) => !v)}
      />
      {/* Содержимое не растягивается на всю ширину монитора: строки метрик и
          списков читаются глазом, а не рулеткой. Но и 1024 px на 27" — окно в
          окне, поэтому широкому экрану даётся третья колонка.

          Страница не прокручивается никогда: высоту делят шапка и ровно одна
          панель, и прокрутка живёт внутри неё. Это и есть цена, ради которой
          панели разошлись по вкладкам. */}
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-2.5 overflow-hidden p-3 xl:max-w-[1600px]">
        <StatusBar status={status} busy={busy > 0} onToggle={toggle} />

        {error && (
          // Ошибка команды — это поломка, а не запертый канал: цвет тот же, что
          // у «служба не отвечает», и другой, чем у сработавшей защиты.
          <div className="enter flex shrink-0 items-start gap-3 rounded-lg border border-edge bg-fault-soft px-4 py-3 text-[13px] text-fault">
            <p className="selectable min-w-0 flex-1">{error}</p>
            <Button variant="quiet" aria-label={s.hideMessage} onClick={() => setError(null)}>
              ✕
            </Button>
          </div>
        )}

        {settings ? (
          <Settings
            className="min-h-0 flex-1"
            status={status}
            act={act}
            onClose={() => setSettings(false)}
            onError={setError}
            rel={rel}
          />
        ) : (
          <>
            {/* Табы со счётчиками: сколько там строк, видно не открывая. Узкая
                полоса и широкая «Главная» — одна навигация в двух видах, кто из
                них показан, решает `index.css` по ширине окна. */}
            <nav className="tabs flex shrink-0 gap-0.5 rounded-md border border-edge bg-surface-2 p-0.5">
              <TabButton className="tab-narrow" active={tab === "profiles"} onClick={() => setTab("profiles")}
                label={s.profiles} count={status?.profiles.length ?? 0} />
              <TabButton className="tab-narrow" active={tab === "apps"} onClick={() => setTab("apps")}
                label={s.apps} count={status?.all_traffic ? "—" : `${inTunnel}/${status?.apps.length ?? 0}`} />
              <TabButton className="tab-narrow" active={tab === "journal"} onClick={() => setTab("journal")}
                label={s.journal} count={status?.log.length ?? 0} />
              {/* Шире 1100 px первые три стоят рядом, и выбирать между ними
                  нечего: остаётся развилка «списки или браузерные профили». */}
              <TabButton className="tab-wide" active={!WIDE.includes(tab)} onClick={() => setTab("profiles")}
                label={s.tabMain} />
              <TabButton active={tab === "browsers"} onClick={() => setTab("browsers")}
                label={s.tabBrowsers} count={status?.browser_profiles.length ?? 0} />
              {/* Счётчика у соединений нет: сколько их, знает только сама
                  панель, а спрашивать это ради подписи на закрытой вкладке
                  значило бы опрашивать службу всегда — ровно то, чего эта
                  панель и не делает. */}
              <TabButton active={tab === "conns"} onClick={() => setTab("conns")} label={s.tabConns} />
            </nav>

            {tab === "browsers" ? (
              <Browsers status={status} act={act} browse={browse} className="min-h-0 flex-1" />
            ) : tab === "conns" ? (
              <Conns status={status} className="min-h-0 flex-1" />
            ) : (
              <div className="panes gap-2.5">
                <Profiles className={pane(tab, "profiles")} status={status} act={act} busy={busy > 0} />
                <Apps className={pane(tab, "apps")} status={status} act={act} busy={busy > 0} />
                <Journal className={pane(tab, "journal")} lines={status?.log ?? []} lang={status?.lang} />
              </div>
            )}
          </>
        )}
      </div>

      {closing && (
        <CloseDialog
          lang={status?.lang}
          onPick={(choice, remember) => {
            if (remember) localStorage.setItem(CLOSE_CHOICE, choice);
            setClosing(false);
            void (choice === "quit" ? quitApp() : hideWindow());
          }}
          onCancel={() => setClosing(false)}
        />
      )}
    </div>
  );
}

/** Вопрос по крестику: свернуть или закрыть совсем.
 *
 *  Своим окном, а не системным диалогом: окно безрамочное, и родная рамка
 *  посреди него выглядела бы чужой — но главное, сказать надо больше, чем
 *  помещается в кнопки. Продукт держит туннель и правила без окна, и «закрыть»
 *  здесь значит «остаться без единственного места, где это видно».
 *
 *  Отмена (Esc и клик мимо) — это «передумал закрывать», а не «сверни»:
 *  молчаливое действие по невнятному жесту тут дороже лишнего клика. */
function CloseDialog({
  lang,
  onPick,
  onCancel,
}: {
  lang: Lang | undefined;
  onPick: (choice: "hide" | "quit", remember: boolean) => void;
  onCancel: () => void;
}) {
  const s = strings(lang);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div
      className="absolute inset-0 z-10 grid place-items-center bg-bg/70 p-6"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={s.closeTitle}
        onClick={(e) => e.stopPropagation()}
        className="enter flex w-full max-w-md flex-col gap-3 rounded-lg border border-edge bg-surface p-5 shadow-lg"
      >
        <h2 className="font-display text-[17px] font-semibold">{s.closeTitle}</h2>
        <p className="text-[13px] text-muted">{s.closeHint}</p>
        <p className="text-[12.5px] text-muted">{s.closeWarn}</p>
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-4 accent-[var(--pg-accent)]"
          />
          {s.closeRemember}
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="quiet" onClick={() => onPick("quit", remember)}>
            {s.closeQuit}
          </Button>
          <Button variant="primary" autoFocus onClick={() => onPick("hide", remember)}>
            {s.closeToTray}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Кнопка таба: подпись и счётчик строк за ней. Счётчик — не украшение: он
 *  единственное, что говорит о закрытой панели хоть что-то. */
function TabButton({
  label,
  count,
  active,
  onClick,
  className = "",
}: {
  label: string;
  count?: number | string;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`smooth inline-flex min-w-0 flex-1 items-baseline justify-center gap-1.5 rounded-[3px] px-1.5 py-1.5 ${
        active ? "bg-surface text-ink" : "text-muted hover:text-ink"
      } ${className}`}
    >
      <span className="engraved truncate">{label}</span>
      {count != null && <span className="shrink-0 text-[11px] text-muted">{count}</span>}
    </button>
  );
}
