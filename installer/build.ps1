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

Write-Host "== sidecars (release)"
& (Join-Path $PSScriptRoot "sidecars.ps1") -Config release -Triple $Triple -SingBox $SingBox

Write-Host "== сборка окна и установщика"
Push-Location $root
try {
  & pnpm install
  & cargo tauri build
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build упал" }
} finally { Pop-Location }

Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\nsis") -Filter *.exe |
  ForEach-Object { Write-Host "готово: $($_.FullName)" }
