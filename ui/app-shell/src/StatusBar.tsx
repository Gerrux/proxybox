import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, type Scope, type Status } from "./platform";
import { strings, type Strings } from "./i18n";
import { Button, CopyButton, Icon, type IconName, Modal, Segmented, flag } from "./ui";
import { WorldMap } from "./WorldMap";

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

/** Байты в секунду за один такт. */
type Rate = { rx: number; tx: number };

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
        { rx: Math.max(0, status.rx - was.rx) / dt, tx: Math.max(0, status.tx - was.tx) / dt },
      ].slice(-SPARK),
    );
    // Зависимость — сам статус, а не его поля: при молчащем канале счётчики не
    // меняются, а график обязан ехать дальше нулём, иначе он читался бы как
    // замерший, то есть как поломка.
  }, [status]);

  return rates;
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

/** История скорости фоном той ячейки, которая считает эти же байты: график
 *  принятого — под числом принятого, отданного — под отданным.
 *
 *  Масштаб общий на оба графика (`peak` считается по обоим), иначе молчащая
 *  отдача рисовалась бы такой же горой, что и загруженный приём, — два
 *  графика рядом читаются как один прибор, и разные шкалы у них врут.
 *
 *  Бледный намеренно: это история, а не показание. Число читают, форму
 *  замечают краем глаза. Ровная линия по нижней кромке значит «туннель поднят,
 *  и по нему молчат» — это не то же самое, что замерший график. */
