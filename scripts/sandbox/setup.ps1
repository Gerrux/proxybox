<#
  Стенд proxybox в Windows Sandbox: установка внутри песочницы.

  Запускается LogonCommand'ом из .wsb под WDAGUtilityAccount (администратор).
  Делает всё, что на живой машине делает установщик, и заводит узел:

    1. копирует бинарники из C:\pb (только чтение) в C:\pb-run;
    2. поднимает второй sing-box как обычный SOCKS5-сервер с direct-выходом —
       это «узел». Тот же sing-box.exe по тому же пути, что и у службы, поэтому
       стена пропускает его по идентификатору приложения и ему есть куда выйти
       под замком;
    3. собирает окружение (PG_PROBE и прочее): значением Environment самой
       службы в реестре, а для клиента ещё и на уровне машины;
    4. `pg-service install`, запись Environment, перезапуск службы, импорт узла;
    5. запускает check.ps1 (если не -SkipChecks).

  Узел слушает на адресе сетевой карты песочницы, а не на 127.0.0.1, и это не
  прихоть. Под живым TUN sing-box службы привязывает исходящие к физическому
  интерфейсу (auto_detect_interface), и петлевой узел становится недостижим:
  `cannot assign requested address` (см. шапку scripts/e2e.sh). Сам узел по той
  же причине ходит наружу с auto_detect_interface: иначе его трафик ушёл бы в
  TUN и вернулся к нему же.

  Журнал: C:\Users\WDAGUtilityAccount\Desktop\proxybox-sandbox.log (и копия в
  C:\pb-out, то есть на хост, в target\sandbox\out).

  Файл обязан лежать в UTF-8 С BOM (см. scripts\cpu.ps1).
#>
[CmdletBinding()]
param(
    [switch]$NoTun,
    [switch]$SkipChecks
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Log = "C:\Users\WDAGUtilityAccount\Desktop\proxybox-sandbox.log"
$Src = "C:\pb"
$Run = "C:\pb-run"
function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m
    Write-Host $line
    Add-Content -Path $Log -Value $line -Encoding UTF8
    # Копия на хост — каждой строкой, а не в конце: среду без окна видно
    # только через этот файл, и зависшая установка иначе не оставляла бы ничего.
    if (Test-Path "C:\pb-out") { Add-Content -Path "C:\pb-out\proxybox-sandbox.live.log" -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue }
}
function Save-Log { if (Test-Path "C:\pb-out") { Copy-Item $Log "C:\pb-out\proxybox-sandbox.log" -Force -ErrorAction SilentlyContinue } }

