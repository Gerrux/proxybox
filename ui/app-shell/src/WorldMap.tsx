/** Карта мира с точкой выхода. Заменила «канал» в шапке: канал говорил «жив
 *  или перерублен», и это по-прежнему говорит цвет состояния, а карта
 *  добавляет то, чего не показывала ни одна картинка окна, — где именно
 *  трафик выходит в сеть.
 *
 *  Плоская, а не глобус, и точками, а не контурами: по ней читают одно — часть
 *  света, — и растр из точек держит вид от плашки в 380 px до окна во весь
 *  экран. Данные собирает `scripts/worldmap.py`.
 *
 *  Своей страны человека на карте нет и не будет: узнать её можно только у
 *  стороннего сервиса, а спрашивать её без туннеля значит выдать настоящий
 *  адрес ровно тогда, когда он не прикрыт. Точка одна — узел.
 *
 *  Движение двух родов, и разведены они по цене:
 *   - перелёт к стране — покадрово из JS, и только в момент смены страны:
 *     точек под две с половиной тысячи, и каждый кадр перелёта стоит
 *     перерисовки всей карты — платим за это секунду, а не всё время;
 *   - пульс точки выхода — CSS на отдельном HTML-слое поверх карты. Он идёт
 *     всё время, пока туннель поднят, и обязан стоить только композиции: внутри
 *     SVG он перерисовывал бы карту шестьдесят раз в секунду.
 *  При `prefers-reduced-motion` карта встаёт на место сразу, пульса нет. */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { LAND, NORTH, PLACES, STEP } from "./worldmap";

/** Единиц карты на градус. Сетка в градусах, а рисовать удобнее целыми. */
const U = 4;
const W = 360 * U;
const H = LAND.length * STEP * U;
/** Точка чуть меньше половины шага: соседние не слипаются и при наезде. */
const DOT = STEP * U * 0.46;

/** Долгота и широта → точка карты. Ряды сетки смещены на полшага вниз, чтобы
 *  верхний не лежал на самой кромке. */
function project(lon: number, lat: number): [number, number] {
  return [(lon + 180) * U, (NORTH - lat) * U + (STEP * U) / 2];
}

const DOTS: [number, number][] = LAND.flatMap((row, r) => {
  const bytes = atob(row);
  const out: [number, number][] = [];
  for (let i = 0; i < bytes.length * 8; i++) {
    if (!((bytes.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1)) continue;
    const lon = -180 + (i + 0.5) * STEP + (r % 2 ? STEP / 2 : 0);
    out.push(project(lon > 180 ? lon - 360 : lon, NORTH - r * STEP));
  }
  return out;
});

/** Вся суша одним путём: `h0` с круглым концом — это точка, а тысяча узлов
 *  `<circle>` была бы тысячей узлов дерева. */
const LAND_PATH = DOTS.map(([x, y]) => `M${x} ${y}h0`).join("");

/** Где стоит «камера»: точка карты в центре внимания и увеличение. */
type Cam = { x: number; y: number; z: number };

/** Карта целиком, чуть выше середины: южнее экватора суши меньше. */
const WORLD: Cam = { x: W / 2, y: H * 0.46, z: 1 };

const FLIGHT_MS = 1100;

export function WorldMap({
  code,
  zoom = 2.4,
  focus = [0.5, 0.5],
  className = "",
}: {
  /** Код страны выхода (ISO alpha-2). Нет — карта целиком и без точки. */
  code: string | null | undefined;
  /** Во сколько раз приблизить страну против карты целиком. */
  zoom?: number;
  /** Где в рамке держать страну, доли ширины и высоты: в шапке окна слева
   *  лежит текст, и страна стоит правее середины. */
  focus?: [number, number];
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);
  const pin = useRef<HTMLSpanElement>(null);
  const place = code ? PLACES[code.toUpperCase()] : undefined;
  const target = useMemo<Cam>(() => {
    if (!place) return WORLD;
    const [x, y] = project(place[0], place[1]);
    return { x, y, z: zoom };
  }, [place, zoom]);
  const spot = place ? project(place[0], place[1]) : null;
  // Где камера сейчас — между кадрами перелёта и между сменами страны.
  const cam = useRef<Cam>(target);
  const [fx, fy] = focus;

  // Точки вокруг выхода — в тон состояния: одна точка на карте теряется, а
  // пятно читается боковым зрением. Два кольца, а не плавный спад: плавный
  // на сетке из точек выглядит грязью.
  const near = useMemo(() => {
    if (!spot) return ["", ""];
    const r1 = 5 * U;
    const r2 = 10 * U;
    let inner = "";
    let outer = "";
    for (const [x, y] of DOTS) {
      const d = Math.hypot(x - spot[0], y - spot[1]);
      if (d <= r1) inner += `M${x} ${y}h0`;
      else if (d <= r2) outer += `M${x} ${y}h0`;
    }
    return [inner, outer];
  }, [spot?.[0], spot?.[1]]);

  // Кадр: камера → преобразование слоя и место точки. Прямо в DOM, мимо
  // React: перерисовывать компонент шестьдесят раз в секунду ради одного
  // атрибута незачем.
  const draw = (c: Cam) => {
    const el = box.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;
    // «Накрыть» рамку картой при единичном увеличении, как `cover` у фона.
    const s = Math.max(cw / W, ch / H) * c.z;
    // Край карты не отрывается от края рамки: за ним пустота, а не море.
    const tx = Math.min(0, Math.max(cw - W * s, cw * fx - c.x * s));
    const ty = Math.min(0, Math.max(ch - H * s, ch * fy - c.y * s));
    layer.current?.setAttribute("transform", `matrix(${s} 0 0 ${s} ${tx} ${ty})`);
    if (pin.current && spot) {
      pin.current.style.transform = `translate(${spot[0] * s + tx}px, ${spot[1] * s + ty}px)`;
    }
  };

  // Первый кадр — до отрисовки, иначе карта мигнула бы в левом верхнем углу.
  useLayoutEffect(() => draw(cam.current));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw(cam.current));
    ro.observe(el);
    return () => ro.disconnect();
    // draw читает свежие значения через замыкание кадра, наблюдатель — один.
  }, [spot?.[0], spot?.[1], fx, fy]);

  useEffect(() => {
    const from = cam.current;
    if (from.x === target.x && from.y === target.y && from.z === target.z) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cam.current = target;
      draw(target);
      return;
    }
    // Далёкий перелёт идёт через отдаление: камера поднимается, пролетает и
    // садится. Прямой проезд на большом увеличении — это полсекунды мелькающих
    // точек, в которых не видно, откуда и куда.
    const far = Math.hypot(target.x - from.x, target.y - from.y) / W;
    const dip = Math.min(0.6, far * 1.6);
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
  }, [target]);

  return (
    <div ref={box} className={`world-map ${className}`} aria-hidden="true">
      <svg width="100%" height="100%" fill="none" strokeLinecap="round">
        <g ref={layer}>
          <path d={LAND_PATH} className="world-land" strokeWidth={DOT} />
          {spot && (
            <>
              <path d={near[1]} className="world-near world-near-2" strokeWidth={DOT} />
              <path d={near[0]} className="world-near" strokeWidth={DOT} />
            </>
          )}
        </g>
      </svg>
      {spot && (
        <span ref={pin} className="world-pin">
          <span className="world-pulse" />
          <span className="world-dot" />
        </span>
      )}
    </div>
  );
}