function CellSpark({ values, peak, id, tone }: { values: number[]; peak: number; id: string; tone: string }) {
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
 *  заливкой страны повторяет состояние (`WorldMap.tsx`). */
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
  const scope = status?.scope ?? "all";
  const inTunnel = status?.apps.filter((a) => a.enabled).length ?? 0;
  // Профиль не выбран, но включать есть что: поднимется первый по алфавиту.
  const pending = status != null && !status.profile && status.profiles.length > 0;
  const latency = useCounted(status?.latency_ms ?? null);
  const rates = useRates(status);
  // Байты не доезжают: между двумя статусами их набегают десятки килобайт, и
  // доезд читался бы не как измерение, а как перебор случайных цифр.
  const rx = status?.rx ?? null;
  const tx = status?.tx ?? null;
  // Масштаб один на оба графика: разные шкалы рядом читались бы как одинаковая
  // нагрузка при десятикратной разнице. Пик по обоим рядам, не по своему.
  const peak = Math.max(1, ...rates.map((r) => Math.max(r.rx, r.tx)));
  const last = rates.at(-1) ?? null;
  const scaleHint = s.rateHint(bytes(peak) + s.perSecond);
  const view = describe(s, status);
  const state = tunnelState(status);

  const on = status != null && status.tunnel !== "off";
  const code = status?.probes.find((p) => p.name === status.profile)?.code;
  const exitFlag = status?.country ? flag(code) : null;
  const [exitCountry, exitCity] = splitExit(status?.country);

  return (
    <header data-state={state} className="relative shrink-0">
      <div className="st st-plate smooth">
        <div className="st-text flex min-w-0 flex-col gap-3 p-4">
          <div className="min-w-0">
            {/* key — чтобы React заменил узел: надпись состояния сменяется
                вплывом, а не подменой символов на месте. Не обрезаем: в
                узком окне «Туннеля нет — доступ закрыт» обрубалось бы до
                «Туннел…», а это ровно та надпись, ради которой окно открыли. */}
            <h1 key={view.title} className="st-word swap flex items-center gap-2.5 text-2xl font-semibold">
              <StateGlyph state={state} size={22} />
              <span className="min-w-0">{view.title}</span>
            </h1>
            {/* Подсказка целиком остаётся в `title`: в узком окне она
                обрезается до одной строки (`index.css`), а обрезается как раз
                хвост — отсчёт до следующей попытки. */}
            <p key={view.hint} title={view.hint} className="st-hint swap mt-1 text-sm text-muted">
              {view.hint}
              {/* Дверь к причине там, где её ищут: «доступ закрыт» читают в
                  ту секунду, когда пропала сеть. Ссылкой в самой подсказке,
                  а не кнопкой в ряду: ряд кнопок в 460 px её не вмещал, и
                  она уезжала на второй ряд одна. */}
              {status?.tunnel === "down" && (
                <>
                  {" · "}
                  <button type="button" className="text-accent hover:underline" onClick={() => setTrouble(true)}>
                    {s.whatsWrong}
                  </button>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={on ? "ghost" : "primary"}
              disabled={!status || (!on && !status.profile && status.profiles.length === 0)}
              onClick={onToggle}
              className="min-w-30"
            >
              <Icon name="power" />
              {on ? s.turnOff : s.turnOn}
            </Button>
            {/* Охват — «кого касается канал», и переключать его надо глядя на
                состояние туннеля, а не в настройках через две панели от него. */}
            <Segmented
              label={s.scope}
              options={[
                ["whitelist", s.scopeWhitelist, inTunnel === 0 ? s.noAppsAhead : s.scopeHintWhitelist],
                ["all", s.scopeAll, s.scopeHint],
              ]}
              value={scope}
              disabled={!status || busy}
              onPick={(v) => onScope(v as Scope)}
            />
          </div>
        </div>
        <div className="st-map-plate smooth">
          <WorldMap className="st-map" code={exitCode(status)} />
        </div>
      </div>

      {/* Пять колонок или ни одной: промежуточные сетки из двух и трёх колонок
          уносили счётчики трафика на второй-третий ряд, а его — за нижний край
          окна. Ниже 768 px линейка целиком уходит в строку (`index.css`). */}
      <dl className="st-metrics relative grid grid-cols-5 px-4 py-2">
        {/* «Не выбран» — не то же, что «неизвестен»: `App.tsx` включает первый
            по алфавиту, и молчание тут уводит в чужую страну без единого слова.
            Показываем предстоящий профиль приглушённо и с подсказкой. */}
        <Metric
          name={s.profile}
          value={status?.profile ?? status?.profiles[0]?.name ?? s.noProfile}
          tone={pending ? "text-muted" : ""}
          hint={pending ? s.profileFirst : undefined}
        />
        {/* Прочерк без объяснения читается как поломка. Настоящую страну при
            выключенном режиме не показываем намеренно: спросить её можно только
            у стороннего сервиса, а без туннеля запрос ушёл бы с настоящего
            адреса. */}
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
              <span className={`min-w-0 truncate ${exitFlag ? "m-country" : ""}`}>
                {exitCountry}
                {/* Город — приглушённо следом и только если он есть. */}
                {exitCity && <span className="m-city font-normal text-muted"> · {exitCity}</span>}
              </span>
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
          mono
        />
        <Metric
          name={s.received}
          value={rx != null ? bytes(rx) : "—"}
          hint={s.trafficHint}
          icon="down"
          mono
          rate={last ? `${bytes(last.rx)}${s.perSecond}` : undefined}
          rateHint={scaleHint}
          spark={<CellSpark values={rates.map((r) => r.rx)} peak={peak} id="pg-spark-down" tone="text-open" />}
        />
        <Metric
          name={s.sent}
          value={tx != null ? bytes(tx) : "—"}
          hint={s.trafficHint}
          icon="up"
          mono
          rate={last ? `${bytes(last.tx)}${s.perSecond}` : undefined}
          rateHint={scaleHint}
          spark={<CellSpark values={rates.map((r) => r.tx)} peak={peak} id="pg-spark-up" tone="text-accent" />}
        />
      </dl>

      {/* Пока служба не ответила, по нижней кромке плиты идёт бегунок. Прогресса
          у нас нет и быть не может — показываем только сам факт ожидания. */}
      {busy && (
        <div className="bar absolute inset-x-0 bottom-0 h-0.5 overflow-hidden text-[color:var(--tone)]" />
      )}
      {trouble && status && <Trouble s={s} status={status} onClose={() => setTrouble(false)} />}
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

/** Ячейка приборной линейки: подпись, под ней значение ступенью крупнее —
 *  линейка читается как прибор, а не как подпись к подписи.
 *  Цифры табличные — статус приходит каждые две секунды, и прыгать по ширине
 *  им нельзя.
 *
 *  В узком окне (`@media (max-width: 767px)` в `index.css`) подписи уходят
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
  spark,
  rate,
  rateHint,
  mono,
}: {
  name: string;
  value: string;
  /** Число, а не слово: набирается моноширинным — цифры прибора стоят
   *  столбиком и не дёргаются, когда меняются. */
  mono?: boolean;
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
  /** История скорости фоном ячейки. Только у счётчиков: у профиля и страны
   *  истории нет, а у задержки она есть, но в байтах её не нарисовать. */
  spark?: ReactNode;
  /** Скорость под числом — то же измерение, что и график, только словами. */
  rate?: string;
  rateHint?: string;
}) {
  return (
    // Разделители только там, где линейка стоит одной строкой: в две колонки
    // левая граница второго ряда висела бы посреди пустоты.
    <div className="m-cell min-w-0 md:border-s md:border-edge md:px-3 md:first:border-s-0 md:first:ps-0">
      {spark}
      <dt className="m-label text-xs text-muted">{name}</dt>
      {/* tabular-nums обязателен именно из-за доезда: цифры разной ширины
          меняются каждый кадр и дёргали бы линейку по всей строке. */}
      <dd
        className={`m-value smooth mt-0.5 flex items-baseline gap-1.5 overflow-hidden text-lg font-semibold tabular-nums ${mono ? "font-mono" : ""} ${tone}`}
        title={hint ? `${name}: ${value} — ${hint}` : `${name}: ${value}`}
      >
        {icon && (
          <span className="m-icon shrink-0 self-center text-muted">
            <Icon name={icon} size={12} />
          </span>
        )}
        {children ?? <span className="truncate">{value}</span>}
      </dd>
      {rate && (
        <dd className="rates truncate font-mono" title={rateHint}>
          {rate}
        </dd>
      )}
    </div>
  );
}
