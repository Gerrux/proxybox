# Собирает закреплённый sing-box и кладёт его вместе с лицензией в binaries.
param(
  [ValidateSet("amd64", "arm64")] [string]$Arch = "amd64"
)
$ErrorActionPreference = "Stop"
$pin = Get-Content (Join-Path $PSScriptRoot "sing-box.env") -Raw | ConvertFrom-StringData
$version = $pin.SING_BOX_VERSION.TrimStart("v")
$module = "github.com/sagernet/sing-box"
$bin = Join-Path (Split-Path -Parent $PSScriptRoot) "src-tauri\binaries"
$exe = Join-Path $bin "sing-box.exe"
$license = Join-Path $bin "LICENSE-sing-box.txt"

if ((Test-Path $exe) -and (Test-Path $license)) {
  $info = & $exe version 2>$null
  if ($LASTEXITCODE -eq 0 -and $info -contains "sing-box version $version" -and
      ($info -match "windows/$Arch$")) { return }
}

$source = & go mod download -json "$module@$($pin.SING_BOX_VERSION)" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $source.Dir) { throw "Не удалось получить исходники $module@$version" }

New-Item -ItemType Directory -Force -Path $bin | Out-Null
$staged = Join-Path $bin "sing-box-$([guid]::NewGuid()).exe"
$savedGOOS = $env:GOOS
$savedGOARCH = $env:GOARCH
$savedCGO = $env:CGO_ENABLED
Push-Location -LiteralPath $source.Dir
try {
  $env:GOOS = "windows"
  $env:GOARCH = $Arch
  $env:CGO_ENABLED = "0"
  & go build -mod=readonly -trimpath -tags $pin.SING_BOX_TAGS -ldflags "-X $module/constant.Version=$version" -o $staged ./cmd/sing-box
  if ($LASTEXITCODE -ne 0) { throw "Сборка sing-box завершилась с кодом $LASTEXITCODE" }
  Copy-Item (Join-Path $source.Dir "LICENSE") $license -Force
  Move-Item -LiteralPath $staged -Destination $exe -Force
} finally {
  Pop-Location
  $env:GOOS = $savedGOOS
  $env:GOARCH = $savedGOARCH
  $env:CGO_ENABLED = $savedCGO
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
}
