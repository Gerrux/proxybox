# Раскладывает sidecar-бинарники в src-tauri\binaries: их требует любая команда
# Tauri — и сборка, и dev, — поэтому шаг общий, а не часть выпуска.
#
#   pwsh installer\sidecars.ps1 [-Config debug|release] [-Triple ...] [-SingBox ...]
param(
  [ValidateSet("debug", "release")] [string]$Config = "debug",
  [string]$Triple = "",
  [string]$SingBox = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

if (-not $Triple) {
  # Цель берём у самого rustc: гадать про arm64 и msvc/gnu незачем.
  $Triple = ((& rustc -vV | Select-String "^host: ") -split " ")[1]
}
# $IsWindows есть только в PowerShell 7; в 5.1 он пуст, а $env:OS есть везде.
$exe = if ($env:OS -eq "Windows_NT") { ".exe" } else { "" }

# sing-box в комплекте обязателен: без него приватный режим не включается.
# GPL-3.0: текст лицензии обязан ехать вместе с бинарником.
# sing-box всегда .exe: это windows-бинарник из релиза, а не наша сборка.
$sb = Join-Path $bin "sing-box.exe"
if ($SingBox) { Copy-Item $SingBox $sb -Force }
if (-not (Test-Path $sb) -or -not (Test-Path (Join-Path $bin "LICENSE-sing-box.txt"))) {
  $arch = if ($Triple -like "aarch64*") { "arm64" } else { "amd64" }
  & (Join-Path $PSScriptRoot "get-singbox.ps1") -Arch $arch
}
# 45 МБ копируются только когда действительно изменились.
$sbTarget = Join-Path $bin "sing-box-$Triple.exe"
if (-not (Test-Path $sbTarget) -or (Get-Item $sbTarget).Length -ne (Get-Item $sb).Length) {
  Copy-Item $sb $sbTarget -Force
}

$flags = @("build", "-p", "pg-service", "-p", "pg-cli")
if ($Config -eq "release") { $flags += "--release" }
& cargo @flags
if ($LASTEXITCODE -ne 0) { throw "cargo build упал" }

foreach ($name in @("pg-service", "privacy-gateway")) {
  Copy-Item (Join-Path $root "target\$Config\$name$exe") (Join-Path $bin "$name-$Triple$exe") -Force
}
Write-Host "sidecars готовы ($Config, $Triple): $bin"
