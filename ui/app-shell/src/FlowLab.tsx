import { useEffect, useRef, useState, type CSSProperties } from "react";
import "./flow-lab.css";

/** Три сценария, а не три палитры. Каждый берётся за один и тот же вопрос —
 *  как показать инвариант «приватный режим включён + туннель не подтверждён =
 *  сети нет» — и отвечает на него другим устройством интерфейса: рубильником,
 *  проходной и стопкой шторок.
 *
 *  Всё внутри — макет: сеть не трогается, состояния переключаются таймером.
 *  Смысл в том, чтобы поспорить руками, а не глазами по картинке. */

const locations = [
  { name: "Нидерланды", city: "Амстердам", code: "NL", ms: 75 },
  { name: "Швеция", city: "Стокгольм", code: "SE", ms: 92 },
  { name: "Германия", city: "Франкфурт", code: "DE", ms: 48 },
];
const apps = ["Chrome", "Telegram", "Spotify", "Discord", "Steam", "Firefox"];
type Place = (typeof locations)[number];
type State = "off" | "connecting" | "up" | "down";

/** Четыре состояния, а не два. Двух не хватает ровно на то, ради чего продукт и
 *  сделан: «включено, но канал не подтверждён» — это не «выключено» и не
 *  «работает», это «сети нет ни у кого из выбранных». */
function useTunnel() {
  const [state, setState] = useState<State>("off");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const arm = (on: boolean) => {
    window.clearTimeout(timer.current);
    if (!on) return setState("off");
    setState("connecting");
    timer.current = window.setTimeout(() => setState("up"), 900);
  };
  return { state, arm, cut: () => setState("down") };
}

const verdict: Record<State, string> = {
  off: "Замка нет: приложения ходят напрямую, как без нас.",
  connecting: "Замок уже стоит, канал ещё не подтверждён — сети у выбранных нет.",
  up: "Канал подтверждён. Выбранные идут через него, остальные — никуда.",
  down: "Рубильник поднят, канал перерублен. Прямого пути не существует: сети нет.",
};

