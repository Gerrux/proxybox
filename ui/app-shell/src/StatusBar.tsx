import { useEffect, useRef, useState } from "react";
import type { Lang, Status } from "./platform";
import { strings } from "./i18n";
import { Button, flag } from "./ui";

/** Длина доезда числа. Заметно меньше периода опроса (2 с), иначе счётчик не
 *  успевал бы доехать до следующего значения и полз бы вечно. */
const COUNT_MS = 450;

/** Состояние окна одним словом. Оно же уезжает в `data-state`, откуда цвет
 *  и вид канала берёт CSS: список состояний живёт в одном месте, а не двумя
 *  параллельными таблицами. */
type State = "fault" | "off" | "connecting" | "up" | "down";

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Число не подменяется, а доезжает до нового значения: скачок читается как
 *  подмена цифры, доезд — как измерение, и заодно видно, что счётчик живой, а
 *  не замер вместе со службой. Доезд стоит покадрового ре-рендера панели,
 *  поэтому достаётся только задержке — она и меняется на единицы миллисекунд,
 *  на которых доезд вообще читается. */
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
 *  прозрачным, после ~300 — заметно мешает. Отмечены только края: подкрашивать
 *  ещё и середину значит красить всегда, а тогда цвет перестаёт что-то значить. */
function latencyTone(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 120) return "text-open";
  return ms < 300 ? "" : "text-wait";
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
  const all = status?.all_traffic ?? false;
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;
  const latency = useCounted(status?.latency_ms ?? null);
  // Байты не доезжают: между двумя статусами их набегают десятки килобайт, и
  // доезд читался бы не как измерение, а как перебор случайных цифр. Считать
  // его было втрое дороже самого дорогого, что делает окно: пока туннель жив,
  // счётчики меняются с каждым статусом, и панель перерисовывалась покадрово.
  const rx = status?.rx ?? null;
  const tx = status?.tx ?? null;

  // Служба не отвечает — это единственная настоящая поломка из пяти состояний,
  // и она единственная требует человека. Остальные четыре — работа продукта.
  const view: { state: State; title: string; hint: string } = !status
    ? { state: "fault", title: s.serviceDown, hint: s.serviceDownHint }
    : {
        // Охват меняет не состояние, а того, о ком оно: подсказка про
        // «выбранные приложения» при включённом «весь компьютер» была бы враньём.
        // Без профилей «Включить» заперта, и сказать об этом должна подсказка
        // под заголовком: гаснущая кнопка сама по себе ничего не объясняет, а
        // единственное объяснение лежало ниже, в пустом списке профилей.
        off: {
          state: "off" as const,
          title: s.off,
          hint: status.profiles.length === 0 ? s.offNoProfiles : all ? s.offHintAll : s.offHint,
        },
        connecting: { state: "connecting" as const, title: s.connecting, hint: all ? s.connectingHintAll : s.connectingHint },
        up: {
          state: "up" as const,
          title: s.up,
          hint: all ? s.upHintAll : inTunnel > 0 ? s.upHint(inTunnel) : s.upNoApps,
        },
        down: { state: "down" as const, title: s.down, hint: all ? s.downHintAll : s.downHint },
      }[status.tunnel];

  const on = status != null && status.tunnel !== "off";
  const code = status?.probes.find((p) => p.name === status.profile)?.code;
  const exit = status?.country ? `${flag(code) ?? ""} ${status.country}`.trim() : null;

  return (
    <header
      data-state={view.state}
      className="smooth relative shrink-0 overflow-hidden rounded-lg border border-edge bg-[color:var(--tone-soft)] px-5 pb-4 pt-4"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          {/* key — чтобы React заменил узел: надпись состояния сменяется
              вплывом, а не подменой символов на месте. */}
          <h1
            key={view.title}
            // Не обрезаем: в узком окне «Туннеля нет — доступ закрыт» обрубается
            // до «Туннел…», а это ровно та надпись, ради которой окно открыли.
            className="swap font-display text-[26px] font-semibold uppercase leading-[1.05] tracking-[0.055em] text-[color:var(--tone)]"
          >
            {view.title}
          </h1>
          <p key={view.hint} className="swap mt-2 text-[13px] text-muted">
            {view.hint}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div className="flex gap-2">
            {(["ru", "en"] as const).map((code) => (
              // aria-pressed, а не только цвет: выбранный язык обязан быть
              // различим и без цвета, и на слух — как у переключателя охвата.
              <button
                key={code}
                type="button"
                aria-pressed={(status?.lang ?? "ru") === code}
                aria-label={code === "ru" ? s.langRu : s.langEn}
                title={code === "ru" ? s.langRu : s.langEn}
                onClick={() => onLang(code)}
                className={`engraved rounded-sm px-1.5 py-1 transition-colors ${
                  (status?.lang ?? "ru") === code ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"
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
            className="h-9 px-5 font-display uppercase tracking-[0.08em]"
          >
            {on ? s.turnOff : s.turnOn}
          </Button>
        </div>
      </div>

      {/* Канал: слева выбранные приложения, справа сеть. Поднят — по нему идут
          штрихи; заперто — он перерублен и стоит. Другого способа показать
          инвариант продукта одной картинкой у нас нет. */}
      <div className="mt-5 flex items-center gap-2.5">
        <span className="engraved shrink-0 text-muted">{all ? s.conduitFromAll : s.conduitFrom}</span>
        <span className="conduit-lamp smooth" />
        <span className="conduit-line smooth" />
        <span className="conduit-end smooth" />
        <span className="engraved shrink-0 text-muted">{s.conduitTo}</span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-y-3 border-t border-edge pt-3 sm:grid-cols-3 md:grid-cols-5">
        <Metric name={s.profile} value={status?.profile ?? s.noProfile} />
        {/* Флаг перед названием: точка выхода — единственная метрика, которую
            читают глазом, а не цифрой, и в узкой ячейке название всё равно
            обрезается. Код берётся из измерений того же профиля: страну и код
            узнают одним запросом, и второго поля в статусе для этого не нужно. */}
        <Metric name={s.exit} value={exit ?? "—"} />
        {/* Цвет — по настоящей задержке, а не по кадру анимации: порог должен
            переключаться по факту, а не по тому, докуда доехало число. */}
        <Metric
          name={s.latency}
          value={latency != null ? `${Math.round(latency)} ms` : "—"}
          tone={latencyTone(status?.latency_ms)}
        />
        <Metric name={s.received} value={rx != null ? bytes(rx) : "—"} hint={s.trafficHint} />
        <Metric name={s.sent} value={tx != null ? bytes(tx) : "—"} hint={s.trafficHint} />
      </dl>

      {/* Пока служба не ответила, по нижней кромке панели идёт бегунок. Прогресса
          у нас нет и быть не может — показываем только сам факт ожидания, и там,
          где ждут: на панели, которой команда и отдана. */}
      {busy && (
        <div className="bar absolute inset-x-0 bottom-0 h-0.5 overflow-hidden text-[color:var(--tone)]" />
      )}
    </header>
  );
}

/** Ячейка приборной линейки: гравированная подпись, под ней значение.
 *  Цифры табличные — статус приходит каждые две секунды, и прыгать по ширине
 *  им нельзя. */
function Metric({
  name,
  value,
  tone = "",
  hint,
}: {
  name: string;
  value: string;
  tone?: string;
  /** Что именно измерено, если из подписи это не следует: счётчики трафика
   *  считают с запуска туннеля, а не с установки приложения. */
  hint?: string;
}) {
  return (
    // Разделители только там, где линейка стоит одной строкой: в две колонки
    // левая граница второго ряда висела бы посреди пустоты.
    <div className="min-w-0 md:border-l md:border-edge md:px-3 md:first:border-l-0 md:first:pl-0">
      <dt className="engraved text-muted" title={hint}>
        {name}
      </dt>
      {/* tabular-nums обязателен именно из-за доезда: цифры разной ширины
          меняются каждый кадр и дёргали бы линейку по всей строке. */}
      <dd className={`smooth mt-1 truncate font-display text-[15px] tabular-nums ${tone}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
