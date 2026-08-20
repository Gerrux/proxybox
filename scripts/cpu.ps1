<#
  Кто на самом деле жрёт ЦП: sing-box в юзерспейсе или фильтры в ядре.

  Меряется дельта за окно, а не накопленное время: Get-Process показывает CPU
  за всю жизнь процесса, и по одному снимку не видно ничего — колонка CPU у
  чужого процесса вдобавок приходит пустой без прав администратора.

  Get-Counter не используется намеренно: имена счётчиков локализованы, и
  '\Processor(_Total)\% Processor Time' на русской Windows просто не
  существует. Всё считается из двух снимков Get-Process, это ещё и дешевле.

  Два прохода: сначала трафик мимо TUN (через mixed-порт службы, тот самый,
  что заведён для пробы и headless), потом через TUN. Разница в CPU на гигабайт
  и есть цена TUN — чужие числа для сравнения не нужны, стенд один и тот же.
  Метрика та же, что в scripts/bench-cores.sh, чтобы Windows и Linux сходились.

  Файл обязан лежать в UTF-8 С BOM, и это не вкусовщина: Windows PowerShell
  5.1 без BOM читает скрипт как ANSI (CP1251), кириллица в комментариях
  рассыпается на байты, среди которых попадаются кавычки и скобки, и парсер
  падает на них — а не на строке, где ошибка. Снимете BOM (или пересохраните
  редактором «UTF-8 without BOM») — скрипт перестанет запускаться целиком.
  pwsh 7 читает UTF-8 и без BOM, так что проверка семёркой этого не ловит.

  Запуск от администратора:

      powershell -ExecutionPolicy Bypass -File scripts\cpu.ps1
#>
[CmdletBinding()]
param(
    # Окно замера. Короче 10 с всплеск сборщика мусора перебивает сигнал.
    [int]$Seconds = 20,
    # Что качать, по порядку до первого удачного. Список, а не один адрес:
    # проход 1 идёт через туннель, сервер видит адрес VPN, и Cloudflare на такой
    # отвечает 403 — двух прогонов это стоило. Свой сервер ставится первым.
    [string[]]$Url = @(
        "https://ash-speed.hetzner.com/100MB.bin",
        "http://speedtest.tele2.net/100MB.zip",
        "https://speed.cloudflare.com/__down?bytes=104857600"
    ),
    # Порты службы: mixed (обход TUN) и Clash API (счётчики байт).
    [int]$MixedPort = 48292,
    [int]$ApiPort = 48293,
    # Имя нашего TUN-адаптера — core_tunnel::TUN_NAME. Разъедется с ним, и
    # главный знаменатель (пакеты через TUN) молча пропадёт из вывода.
    [string]$TunName = "Privacy Gateway",
    # Куда долбиться короткими соединениями. Отвечает быстро, рвётся сразу,
    # байтов почти нет — нужны именно соединения, а не трафик.
    [string]$ChurnTarget = "1.1.1.1",
    [int]$ChurnPort = 443,
    # Сравнить охваты и вернуть как было: замер, `pg-cli scope all`, замер,
    # `pg-cli scope apps`. Это единственный вопрос, на который замер сам ответить
    # не может, — правило process_path либо есть в конфиге, либо его нет.
    [switch]$Scope,
    # Путь к клиенту. Пустой — ищем сами рядом с приложением и в target/.
    # Файл зовётся privacy-gateway.exe: крейт pg-cli, а имя бинарника своё.
    [string]$Cli = ""
)

$ErrorActionPreference = "Stop"
$cores = [int]$env:NUMBER_OF_PROCESSORS

# Клиент и журнал службы пишут UTF-8, а PowerShell декодирует вывод дочернего
# процесса кодировкой консоли (на русской Windows — 866). Без этой строки
# `status` возвращался кракозябрами, проверка «поднят» не совпадала никогда, и
# скрипт сорок секунд ждал туннель, который стоял поднятым с первой секунды.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host "Нужен PowerShell от администратора: служба крутит sing-box от SYSTEM," -ForegroundColor Red
    Write-Host "и без прав его процессорное время читается как пустая колонка." -ForegroundColor Red
    exit 1
}

$sb = @(Get-Process sing-box -ErrorAction SilentlyContinue)
if ($sb.Count -eq 0) {
    Write-Host "sing-box не запущен — включите приватный режим." -ForegroundColor Red
    exit 1
}
if ($sb.Count -gt 1) {
    Write-Host "sing-box в $($sb.Count) экземплярах (сеансы браузера или прогон профилей) — ЦП складывается по всем." -ForegroundColor Yellow
}

# Охват решает, чем мерить второй проход: в «выбранных приложениях» каждое
# соединение сверяется с process_path, а powershell.exe в списке не значится и
# в TUN не попадёт вовсе — значит качать придётся руками, выбранным приложением.
$state = Join-Path $env:ProgramData "privacy-gateway\state.json"
$all = $false
$apps = 0
if (Test-Path $state) {
    $s = Get-Content $state -Raw | ConvertFrom-Json
    $all = [bool]$s.all_traffic
    $apps = @($s.apps | Where-Object { $_.enabled }).Count
}

