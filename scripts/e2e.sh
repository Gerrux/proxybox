#!/usr/bin/env bash
# Сквозная проверка: свой sing-box-сервер → share-link → служба → трафик в туннеле
# → падение сервера → fail-closed. Нужен sing-box (PG_SINGBOX или PATH).
#
# Запуск: PG_SINGBOX=/путь/к/sing-box scripts/e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SB="${PG_SINGBOX:-sing-box}"
UUID=b831381d-6324-4d53-ad4f-8cda48b30811
# Проверки ищут в выводе русские слова, а язык CLI берётся из окружения: под
# английской локалью скрипт падал бы на своих же grep, а не на продукте.
export PG_LANG=ru
WORK=$(mktemp -d)
export XDG_CONFIG_HOME="$WORK/cfg"
# Умолчание `/run/proxybox/service.sock` создать может только root — свой
# путь на каждый прогон заодно даёт изоляцию параллельным e2e, которой не
# было и у прежнего фиксированного порта.
export PG_SOCKET="$WORK/service.sock"
# Под root на Linux скрипт проверяет сам инвариант, а не только путь до узла:
# поднимает TUN, роняет сервер и убеждается, что наружу не уходит ничего.
# Без root проверять нечем — nftables и TUN требуют прав.
FULL=0
if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" = "0" ] && command -v nft >/dev/null; then
  FULL=1
fi
# Служба, убитая сигналом, не успевает прибрать за собой sing-box — в жизни его
# добивает reap_orphan при следующем старте, здесь это делает уборщик скрипта.
cleanup() {
  kill $(jobs -p) 2>/dev/null || true
  kill -9 "$(cat "$XDG_CONFIG_HOME/proxybox/singbox.pid" 2>/dev/null)" 2>/dev/null || true
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
./target/debug/proxybox add-profile --link "vless://$UUID@127.0.0.1:10443?type=tcp#e2e"
./target/debug/proxybox profiles | grep -q e2e || fail "профиль не импортировался"
./target/debug/proxybox on --profile e2e
sleep 5
./target/debug/proxybox status
./target/debug/proxybox status | grep -q "поднят" || fail "туннель не поднялся"

step "трафик действительно идёт через туннель"
BODY=$(curl -s --socks5-hostname 127.0.0.1:48292 http://127.0.0.1:18080/)
[ "$BODY" = "привет из туннеля" ] || fail "через туннель пришло: $BODY"
# Счётчики снимаются раз в PROBE_EVERY × TRAFFIC_EVERY (15 с), а не каждый круг
# присмотра. Ждём появления, а не фиксированной паузой: пауза короче периода
# врёт (так и было — `sleep 4` пережил ту правку и валил скрипт), а длиннее
# периода удлиняет прогон на ровном месте.
for _ in $(seq 25); do
  if ./target/debug/proxybox status | grep -qE 'трафик: +↓[1-9]'; then break; fi
  sleep 1
done
./target/debug/proxybox status | grep -qE 'трафик: +↓[1-9]' || fail "счётчики трафика пусты"

step "соединения видны и подписаны маршрутом"
# Список показывает открытые прямо сейчас соединения, а curl из прошлого шага
# закрылся вместе с ответом сервера. Нужен тот, кто принимает и молчит.
python3 -c 'import socket
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 18081)); s.listen(4)
# Принятое держим: брошенный сокет Python закрывает сам, и соединение
# умирает раньше вопроса — ровно то, что и пряталось за пустым списком.
held = []
while True: held.append(s.accept())' &
sleep 1
curl -s -m 20 --socks5-hostname 127.0.0.1:48292 http://127.0.0.1:18081/ >/dev/null &
sleep 2
./target/debug/proxybox conns
./target/debug/proxybox conns | grep -q "18081" || fail "живое соединение не попало в список"
./target/debug/proxybox conns | grep -q "туннель" || fail "соединение не подписано маршрутом"

step "перезапуск службы: приватный режим восстанавливается сам"
SVC=$(pgrep -f 'target/debug/pg-service' | head -1)
[ -n "$SVC" ] || fail "служба не найдена"
kill "$SVC"; sleep 1
./target/debug/pg-service >>"$WORK/service.log" 2>&1 &
sleep 6
./target/debug/proxybox status
./target/debug/proxybox status | grep -q "поднят" || fail "после перезапуска туннель не поднялся сам"

if [ "$FULL" = "1" ]; then
  step "fail-closed: посторонний процесс доходит, пока сервер жив"
  # Цель обязана быть непетлевой. `oifname "lo" accept` пропускает петлю всегда
  # и обязан пропускать — иначе машина теряет себя саму, — так что проверка по
  # 127.0.0.1 проходила бы и при снятом замке, то есть не проверяла бы ничего.
  # Берём собственный адрес машины: туда пакет идёт через физический интерфейс,
  # ровно тот путь, который замок и обязан рубить.
  LAN=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
  [ -n "$LAN" ] || fail "у машины нет непетлевого адреса — проверять замок не на чем"
  python3 -m http.server 18082 --bind "$LAN" --directory "$WORK" >/dev/null 2>&1 &
  sleep 1
  # Посторонний — это другой uid: служба и sing-box проходят замок по пропуску,
  # и их успех про замок не говорит ничего.
  outsider() { setpriv --reuid=nobody --regid=nogroup --clear-groups \
      curl -s --max-time 5 "http://$LAN:18082/" >/dev/null 2>&1; }
  # Обязан идти до убийства сервера ниже, а не после: посторонний доходит до
  # цели через тот же туннель, что и весь трафик машины (на Linux выбор
  # приложений в замке ещё не разведён с охватом «весь компьютер» — см. шапку
  # core-filter/linux.rs), и его успех держится на живом сервере, а не на
  # подтверждении пробы. Проверь мы это после, увидели бы тот же отказ, что и
  # в шаге ниже, и не отличили бы «замок» от «сервер мёртв». Без этой строки
  # следующая проверка (посторонний заперт) зеленела бы и от сломанного curl.
  outsider || fail "посторонний не дошёл до цели, пока сервер и туннель были живы"
fi

step "fail-closed: сервер убит"
kill $SERVER; wait $SERVER 2>/dev/null || true
sleep 5
./target/debug/proxybox status
./target/debug/proxybox status | grep -q "без сети" || fail "падение сервера не переведено в DROP"
curl -s -m 5 --socks5-hostname 127.0.0.1:48292 http://127.0.0.1:18080/ && fail "через мёртвый туннель что-то прошло"

if [ "$FULL" = "1" ]; then
  step "fail-closed: наружу не уходит ничего"
  nft list table inet proxybox >/dev/null 2>&1 || fail "замок не стоит при мёртвом туннеле"
  outsider && fail "посторонний процесс достучался наружу при мёртвом туннеле"

  step "снятие замка возвращает машину"
  ./target/debug/proxybox off
  nft list table inet proxybox >/dev/null 2>&1 && fail "снятый замок оставил таблицу"
  outsider || fail "снятый замок не вернул сеть"
fi

printf '\nВСЁ ПРОШЛО\n'
