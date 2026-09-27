/** Карта мира со страной выхода. Заменила «канал» в шапке: канал говорил «жив
 *  или перерублен», и это по-прежнему говорит цвет состояния, а карта
 *  добавляет то, чего не показывала ни одна картинка окна, — где именно
 *  трафик выходит в сеть.
 *
 *  Плоская, а не глобус, и силуэтами, а не точками. Точечная сетка — текстура,
 *  одна на все VPN-клиенты, и по ней читалась только часть света. Силуэт даёт
 *  страну как знак: при перелёте окно приближает её так, что очертания
 *  узнаются глазом, а заливка силуэта — это и есть состояние туннеля:
 *   - сплошная тоном состояния — канал несёт трафик;
 *   - штриховая — заперто: картографический знак «закрыто», тот же и у
 *     подключения, пока туннель не подтверждён;
 *   - один контур — режим выключен: узел выбран, трафик через него не идёт.
 *  Что чем заливать, решает `index.css` по `data-state` предка (`.world-exit`);
 *  здесь только рисунок. Сторож — `the_exit_country_wears_the_state`.
 *
 *  Данные собирает `scripts/worldmap.py`: силуэты по коду страны в целых
 *  единицах карты, у каждой страны — точка метки и полуразмеры материкового
 *  кольца. По ним и выбирается увеличение: страна занимает долю рамки
 *  (`fit`), а не фиксированный масштаб, — иначе Россия не влезала бы, а
 *  Нидерланды были бы точкой.
 *
 *  Своей страны человека на карте нет и не будет: узнать её можно только у
 *  стороннего сервиса, а спрашивать её без туннеля значит выдать настоящий
 *  адрес ровно тогда, когда он не прикрыт. Отмечен один узел.
 *
 *  Движение двух родов, и разведены они по цене:
 *   - перелёт к стране — покадрово из JS, и только в момент смены страны:
 *     силуэты — десять тысяч вершин, и каждый кадр перелёта стоит их
 *     перерисовки — платим за это секунду, а не всё время;
 *   - пульс точки выхода — CSS на отдельном HTML-слое поверх карты. Он идёт
 *     всё время, пока туннель поднят, и обязан стоить только композиции: внутри
 *     SVG он перерисовывал бы карту шестьдесят раз в секунду. Сторож —
 *     `the_exit_pulse_never_repaints_the_map`.
 *  При `prefers-reduced-motion` карта встаёт на место сразу, пульса нет. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { COUNTRIES, H, PLACES, W } from "./worldmap";

/** Вся суша одним путём: страна выхода рисуется поверх своим силуэтом из той
 *  же таблицы, поэтому кромки у них совпадают до единицы. */
const LAND = Object.values(COUNTRIES).join("");

/** Где стоит «камера»: точка карты в центре внимания и увеличение против
 *  карты целиком (`1` — карта накрывает рамку, как `cover` у фона). */
type Cam = { x: number; y: number; z: number };

/** Карта целиком, чуть выше середины: южнее экватора суши меньше. */
const WORLD: Cam = { x: W / 2, y: H * 0.44, z: 1 };

/** Пределы увеличения. Нижний — чуть ближе карты целиком, чтобы континент
 *  страны читался; верхний — на Сингапур и Мальту: дальше силуэта нет, и
 *  приближать нечего. */
const Z_MIN = 1.15;
const Z_MAX = 11;

const FLIGHT_MS = 1100;

/** Шаг штриховки на экране, px. Задаётся здесь, а не в CSS: узор лежит в
 *  единицах карты и на каждом кадре перелёта пересчитывается под масштаб,
 *  иначе при наезде штрихи росли бы вместе со страной. */
const HATCH = 7;

/** Идентификатор узора штриховки. Один на документ: карта в окне одна (в
 *  плашке — своё окно), а `fill: url(#…)` из CSS случайного `useId` не знает. */
export const HATCH_ID = "pg-hatch";