function Get-Snapshot {
    # Процессорное время всех процессов разом: из одного снимка выходит и общая
    # загрузка машины, и раскладка по программам, и доля ядра у sing-box.
    $h = @{}
    foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
        if ($p.Id -eq 0) { continue }
        try {
            $h[$p.Id] = [pscustomobject]@{
                Name = $p.ProcessName
                Cpu  = $p.TotalProcessorTime.TotalSeconds
                Krn  = $p.PrivilegedProcessorTime.TotalSeconds
            }
        } catch { }  # процесс умер между перечислением и чтением — не наша забота
    }
    $h
}

function Get-ThreadTimes($id) {
    $h = @{}
    try {
        foreach ($t in (Get-Process -Id $id).Threads) {
            try { $h[$t.Id] = $t.TotalProcessorTime.TotalSeconds } catch { }
        }
    } catch { }
    $h
}

function Get-TrafficBytes {
    # Счётчики Clash API — те же, что показывает окно. Отказ значит «байты не
    # посчитаны»: взять их больше неоткуда, TUN своего счётчика не даёт.
    try {
        # Тайм-аут щедрый намеренно: на живой машине в списке за тысячу
        # соединений, это мегабайт JSON, и трёх секунд на разбор не хватало —
        # снимок молча выходил пустым, а разность потом врала.
        $c = Invoke-RestMethod "http://127.0.0.1:$ApiPort/connections" -TimeoutSec 15
        [int64]$c.downloadTotal + [int64]$c.uploadTotal
    } catch { -1 }
}

function Get-TunStats {
    # Счётчик Clash API считает только то, что ушло в туннель, — а с auto_route
    # через TUN проходит трафик всей машины, включая тот, что уйдёт напрямую
    # по `final: direct`. Работу sing-box меряет адаптер, а не Clash: иначе
    # выходит 27 секунд ЦП на «один мегабайт» и полная бессмыслица.
    try {
        $s = Get-NetAdapterStatistics -Name "$TunName*" -ErrorAction Stop | Select-Object -First 1
        [pscustomobject]@{
            Bytes   = [int64]$s.ReceivedBytes + [int64]$s.SentBytes
            Packets = [int64]$s.ReceivedUnicastPackets + [int64]$s.SentUnicastPackets
        }
    } catch { $null }
}

function Get-ConnIds {
    # Соединения, а не байты: правило process_path сверяется на соединение, и
    # менять надо именно их число. Счёт по разнице множеств — оценка снизу,
    # успевшее открыться и закрыться внутри окна сюда не попадёт; настоящее
    # число генератор возвращает сам.
    try {
        # Тайм-аут щедрый намеренно: на живой машине в списке за тысячу
        # соединений, это мегабайт JSON, и трёх секунд на разбор не хватало —
        # снимок молча выходил пустым, а разность потом врала.
        $c = Invoke-RestMethod "http://127.0.0.1:$ApiPort/connections" -TimeoutSec 15
        $h = @{}
        foreach ($x in $c.connections) { if ($x.id) { $h[$x.id] = $true } }
        $h
    } catch { @{} }
}

# Нагрузка соединениями: много коротких TCP-подключений и почти ноль байт —
# ровно наоборот к большой закачке. С auto_route они всё равно заходят в TUN,
# и sing-box обязан выяснить процесс для каждого, даже если отправит напрямую.
$churner = {
    param($target, $port, $seconds)
    $n = 0
    $err = $null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $seconds) {
        try {
            $c = New-Object Net.Sockets.TcpClient
            $c.Connect($target, [int]$port)
            $c.Close()
            $n++
        } catch {
            # Причина обязана долететь: молча глотая отказ, проход отчитывался
            # «соединений не создал (цель недоступна?)» и оставлял гадать.
            if (-not $err) { $err = $_.Exception.Message }
            Start-Sleep -Milliseconds 100
        }
    }
    [pscustomobject]@{ Made = $n; Error = $err }
}

$loader = {
    # Список приходит одной строкой через перевод: -ArgumentList разворачивает
    # массив в отдельные аргументы, и адреса разъехались бы по чужим параметрам.
    param($urlList, $proxy, $seconds, $tmp)
    $urls = $urlList -split "`n" | Where-Object { $_ }
    # Windows PowerShell 5.1 по умолчанию предлагает SSL3/TLS 1.0, современный
    # сервер такое рвёт на рукопожатии — закачка не начиналась вовсе, а окно
    # всё равно отсчитывалось, и замер выходил про покой под видом нагрузки.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
    $errors = @()
    $good = $null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $seconds) {
        # Пока рабочий адрес не найден — перебираем все; найденный держим.
        $ok = $false
        foreach ($u in $(if ($good) { @($good) } else { $urls })) {
            try {
                $c = New-Object Net.WebClient
                # Голый WebClient не шлёт User-Agent вовсе, и часть зеркал
                # отвечает на это отказом.
                $c.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                $c.Proxy = if ($proxy) { New-Object Net.WebProxy($proxy) } else { $null }
                $c.DownloadFile($u, $tmp)
                $good = $u
                $ok = $true
                break
            } catch {
                # Отказ обязан долететь наверх: молчаливый break и дал проходы
                # с нулём байт и «сравнивать нечего» в итоге, без причины.
                $errors += "$u -> $($_.Exception.Message)"
            }
        }
        if (-not $ok) { break }
    }
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if (-not $good) { $errors -join '; ' }
}

