import { useEffect, useRef, useState } from "react";
import { call, type Act, type Conn, type Status } from "./platform";
import { strings } from "./i18n";
import { bytes } from "./StatusBar";
import { Button, Empty, Icon, Menu, type MenuItem, Modal, Panel, SearchField, spot } from "./ui";

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

/** Один путь в двух написаниях — один файл: на Windows регистр и вид
 *  разделителя файловая система не различает, а путь из таблицы сокетов и путь
 *  из списка приложений приходят из разных рук. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/** Что из адреса соединения можно предложить в исключения: IPv4 или домен.
 *  `host` приходит как `хост:порт`; IPv6 исключениями не бывает вовсе (служба
 *  его отвергнет), поэтому и предлагать его незачем. Одиночный адрес служба
 *  сама приводит к `a.b.c.d/32`, а домен — к нижнему регистру, и для сверки с
 *  уже заведённым списком окно приводит так же. */
function exceptionFor(host: string): { entry: string; stored: string } | null {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return { entry: name, stored: `${name}/32` };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) && /[a-z]/.test(name)) return { entry: name, stored: name };
  return null;
}

/** Что идёт через туннель прямо сейчас — и кто заперт, пока оно идёт.
 *
 *  Панель заведена не ради счётчиков: список приложений — это намерение, а
 *  строка соединения — то, что вышло на самом деле, и увидеть одно рядом с
 *  другим больше негде. Выбранное приложение не в туннеле подсвечено как
 *  поломка: маршрута мимо туннеля в конфиге нет вовсе, и задуманным такой путь
 *  быть не может.
 *
 *  Список — настоящая таблица: шапка и колонки одной ширины (путь, приложение,
 *  адрес, ↓, ↑). Раньше слово «напрямую» стояло перед именем только у части
 *  строк и сдвигало всё, что правее, — числа и адреса не вставали в столбец, а
 *  столбец сравнивают взглядом сверху вниз. Слово пути теперь у каждой строки:
 *  «туннель» бледным (это норма, и глаз не должен на нём останавливаться),
 *  всё остальное — своим тоном, потому что ради этого панель и открывают.
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
  // Адреса, до которых не дозвонилось и прямое соединение: исключение тут не
  // поможет, и сказать это нужно прямо над списком, а не в строке.
  const [unreached, setUnreached] = useState<string[]>([]);
  // Что человек собирается пустить мимо туннеля — до подтверждения.
  const [asking, setAsking] = useState<string | null>(null);
  // Приложение «Раздельно», которому меняют путь, — тоже до подтверждения:
  // правка списка напрямую перезапускает туннель.
  const [routing, setRouting] = useState<{ path: string; direct: boolean } | null>(null);
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
  const fencing = status != null && status.tunnel !== "off" && (status.scope === "whitelist" || status.scope === "none");
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
      setUnreached([]);
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
          // Служба прошлой сборки поля не присылает — панель не должна из-за
          // этого падать целиком.
          setUnreached(r.data.unreached ?? []);
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

  // Исключение добавляется только явным нажатием и после вопроса: правка
  // перезапускает туннель, а трафик на этот адрес уходит мимо него. Список
  // уезжает службе целиком — так устроена команда.
  const addException = (entry: string) => {
    setAsking(null);
    void act({ cmd: "set-bypass", arg: { rules: [...(status?.bypass ?? []), entry] } });
  };

  // «Раздельно»: напрямую идут приложения из `settings.direct_apps`, и правка
  // этого списка — единственный путь. Приложение сперва заводится в общий
  // список (команда его не трогает, если оно там уже есть, а в «Раздельно» новое
  // встаёт без галочки белого списка), иначе строка напрямую ходила бы мимо
  // панели приложений: галочку, снять которую, было бы негде. Путь берётся из
  // списка приложений, если оно там есть, — в двух написаниях галочка не
  // сошлась бы со списком.
  const reroute = ({ path, direct }: { path: string; direct: boolean }) => {
    setRouting(null);
    if (!status) return;
    const listed = status.apps.find((a) => samePath(a.path, path))?.path ?? path;
    const rest = (status.settings.direct_apps ?? []).filter((p) => !samePath(p, path));
    const direct_apps = direct ? [...rest, listed] : rest;
    void (direct ? act({ cmd: "add-app", arg: { path: listed } }) : Promise.resolve(null))
      .then(() => act({ cmd: "set-settings", arg: { settings: { ...status.settings, direct_apps } } }));
  };

  // Что предложить строке, решает поле `picked`, а не своя сверка со списком:
  // форм у пути до двух, а в списке приложений живёт одна, и промах здесь
  // означал бы «добавить» у того, что добавлено. В «Раздельно» белого списка
  // нет, и `picked` там всегда ложь, — спрашивается список «напрямую».
  const rowMenu = (c: Conn, except: string | null): MenuItem[] => {
    const items: MenuItem[] = [];
    if (c.process !== "" && status?.scope === "split") {
      const direct = (status.settings.direct_apps ?? []).some((p) => samePath(p, c.process));
      items.push({
        label: direct ? s.connsBackToTunnel : s.connsDirectApp,
        onPick: () => setRouting({ path: c.process, direct: !direct }),
      });
    } else if (c.process !== "") {
      items.push(
        c.picked
          ? {
              label: s.connsDrop,
              hint: s.connsDropHint,
              danger: true,
              onPick: () => edit("remove-app", c.process),
            }
          : { label: s.connsAdd, onPick: () => edit("add-app", c.process) },
      );
    }
    if (except != null) {
      items.push({ label: s.connsExcept, hint: s.connsExceptHint, onPick: () => setAsking(except) });
    }
    return items;
  };

  // Запертых отбирает окно, а не служба, и это не непоследовательность:
  // соединения режутся сотней по громкости, а запертые приезжают списком
  // целиком — промахнуться мимо обрезки тут негде.
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const locked = fenced.filter((path) => words.every((word) => path.toLowerCase().includes(word)));
  const searchable = live || fenced.length > 0;

  return (
    <Panel
      // Отступа у прокрутки нет: липкая шапка таблицы липнет к кромке прокрутки,
      // а не к её полю за вычетом отступа. Поиск стоит вне прокрутки (`bar`),
      // поля раздают блоки сверху и пустые состояния.
      className={className}
      title={s.conns}
      // Соединения не делят окно с соседями ни на какой ширине, и рейка уже
      // называет панель, — шапки нет вовсе, а счёт стоит в строке поиска.
      folds="always"
      bar={
        searchable && (
          <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1">
            <div className="min-w-24 flex-[1_0_7rem]" title={s.connsFindHint}>
              <SearchField value={query} onChange={setQuery} placeholder={s.connsFind} />
            </div>
            {live && conns.length > 0 && (
              <span className="min-w-0 truncate text-xs text-muted" title={s.connsHint}>
                {filter === ""
                  ? s.connsNote(conns.length, total)
                  : s.connsFound(conns.length, matched, total)}
              </span>
            )}
          </div>
        )
      }
    >
      <div className="flex flex-col">
        {(locked.length > 0 || (live && unreached.length > 0)) && (
          <div className="flex flex-col gap-2.5 p-3 pb-0">
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
                  className="smooth flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-start text-sm hover:bg-hover"
                >
                  <Icon
                    name="chevron"
                    size={12}
                    className={`text-muted motion-safe:transition rtl:-scale-x-100 ${shown ? "rotate-90" : ""}`}
                  />
                  <Icon name="lock" size={14} className="text-closed" />
                  <span className="min-w-0 flex-1 truncate">{s.connsFenced(locked.length)}</span>
                </button>
                {shown && (
                  <ul className="flex flex-col border-t border-edge px-1.5 py-1">
                    {locked.map((path) => (
                      <li
                        key={path}
                        className="row smooth flex items-center gap-2 py-0.5 ps-2.5 pe-1"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm" title={path}>
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
            {live && unreached.length > 0 && (
              // Не поломка окна и не цвет отказа: это сведение, которое снимает
              // с туннеля подозрение, — потому тихая рамка, а не красная.
              <p className="rounded-md border border-edge px-2.5 py-1.5 text-xs text-muted">
                {s.connsUnreached(unreached.join(", "))}
              </p>
            )}
          </div>
        )}
        {!live ? (
          <div className="p-3">
            <Empty>{s.connsOff}</Empty>
          </div>
        ) : conns.length === 0 && filter !== "" ? (
          <div className="p-3">
            <Empty>{s.connsNothing}</Empty>
          </div>
        ) : conns.length === 0 ? (
          // Пусто — это и есть ответ на вопрос, ради которого панель открывают, и
          // единственное место, где он помещается словами: в белом списке
          // доказательством защиты служит отсутствие строк, а обещание «нигде не
          // сохраняется» до сих пор жило в подсказке на счётчике, то есть не
          // показывалось никому.
          <div className="p-3">
            <Empty>
              {s.connsEmpty}
              {status?.scope === "whitelist" && ` ${s.connsEmptyFenced}`} {s.connsHint}
            </Empty>
          </div>
        ) : (
          <div role="table" aria-label={s.conns}>
            {/* Шапка липкая: список сотенный, и посреди прокрутки без неё не
                сказать, что за число стоит справа. Колонки задаёт `.conn-row`,
                одна на шапку и строки — иначе они разъехались бы. Отступы
                шапки — сумма отступов списка и строки (6 + 12 и 6 + 8). */}
            <div role="row" className="conn-row tbl-head h-8 ps-[18px] pe-3.5 text-xs text-muted">
              <span role="columnheader">{s.connsColRoute}</span>
              <span role="columnheader">{s.connsColApp}</span>
              <span role="columnheader" className="conn-addr-head">
                {s.connsColAddr}
              </span>
              {/* Стрелки — те же, что в шапке окна: ↓ принято, ↑ отправлено. */}
              <span role="columnheader" className="text-end" title={s.connsColRx} aria-label={s.connsColRx}>
                ↓
              </span>
              <span role="columnheader" className="text-end" title={s.connsColTx} aria-label={s.connsColTx}>
                ↑
              </span>
            </div>
            <div
              role="rowgroup"
              className="flex flex-col px-1.5 pb-2 pt-1"
              onMouseEnter={() => (hold.current = true)}
              onMouseLeave={() => (hold.current = false)}
            >
              {conns.map((c, i) => {
                // Выбранное приложение мимо туннеля — это тот самый тихий промах, а
                // не «так и задумано»: цвет у него поломочный, как у неподнявшихся
                // правил. Всё остальное прямое — чужой трафик, его мы не трогаем.
                // Считает это служба: путей у приложения бывает две формы, а здесь
                // известна одна.
                //
                // Исключение — выбор человека, а не промах: ушло мимо туннеля, но
                // по его же правилу, и поломочным цветом его не красят.
                const leak = c.leak && !c.bypass;
                const name = base(c.process);
                // «Молчит» — не маршрут, а свойство туннельного соединения, но в
                // колонке пути оно занимает место слова: за ним человек и
                // смотрит, а то, что оно в туннеле, — норма и так.
                const route = c.bypass
                  ? "bypass"
                  : c.tunneled
                    ? c.silent
                      ? "silent"
                      : "tunnel"
                    : leak
                      ? "leak"
                      : "aside";
                // Предлагать нечего, если адрес уже в списке исключений.
                const except = c.silent ? exceptionFor(c.host) : null;
                const offer = except != null && !(status?.bypass ?? []).includes(except.stored) ? except.entry : null;
                const items = rowMenu(c, offer);
                return (
                  <div
                    role="row"
                    // Соединения живут секундами и своего имени не имеют: ключ по
                    // содержимому, а порядковый номер — на случай двух одинаковых.
                    key={`${i}-${c.process}-${c.host}`}
                    // Объяснение есть у обеих не-туннельных строк, а не только у
                    // поломки: серую («sing-box разобрал сам») раньше не объяснял
                    // никто, и читалась она ровно как красная.
                    title={
                      route === "bypass"
                        ? s.connsBypassHint
                        : route === "leak"
                          ? s.connsDirectHint
                          : route === "aside"
                            ? s.connsAsideHint
                            : route === "silent"
                              ? s.connsSilentHint
                              : undefined
                    }
                    // Меню только там, где есть что предложить: пусто в колонке
                    // процесса значит «владельца не нашли» или «порт спорный», и
                    // серый пункт вместо отсутствующего обещал бы действие.
                    onContextMenu={
                      items.length === 0
                        ? undefined
                        : (e) => {
                            e.preventDefault();
                            setMenu({ at: spot(e), items });
                          }
                    }
                    className="row smooth conn-row min-h-9 ps-3 pe-2"
                  >
                    <span
                      className={`row-pill ${
                        route === "tunnel"
                          ? "bg-open"
                          : route === "bypass"
                            ? "bg-accent"
                            : route === "leak"
                              ? "bg-fault"
                              : route === "silent"
                                ? "bg-wait"
                                : "bg-muted"
                      }`}
                    />
                    <span
                      role="cell"
                      className={`truncate text-xs ${
                        route === "tunnel"
                          ? "text-faint"
                          : route === "bypass"
                            ? "text-accent"
                            : route === "leak"
                              ? "font-semibold text-fault"
                              : route === "silent"
                                ? "text-wait"
                                : "text-muted"
                      }`}
                    >
                      {route === "tunnel"
                        ? s.connsTunnel
                        : route === "bypass"
                          ? s.connsBypass
                          : route === "leak"
                            ? s.connsLeak
                            : route === "silent"
                              ? s.connsSilent
                              : s.connsDirect}
                    </span>
                    <span
                      role="cell"
                      className={`truncate text-sm ${name ? "" : "text-muted"}`}
                      title={name ? c.process : s.connsNoProcessHint}
                    >
                      {name || s.connsNoProcess}
                    </span>
                    {/* Подсказка, а не диагноз: ушло и не вернулось ни байта —
                        узел, вероятно, не достаёт до адреса. Исключение — только
                        по явному нажатию: оно перезапускает туннель и выпускает
                        трафик мимо него. Кнопка стоит в колонке адреса, а не
                        отдельной: колонки чисел обязаны остаться на месте. */}
                    <span role="cell" className="conn-addr flex min-w-0 items-center gap-2">
                      <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-muted">{c.host}</span>
                      {offer && (
                        <Button variant="quiet" title={s.connsExceptHint} onClick={() => setAsking(offer)}>
                          {s.connsExcept}
                        </Button>
                      )}
                    </span>
                    {/* Числа моноширинные, правой колонкой: столбец сравнивают
                        взглядом сверху вниз. */}
                    <span role="cell" className="text-end font-mono text-xs tabular-nums text-muted">
                      {bytes(c.rx)}
                    </span>
                    <span role="cell" className="text-end font-mono text-xs tabular-nums text-muted">
                      {bytes(c.tx)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {asking != null && (
        <Modal title={s.connsExceptTitle} onClose={() => setAsking(null)}>
          <p className="text-sm">{s.connsExceptAsk(asking)}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {s.cancel}
            </Button>
            <Button variant="primary" onClick={() => addException(asking)}>
              {s.connsExceptYes}
            </Button>
          </div>
        </Modal>
      )}
      {routing != null && (
        <Modal title={s.connsSplitTitle} onClose={() => setRouting(null)}>
          <p className="text-sm">
            {(routing.direct ? s.connsSplitDirectAsk : s.connsSplitBackAsk)(base(routing.path))}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRouting(null)}>
              {s.cancel}
            </Button>
            <Button variant="primary" onClick={() => reroute(routing)}>
              {s.apply}
            </Button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
