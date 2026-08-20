import { useEffect, useState } from "react";
import { call, type Conn, type Status } from "./platform";
import { strings } from "./i18n";
import { bytes } from "./StatusBar";
import { Empty, Panel } from "./ui";

/** Соединения живут секундами, и опрос у них свой: в статусе им не место —
 *  тот ходит по кругу всегда, а список нужен, только пока панель открыта.
 *  Две секунды — тот же такт, что у статуса: чаще нечего, служба и сама тикает
 *  раз в три. */
const POLL_MS = 2000;

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
 *  трафика» этой панелью не отменяется, она его и соблюдает. */
export function Conns({ status, className }: { status: Status | null; className?: string }) {
  const s = strings(status?.lang);
  const [conns, setConns] = useState<Conn[]>([]);
  const [total, setTotal] = useState(0);
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
