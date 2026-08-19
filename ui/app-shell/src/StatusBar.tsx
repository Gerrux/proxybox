import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Status } from "./platform";
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
}: {
  status: Status | null;
  busy: boolean;
  onToggle: () => void;
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
  const exitFlag = status?.country ? flag(code) : null;

  return (
    <header
      data-state={view.state}
      className="st smooth relative shrink-0 overflow-hidden rounded-lg border border-edge bg-[color:var(--tone-soft)] px-5 pb-4 pt-4"
    >
      <div className="st-head flex items-start justify-between gap-6">
        <div className="min-w-0">
          {/* key — чтобы React заменил узел: надпись состояния сменяется
              вплывом, а не подменой символов на месте. */}
          <h1
            key={view.title}
            // Не обрезаем: в узком окне «Туннеля нет — доступ закрыт» обрубается
            // до «Туннел…», а это ровно та надпись, ради которой окно открыли.
            className="st-title swap font-display text-[26px] font-semibold uppercase leading-[1.05] tracking-[0.055em] text-[color:var(--tone)]"
          >
            {view.title}
          </h1>
          <p key={view.hint} className="st-hint swap mt-2 text-[13px] text-muted">
            {view.hint}
          </p>
        </div>
        <Button
          variant={on ? "ghost" : "primary"}
          disabled={!status || (!on && !status.profile && status.profiles.length === 0)}
          onClick={onToggle}
          className="st-toggle h-9 px-5 font-display uppercase tracking-[0.08em]"
        >
          {on ? s.turnOff : s.turnOn}
        </Button>
      </div>

      {/* Канал: слева выбранные приложения, справа сеть. Поднят — по нему идут
          штрихи; заперто — он перерублен и стоит. Другого способа показать
          инвариант продукта одной картинкой у нас нет. */}
      <div className="st-cond mt-5 flex items-center gap-2.5">
        <span className="engraved shrink-0 text-muted">{all ? s.conduitFromAll : s.conduitFrom}</span>
        <span className="conduit-lamp smooth" />
        <span className="conduit-line smooth" />
        <span className="conduit-end smooth" />
        <span className="engraved shrink-0 text-muted">{s.conduitTo}</span>
      </div>

      <dl className="st-metrics mt-4 grid grid-cols-2 gap-y-3 border-t border-edge pt-3 sm:grid-cols-3 md:grid-cols-5">
        <Metric name={s.profile} value={status?.profile ?? s.noProfile} />
        {/* Флаг перед названием: точка выхода — единственная метрика, которую
            читают глазом, а не цифрой, и в узкой ячейке название всё равно
            обрезается. Код берётся из измерений того же профиля: страну и код
            узнают одним запросом, и второго поля в статусе для этого не нужно. */}
        {/* Прочерк без объяснения читается как поломка. Настоящую страну при
            выключенном режиме не показываем намеренно: спросить её можно только
            у стороннего сервиса, а без туннеля запрос ушёл бы с настоящего
            адреса — продукт про приватность выдал бы человека ровно тогда,
            когда он не прикрыт. */}
        <Metric name={s.exit} value={status?.country ?? "—"} hint={status?.country ? undefined : s.exitUnknown}>
          {status?.country ? (
            <>
              {exitFlag && (
                <span className="shrink-0 leading-none" aria-hidden="true">
                  {exitFlag}
                </span>
              )}
              {/* Название прячется только тогда, когда вместо него остаётся
                  флаг: без флага пустая ячейка не значила бы ничего. */}
              <span className={`truncate ${exitFlag ? "m-country" : ""}`}>{status.country}</span>
            </>
          ) : (
            "—"
          )}
        </Metric>
        {/* Цвет — по настоящей задержке, а не по кадру анимации: порог должен
            переключаться по факту, а не по тому, докуда доехало число. */}
        <Metric
          name={s.latency}
          value={latency != null ? `${Math.round(latency)} ms` : "—"}
          tone={latencyTone(status?.latency_ms)}
        />
        <Metric name={s.received} value={rx != null ? bytes(rx) : "—"} hint={s.trafficHint} icon="down" />
        <Metric name={s.sent} value={tx != null ? bytes(tx) : "—"} hint={s.trafficHint} icon="up" />
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
 *  им нельзя.
 *
 *  В плашке из трея (`@media (max-width: 470px)` в `index.css`) подписи уходят
 *  с глаз, и всё, что ячейка о себе рассказывает, остаётся в подсказке — она
 *  поэтому и собирается из имени, значения и пояснения разом, а не из одного
 *  значения. */
function Metric({
  name,
  value,
  tone = "",
  hint,
  icon,
  children,
}: {
  name: string;
  value: string;
  tone?: string;
  /** Что именно измерено, если из подписи это не следует: счётчики трафика
   *  считают с запуска туннеля, а не с установки приложения. */
  hint?: string;
  /** Стрелка вместо подписи там, где подписи не осталось. Только у счётчиков:
   *  «принято» и «отправлено» — единственная пара, которую рисунок различает
   *  не хуже слова. */
  icon?: "down" | "up";
  /** Значение сложнее строки — точка выхода: флаг и название живут отдельно,
   *  чтобы в узком окне название могло уйти, а флаг остаться. */
  children?: ReactNode;
}) {
  return (
    // Разделители только там, где линейка стоит одной строкой: в две колонки
    // левая граница второго ряда висела бы посреди пустоты.
    <div className="m-cell min-w-0 md:border-l md:border-edge md:px-3 md:first:border-l-0 md:first:pl-0">
      <dt className="m-label engraved text-muted">{name}</dt>
      {/* tabular-nums обязателен именно из-за доезда: цифры разной ширины
          меняются каждый кадр и дёргали бы линейку по всей строке. */}
      <dd
        className={`m-value smooth mt-1 flex items-baseline gap-1.5 overflow-hidden font-display text-[15px] tabular-nums ${tone}`}
        title={hint ? `${name}: ${value} — ${hint}` : `${name}: ${value}`}
      >
        {icon && (
          <span className="m-icon shrink-0 self-center text-muted">
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {icon === "down" ? <path d="M6 2v8M3 7l3 3 3-3" /> : <path d="M6 10V2M3 5l3-3 3 3" />}
            </svg>
          </span>
        )}
        {children ?? <span className="truncate">{value}</span>}
      </dd>
    </div>
  );
}
