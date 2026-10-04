<#
  Стенд proxybox в Windows Sandbox: приёмочные проверки.

  Запускается внутри песочницы (setup.ps1 зовёт его сам; руками —
  powershell -ExecutionPolicy Bypass -File C:\pb-run\check.ps1). НА ХОСТЕ НЕ
  ЗАПУСКАТЬ: скрипт ставит правила брандмауэра, убивает процессы и в конце
  удаляет службу.

  Каждая проверка печатает ПРОЙДЕНО / ПРОВАЛ / ПРОПУСК и причину одной строкой.
  Ключевая — «б»: сторонее разрешающее правило обязано не открывать замок. Под
  старой сборкой на netsh она проваливается (любое включённое разрешающее
  правило перекрывает blockoutbound) — это и есть ошибка, ради которой
  брандмауэр переписан на WFP.

  -NoTun    служба стартовала с PG_TUN=0: проверки, которым нужен живой туннель
            (положительные «curl работает», фоновая петля, охват «весь
            компьютер»), пропускаются; остаются те, что про замок.

  Файл обязан лежать в UTF-8 С BOM (см. scripts\cpu.ps1).
#>
[CmdletBinding()]
param(
    [switch]$NoTun,
    [int]$Apps = 10,
    [switch]$SkipCrashCheck
)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:PG_LANG = "ru"

$Log  = "C:\Users\WDAGUtilityAccount\Desktop\proxybox-sandbox.log"
$Run  = "C:\pb-run"
$Cli  = Join-Path $Run "proxybox.exe"
$Svc  = Join-Path $Run "pg-service.exe"
$Curl = "$env:SystemRoot\System32\curl.exe"          # «выбранное» приложение
$Other = Join-Path $Run "other\curl-other.exe"       # копия curl по другому пути — «невыбранное»
$PidFile  = Join-Path $env:ProgramData "proxybox\singbox.pid"
$Node = "node"
$script:Results = New-Object System.Collections.ArrayList

function Say($m) {
    Write-Host $m
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m
    Add-Content -Path $Log -Value $line -Encoding UTF8
    # Копия на хост каждой строкой: среду без окна видно только через этот
    # файл, а ранний выход иначе не оставлял бы следа вовсе.
    if (Test-Path "C:\pb-out") { Add-Content -Path "C:\pb-out\check.live.log" -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue }
}
function Report($id, $title, $status, $why) {
    [void]$script:Results.Add([pscustomobject]@{ Id = $id; Status = $status })
    $color = switch ($status) { "ПРОЙДЕНО" { "Green" } "ПРОВАЛ" { "Red" } default { "Yellow" } }
    $line = "[{0}] {1}: {2} — {3}" -f $id, $title, $status, $why
    Write-Host $line -ForegroundColor $color
    $stamped = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $line
    Add-Content -Path $Log -Value $stamped -Encoding UTF8
    if (Test-Path "C:\pb-out") { Add-Content -Path "C:\pb-out\check.live.log" -Value $stamped -Encoding UTF8 -ErrorAction SilentlyContinue }
}
function Verdict($id, $title, $ok, $whyOk, $whyBad) {
    if ($ok) { Report $id $title "ПРОЙДЕНО" $whyOk } else { Report $id $title "ПРОВАЛ" $whyBad }
}
function Skip($id, $title, $why) { Report $id $title "ПРОПУСК" $why }

# --- Инструменты -------------------------------------------------------------
# `cli` — встроенный псевдоним Clear-Item, а псевдоним в PowerShell сильнее
# функции: без снятия «Cli status» звал Clear-Item C:\Windows\System32\status, и
# проверки выходили на первом же статусе со словами «служба не отвечает».
Remove-Item Alias:cli -Force -ErrorAction SilentlyContinue
function Cli { & $Cli @args 2>&1 | Out-String }

