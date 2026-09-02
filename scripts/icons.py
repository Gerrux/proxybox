#!/usr/bin/env python3
"""Значок приложения: корпус со сквозным лазом.

Картинки собираются скриптом, а не лежат нарисованными: у знака три формы под
три диапазона размеров, и нарисованные руками они разъезжаются молча — в дифе
видно «icon.ico изменился», а не «лаз уехал на два пикселя». Здесь же видно.

Геометрия — из фирменного стиля (`docs/brand.md`), поле 100×100 без отступов:

  ≥48 px  углы 22, лаз r20 в точке (36, 64), заливка — свечение из лаза;
  24..47  углы 20, лаз r22 в точке (36, 64), плоский цвет;
  <24     углы 18, лаз r26 в точке (36, 62), плоский цвет.

Лаз растёт, а углы спрямляются, потому что на мелком размере тонкая перемычка
между лазом и кромкой пропадает первой, и знак становится просто квадратом.
Смещение лаза влево и вниз обязательно на всех трёх: соосное отверстие делает
из марки объектив.

Свечение — только здесь. Это единственная заливка, которую видит операционная
система; в трее знак плоский (`tray_icon` в `src-tauri/src/main.rs`), в
презентациях — диагональ бренда.

Запуск: python3 scripts/icons.py   (нужен Pillow)
"""

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"

# Сглаживание кромок: рисуем маску крупно и ужимаем. Восьмикратного хватает —
# у знака нет ни тонких штрихов, ни острых углов, где было бы видно больше.
SS = 8

FLAT = (0x2E, 0x4B, 0xD8)
# Свечение бьёт из лаза: центр градиента совпадает с центром отверстия, радиус
# 96 от него накрывает дальний угол корпуса.
GLOW = ((0.0, (0x3A, 0xC0, 0xFF)), (0.55, (0x3B, 0x54, 0xE8)), (1.0, (0x24, 0x1C, 0x7A)))
GLOW_AT, GLOW_R = (36.0, 64.0), 96.0


def form(size):
    """Углы, радиус лаза и его центр для размера — в поле 100×100."""
    if size >= 48:
        return 22, 20, (36, 64)
    if size >= 24:
        return 20, 22, (36, 64)
    if size >= 14:
        return 18, 26, (36, 62)
    # Предельная форма: ниже 11 px знак не ставится вовсе, вместо него точка
    # состояния. Нужна только для картинок в документации.
    return 16, 30, (36, 62)