try {
    Say "== proxybox sandbox: установка"
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { throw "нужен администратор (служба, брандмауэр, TUN)" }

    # --- 1. Бинарники ---
    New-Item -ItemType Directory -Force -Path $Run | Out-Null
    foreach ($f in "pg-service.exe", "proxybox.exe", "sing-box.exe", "check.ps1") {
        Copy-Item (Join-Path $Src $f) (Join-Path $Run $f) -Force
    }
    # VC++ runtime рядом с бинарниками: в чистом образе его нет (см. run.ps1).
    foreach ($f in "vcruntime140.dll", "vcruntime140_1.dll") {
        if (Test-Path (Join-Path $Src $f)) { Copy-Item (Join-Path $Src $f) (Join-Path $Run $f) -Force }
    }
    $svc = Join-Path $Run "pg-service.exe"
    $cli = Join-Path $Run "proxybox.exe"
    $sb  = Join-Path $Run "sing-box.exe"
    Say "бинарники скопированы в $Run"

    # --- 2. Узел: SOCKS5 на адресе сетевой карты ---
    $ip = "127.0.0.1"
    try {
        $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1
        $addr = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1
        if ($addr) { $ip = $addr.IPAddress }
    } catch { }
    if ($ip -eq "127.0.0.1") {
        Say "ПРЕДУПРЕЖДЕНИЕ: адрес сетевой карты не найден, узел на 127.0.0.1 — с TUN он будет недостижим; запускайте с -NoTun"
    }
    $nodeCfg = @{
        log       = @{ level = "info" }
        inbounds  = @(@{ type = "socks"; tag = "in"; listen = $ip; listen_port = 1080 })
        outbounds = @(@{ type = "direct"; tag = "direct" })
        route     = @{ auto_detect_interface = $true; final = "direct" }
    } | ConvertTo-Json -Depth 6
    $nodeFile = Join-Path $Run "node.json"
    [IO.File]::WriteAllText($nodeFile, $nodeCfg, (New-Object Text.UTF8Encoding($false)))
    & $sb check -c $nodeFile
    if ($LASTEXITCODE -ne 0) { throw "sing-box check отверг конфиг узла" }
    Start-Process -FilePath $sb -ArgumentList @("run", "-c", $nodeFile) -WindowStyle Hidden `
        -RedirectStandardError (Join-Path $Run "node.err.log") -RedirectStandardOutput (Join-Path $Run "node.out.log")
    Start-Sleep -Seconds 2
    # Первые запросы сразу после загрузки среды бывают неудачными (curl 28/35),
    # следующие проходят — проверено на живой песочнице. Отказ узла — это
    # отказ пяти попыток подряд, а не первой.
    for ($try = 0; $try -lt 5; $try++) {
        & curl.exe -s -o NUL -m 10 --socks5 "${ip}:1080" https://1.1.1.1
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 3
    }
    if ($LASTEXITCODE -ne 0) { throw "узел socks5://${ip}:1080 не пропускает наружу (curl код $LASTEXITCODE); см. $Run\node.err.log" }
    Say "узел socks5://${ip}:1080 работает"

    # --- 3. Окружение службы (читается при её старте) ---
    $envs = [ordered]@{
        PG_SINGBOX = $sb          # тот же путь, что у узла: по нему стена пропускает sing-box
        PG_PROBE   = "1.1.1.1:443"
        PG_GEO     = "0"          # без запросов страны к стороннему сервису
        PG_REFRESH = "0"
        PG_LANG    = "ru"         # проверки разбирают русский вывод клиента
    }
    if ($NoTun) { $envs["PG_TUN"] = "0" }
    # Переменные уровня машины служба не увидит до перезагрузки: SCM даёт ей
    # окружение, снятое при старте самого SCM. Они нужны клиенту (PG_LANG), а
    # службе окружение задаётся её собственным значением Environment.
    foreach ($k in $envs.Keys) { [Environment]::SetEnvironmentVariable($k, $envs[$k], "Machine") }
    Say ("окружение службы: " + (($envs.Keys | ForEach-Object { "$_=$($envs[$_])" }) -join " "))

    # --- 4. Служба ---
    # `install` сам запускает службу, поэтому окружение она получит только с
    # перезапуском: Environment (REG_MULTI_SZ, строки KEY=VALUE) читается SCM в
    # момент старта.
    & $svc install
    if ($LASTEXITCODE -ne 0) { throw "pg-service install завершился с кодом $LASTEXITCODE" }
    Stop-Service proxybox -Force -ErrorAction SilentlyContinue
    (Get-Service proxybox).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    $envLines = [string[]]@($envs.Keys | ForEach-Object { "$_=$($envs[$_])" })
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\proxybox" -Name Environment -Value $envLines -Type MultiString
    Say "Environment службы записан в реестр"
    Start-Service proxybox
    $env:PG_LANG = "ru"
    $ready = $false
    # Готова — значит канал отвечает. Код выхода клиента тут не годится: на
    # перезапуске службы он успевал выйти нулём, а следующая команда уже не
    # находила канал (os error 2) — проверено на живой песочнице.
    for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
        # try: под $ErrorActionPreference = Stop Windows PowerShell 5.1 превращает
        # stderr клиента при 2>&1 в исключение.
        try { $st = (& $cli status 2>&1 | Out-String) } catch { $st = "недоступна: $($_.Exception.Message)" }
        if ($LASTEXITCODE -eq 0 -and $st -notmatch "os error|недоступна") { $ready = $true } else { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "служба не ответила за 30 с" }
    Say "служба proxybox запущена"

    & $cli lang ru | Out-Null
    $r = & $cli add-profile --link "socks5://${ip}:1080#node" 2>&1 | Out-String
    Say "импорт узла: $($r.Trim())"
    Say ("профили: " + ((& $cli profiles 2>&1 | Out-String).Trim()))
    Say "== установка завершена"
    Save-Log

    # --- 5. Проверки ---
    if ($SkipChecks) {
        Say "проверки отключены (-SkipChecks). Вручную: powershell -ExecutionPolicy Bypass -File $Run\check.ps1"
    } else {
        $chk = @("-ExecutionPolicy", "Bypass", "-File", (Join-Path $Run "check.ps1"))
        if ($NoTun) { $chk += "-NoTun" }
        & powershell.exe @chk
    }
} catch {
    Say "ОШИБКА УСТАНОВКИ: $($_.Exception.Message)"
    Say $_.ScriptStackTrace
} finally {
    Save-Log
}
