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
    [string]$TunName = "Privacy Gateway"
)

$ErrorActionPreference = "Stop"
$cores = [int]$env:NUMBER_OF_PROCESSORS

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
        $c = Invoke-RestMethod "http://127.0.0.1:$ApiPort/connections" -TimeoutSec 3
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
    param([string]$Label, [string]$Proxy, [bool]$Load, [bool]$Prompt)

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
    $job = $null
    if ($Load) {
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
    $b = Get-Snapshot
    $t1 = Get-ThreadTimes $mainId
    if ($job) {
        Stop-Job $job -ErrorAction SilentlyContinue
        $err = @(Receive-Job $job -ErrorAction SilentlyContinue) | Where-Object { $_ }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        if ($err) {
            Write-Host ("  закачка не пошла: {0}" -f ($err -join '; ')) -ForegroundColor Yellow
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
    $krnShare = 0
    if ($myCpu -gt 0) { $krnShare = 100 * $myKrn / $myCpu }
    Write-Host ("{0,-20} {1,7:N0} %   много — работа в ядре: wintun, WFP, драйвер" -f "из них в ядре:", $krnShare)
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

    $perGb = 0.0
    if ($myCpu -gt 0 -and $gb -gt 0.01) { $perGb = $myCpu / $gb }
    [pscustomobject]@{
        Cpu     = $myCpu           # секунд ЦП за окно
        Cores   = $myCpu / $elapsed   # во сколько ядер это обошлось
        PerGb   = $perGb           # по счётчику туннеля; 0, если трафика не было
        TunGb   = $tunGb           # весь трафик через адаптер
        Packets = $packets
    }
}

$scope = if ($all) { "весь компьютер" } else { "выбранные приложения ($apps шт.)" }
Write-Host "Ядер: $cores.  Охват: $scope"

# Правила брандмауэра — статья расхода, с трафиком через туннель не связанная:
# осиротевшее правило WFP разбирает на каждом исходящем соединении в системе,
# своём и чужом, и переживает перезагрузку.
$rules = @(Get-NetFirewallRule -DisplayName 'Privacy Gateway: *' -ErrorAction SilentlyContinue)
Write-Host "Правил 'Privacy Gateway: *': $($rules.Count)"
if ($rules.Count -gt $apps + 1) {
    Write-Host "  больше, чем включённых приложений — похоже на осиротевшие, снимает их sweep() при выключении" -ForegroundColor Yellow
}

# Покой идёт первым и меряется всерьёз: расход, не зависящий от трафика, —
# это не цена шифрования, и искать его надо не там. С него же начинается вывод,
# потому что вычитать его придётся из обоих остальных проходов.
$idle = Measure-Window -Label "проход 0: покой, нагрузки нет" -Proxy $null -Load $false -Prompt $false
$without = Measure-Window -Label "проход 1: мимо TUN (через mixed-порт $MixedPort)" -Proxy "http://127.0.0.1:$MixedPort" -Load $true -Prompt $false
$through = Measure-Window -Label "проход 2: через TUN" -Proxy $null -Load $all -Prompt (-not $all)

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
    Write-Host "  Сверка process_path тут ни при чём: работа на соединение росла бы вместе с трафиком,"
    Write-Host "  а этот расход плоский. Плоский, в ядре, размазанный по потокам — подпись холостого цикла."
    Write-Host "  Проверка без остановки службы: откройте браузерный сеанс. Он поднимает второй sing-box"
    Write-Host "  БЕЗ TUN, и разбивка по pid выше покажет обоих — дешёвый там расход, дорогой тут."
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
