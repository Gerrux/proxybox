import type { Status } from "./platform";
import { Button } from "./ui";

type Tone = { text: string; soft: string; dot: string };

const TONES: Record<"open" | "closed" | "wait" | "idle", Tone> = {
  open: { text: "text-open", soft: "bg-open-soft", dot: "bg-open" },
  closed: { text: "text-closed", soft: "bg-closed-soft", dot: "bg-closed" },
  wait: { text: "text-wait", soft: "bg-wait-soft", dot: "bg-wait animate-pulse" },
  idle: { text: "text-muted", soft: "bg-surface-2", dot: "bg-muted" },
};

function bytes(n: number): string {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Состояние — главное, что показывает окно, поэтому оно и занимает верх. */
export function StatusBar({ status, onToggle }: { status: Status | null; onToggle: () => void }) {
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;

  const view = !status
    ? {
        tone: TONES.closed,
        title: "Служба не отвечает",
        hint: "Запустите PrivacyGateway от имени администратора — без службы ничего не работает",
      }
    : {
        off: {
          tone: TONES.idle,
          title: "Приватный режим выключен",
          hint: "Выбранные приложения ходят в сеть напрямую",
        },
        connecting: {
          tone: TONES.wait,
          title: "Подключение…",
          hint: "Пока туннель не подтверждён, выбранные приложения остаются без сети",
        },
        up: {
          tone: TONES.open,
          title: "Защищено",
          hint:
            inTunnel > 0
              ? `${inTunnel} прил. идут только через туннель, остальной трафик не тронут`
              : "Туннель поднят, но ни одно приложение не выбрано",
        },
        down: {
          tone: TONES.closed,
          title: "Туннеля нет — доступ закрыт",
          hint: "Так и задумано: без туннеля выбранные приложения остаются без сети",
        },
      }[status.tunnel];

  const on = status != null && status.tunnel !== "off";

  return (
    <header className={`shrink-0 rounded-xl border border-edge ${view.tone.soft} p-5`}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className={`size-2.5 shrink-0 rounded-full ${view.tone.dot}`} />
            <h1 className={`truncate text-xl font-semibold ${view.tone.text}`}>{view.title}</h1>
          </div>
          <p className="mt-1.5 text-[13px] text-muted">{view.hint}</p>
        </div>
        <Button
          variant={on ? "ghost" : "primary"}
          disabled={!status || (!on && !status.profile && status.profiles.length === 0)}
          onClick={onToggle}
          className="h-9 px-5"
        >
          {on ? "Выключить" : "Включить"}
        </Button>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-edge pt-3 text-[13px]">
        <Metric name="Профиль" value={status?.profile ?? "не выбран"} />
        <Metric name="Задержка" value={status?.latency_ms != null ? `${status.latency_ms} мс` : "—"} />
        <Metric name="Принято" value={status ? bytes(status.rx) : "—"} />
        <Metric name="Отправлено" value={status ? bytes(status.tx) : "—"} />
      </dl>
    </header>
  );
}

function Metric({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted">{name}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