def ramp(t):
    """Цвет свечения на расстоянии t (0 — центр лаза, 1 — край радиуса)."""
    t = min(max(t, 0.0), 1.0)
    for (t0, c0), (t1, c1) in zip(GLOW, GLOW[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
    return GLOW[-1][1]


def mark(size):
    corner, hole, (hx, hy) = form(size)
    k = size * SS / 100.0

    mask = Image.new("L", (size * SS, size * SS), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size * SS - 1, size * SS - 1), radius=corner * k, fill=255)
    # Лаз сквозной: вырезаем из маски, а не закрашиваем фоном — под знаком
    # обязана быть подложка, а не белое пятно.
    d.ellipse(((hx - hole) * k, (hy - hole) * k, (hx + hole) * k, (hy + hole) * k), fill=0)
    mask = mask.resize((size, size), Image.LANCZOS)

    if size >= 48:
        fill = Image.new("RGB", (size, size))
        px = fill.load()
        for y in range(size):
            for x in range(size):
                gx = (x + 0.5) * 100.0 / size - GLOW_AT[0]
                gy = (y + 0.5) * 100.0 / size - GLOW_AT[1]
                px[x, y] = ramp((gx * gx + gy * gy) ** 0.5 / GLOW_R)
    else:
        fill = Image.new("RGB", (size, size), FLAT)

    out = fill.convert("RGBA")
    out.putalpha(mask)
    return out


def dib(img):
    """Одна картинка внутри .ico: BITMAPINFOHEADER, пиксели снизу вверх,
    пустая маска прозрачности (её заменяет альфа-канал)."""
    size = img.width
    head = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    rows = []
    px = img.load()
    for y in range(size - 1, -1, -1):
        row = bytearray()
        for x in range(size):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    return head + b"".join(rows) + bytes(size * size // 8)


def payload(size):
    """Одна картинка внутри .ico. Мелкие лежат сырым DIB, 256 — сжатым PNG:
    несжатый он весит 256 КБ и один тянет файл со стольких же килобайт до
    трёхсот, то есть в установщик и в каждый коммит с пересборкой значков.
    PNG внутри .ico читает всё, начиная с Vista, а продукт и так Windows 10+."""
    img = mark(size)
    if size < 256:
        return dib(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def ico(path, sizes):
    images = [payload(s) for s in sizes]
    out = bytearray(struct.pack("<HHH", 0, 1, len(sizes)))
    offset = 6 + 16 * len(sizes)
    for s, data in zip(sizes, images):
        # 256 по спецификации кодируется нулём: в байт оно не влезает.
        out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for data in images:
        out += data
    path.write_bytes(bytes(out))


DOCS = Path(__file__).resolve().parent.parent / "docs" / "brand"

# Плитки, на которых знак показывают в документации. Своего фона у знака нет:
# лаз сквозной, и без подложки он проваливается в цвет страницы — у GitHub он
# бывает и белым, и почти чёрным.
PLATE_LIGHT = (0xF4, 0xF6, 0xFF)
PLATE_DARK = (0x14, 0x16, 0x1A)


def tile(size, fill=None, plate=PLATE_LIGHT):
    """Знак на плитке того же размера и с тем же скруглением: подложка видна
    только сквозь лаз, как в самом стиле."""
    corner = form(size)[0]
    base = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(base).rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1), radius=corner * size * SS / 100.0, fill=255
    )
    out = Image.new("RGBA", (size, size), plate + (0,))
    out.putalpha(base.resize((size, size), Image.LANCZOS))
    m = mark(size)
    if fill is not None:
        # Тот же силуэт, но своим цветом: у трея и у предельного размера
        # заливка плоская, а форма обязана остаться той же самой.
        flat = Image.new("RGBA", m.size, fill + (255,))
        flat.putalpha(m.split()[3])
        m = flat
    out.alpha_composite(m)
    return out


def strip(tiles, gap, pad, bg):
    """Ряд картинок по нижнему краю — разные размеры знака рядом."""
    w = sum(t.width for t in tiles) + gap * (len(tiles) - 1) + pad * 2
    h = max(t.height for t in tiles) + pad * 2
    out = Image.new("RGBA", (w, h), bg)
    x = pad
    for t in tiles:
        out.alpha_composite(t, (x, h - pad - t.height))
        x += t.width + gap
    return out


def docs():
    """Картинки для README: сам знак, размерный ряд, трей, палитра."""
    DOCS.mkdir(parents=True, exist_ok=True)
    tile(128).save(DOCS / "mark.png")

    # Размерный ряд: свечение живёт только от 48, ниже — плоский цвет, а 11 px
    # показан серым как предел, за которым знака уже нет.
    sizes = [tile(96), tile(32), tile(16), tile(11, fill=(0xA8, 0xAD, 0xB8))]
    strip(sizes, 26, 16, (0, 0, 0, 0)).save(DOCS / "sizes.png")

    # Трей: тот же знак плоским цветом состояния, на тёмной плитке — панель
    # задач чаще тёмная, и светлые значения проверяются именно на ней.
    tray = [tile(32, fill=c, plate=PLATE_DARK) for c in TRAY]
    strip(tray, 20, 18, PLATE_DARK + (255,)).save(DOCS / "tray.png")

    row = []
    for spec in PALETTE:
        sw = Image.new("RGBA", (132, 44), (0, 0, 0, 0))
        mask = Image.new("L", (132 * 4, 44 * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 132 * 4 - 1, 44 * 4 - 1), radius=32, fill=255)
        if isinstance(spec, tuple):
            body = Image.new("RGB", (132, 44), spec)
        else:
            body = Image.new("RGB", (132, 44))
            px = body.load()
            for y in range(44):
                for x in range(132):
                    px[x, y] = spec((x + y * 0.6) / (132 + 44 * 0.6))
        sw = body.convert("RGBA")
        sw.putalpha(mask.resize((132, 44), Image.LANCZOS))
        row.append(sw)
    strip(row, 12, 10, (0, 0, 0, 0)).save(DOCS / "palette.png")
    print(f"картинки стиля пересобраны: {DOCS}")


# Цвета трея — тёмный ряд состояний: поток, подключение, заперто, сбой, выкл.
# «Заперто намеренно» стиль не описывает, янтарь взят из токенов окна: красным
# сработавшая защита читалась бы как поломка.
TRAY = [
    (0x2F, 0xBE, 0x6C),
    (0xFF, 0x9A, 0x2E),
    (0xEB, 0xBD, 0x57),
    (0xF4, 0x56, 0x4A),
    (0x8A, 0x93, 0xA6),
]

# Палитра целиком: два градиента (свечение системы, диагональ бренда) и
# плоские цвета. Больше градиентов не собирается.
BRAND = ((0.0, (0x5B, 0x4B, 0xFF)), (1.0, (0xC1, 0x3B, 0xE0)))


def _lerp(stops, t):
    t = min(max(t, 0.0), 1.0)
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
    return stops[-1][1]


PALETTE = [
    lambda t: _lerp(GLOW, t),
    lambda t: _lerp(BRAND, t),
    FLAT,
    (0x1E, 0x9E, 0x5A),
    (0xE8, 0x80, 0x1F),
    (0xD3, 0x37, 0x2B),
    (0x7A, 0x84, 0x94),
    (0x14, 0x16, 0x1A),
]


if __name__ == "__main__":
    mark(32).save(OUT / "32x32.png")
    mark(128).save(OUT / "128x128.png")
    mark(256).save(OUT / "icon.png")
    ico(OUT / "icon.ico", [16, 24, 32, 48, 64, 256])
    print(f"значки пересобраны: {OUT}")
    docs()
