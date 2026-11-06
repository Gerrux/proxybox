import { useEffect, useRef, useState } from "react";
import { call, type Scope, type Status } from "./platform";
import { strings, type Strings } from "./i18n";
import { CopyButton, Icon, type IconName, Menu, Modal, Switch, flag } from "./ui";
import { WorldMap } from "./WorldMapView";

/** Длина доезда числа. Заметно меньше периода опроса (2 с), иначе счётчик не
 *  успевал бы доехать до следующего значения и полз бы вечно. */
const COUNT_MS = 450;

/** Состояние окна одним словом. Оно же уезжает в `data-state`, откуда цвет
 *  и вид канала берёт CSS: список состояний живёт в одном месте, а не двумя
 *  параллельными таблицами. */
export type State = "fault" | "off" | "connecting" | "up" | "down";

/** Состояние окна одним словом. Экспортируется ради корня окна: тон плиты и
 *  тон самого окна обязаны быть одним цветом, а значит браться с одного
 *  атрибута. Молчащая служба — единственное, чего нет в `Status::tunnel`. */
export function tunnelState(status: Status | null): State {
  return status?.tunnel ?? "fault";
}

/** Экспортируется ради панели соединений: там те же байты в тех же единицах, а
 *  второй такой же форматтер разошёлся бы с этим на первом же округлении. */
