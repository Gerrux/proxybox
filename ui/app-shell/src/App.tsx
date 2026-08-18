import { useCallback, useEffect, useState } from "react";
import { call, type Lang, type Request, type Status } from "./platform";
import { strings } from "./i18n";
import { Apps } from "./Apps";
import { Journal } from "./Journal";
import { Profiles } from "./Profiles";
import { StatusBar } from "./StatusBar";
import { Button } from "./ui";

/** Опрос статуса. Служба тикает раз в 3 с, чаще спрашивать нечего. */
const POLL_MS = 2000;
/** Пока туннель поднимается, две секунды до обновления — целая вечность на
 *  глаз. Подключение длится секунды, а не часы, лишний трафик по петле дешёвый. */
const POLL_BUSY_MS = 600;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Сколько команд в полёте. Служба отвечает на команду только закончив работу
  // (reapply перезапускает sing-box, не отпуская мьютекс), поэтому «ждём» —
  // единственное, что окно может честно показать всё это время.
  const [busy, setBusy] = useState(0);

  const send = useCallback(async (req: Request) => {
    try {
      const r = await call(req);
      setError(r.reply === "error" ? r.data.message : null);
      if (r.reply === "status") setStatus(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  }, []);

  const refresh = useCallback(() => send({ cmd: "status" }), [send]);

  const connecting = status?.tunnel === "connecting";
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, connecting ? POLL_BUSY_MS : POLL_MS);
    return () => clearInterval(id);
  }, [refresh, connecting]);

  // Команда и сразу перечитанный статус: окно не гадает, что получилось, —
  // единственный источник истины остаётся у службы.
  const act = useCallback(
    (req: Request) => {
      setBusy((n) => n + 1);
      void send(req)
        .then(refresh)
        .finally(() => setBusy((n) => n - 1));
    },
    [send, refresh],
  );

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

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-hidden p-5">
      <StatusBar
        status={status}
        busy={busy > 0}
        onToggle={toggle}
        onLang={(lang: Lang) => act({ cmd: "set-lang", arg: { lang } })}
      />

      {error && (
        <div className="enter flex shrink-0 items-start gap-3 rounded-xl border border-edge bg-closed-soft px-4 py-3 text-[13px] text-closed">
          <p className="selectable min-w-0 flex-1">{error}</p>
          <Button variant="quiet" aria-label={strings(status?.lang).hideMessage} onClick={() => setError(null)}>
            ✕
          </Button>
        </div>
      )}

      {/* Окно 1000×700: две колонки, каждая панель прокручивается сама, страница —
          никогда. Список приложений после автообнаружения самый длинный, ему и
          отдана широкая колонка целиком. */}
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(240px,0.8fr)_1.2fr]">
        <div className="flex min-h-0 flex-col gap-4">
          <Profiles status={status} act={act} busy={busy > 0} className="min-h-0 flex-1" />
          <Journal lines={status?.log ?? []} lang={status?.lang} className="h-[38%] shrink-0" />
        </div>
        <Apps status={status} act={act} className="min-h-0" />
      </div>
    </div>
  );
}