# Возвращает один объект: ЦП за окно и цену трафика в с/ГБ. Всё остальное
# печатается через Write-Host — голая строка в PowerShell уходит в
# возвращаемое значение и смешалась бы с ним.
function Measure-Window {
    param([string]$Label, [string]$Proxy, [bool]$Load, [bool]$Prompt, [bool]$Churn)

    Write-Host ""
    Write-Host "== $Label ==" -ForegroundColor Cyan
    if ($Prompt) {
        Write-Host "Запустите большую закачку выбранным приложением и нажмите Enter — окно $Seconds с" -NoNewline
        [void](Read-Host)
    }

    $mainId = (Get-Process sing-box | Select-Object -First 1).Id
    $t0 = Get-ThreadTimes $mainId
    $a = Get-Snapshot
    $b0 = Get-TrafficBytes
    $n0 = Get-TunStats
    $c0 = Get-ConnIds
    $job = $null
    if ($Churn) {
        $job = Start-Job -ScriptBlock $churner -ArgumentList $ChurnTarget, $ChurnPort, $Seconds
    } elseif ($Load) {
        # GetTempPath, а не $env:TEMP: переменная бывает пустой, а с
        # ErrorActionPreference=Stop пустой путь убил бы замер посреди окна.
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "pg-cpu.bin"
        $job = Start-Job -ScriptBlock $loader -ArgumentList ($Url -join "`n"), $Proxy, $Seconds, $tmp
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds $Seconds
    $elapsed = $sw.Elapsed.TotalSeconds
    $b1 = Get-TrafficBytes
    $n1 = Get-TunStats
    $c1 = Get-ConnIds
    $b = Get-Snapshot
    $t1 = Get-ThreadTimes $mainId
    $made = 0
    if ($job) {
        Stop-Job $job -ErrorAction SilentlyContinue
        $got = @(Receive-Job $job -ErrorAction SilentlyContinue) | Where-Object { $_ }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        if ($Churn) {
            $r = @($got)[-1]
            $made = [int]$r.Made
            $why = ""
            if ($r.Error) { $why = " (первая ошибка: $($r.Error))" }
            Write-Host ("  сделано подключений: {0}{1}" -f $made, $why)
        } elseif ($got) {
            Write-Host ("  закачка не пошла: {0}" -f ($got -join '; ')) -ForegroundColor Yellow
        }
    }

    # Считаем только процессы, дожившие до конца окна: у мелькнувшего между
    # снимками нет базы для вычитания, и его время ушло бы в общую сумму целиком.
    $delta = foreach ($id in $b.Keys) {
        if (-not $a.ContainsKey($id)) { continue }
        [pscustomobject]@{
            Pid  = $id
            Name = $b[$id].Name
            Cpu  = [math]::Max(0, $b[$id].Cpu - $a[$id].Cpu)
            Krn  = [math]::Max(0, $b[$id].Krn - $a[$id].Krn)
        }
    }
    $total = [double](($delta | Measure-Object Cpu -Sum).Sum)
    # Проверяется после снимков, чтобы не попасть в само окно.
    $reach = Test-Reach

    # Дельта берёт только процессы, дожившие от начала окна до конца. Если
    # sing-box за это время перезапустился, PID сменился, оба экземпляра выпали
    # из расчёта и ЦП вышел нулём — не «стало бесплатно», а «не посчитано».
    # Именно так выглядит неподтверждённый туннель: надзор поднимает sing-box
    # заново каждые три секунды, и ноль в отчёте выглядел победой.
    $sbA = @($a.Keys | Where-Object { $a[$_].Name -eq "sing-box" })
    $sbB = @($b.Keys | Where-Object { $b[$_].Name -eq "sing-box" })
    $appeared = @($sbB | Where-Object { $sbA -notcontains $_ }).Count
    $vanished = @($sbA | Where-Object { $sbB -notcontains $_ }).Count
    # Печатается всегда, а не только при беде: молчащая проверка неотличима от
    # отсутствующей, и по выводу нельзя понять, была ли она вообще — прошлый
    # прогон именно из-за этого пришлось читать гаданием.
    $net = if ($reach) { "есть" } else { "НЕТ — тишина не заслуга охвата" }
    $pids = if ($sbB.Count) { $sbB -join ", " } else { "нет процесса" }
    Write-Host ("{0,-20} сеть: {1}; sing-box pid: {2}" -f "проверка окна:", $net, $pids)

    # Без явного $false переменная читалась бы из родительской области, и
    # прошлый проход тянул бы свой вердикт в следующий.
    $restarted = $false
    # Ноль процессов в обоих снимках давал ноль ЦП без единого предупреждения:
    # «расход исчез» и «мерить было нечего» выглядели одинаково.
    if ($sbB.Count -eq 0) {
        Write-Host "  sing-box в конце окна не найден вовсе — считать было нечего." -ForegroundColor Red
        $restarted = $true
    }
    $restarted = $restarted -or ($appeared -gt 0) -or ($vanished -gt 0)
    if ($restarted) {
        Write-Host "  sing-box перезапускался внутри окна (PID сменился): его ЦП занижен или обнулён." -ForegroundColor Yellow
        Write-Host "  Так ведёт себя неподтверждённый туннель — сравнивать такой замер нельзя." -ForegroundColor Yellow
    }
    $mine = @($delta | Where-Object { $_.Name -eq "sing-box" })
    $myCpu = [double](($mine | Measure-Object Cpu -Sum).Sum)
    $myKrn = [double](($mine | Measure-Object Krn -Sum).Sum)
    $gb = -1.0
    if ($b1 -ge 0 -and $b0 -ge 0) { $gb = ($b1 - $b0) / 1GB }

    # Два знака после запятой не для красоты: в первых прогонах все значения
    # вышли ровными целыми, чего у дельт процессорного времени не бывает, —
    # по второму знаку видно, настоящая это гранулярность или округление.
    Write-Host ("{0,-20} {1,7:N2} с   {2,5:N0}% одного ядра, {3,3:N0}% машины" -f `
        "sing-box, ЦП:", $myCpu, (100 * $myCpu / $elapsed), (100 * $myCpu / $elapsed / $cores))
    # Разбивка по процессам — ради дарового опыта: сеанс браузера поднимает
    # второй sing-box БЕЗ TUN (core_tunnel::sidecar), на той же машине, той же
    # версии и том же сервере. Разница между ними и есть цена TUN, без остановки
    # службы и без правки конфига.
    if ($mine.Count -gt 1) {
        foreach ($m in $mine | Sort-Object Cpu -Descending) {
            Write-Host ("    pid {0,-8} {1,7:N2} с   в ядре {2,3:N0}%" -f $m.Pid, $m.Cpu, $(if ($m.Cpu -gt 0) { 100 * $m.Krn / $m.Cpu } else { 0 }))
        }
    }
    # При нулевом ЦП строка про долю ядра — «0 %, много работы в ядре» — читалась
    # как вывод, хотя считать было нечего.
    if ($myCpu -gt 0) {
        Write-Host ("{0,-20} {1,7:N0} %   много — работа в ядре: wintun, WFP, драйвер" -f "из них в ядре:", (100 * $myKrn / $myCpu))
    } else {
        # Ноль бывает и настоящим: при 800 пакетах за окно расход честно меньше
        # сотой доли секунды. Отсылать к предупреждению, которого может не быть,
        # значит врать — состояние окна печатается строкой ниже, там и смотреть.
        Write-Host "                       меньше 0.01 с — либо расхода нет, либо считать было нечего"
    }
    $myShare = 0
    if ($total -gt 0) { $myShare = 100 * $myCpu / $total }
    Write-Host ("{0,-20} {1,7:N1} с   {2,3:N0}% машины, доля sing-box в этом — {3:N0}%" -f `
        "вся машина, ЦП:", $total, (100 * $total / $elapsed / $cores), $myShare)

    if ($gb -lt 0) {
        Write-Host "  Clash API не ответил на $ApiPort — байты не посчитаны"
    } elseif (-not $Load -and -not $Prompt) {
        # Проход покоя: трафика тут и не должно быть, это не жалоба.
        Write-Host ("{0,-20} {1,7:N3} ГБ  фон, нагрузки не было" -f "прошло трафика:", $gb)
    } elseif ($gb -le 0.01) {
        Write-Host ("  трафика прошло всего {0:N3} ГБ — число с/ГБ было бы шумом, повторите с реальной загрузкой" -f $gb)
    } else {
        Write-Host ("{0,-20} {1,7:N2} ГБ" -f "прошло трафика:", $gb)
        Write-Host ("{0,-20} {1,7:N2} с/ГБ  <- главное число, сравнивать с соседним проходом" -f "цена трафика:", ($myCpu / $gb))
    }

    # Один поток или все: у Go горутина на соединение, но один поток данных
    # шифруется последовательно и упирается ровно в одно ядро.
    $hot = $t1.Keys | Where-Object { $t0.ContainsKey($_) } | ForEach-Object { $t1[$_] - $t0[$_] } |
        Sort-Object -Descending | Select-Object -First 1
    if ($hot -and $myCpu -gt 0.5) {
        Write-Host ("{0,-20} {1,7:N0} %   от всего ЦП процесса; потоков: {2}" -f "горячий поток:", (100 * $hot / $myCpu), $t1.Count)
    }

    Write-Host "  топ по ЦП за окно:"
    $delta | Sort-Object Cpu -Descending | Select-Object -First 6 |
        ForEach-Object { Write-Host ("    {0,-24} {1,6:N1} с" -f $_.Name, $_.Cpu) }

    # Через TUN проходит трафик всей машины, а не только уходящий в туннель.
    # Это и есть настоящий объём работы sing-box, и настоящий знаменатель.
    $tunGb = 0.0
    $packets = [int64]0
    if ($n0 -and $n1) {
        $tunGb = ($n1.Bytes - $n0.Bytes) / 1GB
        $packets = $n1.Packets - $n0.Packets
    }
    if (-not $n0 -or -not $n1) {
        Write-Host "  адаптер «$TunName» не найден — работа TUN не посчитана (TUN поднят?)"
    } else {
        Write-Host ("{0,-20} {1,7:N3} ГБ, {2:N0} пакетов" -f "через TUN всего:", $tunGb, $packets)
        if ($packets -gt 1000 -and $myCpu -gt 0) {
            # Микросекунды на пакет — та метрика, по которой TUN и судят:
            # единицы это норма, десятки означают, что на каждый пакет
            # делается что-то лишнее.
            Write-Host ("{0,-20} {1,7:N1} мкс   <- цена одного пакета" -f "на пакет:", (1e6 * $myCpu / $packets))
        }
    }

    # Новые соединения — знаменатель, которого мне и не хватало: правило
    # process_path сверяется на соединение, а большая закачка это одно
    # соединение и сто тысяч пакетов. Меняя байты, я не менял ничего.
    $newConns = 0
    foreach ($k in $c1.Keys) { if (-not $c0.ContainsKey($k)) { $newConns++ } }
    # Печатаются оба снимка, а не только разность: «новых 1030» в каждом проходе
    # означало либо полную смену списка, либо пустой первый снимок, и по одному
    # числу это неразличимо. «Было 0» теперь видно сразу.
    Write-Host ("{0,-20} было {1:N0}, стало {2:N0}, новых {3:N0}" -f "соединений:", $c0.Count, $c1.Count, $newConns)
    if ($newConns -gt 0 -and $myCpu -gt 0) {
        Write-Host ("{0,-20} {1,7:N0} мкс на соединение" -f "цена соединения:", (1e6 * $myCpu / $newConns))
    }

    $perGb = 0.0
    if ($myCpu -gt 0 -and $gb -gt 0.01) { $perGb = $myCpu / $gb }
    [pscustomobject]@{
        Cpu     = $myCpu           # секунд ЦП за окно
        Cores   = $myCpu / $elapsed   # во сколько ядер это обошлось
        PerGb   = $perGb           # по счётчику туннеля; 0, если трафика не было
        TunGb   = $tunGb           # весь трафик через адаптер
        Packets   = $packets
        Conns     = $newConns      # новых соединений за окно
        Restarted = $restarted     # sing-box сменил PID: числу верить нельзя
        Reach     = $reach         # была ли у машины сеть в это окно
    }
}

# Не `$scope`: так зовётся параметр -Scope, а имена переменных в PowerShell
# регистра не различают. Строка затирала флаг, и скрипт всегда уходил в режим
# сравнения охватов — поймано тестом, глазами не видно вовсе.
$scopeName = if ($all) { "весь компьютер" } else { "выбранные приложения ($apps шт.)" }
# Дата файла, а не номер версии: по ней сразу видно, подтянут ли git pull.
# Прошлый прогон нельзя было прочесть именно потому, что новые проверки молчали,
# и отличить «их нечему было сказать» от «их тут ещё нет» было невозможно.
$stamp = try { (Get-Item $PSCommandPath).LastWriteTime.ToString("dd.MM HH:mm") } catch { "?" }
Write-Host "Ядер: $cores.  Охват: $scopeName.  Скрипт от $stamp"

# Правила брандмауэра — статья расхода, с трафиком через туннель не связанная:
# осиротевшее правило WFP разбирает на каждом исходящем соединении в системе,
# своём и чужом, и переживает перезагрузку.
# Второй живой TUN рядом делает бессмысленным весь замер: маршруты уходят к
# тому, кто выиграл, и чей это ЦП — уже не разобрать. Показываем имя вместе с
# описанием: имя задаёт клиент, описание ставит драйвер, и у sing-box оно
# «sing-tun Tunnel» независимо от того, чей это sing-box.
try {
    $ups = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' } |
        Where-Object { $_.InterfaceDescription -match 'tun|tap-|wireguard|vpn' })
    if ($ups) {
        Write-Host "Поднятые туннельные адаптеры:"
        foreach ($a in $ups) {
            $mine = if ($a.Name -eq $TunName) { "  <- наш" } else { "  <- ЧУЖОЙ, замер испорчен" }
            Write-Host ("   {0,-24} {1}{2}" -f $a.Name, $a.InterfaceDescription, $mine)
        }
    }
} catch { }

