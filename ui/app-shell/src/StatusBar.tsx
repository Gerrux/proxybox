import type { Lang, Status } from "./platform";
import { strings } from "./i18n";
import { Button } from "./ui";

type Tone = { text: string; soft: string; dot: string };

const TONES: Record<"open" | "closed" | "wait" | "idle", Tone> = {
  open: { text: "text-open", soft: "bg-open-soft", dot: "bg-open" },
  closed: { text: "text-closed", soft: "bg-closed-soft", dot: "bg-closed" },
  wait: { text: "text-wait", soft: "bg-wait-soft", dot: "bg-wait animate-pulse" },
  idle: { text: "text-muted", soft: "bg-surface-2", dot: "bg-muted" },
};

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Состояние — главное, что показывает окно, поэтому оно и занимает верх. */
export function StatusBar({
  status,
  onToggle,
  onLang,
}: {
  status: Status | null;
  onToggle: () => void;
  onLang: (lang: Lang) => void;
}) {
  const s = strings(status?.lang);
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;

  const view = !status
    ? { tone: TONES.closed, title: s.serviceDown, hint: s.serviceDownHint }
    : {
        off: { tone: TONES.idle, title: s.off, hint: s.offHint },
        connecting: { tone: TONES.wait, title: s.connecting, hint: s.connectingHint },
        up: { tone: TONES.open, title: s.up, hint: inTunnel > 0 ? s.upHint(inTunnel) : s.upNoApps },
        down: { tone: TONES.closed, title: s.down, hint: s.downHint },
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
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex gap-1 text-xs">
            {(["ru", "en"] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => onLang(code)}
                className={`rounded px-1.5 py-0.5 uppercase ${
                  (status?.lang ?? "ru") === code ? "text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {code}
              </button>
            ))}
          </div>
          <Button
            variant={on ? "ghost" : "primary"}
            disabled={!status || (!on && !status.profile && status.profiles.length === 0)}
            onClick={onToggle}
            className="h-9 px-5"
          >
            {on ? s.turnOff : s.turnOn}
          </Button>
        </div>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-edge pt-3 text-[13px]">
        <Metric name={s.profile} value={status?.profile ?? s.noProfile} />
        <Metric name={s.exit} value={status?.country ?? "—"} />
        <Metric name={s.latency} value={status?.latency_ms != null ? `${status.latency_ms} ms` : "—"} />
        <Metric name={s.received} value={status ? bytes(status.rx) : "—"} />
        <Metric name={s.sent} value={status ? bytes(status.tx) : "—"} />
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
