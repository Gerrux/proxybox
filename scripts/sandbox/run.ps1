<#
  Стенд proxybox в Windows Sandbox: хост-часть.

  Собирает службу и клиента, кладёт в каталог-«витрину» (target\sandbox\stage)
  вместе с sing-box и скриптами, пишет .wsb с абсолютными путями и запускает
  Windows Sandbox. Всё остальное — установка службы, свой узел, проверки — делает
  в песочнице setup.ps1. Живая служба proxybox на этой машине не затрагивается:
  песочница — отдельная система с собственным SCM и собственным брандмауэром.

      powershell -ExecutionPolicy Bypass -File scripts\sandbox\run.ps1 [-NoLaunch] [-SkipBuild] [-NoTun] [-NoChecks]

  -NoLaunch   собрать витрину и сгенерировать .wsb, но Sandbox не запускать
  -SkipBuild  не звать cargo: взять то, что уже лежит в target\release
  -NoTun      PG_TUN=0 в песочнице: проверяется только замок, без туннеля
  -NoChecks   после установки проверки не запускать (их можно позвать руками:
              C:\pb-run\check.ps1)

  Файл обязан лежать в UTF-8 С BOM: Windows PowerShell 5.1 без него читает
  кириллицу как ANSI (см. scripts\cpu.ps1).
#>
[CmdletBinding()]
param(
    [switch]$NoLaunch,
    [switch]$SkipBuild,
    [switch]$NoTun,
    [switch]$NoChecks
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"

$root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sbx     = Join-Path $root "target\sandbox"
$stage   = Join-Path $sbx "stage"
$out     = Join-Path $sbx "out"
$cache   = Join-Path $sbx "cache"
$release = Join-Path $(if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root "target" }) "release"

# --- 1. Сборка ---------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host "== cargo build --release -p pg-service -p pg-cli"
    Push-Location $root
    try {
        cargo build --release -p pg-service -p pg-cli
        if ($LASTEXITCODE -ne 0) { throw "cargo build завершился с кодом $LASTEXITCODE" }
    } finally { Pop-Location }
}
# Клиент называется proxybox.exe ([[bin]] в crates/pg-cli/Cargo.toml), а не pg-cli.exe.
$bins = @{ "pg-service.exe" = Join-Path $release "pg-service.exe"; "proxybox.exe" = Join-Path $release "proxybox.exe" }
foreach ($k in $bins.Keys) {
    if (-not (Test-Path $bins[$k])) { throw "нет $($bins[$k]) — соберите без -SkipBuild" }
}

# --- 2. sing-box -------------------------------------------------------------
# Порядок: PG_SINGBOX с хоста -> кэш стенда -> скачать ту версию, что закреплена
# в installer\get-singbox.ps1 (версию берём оттуда же регуляркой, чтобы стенд и
# установщик не разошлись). Сам get-singbox.ps1 не зовём: он пишет в
# src-tauri\binaries, то есть в репозиторий.
New-Item -ItemType Directory -Force -Path $stage, $out, $cache | Out-Null
$singbox = $null
if ($env:PG_SINGBOX -and (Test-Path $env:PG_SINGBOX)) {
    $singbox = (Resolve-Path $env:PG_SINGBOX).Path
    Write-Host "== sing-box из PG_SINGBOX: $singbox"
} else {
    $pin = Get-Content (Join-Path $root "installer\get-singbox.ps1") -Raw -Encoding UTF8
    if ($pin -notmatch '\[string\]\$Version\s*=\s*"([^"]+)"') { throw "не нашёл закреплённую версию в installer\get-singbox.ps1" }
    $ver = $Matches[1]
    $singbox = Join-Path $cache "sing-box-$ver.exe"
    if (-not (Test-Path $singbox)) {
        $name = "sing-box-$ver-windows-amd64"
        $url  = "https://github.com/SagerNet/sing-box/releases/download/v$ver/$name.zip"
        $tmp  = Join-Path $cache "dl"
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        Write-Host "== скачиваю $url"
        Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "$name.zip")
        Expand-Archive -Path (Join-Path $tmp "$name.zip") -DestinationPath $tmp -Force
        Copy-Item (Join-Path $tmp "$name\sing-box.exe") $singbox -Force
        Remove-Item $tmp -Recurse -Force
    } else {
        Write-Host "== sing-box $ver из кэша: $singbox"
    }
}

