import { useEffect, useRef, useState } from "react";
import { call, type Act, type Conn, type Status } from "./platform";
import { strings } from "./i18n";
import { bytes } from "./StatusBar";
import { Button, Empty, Menu, type MenuItem, Panel, SearchField, spot } from "./ui";

/** Соединения живут секундами, и опрос у них свой: в статусе им не место —
 *  тот ходит по кругу всегда, а список нужен, только пока панель открыта.
 *  Две секунды — тот же такт, что у статуса: чаще нечего, служба и сама тикает
 *  раз в три. */
const POLL_MS = 2000;

/** Запертые меняются не по секундам, а по запускам приложений, и стоят они
 *  обхода всех процессов машины. Такт поэтому свой, вчетверо реже: спрашивать
 *  их вместе с соединениями значило бы обходить процессы каждые две секунды
 *  ради списка, который за это время не меняется. */
const FENCED_MS = 8000;

/** Отбор считает служба, а печатают его по букве: без этой паузы каждое
 *  нажатие клавиши — свой поход в clash-api и свой снимок таблицы сокетов. */
const TYPING_MS = 300;

/** Имя файла из пути: строку целиком в колонку не уместить, а различать один
 *  chrome.exe от другого тут всё равно нечем — путь висит подсказкой. */
function base(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/** Что идёт через туннель прямо сейчас — и кто заперт, пока оно идёт.
 *
 *  Панель заведена не ради счётчиков: список приложений — это намерение, а
 *  строка соединения — то, что вышло на самом деле, и увидеть одно рядом с
 *  другим больше негде. Выбранное приложение не в туннеле подсвечено как
 *  поломка: маршрута мимо туннеля в конфиге нет вовсе, и задуманным такой путь
 *  быть не может.
 *
 *  Отбитых соединений в списке нет и быть не может, и это не упущение: Windows
 *  отбивает их на `connect`, до sing-box они не доходят, а сокет не успевает
 *  попасть в таблицу — следа не остаётся нигде, кроме аудита WFP, то есть
 *  вечного журнала трафика на диске. Поэтому вопрос перевёрнут: не «что
 *  отбито», а «кто заперт», и ответ на него служба выводит из уже известного,
 *  не заводя ни одной новой записи.
 *
 *  Имя процесса и выбранность считает служба: у sing-box имени спрашивать
 *  нечего (правила по `process_path` у нас нет ни одного), а сверять путь со
 *  списком приложений здесь нельзя — форм у пути до двух, а в списке живёт
 *  одна.
 *
 *  Ничего не копится: списки спрашиваются, пока панель открыта, и умирают
 *  вместе с ней. Ни журнала, ни диска, ни тем более наружу — принцип «ни логов
 *  трафика» этой панелью не отменяется, она его и соблюдает. */
export function Conns({
  status,
  act,
  className,
}: {
  status: Status | null;
  act: Act;
  className?: string;
}) {
  const s = strings(status?.lang);
  const [conns, setConns] = useState<Conn[]>([]);
  const [total, setTotal] = useState(0);
  const [matched, setMatched] = useState(0);
  const [fenced, setFenced] = useState<string[]>([]);
  const [shown, setShown] = useState(false);
  const [menu, setMenu] = useState<{ at: [number, number]; items: MenuItem[] } | null>(null);
  // Набранное и отправленное — разные вещи: пока букву дописывают, отбор
  // держится прежним, иначе служба получает запрос на каждое нажатие.
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  // Правка списка сбывается сразу, а следующий круг придёт через восемь секунд:
  // без этого приложение оставалось бы в списке запертых после того, как его
  // оттуда же и выпустили.
  const [done, setDone] = useState(0);
  // Соединения спрашиваются у живого туннеля: без него их нет вовсе, и
  // дёргать службу впустую каждые две секунды незачем.
  const live = status?.tunnel === "up";
  // Заперты — это про включённый приватный режим, а не про поднятый туннель, и
  // разница тут не формальная: смотрят сюда как раз тогда, когда туннель лежит
  // и сети нет ни у кого. В охвате «весь компьютер» запертых не бывает — делить
  // там некого, и служба отвечает пустым списком.
  const fencing = status != null && status.tunnel !== "off" && status.scope !== "all";
  // Пока курсор внутри списка, обновление придержано. Служба сортирует по
  // громкости на каждый запрос, и раз в две секунды строки меняются местами —
  // строку не дочитать, а хост не выделить: он уезжает из-под курсора ровно
  // тогда, когда его собираются скопировать. В ref, а не в состоянии: опрос
  // читает признак изнутри таймера, и перезаводить таймер на каждое движение
  // мыши значило бы сдвигать сам такт опроса.
  const hold = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => setFilter(query.trim()), TYPING_MS);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (!live) {
      setConns([]);
      setTotal(0);
      setMatched(0);
      return;
    }
    let gone = false;
    // Первый заход идёт помимо придержки: она про строки, уезжающие из-под
    // курсора, а сменившийся отбор — это ровно то, чего ждут прямо сейчас.
    const ask = (now: boolean) => {
      // Спрятанное в трей окно живёт сколько угодно долго, и смотреть в него
      // некому: там же, где статус, останавливается и этот опрос.
      if (!now && (document.hidden || hold.current)) return;
      void call({ cmd: "connections", arg: { filter } })
        .then((r) => {
          if (gone || r.reply !== "connections") return;
          setConns(r.data.conns);
          setTotal(r.data.total);
          setMatched(r.data.matched);
        })
        // Служба замолчала — про это говорит шапка. Гасить список нечем:
        // последний известный честнее пустого.
        .catch(() => {});
    };
    ask(true);
    const id = setInterval(() => ask(false), POLL_MS);
    return () => {
      gone = true;
      clearInterval(id);
    };
  }, [live, filter]);

  useEffect(() => {
    if (!fencing) {
      setFenced([]);
      return;
    }
    let gone = false;
    const ask = () => {
      if (document.hidden) return;
      void call({ cmd: "fenced" })
        .then((r) => {
          if (!gone && r.reply === "fenced") setFenced(r.data.apps);
        })
        .catch(() => {});
    };
    ask();
    const id = setInterval(ask, FENCED_MS);
    return () => {
      gone = true;
      clearInterval(id);
    };
  }, [fencing, done]);

  const edit = (cmd: "add-app" | "remove-app", path: string) => {
    void act({ cmd, arg: { path } }).then(() => setDone((n) => n + 1));
  };

  // Что предложить строке, решает поле `picked`, а не своя сверка со списком:
  // форм у пути до двух, а в списке приложений живёт одна, и промах здесь
  // означал бы «добавить» у того, что добавлено.
  const rowMenu = (c: Conn): MenuItem[] =>
    c.picked
      ? [
          {
            label: s.connsDrop,
            hint: s.connsDropHint,
            danger: true,
            onPick: () => edit("remove-app", c.process),
          },
        ]
      : [{ label: s.connsAdd, onPick: () => edit("add-app", c.process) }];

  // Запертых отбирает окно, а не служба, и это не непоследовательность:
  // соединения режутся сотней по громкости, а запертые приезжают списком
  // целиком — промахнуться мимо обрезки тут негде.
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const locked = fenced.filter((path) => words.every((word) => path.toLowerCase().includes(word)));
  const searchable = live || fenced.length > 0;

  return (
    <Panel
      pad="p-3.5"
      className={className}
      title={s.conns}
      note={
        live &&
        conns.length > 0 && (
          <span className="text-muted" title={s.connsHint}>
            {filter === ""
              ? s.connsNote(conns.length, total)
              : s.connsFound(conns.length, matched, total)}
          </span>
        )
      }
    >
      <div className="flex flex-col gap-2.5">
        {searchable && (
          <div title={s.connsFindHint}>
            <SearchField value={query} onChange={setQuery} placeholder={s.connsFind} />
          </div>
        )}
        {locked.length > 0 && (
          // Рубеж, а не строка списка: запертые отвечают на другой вопрос, чем
          // соединения, и слитые в один поток читались бы как соединения без
          // адреса. Свёрнуты по умолчанию: запущенных приложений у человека
          // десятки, а панель открывают ради одного из них.
          <div className="rounded-md border border-edge">
            <button
              type="button"
              title={s.connsFencedHint}
              aria-expanded={shown}
              onClick={() => setShown(!shown)}
              className="smooth flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-[12px] text-muted hover:bg-surface-2"
            >
              <span className="shrink-0 font-mono text-[10px]">{shown ? "▾" : "▸"}</span>
              <span className="min-w-0 flex-1 truncate">{s.connsFenced(locked.length)}</span>
            </button>
            {shown && (
              <ul className="flex flex-col border-t border-edge px-1.5 py-1">
                {locked.map((path) => (
                  <li
                    key={path}
                    className="smooth flex items-center gap-2 rounded-md py-1 ps-2 pe-1 hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px]" title={path}>
                      {base(path)}
                    </span>
                    <Button variant="quiet" onClick={() => edit("add-app", path)}>
                      {s.connsAdd}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!live ? (
          <Empty>{s.connsOff}</Empty>
        ) : conns.length === 0 && filter !== "" ? (
          <Empty>{s.connsNothing}</Empty>
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
          <ul
            className="flex flex-col"
            onMouseEnter={() => (hold.current = true)}
            onMouseLeave={() => (hold.current = false)}
          >
            {conns.map((c, i) => {
              // Выбранное приложение мимо туннеля — это тот самый тихий промах, а
              // не «так и задумано»: цвет у него поломочный, как у неподнявшихся
              // правил. Всё остальное прямое — чужой трафик, его мы не трогаем.
              // Считает это служба: путей у приложения бывает две формы, и здесь
              // известна одна.
              const leak = c.leak;
              const name = base(c.process);
              return (
                <li
                  // Соединения живут секундами и своего имени не имеют: ключ по
                  // содержимому, а порядковый номер — на случай двух одинаковых.
                  key={`${i}-${c.process}-${c.host}`}
                  // Объяснение есть у обеих не-туннельных строк, а не только у
                  // поломки: серую («sing-box разобрал сам») раньше не объяснял
                  // никто, и читалась она ровно как красная.
                  title={leak ? s.connsDirectHint : c.tunneled ? undefined : s.connsAsideHint}
                  // Меню только там, где есть кого добавлять: пусто в колонке
                  // процесса значит «владельца не нашли» или «порт спорный», и
                  // серый пункт вместо отсутствующего обещал бы действие.
                  onContextMenu={
                    c.process === ""
                      ? undefined
                      : (e) => {
                          e.preventDefault();
                          setMenu({ at: spot(e), items: rowMenu(c) });
                        }
                  }
                  className="smooth relative flex items-baseline gap-3 rounded-md py-1.5 ps-3 pe-1 hover:bg-surface-2"
                >
                  <span
                    className={`absolute inset-y-1 start-0 w-[3px] rounded-full ${
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
      </div>
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </Panel>
  );
}
