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

# tauri.conf.json кладёт sing-box в externalBin, то есть в /usr/bin рядом с
# pg-service, — а этим путём уже владеет официальный .deb sing-box от
# SagerNet: apt откажется ставить наш пакет поверх ("trying to overwrite").
# Наша аудитория — как раз те, у кого он уже стоит, поэтому это не край
# случая. tauri.conf.json трогать нельзя: externalBin там общий с Windows
# (build.ps1), которому sing-box в комплекте с окном как раз и нужен рядом.
# --config мержится поверх файла (json-merge-patch: массив заменяется
# целиком, объекты — рекурсивно), тем же приёмом build.ps1 подмешивает
# отпечаток сертификата, — и только для этой, линуксовой, сборки: убираем
# sing-box из externalBin и кладём его отдельным файлом в /usr/lib/proxybox,
# куда сторонний пакет не заглядывает. proxybox.service находит его там через
# PG_SINGBOX (Environment=), core_tunnel::binary() иначе искал бы только
# рядом с pg-service.
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
DEB_CONFIG="{\"bundle\":{\"externalBin\":[\"binaries/pg-service\",\"binaries/proxybox\"],\"linux\":{\"deb\":{\"files\":{\"/usr/lib/proxybox/sing-box\":\"binaries/sing-box-$TRIPLE\"}}}}}"

# --bundles deb в лоб, а не только через bundle.targets в tauri.conf.json: тот
# список общий с Windows ("nsis", "deb"), и tauri-bundler сам отфильтрует
# nsis по текущей платформе (Settings::package_types), так что голый
# `cargo tauri build` тут и без флага не тронул бы makensis. Флаг оставлен
# как явная граница: список целей в конфиге общий, а собираем здесь ровно
# одно — не то, что туда допишут для Windows или macOS завтра.
cargo tauri build --bundles deb --config "$DEB_CONFIG"

for f in "$ROOT"/src-tauri/target/release/bundle/deb/*.deb; do
  echo "готово: $f"
done