$rules = @(Get-NetFirewallRule -DisplayName 'Privacy Gateway: *' -ErrorAction SilentlyContinue)
Write-Host "Правил 'Privacy Gateway: *': $($rules.Count)"
if ($rules.Count -gt $apps + 1) {
    Write-Host "  больше, чем включённых приложений — похоже на осиротевшие, снимает их sweep() при выключении" -ForegroundColor Yellow
}

# Крейт зовётся pg-cli, а бинарник — privacy-gateway: так задано в [[bin]] его
# Cargo.toml, и под этим же именем его кладёт установщик (installer/sidecars.ps1
# копирует в src-tauri/binaries). Файла pg-cli.exe не существует нигде, и
# искать надо именно это имя. Рядом стоит «Privacy Gateway.exe» — это окно, а
# не клиент; имена различаются пробелом против дефиса.
$CLI_NAME = "privacy-gateway"

function Find-Cli {
    if ($Cli) { return $Cli }
    # Пустая база пропускается: Join-Path с null бросает, а с ErrorAction=Stop
    # это убивает весь замер из-за необязательного кандидата.
    $bases = @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    $paths = @($bases | ForEach-Object { Join-Path $_ "Privacy Gateway\$CLI_NAME.exe" })
    $paths += (Join-Path $PSScriptRoot "..\target\release\$CLI_NAME.exe")
    $paths += (Join-Path $PSScriptRoot "..\target\debug\$CLI_NAME.exe")
    foreach ($c in $paths) {
        if (Test-Path $c) { return (Resolve-Path $c).Path }
    }
    $null
}

