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
 *  Панель заведена не ради счётчиков: список приложений — это намерение, а
 *  строка соединения — то, что вышло на самом деле, и увидеть одно рядом с
 *  другим больше негде. Выбранное приложение мимо туннеля подсвечено как
 *  поломка, невыбранное — нет: для него прямой путь и есть задуманный.
 *
 *  Имя процесса считает служба по локальному порту соединения: у sing-box его
 *  спрашивать нечего — своё поле он заполняет, только когда в маршрутизации
 *  есть правило по `process_path`, а такого правила у нас нет ни одного.
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
        // Пусто — это и есть ответ на вопрос, ради которого панель открывают, и
        // единственное место, где он помещается словами: в белом списке
        // доказательством защиты служит отсутствие строк, а обещание «нигде не
        // сохраняется» до сих пор жило в подсказке на счётчике, то есть не
        // показывалось никому.
        <Empty>
          {s.connsEmpty}
          {status?.scope === "whitelist" && ` ${s.connsEmptyFenced}`} {s.connsHint}
        </Empty>
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
                // Объяснение есть у обеих не-туннельных строк, а не только у
                // поломки: серую («sing-box разобрал сам») раньше не объяснял
                // никто, и читалась она ровно как красная.
                title={leak ? s.connsDirectHint : c.tunneled ? undefined : s.connsAsideHint}
                className="smooth relative flex items-baseline gap-3 rounded-md py-1.5 pl-3 pr-1 hover:bg-surface-2"
              >
                <span
                  className={`absolute inset-y-1 left-0 w-[3px] rounded-full ${
                    c.tunneled ? "bg-open" : leak ? "bg-fault" : "bg-muted"
                  }`}
                />
                {/* Слово пишется только у исключения. Под `final: proxy` в
                    туннель идёт всё, что sing-box вообще видит, — столбец с
                    неизменным «туннель» приучал глаз его не читать ровно к
                    тому дню, когда там появится другое слово, и отнимал
                    полтора сантиметра у имени хоста, которое режется. Рельс
                    слева остаётся: он и был тем, что различает строки. */}
                {!c.tunneled && (
                  <span className={`shrink-0 text-[11px] ${leak ? "text-fault" : "text-muted"}`}>
                    {s.connsDirect}
                  </span>
                )}
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
