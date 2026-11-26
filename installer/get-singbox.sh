#!/usr/bin/env bash
# Собирает закреплённый sing-box и кладёт его вместе с лицензией в binaries.
set -euo pipefail
INSTALLER="$(cd "$(dirname "$0")" && pwd)"
source "$INSTALLER/sing-box.env"
VERSION="${SING_BOX_VERSION#v}"
MODULE=github.com/sagernet/sing-box
BIN="$INSTALLER/../src-tauri/binaries"
SB="$BIN/sing-box"
LICENSE="$BIN/LICENSE-sing-box.txt"

if [[ -x "$SB" && -f "$LICENSE" ]] && "$SB" version | grep -Fx "sing-box version $VERSION" >/dev/null; then
  exit 0
fi

go mod download "$MODULE@$SING_BOX_VERSION"
SOURCE="$(go env GOMODCACHE)/$MODULE@$SING_BOX_VERSION"
mkdir -p "$BIN"
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
(
  cd "$SOURCE"
  CGO_ENABLED=0 go build -mod=readonly -trimpath -tags "$SING_BOX_TAGS" \
    -ldflags "-X $MODULE/constant.Version=$VERSION" -o "$TMP/sing-box" ./cmd/sing-box
)
install -m 644 "$SOURCE/LICENSE" "$LICENSE"
install -m 755 "$TMP/sing-box" "$SB"
