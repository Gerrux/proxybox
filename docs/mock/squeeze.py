"""Пережать скриншоты окна палитрой в 256 цветов: python docs/mock/squeeze.py файлы…

Окно плоское — ровные заливки, волосяные линии, текст, — и в палитру оно
укладывается без видимых потерь, а весит втрое меньше: ~45 КБ вместо ~130.
Без подмешивания шума (dither): на ровной заливке он виден как рябь. Обложку
(og.png) сюда не передают: у неё градиент фона, и палитра дала бы ступени.
Зовёт его `shoot.mjs`; нужен Pillow.
"""

import sys

from PIL import Image

for path in sys.argv[1:]:
    image = Image.open(path).convert("RGB")
    image.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(path, optimize=True)
