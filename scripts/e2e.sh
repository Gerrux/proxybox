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
# Уборщик не ждёт, пока служба разберёт SIGTERM сама: `kill $(jobs -p)` не
# делает `wait`, а trap может сработать и раньше, чем guard(false)/stop()
# успеют погасить sing-box (сорванное утверждение на середине, отказ шага).
# kill -9 по pid-файлу — страховка на этот случай, а не единственный путь
# уборки: с job 3 служба вне Windows сама гасит sing-box по SIGTERM.
cleanup() {
  kill $(jobs -p) 2>/dev/null || true
  kill -9 "$(cat "$XDG_CONFIG_HOME/proxybox/singbox.pid" 2>/dev/null)" 2>/dev/null || true
  # Провал утверждения между guard(true) и `proxybox off` ниже оставил бы
  # замок стоять до конца job'а — раннер без сети и без логов на весь
  # timeout. Трап надёжнее, чем надежда на то, что штатное снятие успело
  # отработать.
  if [ "$FULL" = "1" ]; then
    nft delete table inet proxybox >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
fail() { echo "ПРОВАЛ: $1" >&2; exit 1; }

step "режим проверки: FULL=$FULL"
# CI обязан гонять полную проверку, а не молча откатываться на путь до узла:
# ровно так «sing-box не установлен — проверять нечем» когда-то пропустил
# фатальный конфиг в 0.3.1 — сторожа спали, а тесты зеленели. PG_E2E_FULL=1
# в CI требует, чтобы FULL и правда оказался 1; без переменной (разработчик
# без root) требования нет.
if [ "${PG_E2E_FULL:-0}" = "1" ] && [ "$FULL" != "1" ]; then
  fail "PG_E2E_FULL=1, а полной проверки нет: нужны Linux, root и nftables"
fi

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
#
# И он же обязан быть громким. Список режется сотней по громкости
# (`core-tunnel`, `leaks_first`), а под живым TUN в туннель идёт вся машина: на
# CI-раннере это под тысячу соединений его собственного сторожевого демона, и
# тихое соединение с нулём байт вытесняется из списка целиком. Раньше на Linux
# TUN не поднимался, в туннеле было только своё, и объём не имел значения.
# Поэтому принятое не просто держим, а вычитываем — иначе upload упрётся в
# backpressure на первых килобайтах и до счётчиков не доедет.
python3 -c 'import socket, threading
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 18081)); s.listen(4)
def drain(c):
    # Принятое держим открытым: брошенный сокет Python закрывает сам, и
    # соединение умирает раньше вопроса — ровно то, что и пряталось за
    # пустым списком.
    while c.recv(65536):
        pass
while True:
    conn, _ = s.accept()
    threading.Thread(target=drain, args=(conn,), daemon=True).start()' &
sleep 1
head -c 4194304 /dev/zero | curl -s -m 20 --socks5-hostname 127.0.0.1:48292 \
  --data-binary @- http://127.0.0.1:18081/ >/dev/null &
sleep 3
./target/debug/proxybox conns
./target/debug/proxybox conns | grep -q "18081" || fail "живое соединение не попало в список"
./target/debug/proxybox conns | grep -q "туннель" || fail "соединение не подписано маршрутом"

step "перезапуск службы: приватный режим восстанавливается сам"
SVC=$(pgrep -f 'target/debug/pg-service' | head -1)
[ -n "$SVC" ] || fail "служба не найдена"
# -9: голый `kill` шлёт SIGTERM, а его служба теперь перехватывает и гасит
# приватный режим сама (`stop()`: private = false, записано на диск) — то
# есть перестаёт быть тем «падением», которое проверяет этот шаг. Нужен
# настоящий SIGKILL, необрабатываемый, чтобы private=true пережило рестарт.
kill -9 "$SVC"; sleep 1
./target/debug/pg-service >>"$WORK/service.log" 2>&1 &
sleep 6
./target/debug/proxybox status
./target/debug/proxybox status | grep -q "поднят" || fail "после перезапуска туннель не поднялся сам"

if [ "$FULL" = "1" ]; then
  step "fail-closed: посторонний доходит, пока замка нет вовсе"
  # Цель — реальный внешний адрес, а не свой: ядро маршрутизирует пакет к
  # собственному адресу машины через `lo` (`ip route get <свой адрес>` отдаёт
  # `dev lo`), и первое же правило нашей таблицы (`oifname "lo" accept`,
  # `core-filter/src/linux.rs`) пропускало бы такой пакет при любом состоянии
  # замка — проверка была бы тавтологией. Свой http.server на непетлевом
  # адресе был точно той же ловушкой в другой обёртке.
  # Посторонний — это другой uid: служба и sing-box проходят замок по
  # пропуску, и их успех про замок не говорит ничего.
  # 15, а не 5: round-trip до внешнего хоста под нагруженным CI-раннером в
  # пять секунд может не уложиться — а красный master дороже лишних секунд.
  outsider() { setpriv --reuid=nobody --regid=nogroup --clear-groups \
      curl -s --max-time 15 -o /dev/null https://github.com; }
  # Обязан идти до убийства сервера ниже, а не после. Здесь единственный
  # охват — `Scope::All` (свежий XDG_CONFIG_HOME, узел ещё не сверялся,
  # `migrate_scope` в отсутствие state.json отдаёт `Scope::All`), а для него
  # `fencing()` ставит killswitch только на `private && blocked` — то есть
  # только пока туннель не подтверждён. Тут он давно подтверждён (проверено
  # выше), `guard(true)` от смерти сервера ещё не сработал, и замка нет
  # вовсе — посторонний обязан пройти. Без этой строки следующая проверка
  # (посторонний заперт) зеленела бы и от сломанного curl.
  outsider || fail "посторонний не дошёл до внешнего адреса при снятом замке"
fi

step "fail-closed: сервер убит"
kill $SERVER; wait $SERVER 2>/dev/null || true
# Down наступает не сразу: PROBE_MISSES=3 промаха подряд, промах — раз в
# PROBE_EVERY=3 с, итого от 6 до 9 с. Фиксированная пауза здесь — как и с
# трафиком выше — либо короче и врёт, либо длиннее и удлиняет прогон впустую.
for _ in $(seq 25); do
  if ./target/debug/proxybox status | grep -q "без сети"; then break; fi
  sleep 1
done
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
  # С запасом, а не одной попыткой: вместе с замком уходит и TUN, а маршрут по
  # умолчанию возвращается не тем же мгновением, каким исчезает интерфейс.
  # Проверяем возврат сети, а не скорость, с какой ядро переставляет таблицу
  # маршрутов.
  for _ in $(seq 5); do
    if outsider; then break; fi
    sleep 2
  done
  outsider || fail "снятый замок не вернул сеть"
fi

printf '\nВСЁ ПРОШЛО\n'
