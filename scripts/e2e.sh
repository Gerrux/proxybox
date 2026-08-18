#!/usr/bin/env bash
# Сквозная проверка: свой sing-box-сервер → share-link → служба → трафик в туннеле
# → падение сервера → fail-closed. Нужен sing-box (PG_SINGBOX или PATH).
#
# Запуск: PG_SINGBOX=/путь/к/sing-box scripts/e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SB="${PG_SINGBOX:-sing-box}"
UUID=b831381d-6324-4d53-ad4f-8cda48b30811
WORK=$(mktemp -d)
export XDG_CONFIG_HOME="$WORK/cfg"
# Служба, убитая сигналом, не успевает прибрать за собой sing-box — в жизни его
# добивает reap_orphan при следующем старте, здесь это делает уборщик скрипта.
cleanup() {
  kill $(jobs -p) 2>/dev/null || true
  kill -9 "$(cat "$XDG_CONFIG_HOME/privacy-gateway/singbox.pid" 2>/dev/null)" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
fail() { echo "ПРОВАЛ: $1" >&2; exit 1; }

step "сборка"
cargo build -q

step "сервер vless на 127.0.0.1:10443 и http на 127.0.0.1:18080"
cat > "$WORK/server.json" <<JSON
{
  "inbounds": [{ "type": "vless", "listen": "127.0.0.1", "listen_port": 10443,
                 "users": [{ "uuid": "$UUID" }] }],
  "outbounds": [{ "type": "direct" }]
}
JSON
"$SB" run -c "$WORK/server.json" -D "$WORK/sb" >"$WORK/server.log" 2>&1 &
SERVER=$!
python3 -m http.server 18080 --bind 127.0.0.1 --directory "$WORK" >/dev/null 2>&1 &
echo "привет из туннеля" > "$WORK/index.html"
sleep 1

step "служба"
./target/debug/pg-service >"$WORK/service.log" 2>&1 &
sleep 1

step "импорт share-link и включение"
./target/debug/privacy-gateway add-profile --link "vless://$UUID@127.0.0.1:10443?type=tcp#e2e"
./target/debug/privacy-gateway profiles | grep -q e2e || fail "профиль не импортировался"
./target/debug/privacy-gateway on --profile e2e
sleep 5
./target/debug/privacy-gateway status
./target/debug/privacy-gateway status | grep -q "поднят" || fail "туннель не поднялся"

step "трафик действительно идёт через туннель"
BODY=$(curl -s --socks5-hostname 127.0.0.1:48292 http://127.0.0.1:18080/)
[ "$BODY" = "привет из туннеля" ] || fail "через туннель пришло: $BODY"
sleep 4  # счётчики обновляются раз в тик присмотра
./target/debug/privacy-gateway status | grep -qE 'трафик: +↓[1-9]' || fail "счётчики трафика пусты"

step "перезапуск службы: приватный режим восстанавливается сам"
SVC=$(ss -ltnp 2>/dev/null | grep ':48291 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
kill "$SVC"; sleep 1
./target/debug/pg-service >>"$WORK/service.log" 2>&1 &
sleep 6
./target/debug/privacy-gateway status
./target/debug/privacy-gateway status | grep -q "поднят" || fail "после перезапуска туннель не поднялся сам"

step "fail-closed: сервер убит"
kill $SERVER; wait $SERVER 2>/dev/null || true
sleep 5
./target/debug/privacy-gateway status
./target/debug/privacy-gateway status | grep -q "без сети" || fail "падение сервера не переведено в DROP"
curl -s -m 5 --socks5-hostname 127.0.0.1:48292 http://127.0.0.1:18080/ && fail "через мёртвый туннель что-то прошло"

printf '\nВСЁ ПРОШЛО\n'
