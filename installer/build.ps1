# Сборка установщика proxybox. Только Windows: нужен WebView2 и MSVC.
#
#   pwsh installer\build.ps1 [-Triple x86_64-pc-windows-msvc] [-SingBox путь\к\sing-box.exe]
#
# На выходе — один .exe в src-tauri\target\release\bundle\nsis\.
param(
  [string]$Triple = "x86_64-pc-windows-msvc",
  [string]$SingBox = "",
  # Отпечаток сертификата Authenticode (sha1). Без него сборка выходит
  # неподписанной, и SmartScreen будет ругаться на установщик.
  [string]$Thumbprint = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== sidecars (release)"
& (Join-Path $PSScriptRoot "sidecars.ps1") -Config release -Triple $Triple -SingBox $SingBox -Thumbprint $Thumbprint

Write-Host "== сборка окна и установщика"
Push-Location $root
try {
  & pnpm install
  if ($Thumbprint) {
    # Отпечаток передаём поверх конфига, а не в tauri.conf.json: сертификат —
    # свойство машины сборки, а не репозитория.
    $signing = @{ bundle = @{ windows = @{
      certificateThumbprint = $Thumbprint
      digestAlgorithm = "sha256"
      timestampUrl = "http://timestamp.digicert.com"
    } } } | ConvertTo-Json -Depth 6 -Compress
    & cargo tauri build --config $signing
  } else {
    Write-Warning "Сборка без подписи: SmartScreen будет предупреждать при установке (см. -Thumbprint)"
    & cargo tauri build
  }
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build упал" }
} finally { Pop-Location }

Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\nsis") -Filter *.exe |
  ForEach-Object { Write-Host "готово: $($_.FullName)" }
