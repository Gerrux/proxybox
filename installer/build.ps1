# Сборка установщика Privacy Gateway. Только Windows: нужен WebView2 и MSVC.
#
#   pwsh installer\build.ps1 [-Triple x86_64-pc-windows-msvc] [-SingBox путь\к\sing-box.exe]
#
# На выходе — один .exe в src-tauri\target\release\bundle\nsis\.
param(
  [string]$Triple = "x86_64-pc-windows-msvc",
  [string]$SingBox = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

# sing-box в комплекте обязателен: без него приватный режим не включается.
$target = Join-Path $bin "sing-box-$Triple.exe"
if ($SingBox) { Copy-Item $SingBox $target -Force }
if (-not (Test-Path $target)) {
  throw "Нет $target. Скачайте sing-box для Windows (https://github.com/SagerNet/sing-box/releases) и укажите -SingBox путь\к\sing-box.exe"
}
# GPL-3.0: текст лицензии обязан ехать вместе с бинарником.
$license = Join-Path $bin "LICENSE-sing-box.txt"
if (-not (Test-Path $license)) {
  throw "Нет $license — положите рядом LICENSE из архива sing-box (условие GPL-3.0)"
}

Write-Host "== сборка службы и CLI"
& cargo build --release -p pg-service -p pg-cli
if ($LASTEXITCODE -ne 0) { throw "cargo build упал" }
Copy-Item (Join-Path $root "target\release\pg-service.exe")       (Join-Path $bin "pg-service-$Triple.exe") -Force
Copy-Item (Join-Path $root "target\release\privacy-gateway.exe")  (Join-Path $bin "privacy-gateway-$Triple.exe") -Force

Write-Host "== сборка окна и установщика"
Push-Location $root
try {
  & pnpm install
  & cargo tauri build
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build упал" }
} finally { Pop-Location }

Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\nsis") -Filter *.exe |
  ForEach-Object { Write-Host "готово: $($_.FullName)" }
