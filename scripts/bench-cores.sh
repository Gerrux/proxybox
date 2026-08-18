#!/usr/bin/env bash
# Сравнение ядер туннеля: sing-box, mihomo, Xray-core — на одном и том же
# vless+TLS сервере (его поднимает sing-box). Меряется клиентская сторона:
# память, CPU на гигабайт, поток, скорость установки соединений.
#
#   PG_SINGBOX=... PG_MIHOMO=... PG_XRAY=... scripts/bench-cores.sh
#
# Числа привязаны к стенду: поток упирается в python http.server, поэтому
# сравнивать имеет смысл CPU/ГБ и память, а не абсолютный поток. Тот же прогон
# без TLS даёт sing-box двукратный выигрыш по CPU за счёт splice() — это
# особенность Linux, на Windows её нет.
D=${BENCH_DIR:-/tmp/pg-bench}
SB=${PG_SINGBOX:-sing-box}
MH=${PG_MIHOMO:-mihomo}
XR=${PG_XRAY:-xray}
W=$D/bench2; rm -rf $W; mkdir -p "$W" $W/sb $W/mh $W/xr
UUID=b831381d-6324-4d53-ad4f-8cda48b30811
SRV=/dev/shm/pgbench; mkdir -p $SRV
head -c 512M /dev/urandom > $SRV/big 2>/dev/null
head -c 4096 /dev/urandom > $SRV/small
openssl req -x509 -newkey rsa:2048 -keyout $W/key.pem -out $W/cert.pem -days 2 -nodes -subj "/CN=bench.local" -addext "subjectAltName=DNS:bench.local" >/dev/null 2>&1

cat > $W/server.json <<JSON
{ "log": {"level":"error"},
  "inbounds": [{ "type": "vless", "listen": "127.0.0.1", "listen_port": 10443,
                 "users": [{ "uuid": "$UUID" }],
                 "tls": { "enabled": true, "server_name": "bench.local",
                          "certificate_path": "$W/cert.pem", "key_path": "$W/key.pem" } }],
  "outbounds": [{ "type": "direct" }] }
JSON
$SB run -c $W/server.json -D $W/sb >$W/server.log 2>&1 & SRVPID=$!
python3 -m http.server 18080 --bind 127.0.0.1 --directory $SRV >/dev/null 2>&1 & HTTPPID=$!
sleep 1.5

cat > $W/sb.json <<JSON
{ "log": {"level":"error"},
  "inbounds": [{ "type": "mixed", "tag": "local", "listen": "127.0.0.1", "listen_port": 21080 }],
  "outbounds": [{ "type": "vless", "tag": "proxy", "server": "127.0.0.1", "server_port": 10443, "uuid": "$UUID",
                  "tls": { "enabled": true, "server_name": "bench.local", "insecure": true,
                           "utls": { "enabled": true, "fingerprint": "chrome" } } },
                { "type": "direct", "tag": "direct" }],
  "route": { "rules": [{ "inbound": ["local"], "action": "route", "outbound": "proxy" }], "final": "direct" } }
JSON
cat > $W/mh.yaml <<YAML
mixed-port: 21081
log-level: silent
mode: rule
proxies:
  - {name: p, type: vless, server: 127.0.0.1, port: 10443, uuid: $UUID, udp: true, network: tcp,
     tls: true, servername: bench.local, skip-cert-verify: true, client-fingerprint: chrome}
rules:
  - MATCH,p
YAML
cat > $W/xr.json <<JSON
{ "log": {"loglevel":"error"},
  "inbounds": [{ "tag":"local", "port": 21082, "listen": "127.0.0.1", "protocol": "socks",
                 "settings": {"udp": true, "auth": "noauth"} }],
  "outbounds": [{ "protocol": "vless",
      "settings": {"vnext":[{"address":"127.0.0.1","port":10443,
                   "users":[{"id":"$UUID","encryption":"none"}]}]},
      "streamSettings": {"network":"tcp","security":"tls",
                         "tlsSettings":{"serverName":"bench.local","fingerprint":"chrome",
                            "certificates":[{"usage":"verify","certificateFile":"$W/cert.pem"}]}} }] }
JSON

cpu() { awk '{print ($14+$15)/100}' /proc/$1/stat 2>/dev/null || echo 0; }
rss() { awk '/VmRSS/{print $2/1024}' /proc/$1/status 2>/dev/null || echo 0; }
hwm() { awk '/VmHWM/{print $2/1024}' /proc/$1/status 2>/dev/null || echo 0; }
waitport() { for i in $(seq 1 200); do (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null && return 0; sleep 0.05; done; return 1; }

bench() {
  NAME=$1; PORT=$2; PID=$3
  curl -s -o /dev/null -m 20 --socks5-hostname 127.0.0.1:$PORT http://127.0.0.1:18080/small || { echo "$NAME: не работает"; return; }
  sleep 3
  IDLE=$(rss $PID); C0=$(cpu $PID); T0=$(date +%s.%N)
  for i in 1 2 3; do curl -s -o /dev/null --socks5-hostname 127.0.0.1:$PORT http://127.0.0.1:18080/big; done
  T1=$(date +%s.%N); C1=$(cpu $PID)
  SEC=$(echo "$T1-$T0"|bc); MBS=$(echo "scale=0; 1536/$SEC"|bc)
  CPU_GB=$(echo "scale=2; ($C1-$C0)*1024/1536"|bc)
  URLS=$(for i in $(seq 1 300); do echo -n "-o /dev/null http://127.0.0.1:18080/small "; done)
  C2=$(cpu $PID); T2=$(date +%s.%N)
  curl -s -H 'Connection: close' --socks5-hostname 127.0.0.1:$PORT $URLS >/dev/null 2>&1
  T3=$(date +%s.%N); C3=$(cpu $PID)
  printf '%-9s %7s %8s %10s %10s %9s %10s\n' "$NAME" "$(printf %.0f $IDLE)МБ" "$(printf %.0f $(hwm $PID))МБ" \
    "${MBS}МБ/с" "${CPU_GB}с/ГБ" "$(echo "scale=0; 300/($T3-$T2)"|bc)/с" "$(echo "scale=2;($C3-$C2)*1000/300"|bc)мс"
}

T0=$(date +%s.%N); curl -s -o /dev/null http://127.0.0.1:18080/big; T1=$(date +%s.%N)
echo "потолок стенда без прокси: $(echo "scale=0; 512/($T1-$T0)"|bc) МБ/с"
echo
printf '%-9s %7s %8s %10s %10s %9s %10s\n' ядро "RSS хх" "RSS пик" поток CPU соед. "CPU/соед"
$SB run -c $W/sb.json -D $W/sb >$W/sb.log 2>&1 & P=$!; waitport 21080 && bench sing-box 21080 $P; kill $P 2>/dev/null
$MH -f $W/mh.yaml -d $W/mh >$W/mh.log 2>&1 & P=$!; waitport 21081 && bench mihomo 21081 $P; kill $P 2>/dev/null
$XR run -c $W/xr.json >$W/xr.log 2>&1 & P=$!; waitport 21082 && bench xray 21082 $P; kill $P 2>/dev/null
kill $SRVPID $HTTPPID 2>/dev/null; rm -rf $SRV
