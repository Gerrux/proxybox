#!/usr/bin/env python3
"""Карта мира для шапки окна: точечная сетка суши и точки стран.

Карта плоская, а не глобус, и рисуется точками: это не атлас, по ней читают
одно — в какой части света вышел трафик, — и точка тут честнее контура.
Контур страны в 16 px высоты — это пятно, а растр из точек держит вид и в
плашке из трея, и в окне во весь экран, и при наезде на страну не мылится.

Собирается скриптом, а не лежит картинкой: сетку и проекцию окно считает само
(`ui/app-shell/src/WorldMap.tsx`), и разъехаться с данными им нельзя. Выход —
`ui/app-shell/src/worldmap.ts`, руками его не правят.

Проекция — равнопромежуточная, долгота и широта линейно. Антарктиды нет: южнее
58° выходить некому, а высоту она съела бы у всей карты. Ряды сдвинуты через
один на полшага — так сетка читается сотами, а не миллиметровкой.

Точки стран — `LABEL_X`/`LABEL_Y` Natural Earth, а не центр масс: у Норвегии,
Чили и Индонезии центр масс падает в море или в соседа. Ключ — ISO 3166-1
alpha-2 (`ISO_A2_EH`: у Франции и Норвегии в `ISO_A2` стоит «-99»), тот же код,
которым служба подписывает пробу (`Probe::code`).

Страна, в которую не попала ни одна точка сетки (Сингапур, Мальта, Монако),
получает свою точку суши под меткой: иначе булавка висела бы над морем.

Данные: Natural Earth, общественное достояние.

Запуск: python3 scripts/worldmap.py [ne_50m_admin_0_countries.geojson ne_10m_admin_0_countries.geojson]
Без аргументов файлы скачиваются с GitHub.
"""

import base64
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui/app-shell/src/worldmap.ts"
SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"

# Шаг сетки в градусах. 2.5° — 144 колонки: в плашке 380 px это точка на
# два с половиной пикселя, в окне на 1000 px — ещё просторно.
STEP = 2.5
NORTH, SOUTH = 84.0, -58.0
COLS = int(360 / STEP)
ROWS = int((NORTH - SOUTH) / STEP) + 1


def load(arg: int, name: str) -> dict:
    if len(sys.argv) > arg:
        return json.loads(Path(sys.argv[arg]).read_text(encoding="utf-8"))
    with urllib.request.urlopen(SOURCE + name) as r:
        return json.loads(r.read())


def rings(geometry: dict) -> list[list[list[list[float]]]]:
    """Полигоны геометрии: список полигонов, у каждого внешний контур и дырки."""
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    return geometry["coordinates"]


def inside(x: float, y: float, ring: list[list[float]]) -> bool:
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def cell(lon: float, lat: float) -> tuple[int, int]:
    """Ближайшая к точке клетка сетки с учётом сдвига рядов."""
    row = round((NORTH - lat) / STEP)
    row = min(max(row, 0), ROWS - 1)
    shift = STEP / 2 if row % 2 else 0.0
    col = round((lon + 180 - shift) / STEP - 0.5) % COLS
    return row, col


def main() -> None:
    land = load(1, "ne_50m_admin_0_countries.geojson")
    labels = load(2, "ne_10m_admin_0_countries.geojson")

    polys = []
    for feature in land["features"]:
        for poly in rings(feature["geometry"]):
            outer = poly[0]
            xs = [p[0] for p in outer]
            ys = [p[1] for p in outer]
            polys.append((min(xs), max(xs), min(ys), max(ys), poly))

    grid = [[False] * COLS for _ in range(ROWS)]
    for row in range(ROWS):
        lat = NORTH - row * STEP
        shift = STEP / 2 if row % 2 else 0.0
        for col in range(COLS):
            lon = -180 + (col + 0.5) * STEP + shift
            if lon > 180:
                lon -= 360
            for x0, x1, y0, y1, poly in polys:
                if not (x0 <= lon <= x1 and y0 <= lat <= y1):
                    continue
                if inside(lon, lat, poly[0]) and not any(inside(lon, lat, hole) for hole in poly[1:]):
                    grid[row][col] = True
                    break

    points: dict[str, tuple[float, float]] = {}
    for feature in labels["features"]:
        p = feature["properties"]
        code = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if not code or len(code) != 2 or not code.isalpha() or code in points:
            continue
        lon, lat = float(p["LABEL_X"]), float(p["LABEL_Y"])
        points[code] = (round(lon, 1), round(lat, 1))
        if SOUTH <= lat <= NORTH:
            row, col = cell(lon, lat)
            grid[row][col] = True

    packed = []
    for row in grid:
        bits = "".join("1" if v else "0" for v in row)
        bits += "0" * (-len(bits) % 8)
        packed.append(base64.b64encode(int(bits, 2).to_bytes(len(bits) // 8, "big")).decode())

    body = ",\n".join(f'  "{r}"' for r in packed)
    table = ",".join(f"{c}:[{lon},{lat}]" for c, (lon, lat) in sorted(points.items()))
    OUT.write_text(
        f"""// Сгенерировано scripts/worldmap.py из Natural Earth (общественное достояние).
// Руками не править: сетку и проекцию читает WorldMap.tsx, и разъехаться им нельзя.

/** Шаг сетки в градусах, северная и южная кромки карты. */
export const STEP = {STEP};
export const NORTH = {NORTH};
export const SOUTH = {SOUTH};
export const COLS = {COLS};

/** Суша по рядам с севера на юг: бит на клетку, base64. Нечётные ряды
 *  сдвинуты на полшага к востоку. */
export const LAND = [
{body},
];

/** Точка метки страны, [долгота, широта], по коду ISO 3166-1 alpha-2. */
export const PLACES: Record<string, [number, number]> = {{{table}}};
""",
        encoding="utf-8",
    )
    dots = sum(v for row in grid for v in row)
    print(f"{OUT.relative_to(ROOT)}: {ROWS}×{COLS}, точек {dots}, стран {len(points)}")


if __name__ == "__main__":
    main()