function Get-TunnelUp($cli) {
    # Ответа Clash API мало: он приходит от живого процесса, а не от
    # подтверждённого туннеля. Пока проба не прошла, служба держит блокировку
    # и каждые три секунды поднимает sing-box заново — мерить там нечего.
    # Состояние знает только служба, и спрашивать надо её.
    try { $out = (& $cli status 2>&1 | Out-String) } catch { return $false }
    # Служба отвечает на языке, который ей выставили, — проверяем оба слова.
    ($out -match "поднят") -or ($out -match "\bup,")
}

function Test-Reach {
    # Была ли у машины сеть в это окно. Без этого «расход исчез» неотличимо от
    # «всё замолчало, потому что сети не стало»: под неподтверждённым туннелем
    # в охвате «весь компьютер» запрещён весь исходящий, и тихо становится
    # везде сразу — включая Defender, который перестаёт что-либо проверять.
    try {
        $c = New-Object Net.Sockets.TcpClient
        $ok = $c.ConnectAsync($ChurnTarget, $ChurnPort).Wait(3000)
        $c.Close()
        $ok
    } catch { $false }
}

function Show-WhyNot($cli) {
    # «Не поднялся» без причины — это приглашение гадать, а причина уже записана:
    # служба ведёт журнал, sing-box пишет свой лог, состояние знает status.
    # Показываем всё три, вместо того чтобы спрашивать человека ещё раз.
    Write-Host ""
    Write-Host "-- состояние службы --" -ForegroundColor Yellow
    try { & $cli status 2>&1 | ForEach-Object { Write-Host "   $_" } } catch { Write-Host "   status не ответил" }

    $dir = Join-Path $env:ProgramData "privacy-gateway"
    Write-Host "-- журнал службы (свежее сверху) --" -ForegroundColor Yellow
    try {
        # -Encoding UTF8 обязателен: служба пишет журнал в UTF-8, а PowerShell
        # 5.1 без указания читает файл в кодировке системы и выдаёт кракозябры.
        $j = Get-Content (Join-Path $dir "journal.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        $j | Select-Object -First 12 | ForEach-Object {
            $mark = if ($_.bad) { "!" } else { " " }
            Write-Host "  $mark $($_.text)"
        }
    } catch { Write-Host "   журнал не прочитан: $($_.Exception.Message)" }

    Write-Host "-- хвост singbox.log --" -ForegroundColor Yellow
    try {
        Get-Content (Join-Path $dir "singbox.log") -Tail 15 | ForEach-Object { Write-Host "   $_" }
    } catch { Write-Host "   лог не прочитан: $($_.Exception.Message)" }

    # Kill-switch в этом охвате — политика брандмауэра, а не правило, и если
    # туннель не встал, машина сидит без сети именно из-за неё.
    Write-Host "-- политика брандмауэра --" -ForegroundColor Yellow
    try {
        netsh advfirewall show allprofiles | Select-String -Pattern "Outbound|Исходящ" | ForEach-Object { Write-Host "   $_" }
    } catch { Write-Host "   netsh не ответил" }
}