# --- 3. Витрина --------------------------------------------------------------
Get-ChildItem $stage -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Copy-Item $bins["pg-service.exe"] (Join-Path $stage "pg-service.exe")
Copy-Item $bins["proxybox.exe"]   (Join-Path $stage "proxybox.exe")
Copy-Item $singbox                (Join-Path $stage "sing-box.exe")
# Бинарники собраны с динамическим CRT, а в чистом образе песочницы VC++ runtime
# нет: без этих DLL рядом служба не стартует вовсе, и стенд падает раньше
# первой проверки. Берём их с хоста — версия та же, с которой собирали.
foreach ($dll in "vcruntime140.dll", "vcruntime140_1.dll") {
    $src = Join-Path $env:SystemRoot "System32\$dll"
    if (Test-Path $src) { Copy-Item $src (Join-Path $stage $dll) }
}
Copy-Item (Join-Path $PSScriptRoot "setup.ps1") $stage
Copy-Item (Join-Path $PSScriptRoot "check.ps1") $stage
Write-Host "== витрина: $stage"

# --- 4. .wsb -----------------------------------------------------------------
$esc = { param($s) [Security.SecurityElement]::Escape($s) }
$argList = "-NoExit -ExecutionPolicy Bypass -File C:\pb\setup.ps1"
if ($NoTun)    { $argList += " -NoTun" }
if ($NoChecks) { $argList += " -SkipChecks" }
$tpl = Get-Content (Join-Path $PSScriptRoot "proxybox.wsb.template") -Raw -Encoding UTF8
$wsb = $tpl.Replace("{{STAGE}}", (& $esc $stage)).Replace("{{OUT}}", (& $esc $out)).Replace("{{ARGS}}", (& $esc $argList))
$wsbPath = Join-Path $sbx "proxybox.wsb"
[IO.File]::WriteAllText($wsbPath, $wsb, (New-Object Text.UTF8Encoding($false)))
Write-Host "== сгенерирован $wsbPath"

if ($NoLaunch) {
    Write-Host "== -NoLaunch: Windows Sandbox не запускаю"
    return
}

# --- 5. Запуск ---------------------------------------------------------------
# Sandbox бывает один на хост: второй запуск молча сворачивается в окно первого,
# а старый .wsb при этом остаётся в силе.
if (Get-Process -Name WindowsSandbox, WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue) {
    throw "Windows Sandbox уже запущена: закройте её окно и повторите"
}
Write-Host "== запускаю Windows Sandbox. Журнал: внутри — Desktop\proxybox-sandbox.log, на хосте — $out"
# Песочница из Store (Windows 11 24H2 и новее) команду входа из .wsb не
# выполняет — проверено: рабочий стол пустой, журнала нет. У неё зато есть
# CLI `wsb`: им поднимаем среду без команды входа и запускаем установку сами,
# от System. Окно просмотра при этом не нужно, а его обрыв (0x80072746) среду
# не гасит. Старый WindowsSandbox.exe — запасной путь, там команда входа живая.
$cli = Get-Command wsb -ErrorAction SilentlyContinue
if ($cli) {
    $cfg = ($wsb -replace '(?s)<!--.*?-->', '' -replace '(?s)<LogonCommand>.*?</LogonCommand>', '')
    $cfg = ($cfg -replace "`r?`n", ' ') -replace '\s{2,}', ' '
    $id = ((& wsb start --config $cfg --raw | Out-String) | ConvertFrom-Json).Id
    if (-not $id) { throw "wsb start не вернул идентификатор среды" }
    Write-Host "== среда $id; жду загрузки"
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        & wsb exec --id $id -r System -c "cmd /c exit 0" *> $null
        if ($LASTEXITCODE -eq 0) { $up = $true } else { Start-Sleep -Seconds 5 }
    }
    if (-not $up) { throw "среда $id не ответила за 5 минут" }
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\pb\setup.ps1"
    if ($NoTun)    { $cmd += " -NoTun" }
    if ($NoChecks) { $cmd += " -SkipChecks" }
    Write-Host "== выполняю setup.ps1 в среде; ход — в $out\proxybox-sandbox.log"
    & wsb exec --id $id -r System -c $cmd
    Write-Host "== готово. Среда остаётся: wsb stop --id $id"
    return
}
$exe = Join-Path $env:SystemRoot "System32\WindowsSandbox.exe"
if (-not (Test-Path $exe)) { throw "нет $exe — включите компонент Windows Sandbox" }
Start-Process -FilePath $exe -ArgumentList "`"$wsbPath`""
