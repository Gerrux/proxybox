#!/usr/bin/env bash
# Линуксовый двойник sidecars.ps1: раскладывает те же три бинарника в
# src-tauri/binaries, только с линуксовой тройкой и без расширений — их
# требует любая команда Tauri, и сборка, и dev, поэтому шаг общий, а не часть
# выпуска. pwsh на Linux по умолчанию не стоит, поэтому это отдельный скрипт,
# а не порт .ps1 через прослойку.
#
#   installer/sidecars.sh [debug|release]
set -euo pipefail
CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
mkdir -p "$BIN"

# Тройку берём у самого rustc, а не пишем руками — так же поступает
# sidecars.ps1, и по той же причине: гадать незачем.
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"

# sing-box в комплекте обязателен: без него приватный режим не включается.
bash "$ROOT/installer/get-singbox.sh"
SB="$BIN/sing-box"
# Бинарник копируется только при изменении содержимого.
SB_TARGET="$BIN/sing-box-$TRIPLE"
if ! cmp -s "$SB" "$SB_TARGET"; then
  cp "$SB" "$SB_TARGET"
fi

FLAGS=(build -p pg-service -p pg-cli)
if [ "$CONFIG" = "release" ]; then FLAGS+=(--release); fi
(cd "$ROOT" && cargo "${FLAGS[@]}")

for name in pg-service proxybox; do
  cp "$ROOT/target/$CONFIG/$name" "$BIN/$name-$TRIPLE"
done

echo "sidecars готовы ($CONFIG, $TRIPLE): $BIN"
