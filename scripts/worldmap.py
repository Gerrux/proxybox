#!/usr/bin/env python3
"""Карта мира для шапки окна: силуэты стран и точки выхода.

Карта плоская, а не глобус, и рисуется силуэтами, а не точками. Точечная
сетка — текстура, одна на все VPN-клиенты, и по ней читалась только часть
света. Силуэт даёт то, чего сетка дать не могла: страну выхода как знак. При
перелёте окно приближает страну так, что её очертания узнаются глазом, а
заливка силуэта говорит о состоянии туннеля: сплошная — канал несёт трафик,
штриховая — доступ закрыт, один контур — режим выключен (`WorldMap.tsx`).

Собирается скриптом, а не лежит картинкой: единицы и проекцию окно считает
само, и разъехаться с данными им нельзя. Выход — `ui/app-shell/src/worldmap.ts`,
руками его не правят.

Проекция — Миллера: цилиндрическая, без полярного раздутия Меркатора, но и
без сплющенной Европы равнопромежуточной. Антарктиды нет: южнее 58° выходить
некому, а высоту она съела бы у всей карты. Единица — 0.05° по долготе, так
что вся карта — 7200 единиц в ширину, и координаты остаются целыми.

Упрощение — Дуглас–Пекер, и допуск у него не один на всех: 0.2° на континент,
но для малых контуров он сжимается вплоть до 0.05°. Крупным странам лишние
точки ни к чему — Канада с её архипелагами и так тяжелее всех, — а малую
страну окно показывает крупно, и десять вершин на Нидерланды читались бы
кляксой. Кольца короче 0.8° по диагонали не рисуются вовсе: на масштабе шапки
это меньше пикселя, а в файле — половина веса.

Точки стран — `LABEL_X`/`LABEL_Y` Natural Earth, а не центр масс: у Норвегии,
Чили и Индонезии центр масс падает в море или в соседа. Ключ — ISO 3166-1
alpha-2 (`ISO_A2_EH`: у Франции и Норвегии в `ISO_A2` стоит «-99»), тот же код,
которым служба подписывает пробу (`Probe::code`). Рядом с точкой — полуразмеры
того кольца, в которое она попала (иначе крупнейшего): по ним окно выбирает
увеличение. Кольцо, а не вся страна: у Нидерландов есть Карибы, у Франции —
Гвиана, и по общей рамке они уезжали бы в океан.

Силуэты из 50m: 10m втрое подробнее там, где подробность уже не видна.
Страны, которых в 50m нет (Гибралтар), получают точку без силуэта.

Данные: Natural Earth, общественное достояние.

Запуск: python3 scripts/worldmap.py [ne_50m_admin_0_countries.geojson ne_10m_admin_0_countries.geojson]
Без аргументов файлы скачиваются с GitHub.
"""

import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui/app-shell/src/worldmap.ts"
SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"

NORTH, SOUTH = 84.0, -58.0
# Градусов долготы на единицу карты.
UNIT = 0.05
# Допуск упрощения в градусах: потолок для континентов и пол для малых колец.
TOL_MAX, TOL_MIN = 0.2, 0.05
# Диагональ кольца, начиная с которой допуск полный.
TOL_FULL_AT = 40.0
# Кольца короче этого по диагонали не рисуются.
MIN_RING = 0.8


def load(arg: int, name: str) -> dict:
    if len(sys.argv) > arg:
        return json.loads(Path(sys.argv[arg]).read_text(encoding="utf-8"))
    with urllib.request.urlopen(SOURCE + name) as r:
        return json.loads(r.read())


def miller(lat: float) -> float:
    return 1.25 * math.log(math.tan(math.pi / 4 + 0.4 * math.radians(lat)))


Y_TOP = miller(NORTH)
W = round(360 / UNIT)
H = round((Y_TOP - miller(SOUTH)) / math.radians(UNIT))


def project(lon: float, lat: float) -> tuple[float, float]:
    lat = max(SOUTH, min(NORTH, lat))
    return (lon + 180) / UNIT, (Y_TOP - miller(lat)) / math.radians(UNIT)


def rings(geometry: dict) -> list[list[list[list[float]]]]:
    """Полигоны геометрии: список полигонов, у каждого внешний контур и дырки."""
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    return geometry["coordinates"]


def simplify(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy) or 1e-9
    best, at = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * px - dx * py + x1 * y0 - y1 * x0) / length
        if d > best:
            best, at = d, i
    if best > tol:
        return simplify(pts[: at + 1], tol)[:-1] + simplify(pts[at:], tol)
    return [pts[0], pts[-1]]


