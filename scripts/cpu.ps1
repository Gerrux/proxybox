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

  Запуск от администратора:

      powershell -ExecutionPolicy Bypass -File scripts\cpu.ps1
#>
[CmdletBinding()]
param(
    # Окно замера. Короче 10 с всплеск сборщика мусора перебивает сигнал.
    [int]$Seconds = 20,
    # Что качать. По умолчанию — открытая мерилка Cloudflare без регистрации;
    # свой сервер подставляется сюда же, больше скрипт наружу не ходит.
    [string]$Url = "https://speed.cloudflare.com/__down?bytes=104857600",
    # Порты службы: mixed (обход TUN) и Clash API (счётчики байт).
    [int]$MixedPort = 48292,
    [int]$ApiPort = 48293
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

$loader = {
    param($url, $proxy, $seconds, $tmp)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $seconds) {
        try {
            $c = New-Object Net.WebClient
            $c.Proxy = if ($proxy) { New-Object Net.WebProxy($proxy) } else { $null }
            $c.DownloadFile($url, $tmp)
        } catch { break }
    }
    Remove-Item $tmp -ErrorAction SilentlyContinue
}

# Возвращает одно число — цену трафика в с/ГБ. Всё остальное печатается через
# Write-Host: голая строка в PowerShell уходит в возвращаемое значение и
# смешалась бы с ним.
function Measure-Window {
    param([string]$Label, [string]$Proxy, [bool]$Auto)

    Write-Host ""
    Write-Host "== $Label ==" -ForegroundColor Cyan
    if (-not $Auto) {
        Write-Host "Запустите большую закачку выбранным приложением и нажмите Enter — окно $Seconds с" -NoNewline
        [void](Read-Host)
    }

    $mainId = (Get-Process sing-box | Select-Object -First 1).Id
    $t0 = Get-ThreadTimes $mainId
    $a = Get-Snapshot
    $b0 = Get-TrafficBytes
    $job = $null
    if ($Auto) {
        # GetTempPath, а не $env:TEMP: переменная бывает пустой, а с
        # ErrorActionPreference=Stop пустой путь убил бы замер посреди окна.
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "pg-cpu.bin"
        $job = Start-Job -ScriptBlock $loader -ArgumentList $Url, $Proxy, $Seconds, $tmp
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds $Seconds
    $elapsed = $sw.Elapsed.TotalSeconds
    $b1 = Get-TrafficBytes
    $b = Get-Snapshot
    $t1 = Get-ThreadTimes $mainId
    if ($job) {
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    }

    # Считаем только процессы, дожившие до конца окна: у мелькнувшего между
    # снимками нет базы для вычитания, и его время ушло бы в общую сумму целиком.
    $delta = foreach ($id in $b.Keys) {
        if (-not $a.ContainsKey($id)) { continue }
        [pscustomobject]@{
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

    Write-Host ("{0,-20} {1,7:N1} с   {2,5:N0}% одного ядра, {3,3:N0}% машины" -f `
        "sing-box, ЦП:", $myCpu, (100 * $myCpu / $elapsed), (100 * $myCpu / $elapsed / $cores))
    $krnShare = 0
    if ($myCpu -gt 0) { $krnShare = 100 * $myKrn / $myCpu }
    Write-Host ("{0,-20} {1,7:N0} %   много — работа в ядре: wintun, WFP, драйвер" -f "из них в ядре:", $krnShare)
    $myShare = 0
    if ($total -gt 0) { $myShare = 100 * $myCpu / $total }
    Write-Host ("{0,-20} {1,7:N1} с   {2,3:N0}% машины, доля sing-box в этом — {3:N0}%" -f `
        "вся машина, ЦП:", $total, (100 * $total / $elapsed / $cores), $myShare)

    if ($gb -lt 0) {
        Write-Host "  Clash API не ответил на $ApiPort — байты не посчитаны"
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

    if ($myCpu -gt 0 -and $gb -gt 0.01) { $myCpu / $gb } else { 0 }
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

$without = Measure-Window -Label "проход 1: мимо TUN (через mixed-порт $MixedPort)" -Proxy "http://127.0.0.1:$MixedPort" -Auto $true
$through = Measure-Window -Label "проход 2: через TUN" -Proxy $null -Auto $all

Write-Host ""
Write-Host "== итог ==" -ForegroundColor Cyan
if ($without -le 0 -or $through -le 0) {
    Write-Host "  Один из проходов остался без трафика — сравнивать нечего."
    return
}
$ratio = $through / $without
Write-Host ("{0,-20} {1,7:N2} с/ГБ" -f "мимо TUN:", $without)
Write-Host ("{0,-20} {1,7:N2} с/ГБ" -f "через TUN:", $through)
Write-Host ("{0,-20} {1,7:N2} x" -f "цена TUN:", $ratio)
if ($ratio -lt 1.3) {
    Write-Host "  TUN почти бесплатен: ЦП уходит на шифрование, и это потолок протокола, а не наш конфиг."
} else {
    Write-Host "  TUN дорог. Первый подозреваемый — UDP/QUIC через gVisor: stack 'mixed' в core-tunnel/build_config."
    if (-not $all) {
        Write-Host "  Второй — сверка process_path на каждом соединении. Повторите в охвате «весь компьютер»: там правила нет вовсе."
    }
}
