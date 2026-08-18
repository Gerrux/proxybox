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
# GPL-3.0: текст лицензии обязан ехать вместе с бинарником, его тоже проверяем.
$license = Join-Path $bin "LICENSE-sing-box.txt"
if ($SingBox) { Copy-Item $SingBox (Join-Path $bin "sing-box.exe") -Force }
if (-not (Test-Path (Join-Path $bin "sing-box.exe")) -or -not (Test-Path $license)) {
  Write-Host "== sing-box не найден, качаю"
  $arch = if ($Triple -like "aarch64*") { "arm64" } else { "amd64" }
  & (Join-Path $PSScriptRoot "get-singbox.ps1") -Arch $arch
}
# Tauri ждёт sidecar-бинарники с суффиксом целевой платформы.
$target = Join-Path $bin "sing-box-$Triple.exe"
Copy-Item (Join-Path $bin "sing-box.exe") $target -Force

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