def ring_path(ring: list[list[float]]) -> tuple[str, tuple[float, float, float, float]] | None:
    """Кольцо → подпуть SVG в целых единицах и его рамка, либо None для мелочи."""
    pts = [project(p[0], p[1]) for p in ring]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    diag_deg = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) * UNIT
    if diag_deg < MIN_RING:
        return None
    tol = max(TOL_MIN, min(TOL_MAX, TOL_MAX * diag_deg / TOL_FULL_AT)) / UNIT
    # Замкнутое кольцо режется в самой далёкой от начала точке: Дуглас–Пекер на
    # кольце, у которого начало и конец совпадают, схлопывает его в отрезок.
    far = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]))
    out = simplify(pts[: far + 1], tol)[:-1] + simplify(pts[far:] + [pts[0]], tol)[:-1]
    cells = [(round(x), round(y)) for x, y in out]
    dedup: list[tuple[int, int]] = [cells[0]]
    for c in cells[1:]:
        if c != dedup[-1]:
            dedup.append(c)
    if dedup[-1] == dedup[0]:
        dedup.pop()
    if len(dedup) < 3:
        return None
    # Пробел перед отрицательным числом SVG не требует, а в файле их тысячи.
    def pair(a: int, b: int) -> str:
        return f"{a}{'' if b < 0 else ' '}{b}"

    d = "M" + pair(dedup[0][0], dedup[0][1])
    for (px, py), (qx, qy) in zip(dedup, dedup[1:]):
        d += "l" + pair(qx - px, qy - py)
    return d + "z", (min(xs), min(ys), max(xs), max(ys))


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


def main() -> None:
    land = load(1, "ne_50m_admin_0_countries.geojson")
    labels = load(2, "ne_10m_admin_0_countries.geojson")

    # Силуэты по коду страны. Без кода (Сомалиленд, Северный Кипр) — суша под
    # служебным ключом: рисовать её надо, а подсветить некому.
    shapes: dict[str, str] = {}
    boxes: dict[str, list[tuple[tuple[float, float, float, float], list[list[float]]]]] = {}
    nameless = 0
    for feature in land["features"]:
        p = feature["properties"]
        code = p.get("ISO_A2_EH") or p.get("ISO_A2") or ""
        if len(code) != 2 or not code.isalpha():
            nameless += 1
            code = f"_{nameless}"
        for poly in rings(feature["geometry"]):
            for i, ring in enumerate(poly):
                made = ring_path(ring)
                if made is None:
                    continue
                shapes[code] = shapes.get(code, "") + made[0]
                if i == 0:
                    boxes.setdefault(code, []).append((made[1], ring))

    places: dict[str, tuple[float, float, int, int]] = {}
    for feature in labels["features"]:
        p = feature["properties"]
        code = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if not code or len(code) != 2 or not code.isalpha() or code in places:
            continue
        lon, lat = float(p["LABEL_X"]), float(p["LABEL_Y"])
        if not SOUTH <= lat <= NORTH:
            continue
        x, y = project(lon, lat)
        # Кольцо под меткой, иначе крупнейшее: по нему выбирается увеличение.
        rx = ry = 0
        own = boxes.get(code, [])
        hit = [b for b, ring in own if inside(lon, lat, ring)]
        if not hit and own:
            hit = [max((b for b, _ in own), key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))]
        if hit:
            b = hit[0]
            rx, ry = round((b[2] - b[0]) / 2), round((b[3] - b[1]) / 2)
        places[code] = (round(x), round(y), rx, ry)

    table = ",\n".join(f'  {c}: "{d}"' for c, d in sorted(shapes.items()))
    points = ",".join(f"{c}:[{x},{y},{rx},{ry}]" for c, (x, y, rx, ry) in sorted(places.items()))
    OUT.write_text(
        f"""// Сгенерировано scripts/worldmap.py из Natural Earth (общественное достояние).
// Руками не править: единицы и проекцию читает WorldMap.tsx, и разъехаться им нельзя.

/** Размер карты в единицах (0.05° долготы), проекция Миллера, 84° с.ш. … 58° ю.ш. */
export const W = {W};
export const H = {H};

/** Силуэты стран по коду ISO 3166-1 alpha-2 — подпути SVG в целых единицах.
 *  Суша без кода лежит под служебными ключами вида `_1`. */
export const COUNTRIES: Record<string, string> = {{
{table},
}};

/** Точка метки страны и полуразмеры её материкового кольца: [x, y, rx, ry].
 *  Нули — силуэта у страны нет. */
export const PLACES: Record<string, [number, number, number, number]> = {{{points}}};
""",
        encoding="utf-8",
    )
    size = OUT.stat().st_size
    print(f"{OUT.relative_to(ROOT)}: {W}×{H}, силуэтов {len(shapes)}, стран {len(places)}, {size // 1024} КБ")


if __name__ == "__main__":
    main()