export function WorldMap({
  code,
  fit = 0.4,
  focus = [0.5, 0.5],
  className = "",
}: {
  /** Код страны выхода (ISO alpha-2). Нет — карта целиком и без отметки. */
  code: string | null | undefined;
  /** Какую долю короткой стороны рамки занимает материковое кольцо страны. */
  fit?: number;
  /** Где в рамке держать страну, доли ширины и высоты. */
  focus?: [number, number];
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);
  const hatch = useRef<SVGPatternElement>(null);
  const pin = useRef<HTMLSpanElement>(null);
  const key = code?.toUpperCase() ?? "";
  const place = PLACES[key];
  const shape = COUNTRIES[key];
  // Размер рамки — состояние, а не чтение на лету: от него зависит целевое
  // увеличение, и на смену размера камера обязана пересчитаться.
  const [frame, setFrame] = useState<[number, number]>([0, 0]);
  const [fx, fy] = focus;

  const target = useMemo<Cam>(() => {
    if (!place) return WORLD;
    const [x, y, rx, ry] = place;
    const [cw, ch] = frame;
    if (!cw || !ch || !rx || !ry) return { x, y, z: rx ? Z_MIN : Z_MAX };
    // Масштаб, при котором кольцо занимает `fit` рамки, против масштаба
    // «накрыть рамку»: это и есть увеличение.
    const cover = Math.max(cw / W, ch / H);
    const s = Math.min((fit * cw) / (2 * rx), (fit * ch) / (2 * ry));
    return { x, y, z: Math.min(Z_MAX, Math.max(Z_MIN, s / cover)) };
  }, [place, frame, fit]);

  // Где камера сейчас — между кадрами перелёта и между сменами страны.
  const cam = useRef<Cam>(target);
  // К какой стране уже летали: смена размера рамки меняет цель, но лететь
  // заново к той же стране — значит анимировать каждое движение угла окна.
  const flown = useRef(key);

  // Кадр: камера → преобразование слоя, шаг штриховки и место отметки. Прямо в
  // DOM, мимо React: перерисовывать компонент шестьдесят раз в секунду ради
  // трёх атрибутов незачем.
  const draw = (c: Cam) => {
    const el = box.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;
    const s = Math.max(cw / W, ch / H) * c.z;
    // Край карты не отрывается от края рамки: за ним пустота, а не море.
    const tx = Math.min(0, Math.max(cw - W * s, cw * fx - c.x * s));
    const ty = Math.min(0, Math.max(ch - H * s, ch * fy - c.y * s));
    layer.current?.setAttribute("transform", `matrix(${s} 0 0 ${s} ${tx} ${ty})`);
    hatch.current?.setAttribute("patternTransform", `scale(${HATCH / s})`);
    if (pin.current && place) {
      pin.current.style.transform = `translate(${place[0] * s + tx}px, ${place[1] * s + ty}px)`;
    }
  };

  // Первый кадр — до отрисовки, иначе карта мигнула бы в левом верхнем углу.
  useLayoutEffect(() => draw(cam.current));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setFrame([el.clientWidth, el.clientHeight]);
      draw(cam.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // draw читает свежие значения через замыкание кадра, наблюдатель — один.
  }, [place, fx, fy]);

  useEffect(() => {
    const from = cam.current;
    if (from.x === target.x && from.y === target.y && from.z === target.z) return;
    const same = flown.current === key;
    flown.current = key;
    if (same || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cam.current = target;
      draw(target);
      return;
    }
    // Далёкий перелёт идёт через отдаление: камера поднимается, пролетает и
    // садится. Прямой проезд на большом увеличении — это полсекунды мелькающей
    // суши, в которой не видно, откуда и куда.
    const far = Math.hypot(target.x - from.x, target.y - from.y) / W;
    const dip = Math.min(0.75, far * 2);
    const start = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / FLIGHT_MS);
      const t = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      const z = from.z * (target.z / from.z) ** t * (1 - dip * Math.sin(Math.PI * t));
      cam.current = { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t, z: Math.max(1, z) };
      draw(cam.current);
      if (k < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [target, key]);

  return (
    <div ref={box} className={`world-map ${className}`} aria-hidden="true">
      <svg width="100%" height="100%">
        <defs>
          {/* Штриховка — знак «закрыто». Цвет узора — `--tone` предка, шаг —
              на экране, а не на карте (`patternTransform` ставит `draw`). */}
          <pattern ref={hatch} id={HATCH_ID} className="world-hatch" patternUnits="userSpaceOnUse" width="1" height="1">
            <path d="M-0.25 0.75L0.75 -0.25M0 1L1 0M0.25 1.25L1.25 0.25" stroke="currentColor" strokeWidth="0.22" />
          </pattern>
        </defs>
        <g ref={layer}>
          <path d={LAND} className="world-land" fillRule="evenodd" />
          {shape && <path d={shape} className="world-exit" fillRule="evenodd" vectorEffect="non-scaling-stroke" />}
        </g>
      </svg>
      {place && (
        <span ref={pin} className="world-pin">
          <span className="world-pulse" />
          <span className="world-dot" />
        </span>
      )}
    </div>
  );
}
