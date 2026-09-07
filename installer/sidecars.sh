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
# Версия закреплена в get-singbox.ps1 и обязана быть одна на установщик и на
# CI (см. её же шапку и ci.yml) — тянем тем же grep, что и там, а не второй
# копией номера.
VER=$(grep -oP '\$Version = "\K[^"]+' "$ROOT/installer/get-singbox.ps1")
SB="$BIN/sing-box"
# GPL-3.0: текст лицензии обязан ехать вместе с бинарником.
if [ ! -f "$SB" ] || [ ! -f "$BIN/LICENSE-sing-box.txt" ]; then
  TMP=$(mktemp -d)
  curl -sL "https://github.com/SagerNet/sing-box/releases/download/v$VER/sing-box-$VER-linux-amd64.tar.gz" | tar xz -C "$TMP"
  cp "$TMP/sing-box-$VER-linux-amd64/sing-box" "$SB"
  cp "$TMP/sing-box-$VER-linux-amd64/LICENSE" "$BIN/LICENSE-sing-box.txt"
  rm -rf "$TMP"
fi
# Копируется только когда действительно изменился — то же правило, что и в
# sidecars.ps1, ради тех же полусотни мегабайт.
SB_TARGET="$BIN/sing-box-$TRIPLE"
if [ ! -f "$SB_TARGET" ] || [ "$(stat -c%s "$SB_TARGET")" != "$(stat -c%s "$SB")" ]; then
  cp "$SB" "$SB_TARGET"
fi

FLAGS=(build -p pg-service -p pg-cli)
if [ "$CONFIG" = "release" ]; then FLAGS+=(--release); fi
(cd "$ROOT" && cargo "${FLAGS[@]}")

for name in pg-service proxybox; do
  cp "$ROOT/target/$CONFIG/$name" "$BIN/$name-$TRIPLE"
done

echo "sidecars готовы ($CONFIG, $TRIPLE): $BIN"
