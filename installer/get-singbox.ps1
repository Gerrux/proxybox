# Кладёт sing-box для Windows в src-tauri\binaries\ — туда, где его ждут и
# сборка установщика, и служба при разработке. Вместе с бинарником забирается
# LICENSE: sing-box под GPL-3.0, распространять его без текста лицензии нельзя.
#
#   pwsh installer\get-singbox.ps1 [-Arch amd64|arm64] [-Version 1.13.19]
param(
  [ValidateSet("amd64", "arm64")] [string]$Arch = "amd64",
  [string]$Version = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

if (-not $Version) {
  $latest = Invoke-RestMethod "https://api.github.com/repos/SagerNet/sing-box/releases/latest"
  $Version = $latest.tag_name.TrimStart("v")
}
$name = "sing-box-$Version-windows-$Arch"
$url  = "https://github.com/SagerNet/sing-box/releases/download/v$Version/$name.zip"
$tmp  = Join-Path $env:TEMP "pg-singbox"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "Скачиваю $url"
$zip = Join-Path $tmp "$name.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $tmp -Force

Copy-Item (Join-Path $tmp "$name\sing-box.exe") (Join-Path $bin "sing-box.exe") -Force
Copy-Item (Join-Path $tmp "$name\LICENSE")      (Join-Path $bin "LICENSE-sing-box.txt") -Force
Remove-Item $tmp -Recurse -Force

Write-Host "Готово: $bin\sing-box.exe (v$Version)"