function Exit({ place, onPick }: { place: Place; onPick: (p: Place) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="lab-exit">
      <button className="lab-exit-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="lab-code">{place.code}</span>
        <span>
          <small>Точка выхода</small>
          <strong>{place.name}</strong>
        </span>
        <span className="lab-ms">{place.ms} мс</span>
        <span className={`lab-chev ${open ? "is-open" : ""}`}>⌄</span>
      </button>
      {open && (
        <div className="lab-exit-list">
          {locations.map((loc) => (
            <button
              key={loc.code}
              aria-pressed={loc.code === place.code}
              onClick={() => {
                onPick(loc);
                setOpen(false);
              }}
            >
              <span className="lab-code">{loc.code}</span>
              <span>
                <strong>{loc.name}</strong>
                <small>{loc.city}</small>
              </span>
              <span className="lab-ms">{loc.ms} мс</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Рубильник. Главного действия как кнопки здесь нет вовсе: включение — это
 *  положение ручки, которую тянут, а под ней нарисован сам канал. Кнопка умеет
 *  сказать «вкл» и «выкл» и больше ничего, а канал умеет быть поднятым и
 *  перерубленным при поднятой ручке — то самое состояние, которое кнопкой не
 *  выражается и из-за которого человек считает себя защищённым зря.
 *
 *  Плата: ручку надо тянуть, то есть одно движение вместо одного щелчка. */
function Switchboard() {
  const { state, arm, cut } = useTunnel();
  const [place, setPlace] = useState<Place>(locations[0]);
  const [all, setAll] = useState(true);
  const on = state !== "off";
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const at = drag ?? (on ? 1 : 0);

  const move = (e: React.PointerEvent) => {
    if (drag == null || !track.current) return;
    const box = track.current.getBoundingClientRect();
    setDrag(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
  };
  const drop = () => {
    if (drag == null) return;
    const next = drag > 0.5;
    setDrag(null);
    if (next !== on) arm(next);
  };

  return (
    <main className="sw-main">
      <p className="lab-eyebrow">Приватный режим</p>
      <div
        ref={track}
        role="switch"
        tabIndex={0}
        aria-checked={on}
        aria-label="Приватный режим"
        data-state={state}
        className={`sw-track ${on ? "is-on" : ""} ${drag != null ? "is-dragging" : ""}`}
        style={{ "--at": `${at * 100}%` } as CSSProperties}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(at);
        }}
        onPointerMove={move}
        onPointerUp={drop}
        onPointerCancel={drop}
        onClick={() => drag == null && arm(!on)}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), arm(!on))}
      >
        <span className="sw-side sw-side-off">Закрыто</span>
        <span className="sw-side sw-side-on">Открыто</span>
        <span className="sw-handle">
          <i />
          <i />
          <i />
        </span>
        {/* Вспышка перерисовывается заново на каждой смене состояния: без этого
            анимация проигралась бы один раз за жизнь узла. */}
        <span key={state} className="sw-spark" aria-hidden="true" />
      </div>

      <div className={`sw-circuit is-${state}`}>
        <span className="sw-node">Компьютер</span>
        <span className="sw-wire" aria-hidden="true" />
        <span className="sw-node sw-node-net">Сеть</span>
      </div>
      <p key={state} className="sw-verdict">
        {verdict[state]}
      </p>

      <div className="sw-rows">
        <div className="sw-row">
          <span>Кого касается</span>
          <div className="lab-seg">
            <button aria-pressed={all} onClick={() => setAll(true)}>
              Весь компьютер
            </button>
            <button aria-pressed={!all} onClick={() => setAll(false)}>
              Только выбранные
            </button>
          </div>
        </div>
        <Exit place={place} onPick={setPlace} />
      </div>

      {/* Дверь в то самое состояние, ради которого концепт и нарисован: увидеть
          его иначе можно только дождавшись обрыва на живой машине. */}
      <footer className="sw-foot">
        <span>Задержка {state === "up" ? `${place.ms} мс` : "—"}</span>
        {state === "up" && <button onClick={cut}>Оборвать канал</button>}
        {state === "down" && <button onClick={() => arm(true)}>Поднять заново</button>}
      </footer>
    </main>
  );
}

/** Проходная. Приложения — подлежащее, туннель — обстоятельство: два столбца и
 *  ворота между ними, а список галочек исчезает вовсе. Галочка отвечает на
 *  вопрос «отмечено ли», а человек спрашивает «ходит ли оно в сеть», и разница
 *  между ответами — это как раз fail-closed: при неподтверждённом канале правый
 *  столбец заперт целиком, хотя все галочки на месте.
 *
 *  Плата: на сотне приложений два столбца превращаются в две простыни, и
 *  поиском тут не обойтись — нужна страница «все приложения» где-то сбоку. */
function Gate() {
  const { state, arm, cut } = useTunnel();
  const [picked, setPicked] = useState<string[]>(["Chrome", "Telegram"]);
  const [all, setAll] = useState(false);
  const [bumped, setBumped] = useState<string | null>(null);
  const on = state !== "off";
  const open = state === "up";
  const inside = all ? apps : picked;
  const outside = all ? [] : apps.filter((a) => !picked.includes(a));

  const knock = (app: string) => {
    setBumped(app);
    window.setTimeout(() => setBumped((b) => (b === app ? null : b)), 420);
  };
  const move = (app: string) => {
    if (all) return knock(app);
    setPicked((old) => (old.includes(app) ? old.filter((a) => a !== app) : [...old, app]));
  };

  const card = (app: string, side: "in" | "out") => (
    <button
      key={`${side}-${app}`}
      className={`gate-card gate-from-${side} ${bumped === app ? "is-bumped" : ""}`}
      onClick={() => move(app)}
      title={all ? "В охвате «весь компьютер» делить некого" : "Перевести на другую сторону"}
    >
      <span className="lab-app-icon">{app[0]}</span>
      <strong>{app}</strong>
      <span className="gate-arrow">{side === "out" ? "→" : "←"}</span>
    </button>
  );

  return (
    <main className="gate-main">
      <div className="gate-head">
        <div className="lab-seg">
          <button aria-pressed={all} onClick={() => setAll(true)}>
            Весь компьютер
          </button>
          <button aria-pressed={!all} onClick={() => setAll(false)}>
            Только выбранные
          </button>
        </div>
        <button className="gate-power" data-state={state} onClick={() => arm(!on)}>
          {on ? "Выключить" : "Включить"}
        </button>
      </div>

      <div className={`gate-yard is-${state} ${all ? "is-all" : ""}`}>
        <section className={`gate-col ${on && !all ? "is-locked" : ""}`}>
          <h2>{on && !all ? "Без сети" : "Напрямую"}</h2>
          <p>
            {all
              ? "В охвате «весь компьютер» здесь пусто: в туннель идут все."
              : on
                ? "Прямого пути в продукте нет. Не выбрано — значит без сети вовсе."
                : "Приватный режим выключен: ходят как ходили."}
          </p>
          <div className="gate-stack">{outside.map((app) => card(app, "out"))}</div>
        </section>

        <div className="gate-bar" data-state={state} aria-hidden="true">
          <span className="gate-bolt" />
          <span className="gate-word">{open ? "открыто" : on ? "заперто" : "снято"}</span>
        </div>

        <section className={`gate-col gate-col-in ${on && !open ? "is-locked" : ""}`}>
          <h2>В туннеле</h2>
          <p>
            {open
              ? `Канал подтверждён: идут через ${locations[0].city}.`
              : on
                ? "Галочки на месте, а сети нет: канал не подтверждён."
                : "Пойдут через туннель, когда его включат."}
          </p>
          <div className="gate-stack">{inside.map((app) => card(app, "in"))}</div>
        </section>
      </div>

      <footer className="gate-foot">
        <span>{all ? "Пропусков нет: в туннель идёт вся машина" : `Пропуск выдан: ${picked.length} из ${apps.length}`}</span>
        {state === "up" && <button onClick={cut}>Оборвать канал</button>}
        {state === "down" && <button onClick={() => arm(true)}>Поднять заново</button>}
      </footer>
    </main>
  );
}

/** Шторки. Ни вкладок, ни трёх панелей: одна колонка с состоянием и действием,
 *  а всё остальное приезжает снизу и утягивается пальцем обратно. Считано с
 *  плашки из трея — она и есть настоящий размер этого продукта, а полноразмерное
 *  окно человек открывает раз в месяц.
 *
 *  Плата очевидна и её надо принять: две вещи разом на экране не помещаются,
 *  поэтому сверить список приложений с журналом можно только по памяти. */
function Sheets() {
  const { state, arm } = useTunnel();
  const [place, setPlace] = useState<Place>(locations[0]);
  const [sheet, setSheet] = useState<null | "exit" | "apps" | "log">(null);
  const [picked, setPicked] = useState<string[]>(["Chrome", "Telegram"]);
  const [pull, setPull] = useState(0);
  const grab = useRef<number | null>(null);
  const on = state !== "off";

  const close = () => {
    setSheet(null);
    setPull(0);
  };
  const title = { exit: "Точка выхода", apps: "Приложения", log: "Журнал" };

  return (
    <main className="sh-main">
      <div className={`sh-stage ${sheet ? "is-behind" : ""}`}>
        <div className="sh-state" data-state={state}>
          <span className="sh-dot" />
          <strong>
            {state === "up" ? "Канал подтверждён" : state === "connecting" ? "Подключение…" : state === "down" ? "Канал перерублен" : "Выключено"}
          </strong>
          <small>{verdict[state]}</small>
        </div>

        <button className={`sh-act ${on ? "is-on" : ""}`} onClick={() => arm(!on)}>
          <span>{on ? "Выключить" : "Включить"}</span>
          <i />
        </button>

        <div className="sh-chips">
          <button onClick={() => setSheet("exit")}>
            <small>Точка выхода</small>
            <strong>
              {place.code} · {place.name}
            </strong>
          </button>
          <button onClick={() => setSheet("apps")}>
            <small>Приложения</small>
            <strong>{picked.length} в туннеле</strong>
          </button>
          <button onClick={() => setSheet("log")}>
            <small>Журнал</small>
            <strong>3 события</strong>
          </button>
        </div>
      </div>

      {sheet && <div className="sh-scrim" onClick={close} />}
      {sheet && (
        <section
          className="sh-sheet"
          style={{ "--pull": `${pull}px` } as CSSProperties}
          role="dialog"
          aria-label={title[sheet]}
        >
          <header
            className="sh-grip"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              grab.current = e.clientY;
            }}
            onPointerMove={(e) => grab.current != null && setPull(Math.max(0, e.clientY - grab.current))}
            onPointerUp={() => {
              grab.current = null;
              pull > 90 ? close() : setPull(0);
            }}
          >
            <i />
            <h2>{title[sheet]}</h2>
            <button onClick={close} aria-label="Закрыть">
              ✕
            </button>
          </header>
          <div className="sh-body">
            {sheet === "exit" &&
              locations.map((loc) => (
                <button
                  key={loc.code}
                  className="sh-row"
                  aria-pressed={loc.code === place.code}
                  onClick={() => {
                    setPlace(loc);
                    close();
                  }}
                >
                  <span className="lab-code">{loc.code}</span>
                  <span>
                    <strong>{loc.name}</strong>
                    <small>{loc.city}</small>
                  </span>
                  <span className="lab-ms">{loc.ms} мс</span>
                </button>
              ))}
            {sheet === "apps" &&
              apps.map((app) => (
                <button
                  key={app}
                  className="sh-row"
                  aria-pressed={picked.includes(app)}
                  onClick={() =>
                    setPicked((old) => (old.includes(app) ? old.filter((a) => a !== app) : [...old, app]))
                  }
                >
                  <span className="lab-app-icon">{app[0]}</span>
                  <span>
                    <strong>{app}</strong>
                    <small>{picked.includes(app) ? "через туннель" : "без сети"}</small>
                  </span>
                  <span className="sh-mark">{picked.includes(app) ? "✓" : ""}</span>
                </button>
              ))}
            {sheet === "log" && (
              <ol className="sh-log">
                <li>
                  <time>16:04</time>точка выхода: {place.name}
                </li>
                <li>
                  <time>16:04</time>туннель поднят, задержка {place.ms} мс
                </li>
                <li>
                  <time>16:03</time>приватный режим включён
                </li>
              </ol>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

export function FlowLab({ flow }: { flow: string }) {
  return (
    <div className={`flow-lab lab-${flow}`}>
      <header className="lab-top">
        <span className="lab-brand">
          proxybox<span>®</span>
        </span>
        <span>Интерактивный макет · сеть не трогается</span>
      </header>
      {flow === "switchboard" && <Switchboard />}
      {flow === "gate" && <Gate />}
      {flow === "sheets" && <Sheets />}
    </div>
  );
}