# Off / Connecting / Up / Down / NoService — по строке «туннель:» вывода status.
function Get-State {
    $o = Cli status
    if ($LASTEXITCODE -ne 0) { return "NoService" }
    if ($o -match 'туннель:\s+(\S+)') {
        switch ($Matches[1]) {
            "выключен"    { return "Off" }
            "подключение" { return "Connecting" }
            "поднят,"     { return "Up" }
            "поднят"      { return "Up" }
            "недоступен"  { return "Down" }
        }
    }
    return "Unknown"
}
# Ждёт состояние; возвращает мс или -1 по таймауту.
function Wait-State($want, $limitMs = 45000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $limitMs) {
        if ((Get-State) -eq $want) { return [int]$sw.ElapsedMilliseconds }
        Start-Sleep -Milliseconds 50
    }
    return -1
}
# Достучался ли exe до внешнего адреса: любой ответ сервера — успех, важен только дозвон.
# Три попытки, а не одна: трафик песочницы идёт через хост, и если на хосте
# поднят свой туннель, без всякой стены теряется примерно каждый пятый запрос
# (замерено: 1 отказ из 5 при нуле наших фильтров). Одна попытка делала бы из
# этой потери «стена осталась», три — нет; «закрыто» требует трёх отказов.
function Reaches($exe) {
    for ($t = 0; $t -lt 3; $t++) {
        & $exe -s -o NUL -m 6 --connect-timeout 5 https://1.1.1.1 *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    return $false
}
# То же по имени: имя разрешает svchost (dnscache) по UDP/53, и под замком это
# работает только благодаря узкому пропуску с адреса туннеля.
function Reaches-Host($exe) {
    for ($t = 0; $t -lt 3; $t++) {
        & $exe -s -o NUL -m 8 --connect-timeout 6 https://one.one.one.one *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    return $false
}
# Журнал службы читаем с диска: клиент его не печатает целиком. Только UTF-8.
function Journal-Text {
    $f = Join-Path $env:ProgramData "proxybox\journal.json"
    if (-not (Test-Path $f)) { return "" }
    return (Get-Content $f -Raw -Encoding UTF8)
}
function Journal-Count($needle) {
    return ([regex]::Matches((Journal-Text), [regex]::Escape($needle))).Count
}
function Reaches-PowerShell {
    # TLS 1.2 явно: Windows PowerShell 5.1 по умолчанию его не предлагает, и
    # без этого powershell «закрыт» и при выключенном режиме — то есть а3
    # проходил бы не благодаря стене, а е2 проваливался бы без неё.
    for ($t = 0; $t -lt 3; $t++) {
        & powershell.exe -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest https://1.1.1.1 -UseBasicParsing -TimeoutSec 6 | Out-Null; exit 0 } catch { exit 1 }" *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    return $false
}
function Timed($block) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $block | Out-Null
    return [int]$sw.ElapsedMilliseconds
}
function Policy-Snapshot {
    (Get-NetFirewallProfile | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Name, $_.DefaultOutboundAction }) -join "; "
}
function Tunnel-On($scope) {
    Cli scope $scope | Out-Null
    Cli on --profile $Node | Out-Null
    return (Wait-State "Up")
}
function Tunnel-Off {
    Cli off | Out-Null
    [void](Wait-State "Off" 15000)
}
function Kill-Tunnel {
    if (-not (Test-Path $PidFile)) { return $false }
    $p = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($p -notmatch '^\d+$') { return $false }
    Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
    return $true
}

# --- Подготовка --------------------------------------------------------------
Say "== proxybox sandbox: проверки (NoTun=$($NoTun.IsPresent))"
$PolicyBefore = Policy-Snapshot
Say "политика исходящего до начала: $PolicyBefore"

$state = "NoService"
for ($i = 0; $i -lt 30 -and $state -eq "NoService"; $i++) {
    $state = Get-State
    if ($state -eq "NoService") { Start-Sleep -Seconds 1 }
}
if ($state -eq "NoService") {
    Say ("статус клиента: код $LASTEXITCODE; " + ((Cli status).Trim() -replace "`r?`n", " | "))
    Say "ОШИБКА: служба не отвечает — проверять нечего (см. журнал setup.ps1)"
    return
}
New-Item -ItemType Directory -Force -Path (Join-Path $Run "other"), (Join-Path $Run "apps") | Out-Null
Copy-Item $Curl $Other -Force
Cli lang ru | Out-Null
if ((Cli profiles) -notmatch $Node) { Say "ОШИБКА: профиль «$Node» не заведён (см. журнал setup.ps1)"; return }

# curl — единственное выбранное приложение. add-app + enable: что делает add-app
# с флагом, из справки не следует, поэтому включаем явно.
Cli add-app --path $Curl | Out-Null
Cli enable --path $Curl | Out-Null

# --- а. Белый список: выбранное работает, невыбранное — нет -------------------
$up = Tunnel-On "whitelist"
if ($up -lt 0) {
    Say "туннель не поднялся за 45 с — состояние: $(Get-State). Журнал службы: $((Cli status))"
    if (-not $NoTun) { Say "Если TUN не заводится в песочнице — перезапустите стенд с -NoTun." }
}
if ($NoTun) { Skip "а1" "Белый список: curl выбранный работает" "-NoTun: туннеля нет, положительную сторону проверять нечем" }
else { Verdict "а1" "Белый список: выбранный curl.exe работает" (Reaches $Curl) "curl.exe дошёл до 1.1.1.1" "curl.exe выбран, а до 1.1.1.1 не дошёл" }
Verdict "а2" "Белый список: копия curl по другому пути закрыта" (-not (Reaches $Other)) "невыбранный exe отбит" "невыбранный exe достучался наружу — замок не держит"
Verdict "а3" "Белый список: powershell (Invoke-WebRequest) закрыт" (-not (Reaches-PowerShell)) "powershell.exe отбит" "powershell.exe достучался наружу — замок не держит"

# Имена: выбранному их разрешает svchost по UDP/53 через пропуск, привязанный к
# адресу туннеля; невыбранному не должно хватать ни имени, ни адреса.
if ($NoTun) { Skip "а4" "Белый список: выбранный curl.exe разрешает имя" "-NoTun: туннеля нет" }
else { Verdict "а4" "Белый список: выбранный curl.exe разрешает имя" (Reaches-Host $Curl) "https://one.one.one.one открылся (щель svchost UDP/53 работает)" "выбранный curl.exe не достучался по имени — щель для DNS не работает" }
Verdict "а5" "Белый список: невыбранный exe по имени закрыт" (-not (Reaches-Host $Other)) "копия curl по имени отбита" "невыбранный exe достучался по имени — щель шире DNS"

# DHCP под замком: аренда обязана обновляться, иначе машина теряет адрес.
$renew = (& ipconfig.exe /renew 2>&1 | Out-String)
$renewCode = $LASTEXITCODE
Verdict "а6" "Под замком обновляется аренда DHCP (ipconfig /renew)" (($renewCode -eq 0) -and ($renew -notmatch '(?i)error|unable|ошибк|не удалось|не может')) `
    "ipconfig /renew прошёл" "ipconfig /renew не прошёл (код $renewCode): $($renew.Trim() -replace '\s+', ' ')"

# --- а-б. Пути выбранных приложений ------------------------------------------------
# Путь с прямыми слэшами обязан получить пропуск наравне с обычным: стена сводит
# написания к одному. Несуществующий путь не имеет права уронить стену:
# остальные выбранные продолжают работать, а журнал не засоряется повтором.
$slashDir = Join-Path $Run "slash"
New-Item -ItemType Directory -Force -Path $slashDir | Out-Null
$slashExe = Join-Path $slashDir "curl-slash.exe"
Copy-Item $Curl $slashExe -Force
$slashPath = $slashExe -replace '\\', '/'
Cli add-app --path $slashPath | Out-Null
Cli enable --path $slashPath | Out-Null
$ghost = "Z:\no\such\dir\ghost.exe"
Cli add-app --path $ghost | Out-Null
Cli enable --path $ghost | Out-Null
Start-Sleep -Seconds 4   # круг надзора переставляет стену не сразу
if ($NoTun) {
    Skip "а7" "Путь с прямыми слэшами получает пропуск" "-NoTun: туннеля нет"
    Skip "а8" "Несуществующий путь не роняет стену" "-NoTun: туннеля нет"
} else {
    Verdict "а7" "Путь с прямыми слэшами получает пропуск" (Reaches $slashExe) "curl по пути «$slashPath» дошёл до 1.1.1.1" "выбранный по пути с «/» curl не дошёл — пропуск не выдан"
    $refusals = Journal-Count "пропуск не выдан"
    $stillClosed = -not (Reaches $Other)
    Verdict "а8" "Несуществующий путь не роняет стену" ((Reaches $Curl) -and $stillClosed -and $refusals -le 1) `
        "соседний выбранный работает, невыбранный закрыт; строк «пропуск не выдан» в журнале: $refusals (несуществующий файл стена пропускает молча, строка бывает только у существующего, но отвергнутого WFP)" `
        "стена пострадала или журнал засорён: невыбранный закрыт=$stillClosed, строк «пропуск не выдан»=$refusals (ожидалось не больше одной)"
}

# --- б. Чужое разрешающее правило не открывает замок ---------------------------
$ruleName = "pb-sandbox-foreign-allow"
try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Allow -Program $Other -Profile Any | Out-Null
    Start-Sleep -Milliseconds 500
    Verdict "б" "Чужое разрешающее правило не открывает замок" (-not (Reaches $Other)) `
        "правило Allow на невыбранный exe есть, а наружу он не вышел (стена WFP старше брандмауэра)" `
        "ПРОВАЛ ожидаем на старой сборке (netsh): чужое Allow перекрывает blockoutbound; на WFP-сборке это ошибка"
} finally {
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
}

# --- в. Fail-closed: смерть туннельного sing-box --------------------------------
if (Kill-Tunnel) {
    $closed = -not (Reaches $Curl)
    Verdict "в1" "Fail-closed: sing-box убит — выбранный curl закрыт" $closed "сеть выбранному оборвана сразу после смерти sing-box" "выбранный curl остался с сетью после смерти sing-box"
    # Сперва дождаться, что служба смерть заметила: сразу после убийства статус
    # ещё прежний Up (наблюдатель ходит раз в DEATH_EVERY), и ждать Up без этого —
    # значит прочитать старое состояние («снова Up через 7 мс» в первом прогоне).
    [void](Wait-State "Down" 5000)
    $rec = Wait-State "Up" 60000
    if ($rec -ge 0) {
        Report "в2" "Служба перезапустила туннель" "ПРОЙДЕНО" "снова Up через $rec мс после того, как смерть замечена"
        # Первые запросы через свежий узел бывают неудачными: трафик песочницы
        # идёт через хост, а на хосте может стоять свой туннель. Ждём до 15 с.
        $back = $false; $sw3 = [Diagnostics.Stopwatch]::StartNew()
        while (-not $NoTun -and -not $back -and $sw3.ElapsedMilliseconds -lt 15000) { $back = Reaches $Curl }
        if (-not $NoTun) { Verdict "в3" "После перезапуска выбранный curl снова работает" $back "доступ вернулся через $([int]$sw3.ElapsedMilliseconds) мс" "туннель Up, а curl не дошёл за 15 с" }
    } else {
        Report "в2" "Служба перезапустила туннель" "ПРОВАЛ" "за 60 с туннель не вернулся в Up (состояние: $(Get-State))"
    }
} else {
    Report "в1" "Fail-closed" "ПРОВАЛ" "не нашёл $PidFile — туннельный sing-box не запущен (туннель не поднялся?)"
}

# --- г. Быстрый выбор нескольких приложений ------------------------------------
# Отсчёт: время каждой команды клиента (включая запуск самого процесса клиента,
# ~десятки мс). Параллельно петля curl по уже выбранному — не должна ни разу
# упасть: правка списка не имеет права оставлять выбранных без сети.
if ((Get-State) -ne "Up") { [void](Wait-State "Up" 30000) }
$flag = Join-Path $Run "loop.run"
Set-Content $flag "1"
$job = $null
if (-not $NoTun) {
    $job = Start-Job -ArgumentList $Curl, $flag -ScriptBlock {
        param($curl, $flag)
        $ok = 0; $bad = 0
        while (Test-Path $flag) {
            & $curl -s -o NUL -m 6 --connect-timeout 5 https://1.1.1.1 *> $null
            if ($LASTEXITCODE -eq 0) { $ok++ } else { $bad++ }
            Start-Sleep -Milliseconds 100
        }
        [pscustomobject]@{ Ok = $ok; Bad = $bad }
    }
    Start-Sleep -Seconds 1
}
$addMs = @(); $enMs = @()
for ($i = 1; $i -le $Apps; $i++) {
    $p = Join-Path $Run "apps\app$i.exe"
    Copy-Item $Curl $p -Force
    $addMs += Timed { Cli add-app --path $p }
    $enMs  += Timed { Cli enable --path $p }
}
Start-Sleep -Seconds 1
Remove-Item $flag -Force
$loop = $null
if ($job) { $loop = Receive-Job $job -Wait -AutoRemoveJob }
$addAvg = [int](($addMs | Measure-Object -Average).Average); $addMax = ($addMs | Measure-Object -Maximum).Maximum
$enAvg  = [int](($enMs  | Measure-Object -Average).Average); $enMax  = ($enMs  | Measure-Object -Maximum).Maximum
Say ("г: add-app мс: " + ($addMs -join " ") + " | enable мс: " + ($enMs -join " "))
$fast = ($enMax -lt 1000) -and ($addMax -lt 1000)
$failures = if ($loop) { [int]$loop.Bad } else { 0 }
$loopNote = if ($loop) { "петля curl: $($loop.Ok) удач / $($loop.Bad) отказов" } else { "петля curl пропущена (-NoTun)" }
Verdict "г" "Быстрый выбор $Apps приложений" ($fast -and $failures -eq 0) `
    "add-app среднее $addAvg мс (макс $addMax), enable среднее $enAvg мс (макс $enMax); $loopNote" `
    "add-app среднее $addAvg мс (макс $addMax), enable среднее $enAvg мс (макс $enMax); $loopNote; порог: <1000 мс и 0 отказов (ожидаются миллисекунды, не секунды)"

# --- д. Время включения ---------------------------------------------------------
Tunnel-Off
Cli scope whitelist | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()
Cli on --profile $Node | Out-Null
$onMs = [int]$sw.ElapsedMilliseconds
$upMs = Wait-State "Up" 45000
$totalMs = [int]$sw.ElapsedMilliseconds
if ($upMs -ge 0) {
    $first = ""
    if (-not $NoTun) {
        while ($sw.ElapsedMilliseconds -lt 30000 -and -not (Reaches $Curl)) { Start-Sleep -Milliseconds 100 }
        $first = "; до первого успешного curl $([int]$sw.ElapsedMilliseconds) мс"
    }
    Report "д" "Время включения" "ПРОЙДЕНО" "команда on вернулась за $onMs мс, статус Up через $totalMs мс от команды$first"
} else {
    Report "д" "Время включения" "ПРОВАЛ" "Up не наступил за 45 с (состояние: $(Get-State))"
}

# --- е. Приватный режим выключен: всё работает, политика машины цела -------------
$polOn = Policy-Snapshot
Tunnel-Off
$polOff = Policy-Snapshot
Verdict "е1" "Режим выключен: невыбранная программа работает" (Reaches $Other) "копия curl вышла в сеть" "приватный режим выключен, а копия curl закрыта — стена осталась"
Verdict "е2" "Режим выключен: powershell работает" (Reaches-PowerShell) "powershell.exe вышел в сеть" "powershell.exe закрыт при выключенном режиме"
Verdict "е3" "Политика исходящего не тронута" (($polOn -eq $PolicyBefore) -and ($polOff -eq $PolicyBefore)) `
    "Get-NetFirewallProfile: до, при включённом и после выключенного режима одно и то же ($PolicyBefore)" `
    "политика изменилась: до [$PolicyBefore], при включённом [$polOn], после [$polOff]"

# --- ж. Охват «весь компьютер» ----------------------------------------------------
if ($NoTun) {
    Skip "ж" "Охват «весь компьютер»" "-NoTun: нужен живой туннель"
} else {
    $u = Tunnel-On "all"
    if ($u -lt 0) {
        Report "ж" "Охват «весь компьютер»" "ПРОВАЛ" "туннель не поднялся (состояние: $(Get-State))"
    } else {
        $works = Reaches $Other
        [void](Kill-Tunnel)
        $dead = -not (Reaches $Other)
        Verdict "ж" "Охват «весь компьютер»" ($works -and $dead) `
            "невыбранная программа работает через туннель, а после смерти sing-box закрыта" `
            "невыбранная программа: при поднятом туннеле работает=$works, после смерти sing-box закрыта=$dead"
        [void](Wait-State "Up" 60000)
    }
    Tunnel-Off
    Cli scope whitelist | Out-Null
}

# --- и. Замок закрыт и на вход ------------------------------------------------------
# Невыбранный слушатель с разрешающим ВХОДЯЩИМ правилом брандмауэра не должен
# принимать пиров на физической карте. Изнутри песочницы это не доказать: Windows
# считает соединение с собственного адреса петлёй, а петлю стена пропускает. Поэтому
# две части: (и1) автоматически — запреты на обоих слоях RECV_ACCEPT стоят в ядре;
# (и2) вручную — подключение с хоста к адресу песочницы.
$listenPort = 45678
$inRule = "pb-sandbox-inbound-allow"
$script:ListenerJob = $null
$nicIp = $null
try {
    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1
    $nicIp = (Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
} catch { }
[void](Tunnel-On "whitelist")
New-NetFirewallRule -DisplayName $inRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $listenPort -Profile Any | Out-Null
$script:ListenerJob = Start-Job -ArgumentList $listenPort -ScriptBlock {
    param($port)
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
    $l.Start()
    while ($true) { $c = $l.AcceptTcpClient(); $c.Close() }
}
Start-Sleep -Seconds 2
$inbound = @()
$wfpIn = Join-Path $Run "wfp-inbound.xml"
Remove-Item $wfpIn -Force -ErrorAction SilentlyContinue
& netsh.exe wfp show filters file="$wfpIn" *> $null
if (Test-Path $wfpIn) {
    $xmlIn = New-Object Xml.XmlDocument
    $xmlIn.Load($wfpIn)
    foreach ($it in $xmlIn.SelectNodes("//item[providerKey]")) {
        if ($it.providerKey -match "84a577e5-d48e-4489-9c9f-5140ed145854") { $inbound += [string]$it.layerKey }
    }
}
$inV4 = @($inbound | Where-Object { $_ -match 'RECV_ACCEPT_V4|c38d57d1-05a7-4c33-904f-7fbceee60e82' }).Count
$inV6 = @($inbound | Where-Object { $_ -match 'RECV_ACCEPT_V6|4a72393b-319f-44bc-84c3-ba54dcb3b6b4' }).Count
Verdict "и1" "Замок закрыт на вход: фильтры на RECV_ACCEPT v4 и v6" (($inV4 -gt 0) -and ($inV6 -gt 0)) `
    "в ядре наших фильтров на входящих слоях: v4=$inV4, v6=$inV6" `
    "наших фильтров на входящих слоях: v4=$inV4, v6=$inV6 (дамп: $wfpIn) — замок на вход не стоит"
$ipText = if ($nicIp) { $nicIp } else { "<адрес сетевой карты песочницы: ipconfig>" }
Skip "и2" "Невыбранный слушатель с входящим Allow недоступен снаружи" `
    "РУЧНАЯ: слушатель powershell на 0.0.0.0:$listenPort и правило $inRule живут до конца проверок; с ХОСТА выполните Test-NetConnection $ipText -Port $listenPort — обязано быть TcpTestSucceeded : False (при поднятом туннеле и белом списке). Из песочницы это не проверить: соединение с собственным адресом идёт петлёй"
# Замок намеренно остаётся стоять: следующая проверка («з») и так включает его
# заново, а при -SkipCrashCheck он нужен руками.

# --- з. Падение службы не снимает стену; uninstall её убирает --------------------
# Разрушающая и потому последняя: после неё службы в песочнице нет.
if ($SkipCrashCheck) {
    Skip "з" "Стена переживает падение службы" "-SkipCrashCheck"
} else {
    $providerKey = "84a577e5-d48e-4489-9c9f-5140ed145854"
    $wfpDump = Join-Path $Run "wfp-filters.xml"
    # Число наших фильтров в ядре: разбор XML, который пишет `netsh wfp show filters`.
    function Our-Filters {
        Remove-Item $wfpDump -Force -ErrorAction SilentlyContinue
        & netsh.exe wfp show filters file="$wfpDump" *> $null
        if (-not (Test-Path $wfpDump)) { return -1 }
        $xml = New-Object Xml.XmlDocument
        $xml.Load($wfpDump)
        return @($xml.SelectNodes("//providerKey") | Where-Object { $_.InnerText -match $providerKey }).Count
    }
    [void](Tunnel-On "whitelist")
    $before = Our-Filters
    # Без этого SCM поднимет убитую службу через 5 с, и uninstall пошёл бы по пути
    # «остановить штатно, обработчик сам снимет стену», а не по запасному forget().
    & sc.exe failure proxybox reset= 0 actions= "" *> $null
    Get-Process -Name "pg-service" -ErrorAction SilentlyContinue | Stop-Process -Force
    $svcDown = $false
    for ($i = 0; $i -lt 30 -and -not $svcDown; $i++) {
        $s = Get-Service proxybox -ErrorAction SilentlyContinue
        if (-not $s -or $s.Status -eq "Stopped") { $svcDown = $true } else { Start-Sleep -Milliseconds 500 }
    }
    if (-not $svcDown) { Report "з0" "Служба остановлена перед проверкой" "ПРОВАЛ" "служба так и не остановилась за 15 с — uninstall пойдёт штатным путём, а не через forget()" }
    $stands = -not (Reaches $Other)
    Verdict "з1" "Служба убита — стена стоит" ($stands -and $before -gt 0) "невыбранный exe по-прежнему закрыт (постоянные фильтры WFP; наших фильтров в ядре: $before)" "после падения службы стена не стоит: невыбранный закрыт=$stands, наших фильтров в ядре=$before"
    & $Svc uninstall *> $null
    [void](Kill-Tunnel)   # осиротевший туннельный sing-box: службы, что его погасит, уже нет
    Start-Sleep -Seconds 1
    Verdict "з2" "pg-service uninstall снимает стену" (Reaches $Other) "после uninstall невыбранный exe вышел в сеть (forget убрал фильтры)" "после uninstall невыбранный exe всё ещё закрыт — forget ничего не снял"
    $after = Our-Filters
    Verdict "з3" "После uninstall в WFP нет фильтров провайдера proxybox" ($after -eq 0) "netsh wfp show filters: фильтров провайдера $providerKey не осталось" "в WFP осталось фильтров провайдера ${providerKey}: $after (-1 — дамп не получился)"
}

Remove-NetFirewallRule -DisplayName $inRule -ErrorAction SilentlyContinue
if ($script:ListenerJob) { Stop-Job $script:ListenerJob -ErrorAction SilentlyContinue; Remove-Job $script:ListenerJob -Force -ErrorAction SilentlyContinue }

# --- Итог -------------------------------------------------------------------------
$pass = @($Results | Where-Object Status -eq "ПРОЙДЕНО").Count
$fail = @($Results | Where-Object Status -eq "ПРОВАЛ").Count
$skip = @($Results | Where-Object Status -eq "ПРОПУСК").Count
Say "== итого: пройдено $pass, провалено $fail, пропущено $skip. Журнал: $Log"
if (Test-Path "C:\pb-out") { Copy-Item $Log "C:\pb-out\proxybox-sandbox.log" -Force -ErrorAction SilentlyContinue }
if ($fail -gt 0) { exit 1 }
