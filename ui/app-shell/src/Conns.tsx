import { useEffect, useRef, useState } from "react";
import { call, type Conn, type Status } from "./platform";
import { strings, type Strings } from "./i18n";
import { bytes } from "./StatusBar";
import { Empty, Panel } from "./ui";

/** Соединения живут секундами, и опрос у них свой: в статусе им не место —
 *  тот ходит по кругу всегда, а список нужен, только пока панель открыта.
 *  Две секунды — тот же такт, что у статуса: чаще нечего, служба и сама тикает
 *  раз в три. */
const POLL_MS = 2000;

/** Сколько отсчётов держит график: при такте статуса в две секунды это около
 *  полутора минут — столько, чтобы увидеть всплеск и понять, кончился он или
 *  продолжается. Дольше держать нечем и незачем: истории у нас нет, и заводить
 *  её ради картинки значит начать хранить трафик. */
const SPARK = 45;
/** Размер графика в пикселях. Он же система координат SVG: второго масштаба
 *  между отсчётами и линией не заводим. */
const SPARK_W = 132;
const SPARK_H = 26;

/** Байты в секунду за один такт. */
type Rate = { rx: number; tx: number };

/** Скорость канала из тех же счётчиков, что показывает шапка. Они идут с
 *  запуска sing-box, поэтому разница между двумя статусами и есть байты в
 *  секунду; своего опроса графику не нужно вовсе — он едет на статусе, который
 *  окно и так спрашивает.
 *
 *  Память живёт в окне и умирает вместе с панелью: ни в службу, ни на диск это
 *  не уезжает — там его хранение называлось бы журналом трафика. */
