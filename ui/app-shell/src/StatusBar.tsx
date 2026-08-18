import { useEffect, useRef, useState } from "react";
import type { Lang, Status } from "./platform";
import { strings } from "./i18n";
import { Button } from "./ui";

/** Длина доезда числа. Заметно меньше периода опроса (2 с), иначе счётчик не
 *  успевал бы доехать до следующего значения и полз бы вечно. */
const COUNT_MS = 450;

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

/** Число не подменяется, а доезжает до нового значения. Статус приходит раз в
 *  две секунды и приносит сразу десятки килобайт: скачок читается как подмена
 *  цифры, доезд — как измерение. Заодно видно, что счётчик живой, а не замер
 *  вместе со службой. */
function useCounted(value: number | null): number | null {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    // Появление и пропажу числа анимировать нечем — ехать не из чего.
    if (value == null || from.current == null || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setShown(value);
      return;
    }
    // Точка отсчёта — то, что показано сейчас, а не прошлое значение статуса:
    // новый статус может прийти посреди доезда, и рывка назад быть не должно.
    const a = from.current;
    const start = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / COUNT_MS);
      // Замедление к концу: быстрый старт читается как реакция, ровная
      // линейная ползучесть — как заедание.
      const next = a + (value - a) * (1 - (1 - k) ** 3);
      from.current = next;
      setShown(next);
      if (k < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return shown;
}

/** Цвет задержки. Пороги на глаз, не по науке: до ~120 мс туннель ощущается
 *  прозрачным, после ~300 — заметно мешает. Число само по себе ни о чём не
 *  говорит тому, кто не меряет пинги руками, цвет говорит сразу. */
function latencyTone(ms: number | null | undefined): string {
  if (ms == null) return "";
  return ms < 120 ? "text-open" : ms < 300 ? "text-wait" : "text-closed";
}

/** Состояние — главное, что показывает окно, поэтому оно и занимает верх. */
export function StatusBar({
  status,
  busy,
  onToggle,
  onLang,
}: {
  status: Status | null;
  busy: boolean;
  onToggle: () => void;
  onLang: (lang: Lang) => void;
}) {
  const s = strings(status?.lang);
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;
  const latency = useCounted(status?.latency_ms ?? null);
  const rx = useCounted(status?.rx ?? null);
  const tx = useCounted(status?.tx ?? null);

  const view = !status
    ? { tone: TONES.closed, title: s.serviceDown, hint: s.serviceDownHint }
    : {
        off: { tone: TONES.idle, title: s.off, hint: s.offHint },
        connecting: { tone: TONES.wait, title: s.connecting, hint: s.connectingHint },
        up: { tone: TONES.open, title: s.up, hint: inTunnel > 0 ? s.upHint(inTunnel) : s.upNoApps },
        down: { tone: TONES.closed, title: s.down, hint: s.downHint },
      }[status.tunnel];

  const on = status != null && status.tunnel !== "off";
  // Ждём службу или сам туннель — для глаза это одно и то же ожидание.
  const waiting = busy || status?.tunnel === "connecting";

  return (
    <header className={`smooth shrink-0 rounded-xl border border-edge ${view.tone.soft} p-5`}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className={`smooth size-2.5 shrink-0 rounded-full ${view.tone.dot}`} />
            {/* key — чтобы React заменил узел: надпись состояния сменяется
                вплывом, а не подменой символов на месте. */}
            <h1 key={view.title} className={`swap truncate text-xl font-semibold ${view.tone.text}`}>
              {view.title}
            </h1>
          </div>
          <p key={view.hint} className="swap mt-1.5 text-[13px] text-muted">
            {view.hint}
          </p>
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

      {/* Разделитель он же индикатор ожидания: пока служба не ответила, линия
          не просто лежит, а бежит. Место то же, скачка вёрстки нет. */}
      <div
        className={`relative mt-4 h-0.5 overflow-hidden rounded-full bg-edge ${waiting ? `bar ${view.tone.text}` : ""}`}
      />

      <dl className="flex flex-wrap gap-x-8 gap-y-2 pt-3 text-[13px]">
        <Metric name={s.profile} value={status?.profile ?? s.noProfile} />
        <Metric name={s.exit} value={status?.country ?? "—"} />
        {/* Цвет — по настоящей задержке, а не по кадру анимации: порог должен
            переключаться по факту, а не по тому, докуда доехало число. */}
        <Metric
          name={s.latency}
          value={latency != null ? `${Math.round(latency)} ms` : "—"}
          tone={latencyTone(status?.latency_ms)}
        />
        <Metric name={s.received} value={rx != null ? bytes(rx) : "—"} />
        <Metric name={s.sent} value={tx != null ? bytes(tx) : "—"} />
      </dl>
    </header>
  );
}

function Metric({ name, value, tone = "" }: { name: string; value: string; tone?: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted">{name}</dt>
      {/* tabular-nums обязателен именно из-за доезда: цифры разной ширины
          меняются каждый кадр и дёргали бы соседние метрики по всей строке. */}
      <dd className={`smooth font-medium tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}
