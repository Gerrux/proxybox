#!/usr/bin/env bash
# Настройки службы: правка по одному полю, запись на диск, перезапуск и
# перебивка переменными окружения. sing-box не нужен — туннель тут не поднимают.
#
# Запуск: scripts/settings.sh
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=$(mktemp -d)
export XDG_CONFIG_HOME="$WORK/cfg"
# На Linux TUN не поднять, а настройкам он и не нужен.
export PG_TUN=0
# Язык фиксируем: скрипт сверяет строки, а не смысл.
export PG_LANG=ru
STATE="$XDG_CONFIG_HOME/proxybox/state.json"
CLI=target/debug/proxybox

cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
fail() { echo "ПРОВАЛ: $1" >&2; exit 1; }

# Служба поднимается несколько раз: каждый раз ждём, пока она начнёт отвечать.
serve() {
  env "$@" target/debug/pg-service >>"$WORK/svc.log" 2>&1 &
  for _ in $(seq 1 40); do
    $CLI status >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  fail "служба не поднялась"
}
halt() {
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
}

step "сборка"
cargo build -q

step "умолчания: сверка идёт, страну спрашиваем, проба на сервер узла"
serve PG_LANG=ru
$CLI settings | grep -q '^refresh    on' || fail "сверка подписок должна быть включена"
$CLI settings | grep -q '^geo        on' || fail "запрос страны должен быть включён"
$CLI settings | grep -q '^probe      сервер узла' || fail "проба должна идти на сервер узла"

step "правка одного поля не стирает остальные"
$CLI settings --geo off >/dev/null
$CLI settings --probe 1.1.1.1:443 >/dev/null
$CLI settings --singbox /opt/sing-box/sing-box >/dev/null
$CLI settings --refresh off >/dev/null
$CLI settings
grep -q '"probe": "1.1.1.1:443"' "$STATE" || fail "цель пробы не записалась"
grep -q '"singbox": "/opt/sing-box/sing-box"' "$STATE" || fail "путь к sing-box не записался"
grep -q '"geo": false' "$STATE" || fail "запрос страны не выключился"

step "тумблер принимает on|off и ничего больше"
$CLI settings --geo нет >/dev/null 2>&1 && fail "приняли не on/off"
echo "отказ получен"

step "настройки переживают перезапуск службы"
halt
serve PG_LANG=ru
$CLI settings | grep -q '^probe      1.1.1.1:443' || fail "цель пробы не пережила перезапуск"

step "переменная окружения перебивает настройку и говорит об этом в журнале"
halt
serve PG_LANG=ru PG_PROBE=9.9.9.9:53
$CLI settings | grep -q '^probe      9.9.9.9:53' || fail "PG_PROBE не перебила настройку"
grep -q 'перебит' "$WORK/svc.log" || fail "про перебивку в журнале ни слова"

step "перебивка не переживает переменную: на диск уходит выбранное человеком"
# Клиент показывает действующие значения и присылает их обратно набором —
# записать среди них значение переменной значило бы сделать её постоянной.
$CLI settings --refresh on >/dev/null
grep -q '"probe": "1.1.1.1:443"' "$STATE" || fail "окружение записалось на диск"
grep -q '"refresh": true' "$STATE" || fail "неперебитое поле не сохранилось"

printf '\nВСЁ ХОРОШО\n'