function useRates(status: Status | null): Rate[] {
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
    const at = performance.now();
    const was = prev.current;
    prev.current = { rx: status.rx, tx: status.tx, at };
    // Первый статус — точка отсчёта, скорости из одного числа не бывает.
    if (!was) return;
    const dt = (at - was.at) / 1000;
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

/** Точки ломаной по отсчётам, сверху вниз в координатах SVG. */
function points(values: number[], peak: number): string {
  const step = SPARK_W / (values.length - 1);
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(SPARK_H - (v / peak) * SPARK_H).toFixed(1)}`)
    .join(" ");
}

/** График скорости в шапке панели: полторы минуты канала одной картинкой.
 *
 *  Масштаб плавающий, по пику окна — постоянной шкалы у канала нет, а «сколько
 *  это в байтах» отвечает подпись рядом. Ровная линия по нижней кромке значит
 *  «туннель поднят, и по нему молчат»: это не то же самое, что замерший
 *  график, и различать их человек должен глазом. */
function Spark({ rates, s }: { rates: Rate[]; s: Strings }) {
  // Одна точка — ещё не линия: рисовать нечего, пока не пришёл второй статус.
  if (rates.length < 2) return null;
  const peak = Math.max(1, ...rates.map((r) => Math.max(r.rx, r.tx)));
  const last = rates[rates.length - 1];
  return (
    <div className="flex items-center gap-2" title={s.connsRateHint(bytes(peak) + s.perSecond)}>
      <svg
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        aria-hidden="true"
        className="shrink-0"
      >
        {/* Отправленное под принятым: его обычно меньше, и тонкой линией оно не
            прячется за толстой. */}
        <polyline
          points={points(rates.map((r) => r.tx), peak)}
          className="text-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <polyline
          points={points(rates.map((r) => r.rx), peak)}
          className="text-accent"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {/* Тот же порядок и те же стрелки, что в приборной линейке: ↓ принято,
          ↑ отправлено. Цифры табличные — они меняются каждые две секунды. */}
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
        ↓{bytes(last.rx)}{s.perSecond} ↑{bytes(last.tx)}{s.perSecond}
      </span>
    </div>
  );
}

/** Что идёт через туннель прямо сейчас — и что идёт мимо него.
 *
 *  Панель заведена не ради счётчиков: правило sing-box по `process_path`
 *  сверяет путь побайтово, и промах у него тихий — приложение уходит напрямую,
 *  не переставая считаться защищённым. Единственный способ это увидеть — своими
 *  глазами, в строке соединения. Выбранное приложение мимо туннеля подсвечено
 *  как поломка, невыбранное — нет: для него прямой путь и есть задуманный.
 *
 *  Ничего не копится: список спрашивается, пока панель открыта, и умирает
 *  вместе с ней. Ни журнала, ни диска, ни тем более наружу — принцип «ни логов
 *  трафика» этой панелью не отменяется, она его и соблюдает. Полторы минуты
 *  скорости в графике — единственное, что панель помнит, и помнит она это в
 *  своём состоянии: закрыли вкладку — забыла. */
export function Conns({ status, className }: { status: Status | null; className?: string }) {
  const s = strings(status?.lang);
  const [conns, setConns] = useState<Conn[]>([]);
  const [total, setTotal] = useState(0);
  const rates = useRates(status);
  // Соединения спрашиваются у живого туннеля: без него их нет вовсе, и
  // дёргать службу впустую каждые две секунды незачем.
  const live = status?.tunnel === "up";

  useEffect(() => {
    if (!live) {
      setConns([]);
      setTotal(0);
      return;
    }
    let gone = false;
    const ask = () => {
      // Спрятанное в трей окно живёт сколько угодно долго, и смотреть в него
      // некому: там же, где статус, останавливается и этот опрос.
      if (document.hidden) return;
      void call({ cmd: "connections" })
        .then((r) => {
          if (gone || r.reply !== "connections") return;
          setConns(r.data.conns);
          setTotal(r.data.total);
        })
        // Служба замолчала — про это говорит шапка. Гасить список нечем:
        // последний известный честнее пустого.
        .catch(() => {});
    };
    ask();
    const id = setInterval(ask, POLL_MS);
    return () => {
      gone = true;
      clearInterval(id);
    };
  }, [live]);

  return (
    <Panel
      className={className}
      title={s.conns}
      note={
        live &&
        conns.length > 0 && (
          <span className="text-muted" title={s.connsHint}>
            {s.connsNote(conns.length, total)}
          </span>
        )
      }
      action={live ? <Spark rates={rates} s={s} /> : undefined}
    >
      {!live ? (
        <Empty>{s.connsOff}</Empty>
      ) : conns.length === 0 ? (
        <Empty>{s.connsEmpty}</Empty>
      ) : (
        <ul className="flex flex-col">
          {conns.map((c, i) => {
            // Выбранное приложение мимо туннеля — это тот самый тихий промах, а
            // не «так и задумано»: цвет у него поломочный, как у неподнявшихся
            // правил. Всё остальное прямое — чужой трафик, его мы не трогаем.
            // Считает это служба: путей у приложения бывает две формы, и здесь
            // известна одна.
            const leak = c.leak;
            const name = c.process.split(/[\\/]/).pop() ?? "";
            return (
              <li
                // Соединения живут секундами и своего имени не имеют: ключ по
                // содержимому, а порядковый номер — на случай двух одинаковых.
                key={`${i}-${c.process}-${c.host}`}
                title={leak ? s.connsDirectHint : undefined}
                className="smooth relative flex items-baseline gap-3 rounded-md py-1.5 pl-3 pr-1 hover:bg-surface-2"
              >
                <span
                  className={`absolute inset-y-1 left-0 w-[3px] rounded-full ${
                    c.tunneled ? "bg-open" : leak ? "bg-fault" : "bg-muted"
                  }`}
                />
                <span
                  className={`w-[4.5rem] shrink-0 text-[11px] ${
                    c.tunneled ? "text-open" : leak ? "text-fault" : "text-muted"
                  }`}
                >
                  {c.tunneled ? s.connsTunnel : s.connsDirect}
                </span>
                <span
                  className={`w-32 shrink-0 truncate text-[12.5px] ${name ? "" : "text-muted"}`}
                  title={name ? c.process : s.connsNoProcessHint}
                >
                  {name || s.connsNoProcess}
                </span>
                <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
                  {c.host}
                </span>
                {/* Числа моноширинные и в одном порядке с шапкой: ↓ принято,
                    ↑ отправлено. */}
                <span className="shrink-0 font-mono text-[11px] text-muted">
                  ↓{bytes(c.rx)} ↑{bytes(c.tx)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