export function bytes(n: number): string {
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

/** Сколько отсчётов держит график. Отсчёт — одно снятие счётчиков службой, а
 *  их такт задаёт она сама; сорок штук — столько, чтобы увидеть всплеск и
 *  понять, кончился он или продолжается. Дольше держать нечем и незачем:
 *  истории у нас нет, и заводить её ради картинки значит начать хранить
 *  трафик. */
const SPARK = 40;
/** Система координат графика. Не пиксели: график растянут по ячейке
 *  (`preserveAspectRatio="none"`), а размер ему задаёт линейка, не мы. */
const SPARK_W = 118;
const SPARK_H = 30;

/** Байты в секунду за один такт и отметка службы (`traffic_at`, мс), на которой
 *  такт закончился: по первой и последней отметке на экране считается, сколько
 *  времени график держит на самом деле (`spanSeconds`). */
type Rate = { rx: number; tx: number; at: number };

/** Сколько секунд охватывают отсчёты на экране — от первой отметки до
 *  последней, а не обещанное число: такт задаёт служба
 *  (`PROBE_EVERY × TRAFFIC_EVERY`, ~15 с), и сорок отсчётов — это минуты, а
 *  подпись «90 с» врала бы вдесятеро. Меньше двух отсчётов — промежутка нет,
 *  и подписи нет (`null`). Сторож —
 *  `the_speed_history_spans_what_its_label_says`. */
export function spanSeconds(rates: Rate[]): number | null {
  if (rates.length < 2) return null;
  return Math.round((rates[rates.length - 1].at - rates[0].at) / 1000);
}

/** Скорость канала из тех же счётчиков, что стоят в приборной линейке. Они
 *  идут с запуска sing-box, поэтому разница между двумя снятиями и есть байты
 *  в секунду; своего опроса графику не нужно вовсе — он едет на статусе,
 *  который окно и так спрашивает.
 *
 *  Такт задают не мы: служба ходит за счётчиками раз в несколько кругов надзора
 *  (`TRAFFIC_EVERY`), а статус окно спрашивает чаще. Поэтому отсчёт даёт не
 *  каждый статус, а каждая новая `traffic_at`, и делим мы на разницу отметок, а
 *  не на такт опроса: иначе те же числа, поделённые на две секунды, рисовали бы
 *  нули с всплеском всемеро выше правды — ровно то дёрганье, ради которого
 *  отметка и заведена. Отметка двигается и когда числа не изменились, так что
 *  молчащий канал по-прежнему едет нулём, а не замирает.
 *
 *  Память живёт в окне и умирает вместе с ним: ни в службу, ни на диск это
 *  не уезжает — там его хранение называлось бы журналом трафика. */
export function useRates(status: Status | null): Rate[] {
  const [rates, setRates] = useState<Rate[]>([]);
  const prev = useRef<{ rx: number; tx: number; at: number } | null>(null);

  useEffect(() => {
    if (!status || status.tunnel !== "up") {
      prev.current = null;
      // Стираем, только если было что стирать: иначе каждый статус выключенного
      // режима стоил бы окну лишней перерисовки на ровном месте.
      setRates((r) => (r.length ? [] : r));
      return;
    }
    const at = status.traffic_at;
    const was = prev.current;
    // Счётчики с прошлого раза не снимали — считать нечего.
    if (was && at === was.at) return;
    prev.current = { rx: status.rx, tx: status.tx, at };
    // Первый статус — точка отсчёта, скорости из одного числа не бывает.
    if (!was) return;
    const dt = (at - was.at) / 1000;
    // Часы могли прыгнуть назад: отрицательный промежуток — не скорость.
    if (dt <= 0) return;
    // Счётчики считают с запуска sing-box, и перезапуск туннеля роняет их
    // назад: отрицательная разница — не «минус байт в секунду», а новый отсчёт.
    setRates((r) =>
      [
        ...r,
        { rx: Math.max(0, status.rx - was.rx) / dt, tx: Math.max(0, status.tx - was.tx) / dt, at },
      ].slice(-SPARK),
    );
    // Зависимость — сам статус, а не его поля: при молчащем канале счётчики не
    // меняются, а график обязан ехать дальше нулём, иначе он читался бы как
    // замерший, то есть как поломка.
  }, [status]);

  return rates;
}

/** Не чаще одного отсчёта задержки за это время. Окно спрашивает пульс каждые
 *  две секунды, а после каждой команды — ещё раз сразу; задержку служба
 *  обновляет своей пробой раз в три секунды, и без прореживания один и тот же
 *  замер ложился бы в историю несколько раз подряд — полоски стояли бы
 *  ступеньками, а не измерениями. */
const LATENCY_SPACING_MS = 1500;

/** История задержки для полосок под числом. Та же договорённость, что у
 *  `useRates`: живёт в памяти окна, умирает с ним и с подъёмом туннеля — нового
 *  опроса у неё нет, она едет на статусе, который окно и так спрашивает.
 *  Хранить задержки в службе значило бы вести журнал качества канала, а он
 *  продукту ни к чему: смотрят на него здесь и сейчас. */
export function useLatencies(status: Status | null): number[] {
  const [values, setValues] = useState<number[]>([]);
  const at = useRef(0);

  useEffect(() => {
    if (!status || status.tunnel !== "up") {
      at.current = 0;
      setValues((v) => (v.length ? [] : v));
      return;
    }
    const ms = status.latency_ms;
    const now = Date.now();
    if (ms == null || now - at.current < LATENCY_SPACING_MS) return;
    at.current = now;
    setValues((v) => [...v, ms].slice(-SPARK));
  }, [status]);

  return values;
}

/** Путь по отсчётам, сверху вниз в координатах SVG. Именно путь, а не
 *  polyline: тем же контуром закрашивается заливка под линией, и второй раз
 *  считать те же точки незачем. */
function path(values: number[], peak: number): string {
  const step = SPARK_W / (values.length - 1);
  return values
    .map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(SPARK_H - (v / peak) * SPARK_H).toFixed(1)}`)
    .join(" ");
}

/** Одна линия истории скорости. Две таких — принятое и отданное — кладутся
 *  друг на друга в одном поле — фоне ячейки «Скорость».
 *
 *  Масштаб общий на оба графика (`peak` считается по обоим), иначе молчащая
 *  отдача рисовалась бы такой же горой, что и загруженный приём, — два
 *  графика в одном поле читаются как один прибор, и разные шкалы у них врут.
 *
 *  Бледный намеренно: это история, а не показание. Число читают, форму
 *  замечают краем глаза. Ровная линия по нижней кромке значит «туннель поднят,
 *  и по нему молчат» — это не то же самое, что замерший график. */
export function CellSpark({ values, peak, id, tone }: { values: number[]; peak: number; id: string; tone: string }) {
  // Одна точка — ещё не линия: рисовать нечего, пока не пришёл второй статус.
  if (values.length < 2) return null;
  const line = path(values, peak);
  return (
    <span className={`spark ${tone}`} aria-hidden="true">
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        fill="none"
      >
        <path d={`${line} L${SPARK_W} ${SPARK_H} L0 ${SPARK_H} Z`} fill={`url(#${id})`} />
        {/* Толщина не тянется вместе с ячейкой: без non-scaling-stroke
            растянутый по ширине график давал бы линию в полпикселя. */}
        <path
          d={line}
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity=".42" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}

/** Последние отсчёты задержки полосками: форма ряда важнее числа, а число
 *  лежит поверх них, в той же ячейке. Высота — от пика видимого окна, а не от нуля: нулевая
 *  шкала сделала бы ровный канал в 85 мс одной сплошной полосой. Цвет у
 *  каждой полоски свой — по тем же порогам, что и у числа. */
export function LatencyBars({ values, className = "" }: { values: number[]; className?: string }) {
  if (values.length === 0) return null;
  const top = Math.max(...values, 1);
  return (
    <span className={`lat-bars ${className}`} aria-hidden="true">
      {values.map((ms, i) => (
        <i
          key={i}
          className={`lat-bar ${latencyTone(ms) || "text-muted"}`}
          style={{ blockSize: `${Math.max(14, (ms / top) * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** «Нидерланды, Амстердам» → страна и город по отдельности. Склеивает их сама
 *  служба (`core_tunnel::parse_country`), и при пустом городе не склеивает
 *  вовсе — тогда второй строки просто нет. */
export function splitExit(exit: string | null | undefined): [string, string] {
  if (!exit) return ["", ""];
  const at = exit.indexOf(",");
  return at === -1 ? [exit, ""] : [exit.slice(0, at), exit.slice(at + 1).trim()];
}

/** Цвет задержки. Пороги на глаз, не по науке: до ~120 мс туннель ощущается
 *  прозрачным, после ~300 — заметно мешает. Отмечены только края: подкрашивать
 *  ещё и середину значит красить всегда, а тогда цвет перестаёт что-то значить. */
export function latencyTone(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 120) return "text-open";
  return ms < 300 ? "" : "text-wait";
}

/** Страна узла для карты: код из измерений того профиля, который включён или
 *  включится. Страну и код узнают одним запросом, и второго поля в статусе
 *  для этого не нужно. У выключенного режима это страна узла по прошлому
 *  замеру, а не страна человека: ту без туннеля не спрашиваем вовсе. */
export function exitCode(status: Status | null): string | null {
  const name = status?.profile ?? status?.profiles[0]?.name;
  if (!status || !name) return null;
  return status.probes.find((p) => p.name === name)?.code ?? null;
}

/** Заголовок и подсказка состояния. Одни на шапку окна и на плашку из трея:
 *  разойдись они — и одно и то же состояние называлось бы в двух окнах
 *  по-разному. */
export function describe(s: Strings, status: Status | null): { title: string; hint: string } {
  if (!status) return { title: s.serviceDown, hint: s.serviceDownHint };
  if (status.scope === "split") {
    const title = { off: s.off, connecting: s.connecting, up: s.upSplit, down: s.down }[status.tunnel];
    return { title, hint: status.tunnel === "up" ? s.splitHint : status.tunnel === "off" ? s.offHintAll : s.downHintAll };
  }
  const all = (status.scope ?? "all") === "all";
  const inTunnel = status.apps.filter((a) => a.enabled).length;
  const view = {
    // Охват меняет не состояние, а того, о ком оно: подсказка про
    // «выбранные приложения» при включённом «весь компьютер» была бы враньём.
    // Без профилей «Включить» заперта, и сказать об этом должна подсказка
    // под заголовком: гаснущая кнопка сама по себе ничего не объясняет.
    off: {
      title: s.off,
      hint: status.profiles.length === 0 ? s.offNoProfiles : all ? s.offHintAll : s.offHintWhitelist,
    },
    connecting: { title: s.connecting, hint: all ? s.connectingHintAll : s.connectingHintWhitelist },
    up: { title: s.up, hint: all ? s.upHintAll : s.upHintWhitelist(inTunnel) },
    down: {
      title: s.down,
      // Отсчёт приписывается к подсказке охвата, а не заменяет её: «доступ
      // закрыт» — это состояние, а пауза — то, что с ним будет дальше.
      hint:
        (all ? s.downHintAll : s.downHintWhitelist) +
        (status.retry_in != null ? ` · ${s.retryIn(status.retry_in)}` : ""),
    },
  }[status.tunnel];
  // Белый список без единой галочки запирает машину целиком: пропуска
  // раздаются по списку, а пустой список — это ноль пропусков. Со стороны это
  // выглядит не как сработавшая защита, а как «интернет отвалился» — сказать
  // об этом должно каждое состояние, а не только «поднят». Профилей нет вовсе
  // — впереди более срочная новость: включать нечем.
  if (!all && inTunnel === 0 && status.profiles.length > 0) {
    view.hint = status.tunnel === "off" ? s.noAppsAhead : s.noAppsLocked;
  }
  return view;
}

/** Глиф состояния. Цвет — от `data-state` предка, глиф — от самого состояния:
 *  в оттенках серого и для дальтоника щит, замок и выключатель различимы.
 *  Голый значок перед словом, а не кружок с ним внутри: слово состояния само
 *  набрано тоном и само является индикатором, кружок лишь повторял бы его. */
const GLYPH: Record<State, IconName> = {
  up: "shield",
  connecting: "ring",
  down: "lock",
  off: "power",
  fault: "warn",
};

export function StateGlyph({ state, size = 20 }: { state: State; size?: number }) {
  return (
    <span className="st-glyph smooth inline-flex shrink-0" aria-hidden="true">
      <Icon name={GLYPH[state]} size={size} className="st-spin" />
    </span>
  );
}

/** Состояние — главное, что показывает окно, поэтому оно и занимает верх:
 *  плита, подкрашенная тоном состояния, со словом состояния слева и картой
 *  справа, а под ней приборная линейка.
 *
 *  Картинка плиты — карта со страной выхода. «Канал», который стоял здесь
 *  раньше, говорил одно — поднят туннель или перерублен; это теперь говорят
 *  слово и цвет, а карта добавляет, где именно трафик выходит в сеть, и
 *  заливкой страны повторяет состояние (`WorldMapView.tsx`). */
export function StatusBar({
  status,
  busy,
  onToggle,
  onScope,
}: {
  status: Status | null;
  busy: boolean;
  onToggle: () => void;
  /** Смена охвата. Идёт наверх, а не в службу отсюда: ошибка команды обязана
   *  попасть туда же, куда ошибка «включить». Туннель она не перезапускает —
   *  конфиг у обоих охватов один, — так что живые соединения её переживают. */
  onScope: (scope: Scope) => void;
}) {
  const s = strings(status?.lang);
  const [trouble, setTrouble] = useState(false);
  // Разовый отклик на включение (`.sw-sweep` в `switch.css`): растёт только от
  // нажатия человека, статус службы его не трогает.
  const [swept, setSwept] = useState(0);
  const [menu, setMenu] = useState<[number, number] | null>(null);
  const scope = status?.scope ?? "all";
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;
  // Профиль не выбран, но включать есть что: поднимется первый по алфавиту.
  const pending = status != null && !status.profile && status.profiles.length > 0;
  const latency = useCounted(status?.latency_ms ?? null);
  const latencies = useLatencies(status);
  const rates = useRates(status);
  // Байты не доезжают: между двумя статусами их набегают десятки килобайт, и
  // доезд читался бы не как измерение, а как перебор случайных цифр.
  const rx = status?.rx ?? null;
  const tx = status?.tx ?? null;
  // Масштаб один на оба графика: разные шкалы рядом читались бы как одинаковая
  // нагрузка при десятикратной разнице. Пик по обоим рядам, не по своему.
  const peak = Math.max(1, ...rates.map((r) => Math.max(r.rx, r.tx)));
  const last = rates.at(-1) ?? null;
  const span = spanSeconds(rates);
  const scaleHint = s.rateHint(bytes(peak) + s.perSecond);
  const view = describe(s, status);
  const state = tunnelState(status);

  const on = status != null && status.tunnel !== "off";
  const code = status?.probes.find((p) => p.name === status.profile)?.code;
  const exitFlag = status?.country ? flag(code) : null;
  const [exitCountry, exitCity] = splitExit(status?.country);
  // Узел, через который идёт (или пойдёт) канал, и его тип для метки.
  const nodeName = status?.profile ?? status?.profiles[0]?.name ?? null;
  const nodeKind = status?.profiles.find((p) => p.name === nodeName)?.kind;
  // Охваты, которые окно предлагает. `none` диагностический и в списке не
  // стоит (`the_frontend_knows_the_same_scopes`): показать его как состояние
  // окно умеет, выбрать — нет.
  const scopes: [Scope, string, string][] = [
    ["whitelist", s.scopeWhitelist, inTunnel === 0 ? s.noAppsAhead : s.scopeHintWhitelist],
    ["all", s.scopeAll, s.scopeHint],
    ["split", s.scopeSplit, s.splitHint],
  ];
  const scopeName = scopes.find(([value]) => value === scope)?.[1] ?? s.scope;
  const [rxNum, rxUnit] = last ? bytes(last.rx).split(" ") : ["—", ""];
  const [txNum, txUnit] = last ? bytes(last.tx).split(" ") : ["—", ""];

  return (
    <header data-state={state} className="relative shrink-0">
      {/* Верх окна — один ряд из трёх блоков на одной поверхности, разделённых
          волосяными линиями: состояние, скорость, задержка (1.75 : 1 : 0.72 —
          `.st-hero` в `index.css`). Прежде это были плита в 177 px и отдельная
          линейка в 89 под ней, и первая группа списка начиналась на 445-м
          пикселе окна в 705 px. Трёх колонок или ни одной: ниже 768 px блок
          состояния встаёт во всю ширину, а скорость и задержка — одной строкой
          под ним (`.st-metrics`), и сторож `the_instrument_row_never_wraps`
          следит, что строка не переносится. */}
      <div className="st-hero grid grid-cols-3">
        <div className="st st-state smooth">
        {swept > 0 && <span key={swept} className="sw-sweep" aria-hidden="true" />}
        {/* Карта — фон конца блока состояния, а не отдельная плита: она
            уходит под текст маской. Слой абсолютный, поэтому высоту блока
            задаёт текст. */}
        <div className="st-map-plate smooth">
          <WorldMap className="st-map" code={exitCode(status)} />
        </div>
        <div className="st-text relative flex h-full min-w-0 flex-col gap-1.5 px-4 py-2.5">
          {/* key — чтобы React заменил узел: надпись состояния сменяется
              вплывом, а не подменой символов на месте. Не обрезаем: в
              узком окне «Туннеля нет — доступ закрыт» обрубалось бы до
              «Туннел…», а это ровно та надпись, ради которой окно открыли. */}
          <div className="flex min-w-0 items-center gap-3">
            <h1 key={view.title} className="st-word swap flex min-w-0 flex-1 items-center gap-2.5 text-2xl font-semibold">
              <StateGlyph state={state} size={22} />
              <span className="min-w-0">{view.title}</span>
            </h1>
            {/* Выключатель продукта — тот же тумблер, что в плашке из трея:
                одна и та же вещь не должна выглядеть в двух окнах двумя
                разными кнопками. Надпись и условия запрета — те же, что
                были у кнопки «Включить». */}
            <Switch
              size="lg"
              checked={on}
              label={on ? s.turnOff : s.turnOn}
              disabled={!status || (!on && !status.profile && status.profiles.length === 0)}
              onChange={(next) => {
                if (next) setSwept((n) => n + 1);
                onToggle();
              }}
            />
          </div>
          {/* Подсказка — одна строка в любой ширине (`.st-hint` в `index.css`),
              целиком она остаётся в `title`: обрезается как раз хвост —
              отсчёт до следующей попытки. Дверь к причине стоит рядом с ней,
              а не внутри: «доступ закрыт» читают в ту секунду, когда пропала
              сеть, и ссылка в хвосте обрезаемой строки уезжала бы первой.
              Ряд один на подсказку и ссылку: в низком окне подсказка уходит
              (`@media (max-height)`), а ссылка остаётся — без неё «доступ
              закрыт» не говорил бы, где смотреть причину. */}
          <div className="st-hint-row flex min-w-0 items-baseline gap-2">
            <p key={view.hint} title={view.hint} className="st-hint swap min-w-0 flex-1 text-sm text-muted">
              {view.hint}
            </p>
            {status?.tunnel === "down" && (
              <button
                type="button"
                className="shrink-0 text-sm text-accent hover:underline"
                onClick={() => setTrouble(true)}
              >
                {s.whatsWrong}
              </button>
            )}
          </div>
          {/* Охват — «кого касается канал», и переключать его надо глядя на
              состояние туннеля, а не в настройках через две панели от него.
              Выпадающим выбором, а не полоской рядом с выключателем: охват
              меняют редко, а ряд из выключателя и трёх сегментов в 460 px
              не помещался и уходил на второй ряд. Пояснения — прямо в
              пунктах меню: по ним охваты и различают. Точка перед названием —
              тон состояния. */}
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={`${s.scope}: ${scopeName}`}
            title={s.scope}
            disabled={!status || busy}
            onClick={(e) => {
              // Начальный край кнопки, а не физический левый: в раскладке
              // справа налево меню растёт от правого (`fromStart` у `Menu`).
              const at = e.currentTarget.getBoundingClientRect();
              setMenu([document.documentElement.dir === "rtl" ? at.right : at.left, at.bottom + 4]);
            }}
            className="st-scope smooth inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 self-start px-2 text-sm font-medium disabled:opacity-40"
          >
            <span className="st-scope-dot" aria-hidden="true" />
            <span className="min-w-0 truncate">{scopeName}</span>
            <Icon name="chevron" size={14} className="rotate-90 text-muted" />
          </button>
          {/* Точка выхода и узел — внизу блока состояния, в две строки: куда
              выходим и через какой узел, а не двумя ячейками линейки. Прочерк
              без объяснения читается как поломка; настоящую страну при
              выключенном режиме не показываем намеренно: спросить её можно
              только у стороннего сервиса, а без туннеля запрос ушёл бы с
              настоящего адреса. «Не выбран» — не то же, что «неизвестен»:
              `App.tsx` включает первый по алфавиту, и молчание тут уводило бы в
              чужую страну без единого слова, поэтому предстоящий узел показан
              приглушённо и с подсказкой. Ужимается город, потом имя узла;
              страна и метка типа — последними. */}
          <div
            className="st-exit mt-auto flex min-w-0 flex-col gap-0.5 overflow-hidden whitespace-nowrap"
            title={status?.country ? undefined : pending ? s.profileFirst : s.exitUnknown}
          >
            <p className="flex min-w-0 items-baseline gap-x-2 text-base">
              {status?.country ? (
                <>
                  {exitFlag && (
                    <span className="shrink-0 self-center leading-none" aria-hidden="true">
                      {exitFlag}
                    </span>
                  )}
                  {/* Название прячется только тогда, когда вместо него
                      остаётся флаг: без флага пустая строка не значила бы
                      ничего. */}
                  <span className={`min-w-0 shrink-[0.1] truncate font-semibold ${exitFlag ? "m-country" : ""}`}>
                    {exitCountry}
                  </span>
                  {exitCity && <span className="m-city min-w-0 shrink-[100] truncate text-muted">{exitCity}</span>}
                </>
              ) : (
                <span className={`min-w-0 truncate ${pending ? "text-muted" : "font-semibold"}`}>
                  {nodeName ?? s.noProfile}
                </span>
              )}
            </p>
            {(status?.country ? nodeName : null) || nodeKind ? (
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                {status?.country && nodeName && (
                  <span className="min-w-0 shrink-[10] truncate" title={nodeName}>
                    {s.viaNode(nodeName)}
                  </span>
                )}
                {nodeKind && (
                  <span className="shrink-0 rounded-sm border border-edge px-1.5 font-mono text-xs">{nodeKind}</span>
                )}
              </p>
            ) : null}
          </div>
        </div>
        </div>

        {/* Два блока-измерителя: подпись и «окно» истории справа от неё, под
            ними — крупное число, под числом — колодец с графиком на всю
            оставшуюся высоту ряда и мелкая справка внизу. Колодец — не фон
            числа, а своё место: графику нужна площадь, а не просвет между
            цифрами. В узком окне (`.st-metrics` ниже 768 px) блоки
            складываются в строку чисел, а колодцы и подписи уходят. */}
        <div className="st-metrics">
          <section className="m-block" role="group" aria-label={s.speed} title={scaleHint}>
            <div className="m-legend">
              <span className="m-label text-xs">{s.speed}</span>
              {span != null && <span className="m-aside text-xs">{s.histSpan(span)}</span>}
            </div>
            <div className="m-rates flex items-baseline gap-x-4 font-mono tabular-nums">
              <span className="flex items-baseline gap-1 text-open" title={s.received}>
                <Icon name="down" size={14} className="m-icon-down shrink-0 self-center" />
                <span className="m-num text-xl font-medium">{rxNum}</span>
                <span className="text-xs font-normal text-muted">
                  {rxUnit}
                  {last ? s.perSecond : ""}
                </span>
              </span>
              <span className="flex items-baseline gap-1 text-accent" title={s.sent}>
                <Icon name="up" size={14} className="m-icon-up shrink-0 self-center" />
                <span className="m-num text-xl font-medium">{txNum}</span>
                <span className="text-xs font-normal text-muted">
                  {txUnit}
                  {last ? s.perSecond : ""}
                </span>
              </span>
            </div>
            {/* Принятое и отданное — одним колодцем и на одной шкале: так
                видно, какая из двух сторон несёт канал. */}
            <div className="chart" aria-hidden="true">
              <CellSpark values={rates.map((r) => r.rx)} peak={peak} id="pg-spark-down" tone="text-open" />
              <CellSpark values={rates.map((r) => r.tx)} peak={peak} id="pg-spark-up" tone="text-accent" />
            </div>
            <div className="m-foot m-session" title={s.trafficHint}>
              <span className="m-foot-label">{s.sessionTotal}</span>
              <span className="flex items-center gap-x-2.5 whitespace-nowrap font-mono tabular-nums text-muted">
                <span className="inline-flex items-center gap-0.5" title={s.received}>
                  <Icon name="down" size={12} className="shrink-0" />
                  {rx != null ? bytes(rx) : "—"}
                </span>
                <span className="inline-flex items-center gap-0.5" title={s.sent}>
                  <Icon name="up" size={12} className="shrink-0" />
                  {tx != null ? bytes(tx) : "—"}
                </span>
              </span>
            </div>
          </section>
          {/* Цвет — по настоящей задержке, а не по кадру анимации: порог должен
              переключаться по факту, а не по тому, докуда доехало число. */}
          <section className="m-block" role="group" aria-label={s.latency}>
            <div className="m-legend">
              <span className="m-label text-xs">{s.latency}</span>
              <span className="m-aside text-xs">{s.probeEvery}</span>
            </div>
            <div
              className={`m-latency smooth truncate font-mono text-2xl font-medium tabular-nums ${latencyTone(status?.latency_ms)}`}
            >
              {latency != null ? Math.round(latency) : "—"}
              {latency != null && <span className="ms-1 text-sm font-normal text-muted">ms</span>}
            </div>
            <div className="chart" aria-hidden="true">
              <LatencyBars values={latencies} className="m-bars" />
            </div>
            <div className="m-foot m-range">
              <span>
                {s.minShort}{" "}
                <span className="font-mono tabular-nums text-muted">
                  {latencies.length > 0 ? Math.round(Math.min(...latencies)) : "—"}
                </span>
              </span>
              <span>
                {s.maxShort}{" "}
                <span className="font-mono tabular-nums text-muted">
                  {latencies.length > 0 ? Math.round(Math.max(...latencies)) : "—"}
                </span>
              </span>
            </div>
          </section>
        </div>
      </div>

      {/* Пока служба не ответила, по нижней кромке плиты идёт бегунок. Прогресса
          у нас нет и быть не может — показываем только сам факт ожидания. */}
      {busy && (
        <div className="bar absolute inset-x-0 bottom-0 h-0.5 overflow-hidden text-[color:var(--tone)]" />
      )}
      {trouble && status && <Trouble s={s} status={status} onClose={() => setTrouble(false)} />}
      {menu && (
        <Menu
          at={menu}
          onClose={() => setMenu(null)}
          fromStart
          items={scopes.map(([value, label, hint]) => ({
            label,
            sub: hint,
            mark: value === scope,
            onPick: () => onScope(value),
          }))}
        />
      )}
    </header>
  );
}

/** Что не так: последние поломки из ленты службы и хвост журнала sing-box —
 *  одним окном, из шапки. Хвост спрашивается один раз на открытие: это
 *  взгляд, а не наблюдение, наблюдать — в настройках (`SingboxLog`). */
function Trouble({ s, status, onClose }: { s: Strings; status: Status; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let gone = false;
    void call({ cmd: "singbox-log" })
      .then((r) => {
        if (!gone && r.reply === "singbox-log") setLines(r.data.lines.slice(-40));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  const bad = status.log.filter((line) => line.bad).slice(0, 3);
  const text = () => [...bad.map((line) => line.text), "", ...(lines ?? [])].join("\n");
  return (
    <Modal title={s.whatsWrong} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <section>
          <h3 className="mb-1 text-sm font-semibold">{s.whatsWrongJournal}</h3>
          {bad.length === 0 ? (
            <p className="text-sm text-muted">—</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {bad.map((line, i) => (
                <li key={i} className="selectable font-mono text-xs leading-snug text-fault">
                  {line.text}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-1 text-sm font-semibold">{s.whatsWrongLog}</h3>
          <div className="scroll max-h-[45vh] overflow-auto rounded-md bg-surface-2 p-2">
            {lines == null || lines.length === 0 ? (
              <p className="p-1 text-sm text-muted">{lines == null ? "…" : s.whatsWrongEmpty}</p>
            ) : (
              <pre className="selectable whitespace-pre-wrap break-all font-mono text-xs text-muted">
                {lines.join("\n")}
              </pre>
            )}
          </div>
        </section>
        <div className="flex justify-end">
          <CopyButton text={text} label={s.copyLog} done={s.copied} />
        </div>
      </div>
    </Modal>
  );
}
