import { useCallback, useEffect, useState } from "react";
import { browse as openBrowser, call, type Act, type Lang, type Request, type Response, type Status } from "./platform";
import { strings } from "./i18n";
import { Apps } from "./Apps";
import { Journal } from "./Journal";
import { Profiles } from "./Profiles";
import { StatusBar } from "./StatusBar";
import { Updates } from "./Updates";
import { TitleBar } from "./TitleBar";
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
  const browse = useCallback((profile: string) => {
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar title="Privacy Gateway" lang={status?.lang} />
      {/* Содержимое не растягивается на всю ширину монитора: строки метрик и
          списков читаются глазом, а не рулеткой. Но и 1024 px на 27" — окно в
          окне, поэтому широкому экрану даётся третья колонка.

          Если окно сузили руками, панели не сплющиваются в полоски: прокрутка
          возвращается всей странице. */}
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 overflow-y-auto p-5 md:overflow-hidden xl:max-w-[1600px]">
        <StatusBar
          status={status}
          busy={busy > 0}
          onToggle={toggle}
          onLang={(lang: Lang) => act({ cmd: "set-lang", arg: { lang } })}
        />

        {error && (
          // Ошибка команды — это поломка, а не запертый канал: цвет тот же, что
          // у «служба не отвечает», и другой, чем у сработавшей защиты.
          <div className="enter flex shrink-0 items-start gap-3 rounded-lg border border-edge bg-fault-soft px-4 py-3 text-[13px] text-fault">
            <p className="selectable min-w-0 flex-1">{error}</p>
            <Button variant="quiet" aria-label={strings(status?.lang).hideMessage} onClick={() => setError(null)}>
              ✕
            </Button>
          </div>
        )}

        {/* Окно 1000×700: две колонки, журнал под профилями. Каждая панель
            прокручивается сама, страница — никогда. Список приложений после
            автообнаружения самый длинный, ему и отдана широкая колонка целиком.

            Высоту в узкой колонке забирают профили, а не журнал: с парой
            подписок их бывает под сотню, а журнал читают, когда что-то уже
            пошло не так. С 1280 px журнал уезжает в свою колонку и высоту не
            делит вовсе. */}
        <div
          className="grid gap-4 md:min-h-0 md:flex-1 md:grid-cols-[minmax(260px,0.9fr)_1.2fr] md:grid-rows-[1.6fr_1fr]
                     xl:grid-cols-[minmax(320px,1fr)_1.4fr_minmax(280px,0.9fr)] xl:grid-rows-1"
        >
          <Profiles status={status} act={act} browse={browse} busy={busy > 0} className="md:min-h-0" />
          <Apps
            status={status}
            act={act}
            busy={busy > 0}
            className="md:col-start-2 md:row-start-1 md:row-span-2 md:min-h-0 xl:row-span-1"
          />
          <Journal
            lines={status?.log ?? []}
            lang={status?.lang}
            className="min-h-[9rem] md:col-start-1 md:row-start-2 md:min-h-0 xl:col-start-3 xl:row-start-1"
          />
        </div>

        {/* Версия и обновления — подвал: смотрят туда раз в месяц, а состояние
            туннеля видно всё время. */}
        <Updates lang={status?.lang} />
      </div>
    </div>
  );
}
