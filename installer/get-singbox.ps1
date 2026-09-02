# Кладёт sing-box для Windows в src-tauri\binaries\ — туда, где его ждут и
# сборка установщика, и служба при разработке. Вместе с бинарником забирается
# LICENSE: sing-box под GPL-3.0, распространять его без текста лицензии нельзя.
#
#   pwsh installer\get-singbox.ps1 [-Arch amd64|arm64] [-Version 1.13.21]
#
# Версия закреплена, и это не педантизм. Раньше пустая $Version означала
# «последний релиз с GitHub» — то есть версию sing-box выбирала дата сборки, а
# не репозиторий. Так и вышло: 0.3.1 собрался через два дня после выхода 1.14.0
# и унёс его в установщике, а конфиг писан под 1.13. Приватный режим не
# включался вовсе — «create service: initialize dns router: Legacy `strategy`
# DNS rule action option is deprecated». Код при этом не менялся ни строкой.
#
# Поднимать версию — отдельная осознанная правка: в CLAUDE.md десяток замеров и
# «проверено на 1.13.x», и каждый из них новая версия вправе отменить.
param(
  [ValidateSet("amd64", "arm64")] [string]$Arch = "amd64",
  [string]$Version = "1.13.21"
)
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1: TLS 1.2 по умолчанию не включён на старых системах,
# а полоса прогресса Invoke-WebRequest замедляет закачку в разы.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$name = "sing-box-$Version-windows-$Arch"
$url  = "https://github.com/SagerNet/sing-box/releases/download/v$Version/$name.zip"
$tmp  = Join-Path $env:TEMP "pg-singbox"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "Скачиваю $url"
$zip = Join-Path $tmp "$name.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $tmp -Force

# libcronet.dll из архива не берём: он нужен только outbound-у naive, которого
# мы не поддерживаем, а весит 9 МБ в каждом установщике.
Copy-Item (Join-Path $tmp "$name\sing-box.exe") (Join-Path $bin "sing-box.exe") -Force
Copy-Item (Join-Path $tmp "$name\LICENSE")      (Join-Path $bin "LICENSE-sing-box.txt") -Force
Remove-Item $tmp -Recurse -Force

Write-Host "Готово: $bin\sing-box.exe (v$Version)"
