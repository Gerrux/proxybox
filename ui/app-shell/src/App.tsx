import { useCallback, useEffect, useState } from "react";
import {
  browse as openBrowser,
  call,
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
import { Journal } from "./Journal";
import { Profiles } from "./Profiles";
import { Settings, useReleases } from "./Settings";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Button } from "./ui";

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
type Tab = "profiles" | "apps" | "journal" | "browsers";

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
      if (!document.hidden) void refresh();
    }, connecting ? POLL_BUSY_MS : POLL_MS);
    return () => clearInterval(id);
  }, [refresh, connecting]);

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
  const browse = useCallback((profile: BrowserProfile) => {
    setError(null);
    setBusy((n) => n + 1);
    void openBrowser(profile)
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
    <div className="flex h-full flex-col overflow-hidden">
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
            lang={status?.lang}
            onLang={(lang: Lang) => act({ cmd: "set-lang", arg: { lang } })}
            onClose={() => setSettings(false)}
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
              <TabButton className="tab-wide" active={tab !== "browsers"} onClick={() => setTab("profiles")}
                label={s.tabMain} />
              <TabButton active={tab === "browsers"} onClick={() => setTab("browsers")}
                label={s.tabBrowsers} count={status?.browser_profiles.length ?? 0} />
            </nav>

            {tab === "browsers" ? (
              <Browsers status={status} act={act} browse={browse} className="min-h-0 flex-1" />
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
