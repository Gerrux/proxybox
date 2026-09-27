import { useCallback, useEffect, useRef, useState } from "react";
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
  type Scope,
  type Status,
} from "./platform";
import { dir, strings } from "./i18n";
import { Apps } from "./Apps";
import { Browsers } from "./Browsers";
import { Conns } from "./Conns";
import { Journal } from "./Journal";
import { Profiles } from "./Profiles";
import { Settings, useReleases, useTheme } from "./Settings";
import { StatusBar, tunnelState } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Welcome } from "./Welcome";
import { Flyout } from "./Flyout";
import { Button, Icon, IconButton, type IconName } from "./ui";

/** Что делать с крестиком, если человек попросил больше не спрашивать. Живёт в
 *  localStorage окна, а не в настройках службы: это привычка к окну, а не
 *  свойство туннеля, и делить её с CLI не с кем. */
const CLOSE_CHOICE = "pg.close";

/** Опрос статуса. Служба тикает раз в 3 с, чаще спрашивать нечего. */
const POLL_MS = 2000;
/** Пока туннель поднимается, две секунды до обновления — целая вечность на
 *  глаз. Подключение длится секунды, а не часы, лишний трафик по петле дешёвый. */
const POLL_BUSY_MS = 600;

/** Что показано справа от рейки. Одна панель за раз — окно у нас маленькое:
 *  380×520 это минимум, и делить эту высоту на четыре списка значит не
 *  показать ни одного. Шире 1100 px делить нечего, и первые три встают рядом
 *  (`.panes` в `index.css`); браузерные профили остаются пунктом на любой
 *  ширине — четвёртой колонки нет. */
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
  // Тема красит всё окно, а не панель настроек, и стоять обязана с первого
  // рендера — задолго до того, как настройки вообще откроют.
  const theme = useTheme();
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
      // Пульс — вырезка из статуса: подменяются только горячие поля, всё
      // остальное (списки, журнал, настройки) остаётся тем, что приехало с
      // последним полным статусом.
      if (r.reply === "pulse") {
        const p = r.data;
        setStatus(
          (was) =>
            was && {
              ...was,
              tunnel: p.tunnel,
              profile: p.profile,
              latency_ms: p.latency_ms,
              country: p.country,
              rx: p.rx,
              tx: p.tx,
              traffic_at: p.traffic_at,
              retry_in: p.retry_in,
              testing: p.testing,
            },
        );
      }
      return r;
    } catch {
      // Служба не отвечает — про это во весь рост говорит шапка (status === null),
      // и повторять то же самое баннером незачем. Заодно такое сообщение
      // некому было бы снять: команды в этом состоянии не проходят.
      setStatus(null);
      return null;
    }
  }, []);

  // Опрос идёт пульсом, а не статусом: полный статус везёт весь список
  // профилей и журнал, и на подписке в сотни узлов это сотня килобайт и полная
  // перерисовка окна каждые две секунды — ради двух чисел трафика. За полным
  // окно идёт, когда отпечаток холодной части (`cold`) сменился или статуса
  // ещё нет вовсе. Отпечаток запоминается вместе с пульсом, а не с ответом:
  // сменившееся между пульсом и статусом всплывёт следующим пульсом.
  const coldRef = useRef<number | null>(null);
  const haveStatus = status !== null;
  const refresh = useCallback(async () => {
    if (!haveStatus) return send({ cmd: "status" });
    const r = await send({ cmd: "pulse" });
    if (r?.reply === "pulse" && r.data.cold !== coldRef.current) {
      coldRef.current = r.data.cold;
      return send({ cmd: "status" });
    }
    return r;
  }, [send, haveStatus]);

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
  // Ctrl+, — настройки, как в редакторах. По коду клавиши, а не по символу:
  // на русской раскладке та же клавиша даёт «б». Остальные клавиши живут у
  // своих панелей (`Profiles`): им нужно знать, видна ли панель.
  useEffect(() => {
    if (flyout) return;
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "Comma") {
        e.preventDefault();
        setSettings((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [flyout]);

  // Направление письма ставится на корне документа, а не на панелях: с фарси
  // зеркалить надо и раскладку, и прокрутку, и порядок слов внутри строки, а
  // это умеет браузер — но только если сказать ему один раз и сверху.
  // Раскладка тут вся на flex и grid, поэтому переворачивается сама; штучных
  // отступов осталось меньше десятка, и все они логические (`ps-`/`pe-`).
  //
  // `lang` заодно чинит перенос строк и подбор шрифта: без него браузер
  // считает персидский текст русским — так написано в index.html.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = status?.lang ?? "ru";
    root.dir = dir(status?.lang);
  }, [status?.lang]);

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
        .then((r) => refresh().then(() => r))
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
    const profile = status.profile ?? status.profiles[0]?.name;
    if (!profile) return;
    setStatus({ ...status, tunnel: "connecting", profile });
    void act({ cmd: "on", arg: { profile } });
  };

  const s = strings(status?.lang);
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;
  const setScope = (scope: Scope) => void act({ cmd: "set-scope", arg: { scope } });

  // Плашка из трея — своя раскладка (`Flyout.tsx`): её открывают глянуть и
  // переключить, а не читать списки.
  if (flyout) {
    return (
      <div className="app h-full overflow-hidden" data-state={tunnelState(status)}>
        <Flyout
          status={status}
          act={act}
          busy={busy > 0}
          error={error}
          onError={setError}
          onToggle={toggle}
          onScope={setScope}
        />
      </div>
    );
  }

  // Пункт рейки закрывает настройки: они лежат поверх панелей, и пункт,
  // нажатый под открытыми настройками, иначе не делал бы ничего видимого.
  const pick = (next: Tab) => {
    setSettings(false);
    setTab(next);
  };

  return (
    <div className="app relative flex h-full flex-col overflow-hidden" data-state={tunnelState(status)}>
      <TitleBar
        title="proxybox"
        lang={status?.lang}
        update={rel.latest && rel.fresh ? rel.latest.tag_name : null}
        onUpdate={rel.openUpdate}
        settingsOpen={settings}
        onSettings={() => setSettings((v) => !v)}
      />
      {/* Окно — одна плоская поверхность от края до края, как Проводник или
          Диспетчер задач: плита состояния и линейка во всю ширину, под ними
          рейка навигации у начала и панель на остатке. Полей вокруг и карточек
          нет: в 380 px они съедали у списка по строке с каждой стороны.

          Страница не прокручивается никогда: высоту делят плита и ровно одна
          панель, и прокрутка живёт внутри неё. */}
      <StatusBar status={status} busy={busy > 0} onToggle={toggle} onScope={setScope} />

      {error && (
        // Ошибка команды — это поломка, а не запертый канал: цвет тот же, что
        // у «служба не отвечает», и другой, чем у сработавшей защиты. Вид —
        // InfoBar Windows: значок, текст, крестик, ровная заливка.
        <div className="enter flex shrink-0 items-start gap-2.5 border-b border-edge bg-fault-soft py-1 ps-4 pe-1 text-sm">
          <Icon name="warn" className="mt-2 text-fault" />
          <p className="selectable min-w-0 flex-1 py-1.5">{error}</p>
          <IconButton icon="close" label={s.hideMessage} onClick={() => setError(null)} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Рейка — NavigationView Windows 11 в компактном виде: значки в
            столбец, под каждым счётчик строк. Счётчик — не украшение: он
            единственное, что говорит о закрытой панели хоть что-то. Узкая
            рейка и широкая «Главная» — одна навигация в двух видах, кто из
            них показан, решает `index.css` по ширине окна. */}
        <nav className="rail flex shrink-0 flex-col items-center gap-0.5 py-1.5" aria-label={s.tabMain}>
          <RailItem className="rail-narrow" icon="server" active={!settings && tab === "profiles"} onClick={() => pick("profiles")}
            label={s.profiles} count={status?.profiles.length ?? 0} />
          <RailItem className="rail-narrow" icon="screen" active={!settings && tab === "apps"} onClick={() => pick("apps")}
            label={s.apps} count={`${inTunnel}/${status?.apps.length ?? 0}`} />
          <RailItem className="rail-narrow" icon="lines" active={!settings && tab === "journal"} onClick={() => pick("journal")}
            label={s.journal} count={status?.log.length ?? 0} />
          {/* Шире 1100 px первые три стоят рядом, и выбирать между ними
              нечего: остаётся развилка «списки или браузерные профили». */}
          <RailItem className="rail-wide" icon="server" active={!settings && !WIDE.includes(tab)} onClick={() => pick("profiles")}
            label={s.tabMain} />
          <RailItem icon="browser" active={!settings && tab === "browsers"} onClick={() => pick("browsers")}
            label={s.tabBrowsers} count={status?.browser_profiles.length ?? 0} />
          {/* Счётчика у соединений нет: сколько их, знает только сама
              панель, а спрашивать это ради подписи на закрытой вкладке
              значило бы опрашивать службу всегда — ровно то, чего эта
              панель и не делает. */}
          <RailItem icon="swap" active={!settings && tab === "conns"} onClick={() => pick("conns")} label={s.tabConns} />
        </nav>

        <main className="flex min-w-0 flex-1 flex-col">
          {settings ? (
            <Settings
              className="min-h-0 flex-1"
              status={status}
              act={act}
              onClose={() => setSettings(false)}
              onError={setError}
              rel={rel}
              theme={theme}
            />
          ) : (
            <>
              {/* Что сделать, чтобы это заработало. Уходит навсегда, как только
                  сбылись все три шага. В плашке его нет — у неё своя раскладка. */}
              {status && <Welcome status={status} />}
              {tab === "browsers" ? (
                <Browsers status={status} act={act} browse={browse} fail={setError} className="min-h-0 flex-1" />
              ) : tab === "conns" ? (
                <Conns status={status} act={act} className="min-h-0 flex-1" />
              ) : (
                <div className="panes">
                  <Profiles
                    className={pane(tab, "profiles")}
                    status={status}
                    act={act}
                    busy={busy > 0}
                    onError={setError}
                  />
                  <Apps className={pane(tab, "apps")} status={status} act={act} busy={busy > 0} />
                  <Journal className={pane(tab, "journal")} lines={status?.log ?? []} lang={status?.lang} />
                </div>
              )}
            </>
          )}
        </main>
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
      className="absolute inset-0 z-10 grid place-items-center bg-black/30 p-6"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={s.closeTitle}
        onClick={(e) => e.stopPropagation()}
        className="enter flex w-full max-w-md flex-col gap-3 rounded-lg border border-edge bg-surface p-5 shadow-[var(--pg-flyout-shadow)]"
      >
        <h2 className="text-xl font-semibold">{s.closeTitle}</h2>
        <p className="text-sm">{s.closeHint}</p>
        <p className="text-sm text-muted">{s.closeWarn}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-4 accent-[var(--pg-accent)]"
          />
          {s.closeRemember}
        </label>
        {/* Кнопки диалога Windows — поровну ширины, главная первой. */}
        <div className="-mx-5 -mb-5 mt-2 grid grid-cols-2 gap-2 rounded-b-lg border-t border-edge bg-bg p-4">
          <Button variant="primary" autoFocus onClick={() => onPick("hide", remember)}>
            {s.closeToTray}
          </Button>
          <Button onClick={() => onPick("quit", remember)}>{s.closeQuit}</Button>
        </div>
      </div>
    </div>
  );
}

/** Пункт рейки: значок и счётчик строк под ним. Подпись живёт в подсказке и
 *  в имени для чтения с экрана — вместе со счётчиком, чтобы диктор прочёл
 *  «Профили · 7», а не голое число.
 *
 *  Строка под счётчик держится и у пунктов без счётчика: иначе значки
 *  соседних пунктов стояли бы на разной высоте, и столбец рассыпался бы. */
function RailItem({
  label,
  icon,
  count,
  active,
  onClick,
  className = "",
}: {
  label: string;
  icon: IconName;
  count?: number | string;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  const name = count != null ? `${label} · ${count}` : label;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={name}
      title={name}
      onClick={onClick}
      className={`rail-item smooth flex h-12 w-10 flex-col items-center justify-center gap-1 ${
        active ? "text-ink" : "text-muted hover:text-ink"
      } ${className}`}
    >
      <Icon name={icon} className={active ? "text-accent" : ""} />
      <span className="h-3 text-xs leading-none tabular-nums text-faint" aria-hidden="true">
        {count ?? ""}
      </span>
    </button>
  );
}
