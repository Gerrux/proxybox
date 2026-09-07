#!/usr/bin/env bash
# Сборка .deb proxybox для Linux — двойник build.ps1. Требует cargo-tauri,
# webkit2gtk и заголовки appindicator (см. release.yml, job linux).
#
#   installer/build.sh
#
# На выходе — один .deb в src-tauri/target/release/bundle/deb/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== sidecars (release)"
"$(dirname "$0")/sidecars.sh" release

echo "== сборка окна и пакета"
cd "$ROOT"
pnpm install
# --bundles deb в лоб, а не через bundle.targets в tauri.conf.json: тот
# список общий с Windows ("nsis", "deb"), и tauri-bundler сам отфильтрует
# nsis по текущей платформе (Settings::package_types), так что голый
# `cargo tauri build` тут и без флага не тронул бы makensis. Флаг оставлен
# как явная граница: список целей в конфиге общий, а собираем здесь ровно
# одно — не то, что туда допишут для Windows или macOS завтра.
cargo tauri build --bundles deb

for f in "$ROOT"/src-tauri/target/release/bundle/deb/*.deb; do
  echo "готово: $f"
done