function Wait-Tunnel($cli) {
    # Смена охвата перезапускает sing-box: `final` живёт в его конфиге.
    for ($i = 0; $i -lt 40; $i++) {
        if (Get-TunnelUp $cli) { Start-Sleep -Seconds 3; return $true }
        Start-Sleep -Seconds 1
    }
    $false
}

if ($Scope) {
    $cli = Find-Cli
    if (-not $cli) {
        Write-Host "$CLI_NAME.exe не найден. Он ставится вместе с приложением; если нет — соберите:" -ForegroundColor Red
        Write-Host "    cargo build -p pg-cli --release" -ForegroundColor Red
        Write-Host "Бинарник ляжет в target\release\$CLI_NAME.exe (крейт pg-cli, имя из [[bin]])." -ForegroundColor Red
        exit 1
    }
    if ([IO.Path]::GetFileNameWithoutExtension($cli) -ne $CLI_NAME) {
        # Ровно та ошибка, которую легко сделать: подсунуть pg-service.exe.
        # Служба команду `scope` не разбирает — она её слушает, а не шлёт.
        Write-Host "«$cli» — это не клиент. Охват меняет $CLI_NAME.exe, а не служба и не окно." -ForegroundColor Red
        Write-Host "Путь с пробелами обязателен в кавычках: -Cli `"C:\Program Files\Privacy Gateway\$CLI_NAME.exe`"" -ForegroundColor Red
        exit 1
    }
    $was = if ($all) { "all" } else { "apps" }
    $other = if ($all) { "apps" } else { "all" }
    Write-Host "CLI: $cli.  Текущий охват: $was, сравниваем с $other."
    try {
        $first = Measure-Window -Label "охват «$was» (как сейчас)" -Proxy $null -Load $false -Prompt $false
        Write-Host ""
        Write-Host "переключаю охват на «$other»…"
        & $cli scope $other | Out-Null
        if (-not (Wait-Tunnel $cli)) {
            Write-Host "  туннель не поднялся после смены охвата — замер отменён" -ForegroundColor Red
            Show-WhyNot $cli
            $second = $null
        } else {
            $second = Measure-Window -Label "охват «$other»" -Proxy $null -Load $false -Prompt $false
        }
    } finally {
        # Охват возвращается всегда, даже если замер оборвали: оставить чужую
        # машину в другом режиме перехвата — это не «побочный эффект замера».
        Write-Host ""
        Write-Host "возвращаю охват «$was»…"
        & $cli scope $was | Out-Null
        [void](Wait-Tunnel $cli)
    }

    Write-Host ""
    Write-Host "== итог: охваты ==" -ForegroundColor Cyan
    if (-not $second) {
        Write-Host "  Второй замер не состоялся."
        exit 1
    }
    Write-Host ("{0,-22} {1,6:N2} ядра, {2:N0} соединений" -f "охват «$was»:", $first.Cores, $first.Conns)
    Write-Host ("{0,-22} {1,6:N2} ядра, {2:N0} соединений" -f "охват «$other»:", $second.Cores, $second.Conns)
    if ($first.Reach -ne $second.Reach) {
        # Сравнивать «машина в сети» с «машина без сети» нельзя: во втором
        # случае замолкает всё сразу, и Defender в первую очередь.
        $a = if ($first.Reach) { "была" } else { "не было" }
        $b = if ($second.Reach) { "была" } else { "не было" }
        Write-Host "  Вывода не будет: в «$was» сеть $a, в «$other» — $b." -ForegroundColor Red
        Write-Host "  Это сравнение работающей машины с обесточенной, а не двух охватов." -ForegroundColor Red
        exit 1
    }
    if ($first.Restarted -or $second.Restarted) {
        Write-Host "  Вывода не будет: sing-box перезапускался внутри окна, и его ЦП там не посчитан." -ForegroundColor Red
        Write-Host "  Ноль ядер здесь означает «туннель не поднялся», а не «расход исчез»: под" -ForegroundColor Red
        Write-Host "  неподтверждённым туннелем машина сидит без сети, оттого и всё остальное тихо." -ForegroundColor Red
        exit 1
    }
    $drop = $first.Cores - $second.Cores
    if ([math]::Abs($drop) -lt 0.15) {
        Write-Host "  Разницы нет. process_path ни при чём — расход не от сверки процессов." -ForegroundColor Yellow
    } elseif (($was -eq "apps") -eq ($drop -gt 0)) {
        Write-Host ("  «Выбранные приложения» дороже на {0:N2} ядра. Это и есть сверка process_path:" -f [math]::Abs($drop)) -ForegroundColor Yellow
        Write-Host "  в охвате «весь компьютер» правила нет в конфиге вовсе, и расход уходит вместе с ним."
    } else {
        Write-Host ("  Дороже оказался охват «весь компьютер», на {0:N2} ядра — версию про process_path это не подтверждает." -f [math]::Abs($drop))
    }
    exit 0
}

# Покой идёт первым и меряется всерьёз: расход, не зависящий от трафика, —
# это не цена шифрования, и искать его надо не там. С него же начинается вывод,
# потому что вычитать его придётся из обоих остальных проходов.
$idle = Measure-Window -Label "проход 0: покой, нагрузки нет" -Proxy $null -Load $false -Prompt $false
$without = Measure-Window -Label "проход 1: мимо TUN (через mixed-порт $MixedPort)" -Proxy "http://127.0.0.1:$MixedPort" -Load $true -Prompt $false
$through = Measure-Window -Label "проход 2: через TUN" -Proxy $null -Load $all -Prompt (-not $all)
# Проход 3 меняет ровно то, что меняли зря все предыдущие: число соединений.
# Байтов тут почти нет, зато соединений сотни — если расход про process_path,
# именно здесь он и подскочит.
$churn = Measure-Window -Label "проход 3: много коротких соединений" -Proxy $null -Load $false -Prompt $false -Churn $true

Write-Host ""
Write-Host "== итог ==" -ForegroundColor Cyan
Write-Host ("{0,-20} {1,7:N2} ядра" -f "покой:", $idle.Cores)
# Покой с трафиком через TUN — это не покой, а фоновая работа всей машины:
# при auto_route sing-box разбирает и те пакеты, что уйдут напрямую.
if ($idle.Packets -gt 1000) {
    Write-Host ("{0,-20} {1,7:N1} мкс на пакет при {2:N0} пакетах фона" -f "  в покое:", (1e6 * $idle.Cpu / $idle.Packets), $idle.Packets)
    Write-Host "  Трафика в туннель почти нет, а пакеты через TUN идут: с auto_route в него заходит вся машина."
}
if ($idle.Cores -gt 0.25) {
    Write-Host "  Столько ЦП без трафика — это уже не шифрование." -ForegroundColor Yellow
    # Плоскость расхода долго читалась как «холостой цикл». Это была ошибка:
    # байты я менял, а соединения — нет, и постоянная фоновая частота соединений
    # даёт ровно такую же ровную линию. Отсюда и совет ниже.
    Write-Host "  Плоский по байтам — ещё не холостой: фоновая частота соединений тоже постоянна,"
    Write-Host "  а sing-box выясняет процесс на каждом соединении, входящем в TUN. Смотрите строку"
    Write-Host "  «соединений» выше: если их тысячи, вот вам и расход, и время в ядре, и Defender рядом."
    if (-not $all) {
        Write-Host "  Решающая проверка — охват «весь компьютер»: там правила process_path нет вовсе."
    }
}

# Соединения против покоя — сравнение, которого не хватало всё это время.
$dConn = $churn.Conns - $idle.Conns
$dCpuC = $churn.Cpu - $idle.Cpu
if ($dConn -gt 50) {
    Write-Host ("{0,-20} {1,7:N0} сверх покоя, ЦП на {2:N2} с" -f "соединений:", $dConn, $dCpuC)
    if ($dCpuC -gt 0.5) {
        Write-Host ("  {0:N0} мкс на соединение: расход идёт за соединениями, а не за байтами." -f (1e6 * $dCpuC / $dConn)) -ForegroundColor Yellow
        if (-not $all) {
            Write-Host "  Это подпись process_path — сверка пути процесса на каждом соединении, входящем в TUN."
            Write-Host "  Проверка: охват «весь компьютер», там правила нет вовсе, и проход 3 обязан подешеветь."
        }
    } else {
        Write-Host "  Соединения расход не двигают — process_path вне подозрений, ищите холостой цикл."
    }
} else {
    Write-Host "  Проход 3 соединений не создал (цель недоступна?) — главное сравнение не состоялось." -ForegroundColor Yellow
}

# Предельная цена трафика: сколько ЦП добавил гигабайт СВЕРХ покоя. Считается
# по адаптеру и не ждёт удавшегося прохода 1 — а нулевая или отрицательная
# прибавка и есть главный ответ: расход постоянный, к трафику отношения не имеет.
$dGb = $through.TunGb - $idle.TunGb
$dCpu = $through.Cpu - $idle.Cpu
$dPk = $through.Packets - $idle.Packets
if ($dPk -gt 1000) {
    if ($dCpu -le 0.5) {
        Write-Host ("  Трафик вырос на {0:N0} пакетов, а ЦП — на {1:N2} с. Расход постоянный: он не про трафик." -f $dPk, $dCpu) -ForegroundColor Yellow
        Write-Host "  Ищите не цену пакета, а то, что крутится вхолостую: sing-box занят и когда делать нечего."
        # Дальше идти нельзя: цена гигабайта считается делением на прибавку,
        # а она здесь нулевая. Ровно так вывелось «цена TUN 0.00x, TUN почти
        # бесплатен» — арифметика от нуля, поданная как вывод.
        return
    } else {
        Write-Host ("{0,-20} {1,7:N1} мкс/пакет сверх покоя" -f "цена пакета:", (1e6 * $dCpu / $dPk))
        if ($dGb -gt 0.005) {
            Write-Host ("{0,-20} {1,7:N1} с/ГБ сверх покоя" -f "цена трафика:", ($dCpu / $dGb))
        }
    }
}

if ($without.PerGb -le 0 -or $through.PerGb -le 0) {
    Write-Host "  Проход без трафика — цену гигабайта по счётчику туннеля сравнить не на чем."
    return
}
# Из цены гигабайта вычитается покой: иначе постоянный расход размазывается по
# трафику и тем сильнее врёт, чем меньше успели скачать.
$netWithout = [math]::Max(0, $without.Cpu - $idle.Cpu)
$netThrough = [math]::Max(0, $through.Cpu - $idle.Cpu)
Write-Host ("{0,-20} {1,7:N2} с/ГБ  (с покоем {2:N2})" -f "мимо TUN:", ($netWithout / $without.Cpu * $without.PerGb), $without.PerGb)
Write-Host ("{0,-20} {1,7:N2} с/ГБ  (с покоем {2:N2})" -f "через TUN:", ($netThrough / $through.Cpu * $through.PerGb), $through.PerGb)
if ($netWithout -le 0) {
    Write-Host "  Мимо TUN расход не отличим от покоя — цену TUN считать не от чего."
    return
}
$ratio = $netThrough / $netWithout
Write-Host ("{0,-20} {1,7:N2} x" -f "цена TUN:", $ratio)
if ($ratio -lt 1.3) {
    Write-Host "  TUN почти бесплатен: ЦП уходит на шифрование, и это потолок протокола, а не наш конфиг."
} else {
    Write-Host "  TUN дорог. Первый подозреваемый — UDP/QUIC через gVisor: stack 'mixed' в core-tunnel/build_config."
}
