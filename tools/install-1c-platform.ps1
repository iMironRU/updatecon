<#
  Апдейкон — установка платформы 1С:Предприятие (сборка на выбор) (64-bit) для Windows
  Сформировано на upd.imiron.ru 2026-10-06

  Что делает скрипт:
    1. Показывает, какие версии платформы уже стоят на этом компьютере и какие есть на портале 1С.
    2. Предлагает: обновить установленную линейку, поставить 8.5, поставить любую сборку,
       удалить старые версии. Состав — клиент и конфигуратор, с сервером 1С или только сервер.
    3. Скачивает дистрибутив с портала 1С (releases.1c.ru) под вашей учётной записью ИТС во
       временную папку и устанавливает без вопросов. Логин и пароль ИТС уходят только на серверы 1С.
    4. Сервер регистрируется службой Windows «Агент сервера»; при обновлении службу можно
       перевести на новую сборку.
    5. После установки — по запросу: регистрация COM-компоненты (comcntr.dll), консоли
       администрирования серверов (radmin.dll), удаление скачанного дистрибутива.

  Запуск (PowerShell от имени администратора):
    powershell -ExecutionPolicy Bypass -File .\install-1c-platform.ps1

  Параметры (все необязательные; что не задано — скрипт спросит):
    -Version 8.5   номер сборки (8.5.1.1529) или линейка (8.5, 8.3.27) — последняя сборка линейки
    -Mode client   client — клиент и конфигуратор; full — ещё и сервер 1С; server — только сервер
    -Server        то же, что -Mode full
    -Com, -Admin   зарегистрировать COM-компоненту / консоль администрирования (-NoCom, -NoAdmin — не спрашивать)
    -MoveService   при обновлении перевести службу сервера на новую сборку (-KeepService — оставить)
    -RemoveFiles / -KeepFiles   удалить или оставить дистрибутив после установки
    -Yes           не спрашивать подтверждение перед установкой
    -WorkDir "D:\distr"   куда скачивать (по умолчанию — временная папка)
    -DryRun        только войти на портал и найти дистрибутив, ничего не скачивая
  Логин и пароль ИТС можно передать через переменные окружения ITS_LOGIN и ITS_PASSWORD.
  Для распаковки .rar нужен Windows 11 (tar) или установленный 7-Zip (7-zip.org).
#>
param(
  [string]$Version, [ValidateSet('', 'client', 'full', 'server')][string]$Mode = '', [switch]$Server,
  [switch]$Com, [switch]$NoCom, [switch]$Admin, [switch]$NoAdmin, [switch]$MoveService, [switch]$KeepService,
  [switch]$RemoveFiles, [switch]$KeepFiles, [switch]$Yes, [string]$WorkDir, [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Site = 'https://upd.imiron.ru'
$UA = '1C+Enterprise/8.3'
if (-not $Version) { $Version = '' }
$programFiles = $env:ProgramFiles
if (-not $programFiles) { $programFiles = 'C:\Program Files' }
$tempDir = $env:TEMP
if (-not $tempDir) { $tempDir = [IO.Path]::GetTempPath() }

# ── Helpers ──────────────────────────────────────────────────────────────────
function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Head([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host ''; Write-Host "ОШИБКА: $Text" -ForegroundColor Red; exit 1 }
function AskYes([string]$Question, [bool]$Default = $true) {
  $hint = if ($Default) { 'да/нет [да]' } else { 'да/нет [нет]' }
  $a = (Read-Host "$Question ($hint)").Trim()
  if (-not $a) { return $Default }
  return $a -match '^(д|да|y|yes)$'
}
# A numbered menu: $Items = @(@{ Key='u'; Text='…' }, …). Returns the chosen Key.
function Menu([string]$Title, [array]$Items, [string]$Default) {
  Say ''
  Say $Title 'White'
  for ($i = 0; $i -lt $Items.Count; $i++) {
    $mark = if ($Items[$i].Key -eq $Default) { '*' } else { ' ' }
    Say ("  {0}{1} — {2}" -f $mark, ($i + 1), $Items[$i].Text)
  }
  $defIdx = [array]::IndexOf(@($Items | ForEach-Object { $_.Key }), $Default) + 1
  while ($true) {
    $a = (Read-Host "Выбор [$defIdx]").Trim()
    if (-not $a) { return $Default }
    if ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le $Items.Count) { return $Items[[int]$a - 1].Key }
    $hit = $Items | Where-Object { $_.Key -eq $a }
    if ($hit) { return $hit.Key }
    Say "  Введите число от 1 до $($Items.Count)" 'Yellow'
  }
}
function Plain([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function V([string]$s) { [version]$s }
# Download with a progress line (Invoke-WebRequest's own progress bar makes Windows
# PowerShell many times slower, so it stays off). Throws on HTTP errors.
function Download([string]$Uri, [string]$Dest, $Cookies, [hashtable]$Headers) {
  $req = [Net.HttpWebRequest]::Create($Uri)
  $req.UserAgent = $UA
  $req.AllowAutoRedirect = $true
  if ($Cookies) { $req.CookieContainer = $Cookies }
  if ($Headers) { foreach ($k in $Headers.Keys) { $req.Headers[$k] = $Headers[$k] } }
  $resp = $req.GetResponse()
  try {
    $total = $resp.ContentLength
    $in = $resp.GetResponseStream()
    $out = [IO.File]::Create($Dest)
    try {
      $buf = New-Object byte[] (1MB)
      $done = 0L; $last = -1000L
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $show = {
        $sec = [Math]::Max($sw.Elapsed.TotalSeconds, 0.001)
        $speed = $done / 1MB / $sec
        if ($total -gt 0) {
          $left = if ($speed -gt 0) { [TimeSpan]::FromSeconds(($total - $done) / 1MB / $speed).ToString('hh\:mm\:ss') } else { '--:--:--' }
          $line = '  {0,5:N1}%  {1:N0} из {2:N0} МБ  {3:N1} МБ/с  осталось {4}' -f ($done * 100.0 / $total), ($done / 1MB), ($total / 1MB), $speed, $left
        } else {
          $line = '  {0:N0} МБ  {1:N1} МБ/с' -f ($done / 1MB), $speed
        }
        Write-Host ("`r" + $line.PadRight(70)) -NoNewline
      }
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $n)
        $done += $n
        if ($sw.ElapsedMilliseconds - $last -ge 1000) { $last = $sw.ElapsedMilliseconds; & $show }
      }
      & $show
      Write-Host ''
    } finally { $out.Dispose(); $in.Dispose() }
  } finally { $resp.Dispose() }
}
# A GET to the 1C portal; a dropped connection is tried again twice before giving up.
function Web([string]$Uri, $Session) {
  for ($try = 1; ; $try++) {
    try { return Invoke-WebRequest -Uri $Uri -WebSession $Session -UserAgent $UA -UseBasicParsing }
    catch {
      if ($_.Exception.Response -or $try -ge 3) {
        $hostName = ([uri]$Uri).Host
        Fail "Нет связи с $hostName ($($_.Exception.Message)). Проверьте интернет, прокси и антивирус: Test-NetConnection $hostName -Port 443 должен ответить TcpTestSucceeded : True."
      }
      Say "  Нет связи с порталом 1С, повторяю через 5 секунд ($try из 3)..." 'Yellow'
      Start-Sleep -Seconds 5
    }
  }
}
# 1C server-agent services (name, state, path); empty where there is no service manager.
function AgentServices() {
  try { return @(Get-CimInstance Win32_Service -Filter "Name LIKE '1C:Enterprise%Server Agent%'" -ErrorAction Stop) } catch { return @() }
}
# Installed platforms: version, components, whether the server service points at it.
function Installed() {
  $out = @()
  $root = "$programFiles\1cv8"
  if (-not (Test-Path $root)) { return $out }
  $services = AgentServices
  foreach ($d in Get-ChildItem $root -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' }) {
    $bin = Join-Path $d.FullName 'bin'
    $hasClient = Test-Path "$bin\1cv8.exe"
    $hasServer = Test-Path "$bin\ragent.exe"
    if (-not $hasClient -and -not $hasServer) { continue }
    $svc = $services | Where-Object { $_.PathName -like "*$($d.Name)\bin\ragent.exe*" } | Select-Object -First 1
    $out += [pscustomobject]@{
      Version = $d.Name; Dir = $d.FullName; Client = $hasClient; Server = $hasServer
      Service = if ($svc) { $svc.Name } else { $null }
      ServiceState = if ($svc) { $svc.State } else { $null }
      Com = ($hasClient -and (Test-Path "HKLM:\SOFTWARE\Classes\CLSID\{181E893D-73A4-4722-B61D-D604B3D67D47}\InprocServer32") -and
             ((Get-ItemProperty "HKLM:\SOFTWARE\Classes\CLSID\{181E893D-73A4-4722-B61D-D604B3D67D47}\InprocServer32" -ErrorAction SilentlyContinue).'(default)' -like "*$($d.Name)*"))
    }
  }
  return @($out | Sort-Object { V $_.Version })
}
function Describe($p) {
  $parts = @()
  if ($p.Client) { $parts += 'клиент, конфигуратор' }
  if ($p.Server) { $parts += 'сервер' }
  $s = $parts -join ', '
  if ($p.Service) { $s += " (служба $($p.ServiceState.ToLower() -replace 'running','работает' -replace 'stopped','остановлена'))" }
  if ($p.Com) { $s += ', COM' }
  return $s
}
# msiexec for a build; the unpacked folder must hold the .msi.
function RunMsi([string]$MsiPath, [bool]$WithClient, [bool]$WithServer, [string]$Log) {
  $c = [int]$WithClient; $sv = [int]$WithServer
  $props = @("DESIGNERALLCLIENTS=$c", "THICKCLIENT=$c", "THINCLIENTFILE=$c", "THINCLIENT=$c", 'WEBSERVEREXT=0',
             'CONFREPOSSERVER=0', 'CONVERTER77=0', 'LANGUAGES=RU', "SERVER=$sv", "SERVERCLIENT=$sv")
  $dir = Split-Path $MsiPath -Parent
  $transforms = @('adminstallrelogon.mst', '1049.mst') | Where-Object { Test-Path (Join-Path $dir $_) }
  $line = '/i "' + $MsiPath + '" /qn /norestart'
  if ($transforms) { $line += ' TRANSFORMS="' + (($transforms | ForEach-Object { Join-Path $dir $_ }) -join ';') + '"' }
  $line += ' ' + ($props -join ' ') + ' /l*v "' + $Log + '"'
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $line -Wait -PassThru
  return $p.ExitCode
}
function Regsvr([string]$Dll, [string]$What) {
  if (-not (Test-Path $Dll)) { Say "  Нет файла $Dll — $What не зарегистрирована." 'Yellow'; return }
  $p = Start-Process regsvr32.exe -ArgumentList @('/s', "`"$Dll`"") -Wait -PassThru
  if ($p.ExitCode -eq 0) { Say "  $What зарегистрирована: $Dll" 'Green' } else { Say "  regsvr32 вернул код $($p.ExitCode) для $Dll" 'Yellow' }
}

# ── Start ────────────────────────────────────────────────────────────────────
Head 'Апдейкон: установка платформы 1С:Предприятие (64-bit) для Windows'
$isAdmin = $false
try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
if (-not $isAdmin -and -not $DryRun) { Fail 'Нужны права администратора: откройте PowerShell через «Запуск от имени администратора» и запустите скрипт снова.' }

# ── What is installed, what the portal has ───────────────────────────────────
$have = Installed
try { $builds = @((Invoke-RestMethod "$Site/api/platform" -UseBasicParsing).builds | Where-Object { $_.v -match '^8\.[35]\.' }) }
catch { Fail "Не удалось получить список сборок с ${Site}: $($_.Exception.Message)" }
$newest = { param($prefix) $builds | Where-Object { $_.v -like "$prefix.*" } | Sort-Object { V $_.v } -Descending | Select-Object -First 1 }
$l83 = & $newest '8.3'; $l85 = & $newest '8.5'
$fmtDate = { param($d) if ($d) { ([datetime]$d).ToString('dd.MM.yyyy') } else { '' } }

Say ''
if ($have.Count -eq 0) { Say 'На этом компьютере платформа 1С не установлена.' }
else {
  Say 'Установлено на этом компьютере:' 'White'
  foreach ($p in $have) { Say ("  {0,-14} {1}" -f $p.Version, (Describe $p)) }
}
Say 'Доступно на портале 1С:' 'White'
Say ("  8.3  →  {0,-14} вышла {1}" -f $l83.v, (& $fmtDate $l83.date))
Say ("  8.5  →  {0,-14} вышла {1}" -f $l85.v, (& $fmtDate $l85.date))

# ── Action ───────────────────────────────────────────────────────────────────
$Version = "$Version".Trim()
$base = $null             # the installed build we update from (its components + service carry over)
$action = ''
if ($Version) {
  $action = 'install'
} else {
  $items = @()
  $old83 = @($have | Where-Object { $_.Version -like '8.3.*' -and (V $_.Version) -lt (V $l83.v) }) | Select-Object -Last 1
  $has83new = $have | Where-Object { $_.Version -eq $l83.v }
  $has85new = $have | Where-Object { $_.Version -eq $l85.v }
  if ($old83) { $items += @{ Key = 'up83'; Text = "Обновить 8.3: $($old83.Version) → $($l83.v)" } }
  elseif ($has83new) { $items += @{ Key = 'has83'; Text = "8.3 уже последняя ($($l83.v))" } }
  else { $items += @{ Key = 'i83'; Text = "Установить 8.3 ($($l83.v))" } }
  if ($has85new) { $items += @{ Key = 'has85'; Text = "8.5 уже последняя ($($l85.v))" } }
  else { $items += @{ Key = 'i85'; Text = "Установить 8.5 ($($l85.v))" } }
  $items += @{ Key = 'other'; Text = 'Установить другую сборку (ввести номер или линейку)' }
  if ($have.Count -gt 1) { $items += @{ Key = 'clean'; Text = 'Удалить старые версии платформы' } }
  $items += @{ Key = 'dry'; Text = 'Только проверить вход на портал 1С' }
  $items += @{ Key = 'quit'; Text = 'Выход' }
  $def = if ($old83) { 'up83' } elseif (-not $has83new -and -not $has85new) { 'i83' } elseif (-not $has85new) { 'i85' } else { 'quit' }
  switch (Menu 'Что сделать?' $items $def) {
    'up83' { $Version = $l83.v; $base = $old83; $action = 'install' }
    'i83'  { $Version = $l83.v; $action = 'install' }
    'i85'  { $Version = $l85.v; $action = 'install' }
    'other' { $Version = (Read-Host 'Номер сборки (8.3.24.1819) или линейка (8.3.24, 8.5)').Trim(); $action = 'install' }
    'clean' { $action = 'clean' }
    'dry' { $DryRun = $true; $Version = $l83.v; $action = 'install' }
    'has83' { Say 'Уже установлена.'; exit 0 }
    'has85' { Say 'Уже установлена.'; exit 0 }
    default { exit 0 }
  }
}

# ── Remove old versions ──────────────────────────────────────────────────────
if ($action -eq 'clean') {
  $newestEach = @{}
  foreach ($p in $have) { $k = ($p.Version -split '\.')[0..2] -join '.'; if (-not $newestEach[$k] -or (V $p.Version) -gt (V $newestEach[$k])) { $newestEach[$k] = $p.Version } }
  $cands = @($have | Where-Object { $newestEach[(($_.Version -split '\.')[0..2] -join '.')] -ne $_.Version -and -not $_.Service })
  if ($cands.Count -eq 0) { Say 'Удалять нечего: в каждой линейке стоит одна сборка (или на ней работает служба сервера).'; exit 0 }
  Say ''
  Say 'Можно удалить (в каждой линейке остаётся новейшая сборка; версии со службой сервера не трогаю):' 'White'
  foreach ($p in $cands) { Say ("  {0,-14} {1}" -f $p.Version, (Describe $p)) }
  if (-not (AskYes 'Удалить эти версии?' $false)) { exit 0 }
  foreach ($p in $cands) {
    $prod = Get-CimInstance Win32_Product -Filter "Name LIKE '1C:Enterprise%' AND Version = '$($p.Version)'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $prod) { $prod = Get-CimInstance Win32_Product -Filter "Name LIKE '1C:Enterprise%'" -ErrorAction SilentlyContinue | Where-Object { $_.InstallLocation -like "*$($p.Version)*" } | Select-Object -First 1 }
    if (-not $prod) { Say "  $($p.Version): запись установщика не найдена, удалите через «Параметры → Приложения»." 'Yellow'; continue }
    Say "  Удаляю $($p.Version)..."
    $r = Start-Process msiexec.exe -ArgumentList @('/x', $prod.IdentifyingNumber, '/qn', '/norestart') -Wait -PassThru
    if ($r.ExitCode -eq 0 -or $r.ExitCode -eq 3010) { Say "  $($p.Version) удалена" 'Green' } else { Say "  msiexec вернул код $($r.ExitCode)" 'Yellow' }
  }
  exit 0
}

# ── Resolve the build ────────────────────────────────────────────────────────
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  $line = $Version
  $b = & $newest $line
  if (-not $b) { Fail "В каталоге нет сборок линейки $line. Список: $Site/platform" }
  $Version = $b.v
}
if ($Version -notmatch '^8\.[35]\.') { Fail "Скрипт ставит платформы 8.3 и 8.5, а указана $Version" }
$Under = $Version.Replace('.', '_')
$Major = (($Version -split '\.')[0..1]) -join '.'
$Nick = 'Platform' + $Major.Replace('.', '')
$installDir = "$programFiles\1cv8\$Version"
$existing = $have | Where-Object { $_.Version -eq $Version }
if (-not $base) { $base = @($have | Where-Object { $_.Version -like "$Major.*" -and $_.Version -ne $Version }) | Select-Object -Last 1 }

# ── Components ───────────────────────────────────────────────────────────────
if ($Server -and -not $Mode) { $Mode = 'full' }
if (-not $Mode -and $DryRun) { $Mode = 'client' }
if (-not $Mode) {
  $sameAs = $null
  if ($base) { $sameAs = if ($base.Server -and $base.Client) { 'full' } elseif ($base.Server) { 'server' } else { 'client' } }
  $items = @(
    @{ Key = 'client'; Text = 'Клиент и конфигуратор (рабочее место)' },
    @{ Key = 'full';   Text = 'Клиент, конфигуратор и сервер 1С со службой «Агент сервера»' },
    @{ Key = 'server'; Text = 'Только сервер 1С со службой «Агент сервера»' }
  )
  if ($sameAs) { $items = @($items | ForEach-Object { if ($_.Key -eq $sameAs) { @{ Key = $_.Key; Text = $_.Text + " — как у $($base.Version)" } } else { $_ } }) }
  $Mode = Menu 'Что установить?' $items $(if ($sameAs) { $sameAs } else { 'client' })
}
$withClient = $Mode -ne 'server'
$withServer = $Mode -ne 'client'
if ($existing) {
  if ($withServer -and -not $existing.Server) { Fail "Платформа $Version уже установлена без сервера. Добавьте компонент «Сервер 1С:Предприятия» через «Параметры → Приложения» (Изменить) или удалите эту версию и запустите скрипт снова." }
  if (-not $withServer -and $withClient -and -not $existing.Client) { Fail "Платформа $Version уже установлена без клиента. Добавьте клиент через «Параметры → Приложения» (Изменить)." }
}

# Service: a running agent on the base build can be moved to the new one.
$moveSvc = $false
$svcToMove = $null
if ($withServer -and $base -and $base.Service) {
  $svcToMove = $base.Service
  if ($MoveService) { $moveSvc = $true }
  elseif (-not $KeepService -and -not $DryRun) {
    Say ''
    Say "На $($base.Version) работает служба сервера «$svcToMove»." 'White'
    Say 'Перевод службы на новую сборку останавливает её: все сеансы на этом сервере отвалятся.' 'Yellow'
    $moveSvc = AskYes "Перевести службу на $Version после установки?" $false
  }
}
# COM / admin console — asked after the install unless given as parameters.

# ── Summary ──────────────────────────────────────────────────────────────────
$needMb = 3500
$driveName = $programFiles.Substring(0, 1)
$freeMb = -1
try { $freeMb = [Math]::Round((Get-PSDrive $driveName -ErrorAction Stop).Free / 1MB) } catch { }
if (-not $WorkDir) { $WorkDir = Join-Path $tempDir "updatecon-platform-$Under" }
Head 'Сводка'
Say ("  Сборка:        {0}  (вышла {1}, изменения: {2}/platform?build={0})" -f $Version, (& $fmtDate (($builds | Where-Object { $_.v -eq $Version }).date)), $Site)
Say ("  Состав:        {0}" -f @{ client = 'клиент и конфигуратор'; full = 'клиент, конфигуратор и сервер 1С'; server = 'сервер 1С' }[$Mode])
Say ("  Куда:          {0}" -f $installDir)
if ($existing) { Say '  Уже установлена — скачивать и ставить не нужно' }
else { Say ("  Скачать:       ~1 ГБ во временную папку {0}" -f $WorkDir) }
if ($withServer) {
  if ($moveSvc) { Say "  Служба:        «$svcToMove» будет переведена на $Version" }
  elseif ($svcToMove) { Say "  Служба:        «$svcToMove» остаётся на $($base.Version)" }
  elseif ((AgentServices).Count -gt 0) { Say '  Служба:        уже есть другая, новую не создаю' }
  else { Say '  Служба:        будет создана «Агент сервера», порты 1540, 1541, 1560-1591' }
}
if ($freeMb -ge 0) { Say ("  Место на {0}:   свободно {1:N0} МБ, нужно около {2:N0} МБ" -f $driveName, $freeMb, $needMb) }
if (-not $existing -and $freeMb -ge 0 -and $freeMb -lt $needMb) { Fail "Мало места на диске ${driveName}: освободите хотя бы $needMb МБ." }
if (-not $existing -and -not $DryRun) {
  $canUnpack = (Test-Path "$env:SystemRoot\System32\tar.exe") -or (Test-Path "$programFiles\7-Zip\7z.exe") -or (Test-Path "${env:ProgramFiles(x86)}\7-Zip\7z.exe") -or (Test-Path "$programFiles\WinRAR\UnRAR.exe")
  if (-not $canUnpack) { Fail 'Нечем распаковать .rar: установите 7-Zip (7-zip.org) и запустите скрипт снова.' }
}
if (-not $Yes -and -not $DryRun) { if (-not (AskYes 'Продолжить?')) { exit 0 } }

# ── Download + unpack + install ──────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path
$unpacked = Join-Path $WorkDir 'setup'
$servicesBefore = @(AgentServices | ForEach-Object { $_.Name })

if (-not $existing) {
  $msi = Get-ChildItem -Path $unpacked -Filter '*.msi' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $msi) {
    $archive = Get-ChildItem -Path $WorkDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "^windows64full_$Under\.(rar|zip)$" } | Select-Object -First 1
    if (-not $archive) {
      # ── Portal login (login.1c.ru), then the build's file list ─────────────
      $itsLogin = $env:ITS_LOGIN
      $itsPass = $env:ITS_PASSWORD
      if (-not $itsLogin -or -not $itsPass) {
        Say ''
        Say 'Дистрибутив скачивается с портала 1С под учётной записью ИТС.'
        $itsLogin = Read-Host 'Логин ИТС'
        $itsPass = Plain (Read-Host 'Пароль ИТС (вставка — правой кнопкой мыши)' -AsSecureString)
      }
      $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
      $loginUrl = 'https://login.1c.ru/login?service=' + [uri]::EscapeDataString('https://releases.1c.ru/public/security_check')
      Say 'Вхожу на портал 1С...'
      $page = Web $loginUrl $session
      $execution = [regex]::Match($page.Content, 'name="execution"\s+value="([^"]+)"').Groups[1].Value
      if (-not $execution) { Fail "Страница входа 1С изменилась, скрипт нужно обновить: $Site/platform" }
      $badLogin = 'Портал 1С не принял логин и пароль ИТС. Пароль вводится без отображения: звёздочек должно быть столько, сколько символов. Вставить пароль в это окно можно правой кнопкой мыши (Ctrl+V здесь не работает).'
      try {
        $null = Invoke-WebRequest -Uri $loginUrl -Method Post -WebSession $session -UserAgent $UA -UseBasicParsing -MaximumRedirection 10 `
          -Body @{ username = $itsLogin; password = $itsPass; execution = $execution; _eventId = 'submit' }
      } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401 -or $code -eq 403) { Fail $badLogin }
        Fail "Портал 1С не ответил на вход: $($_.Exception.Message)"
      }
      $list = (Web "https://releases.1c.ru/version_files?nick=$Nick&ver=$Version" $session).Content
      if ($list -match 'name="execution"') { Fail $badLogin }
      $href = [regex]::Match($list, 'href="(/version_file\?[^"]*windows64full_' + $Under + '\.(?:rar|zip))"').Groups[1].Value
      if (-not $href) { Fail "У сборки $Version на портале нет дистрибутива «Технологическая платформа (64-bit) для Windows»." }
      $href = $href.Replace('&amp;', '&')
      $name = ([uri]::UnescapeDataString($href) -split '[\\/]')[-1]
      $filePage = (Web ('https://releases.1c.ru' + $href) $session).Content
      $mirrors = @([regex]::Matches($filePage, 'href="(https://dl\d*\.1c\.ru/[^"]+)"') | ForEach-Object { $_.Groups[1].Value.Replace('&amp;', '&') } | Select-Object -Unique)
      if ($mirrors.Count -eq 0) { Fail "Не найдена ссылка на скачивание $name, скрипт нужно обновить: $Site/platform" }
      Say "Дистрибутив: $name" 'Green'
      if ($DryRun) { Say "Проверка прошла: вход на портал работает, ссылка на скачивание найдена ($($mirrors.Count))."; exit 0 }

      $dest = Join-Path $WorkDir $name
      $done = $false
      foreach ($m in $mirrors) {
        Say "Скачиваю $name..."
        try {
          Download $m "$dest.part" $session.Cookies
          Move-Item "$dest.part" $dest -Force
          $done = $true
          break
        } catch {
          Remove-Item "$dest.part" -ErrorAction SilentlyContinue
          Write-Host ''
          Say "  Не получилось ($($_.Exception.Message)), пробую зеркало..." 'Yellow'
        }
      }
      if (-not $done) { Fail "Не удалось скачать $name ни с одного зеркала 1С." }
      $archive = Get-Item $dest
    }

    # ── Unpack ──────────────────────────────────────────────────────────────
    Say "Распаковываю $($archive.Name)..."
    New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
    if ($archive.Extension -eq '.zip') {
      Expand-Archive -Path $archive.FullName -DestinationPath $unpacked -Force
    } else {
      $tools = @(
        @{ Exe = "$env:SystemRoot\System32\tar.exe"; Args = @('-xf', $archive.FullName, '-C', $unpacked) },
        @{ Exe = "$programFiles\7-Zip\7z.exe"; Args = @('x', '-y', "-o$unpacked", $archive.FullName) },
        @{ Exe = "${env:ProgramFiles(x86)}\7-Zip\7z.exe"; Args = @('x', '-y', "-o$unpacked", $archive.FullName) },
        @{ Exe = "$programFiles\WinRAR\UnRAR.exe"; Args = @('x', '-y', $archive.FullName, "$unpacked\") }
      )
      foreach ($t in $tools) {
        if (-not (Test-Path $t.Exe)) { continue }
        # Windows PowerShell turns a native tool's stderr into terminating errors under 'Stop'.
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { & $t.Exe @($t.Args) *> $null } catch { } finally { $ErrorActionPreference = $eap }
        if (Get-ChildItem -Path $unpacked -Filter '*.msi' -Recurse -ErrorAction SilentlyContinue) { break }
      }
    }
    $msi = Get-ChildItem -Path $unpacked -Filter '*.msi' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $msi) { Fail "Не удалось распаковать $($archive.Name). Установите 7-Zip (7-zip.org) и запустите скрипт снова — скачанный дистрибутив повторно не скачивается." }
  }

  # ── Install ───────────────────────────────────────────────────────────────
  $log = Join-Path $WorkDir 'install.log'
  Say 'Устанавливаю платформу (несколько минут)...'
  $code = RunMsi $msi.FullName $withClient $withServer $log
  if ($code -ne 0 -and $code -ne 3010) { Fail "Установщик завершился с кодом $code. Журнал установки: $log" }
  if ($code -eq 3010) { Say 'Установщик просит перезагрузить компьютер после установки.' 'Yellow' }
  if (-not (Test-Path "$installDir\bin")) { Fail "Установщик закончил работу, но папки $installDir\bin нет. Журнал установки: $log" }
  Say "Платформа $Version установлена: $installDir" 'Green'
} elseif ($DryRun) {
  Say "Платформа $Version уже установлена: проверять нечего."; exit 0
} else {
  Say "Платформа $Version уже установлена: $installDir" 'Green'
}

# ── Server agent service ─────────────────────────────────────────────────────
if ($withServer) {
  $ragent = "$installDir\bin\ragent.exe"
  if (-not (Test-Path $ragent)) { Fail "Нет файла $ragent — серверная часть не установилась. Журнал установки: $(Join-Path $WorkDir 'install.log')" }
  $services = AgentServices
  $new = @($services | Where-Object { $servicesBefore -notcontains $_.Name })
  $mine = $services | Where-Object { $_.PathName -like "*$Version\bin\ragent.exe*" } | Select-Object -First 1
  if ($moveSvc -and $svcToMove) {
    $svc = Get-CimInstance Win32_Service -Filter "Name = '$svcToMove'"
    $newPath = $svc.PathName -replace [regex]::Escape($base.Dir), $installDir
    # The installer may have created its own service for the new build — it would fight for the ports.
    foreach ($n in $new) { Stop-Service $n.Name -Force -ErrorAction SilentlyContinue; & sc.exe delete $n.Name | Out-Null }
    Say "  Останавливаю «$svcToMove»..."
    Stop-Service $svcToMove -Force
    & sc.exe config "$svcToMove" binPath= "$newPath" | Out-Null
    Start-Service $svcToMove
    Say "  Служба «$svcToMove» переведена на $Version и запущена." 'Green'
  } elseif ($mine) {
    Say "Служба сервера на $Version есть: $($mine.Name) ($($mine.State))" 'Green'
    if ($new.Count -gt 0 -and $services.Count -gt $new.Count) { Say "  Внимание: установщик создал службу, а другая служба сервера уже работает — у них общие порты." 'Yellow' }
  } elseif ($services.Count -gt 0) {
    Say "Служба сервера 1С уже есть: $($services[0].Name) на другой сборке. Новую не создаю, чтобы не было конфликта портов." 'Yellow'
    Say "Перевести её на ${Version}: запустите скрипт снова и ответьте «да» на вопрос о переводе службы." 'Yellow'
  } else {
    $srvinfo = "$programFiles\1cv8\srvinfo"
    New-Item -ItemType Directory -Force -Path $srvinfo | Out-Null
    $bin = '"' + $ragent + '" -srvc -agent -regport 1541 -port 1540 -range 1560:1591 -d "' + $srvinfo + '" -debug'
    $svc = "1C:Enterprise $Major Server Agent (x86-64)"
    New-Service -Name $svc -BinaryPathName $bin -DisplayName "Агент сервера 1С:Предприятия $Major (x86-64)" -StartupType Automatic | Out-Null
    Start-Service -Name $svc
    Say "Служба «$svc» создана и запущена (порты 1540, 1541, 1560-1591)." 'Green'
    Say '  Работает под LocalSystem; при необходимости смените учётную запись в свойствах службы.'
  }
}

# ── After the install: COM, admin console ────────────────────────────────────
Head 'После установки'
$doCom = $false
if ($withClient) {
  if ($Com) { $doCom = $true } elseif (-not $NoCom) {
    $doCom = AskYes "Зарегистрировать COM-компоненту $Version (V83.COMConnector — внешние подключения, обмены)?" $false
  }
  if ($doCom) { Regsvr "$installDir\bin\comcntr.dll" 'COM-компонента' }
}
$doAdmin = $false
if ($Admin) { $doAdmin = $true } elseif (-not $NoAdmin) {
  $doAdmin = AskYes 'Зарегистрировать консоль администрирования серверов 1С (radmin.dll, оснастка «Администрирование серверов»)?' $withServer
}
if ($doAdmin) {
  Regsvr "$installDir\bin\radmin.dll" 'Консоль администрирования'
  $msc = "$installDir\common\1CV8 Servers.msc"
  if (Test-Path $msc) { Say "  Оснастка: `"$msc`"" }
}

# ── The downloaded distribution ──────────────────────────────────────────────
Say ''
Say "Готово: платформа $Version — $installDir" 'Green'
if (Test-Path $WorkDir) {
  $log = Join-Path $WorkDir 'install.log'
  $keptLog = Join-Path $tempDir "updatecon-platform-$Under-install.log"
  if (Test-Path $log) { Copy-Item $log $keptLog -Force }
  $sizeMb = [Math]::Round(((Get-ChildItem $WorkDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB)
  if ($sizeMb -gt 0) {
    $remove = $RemoveFiles -or (-not $KeepFiles -and (AskYes "Удалить скачанный дистрибутив ($sizeMb МБ, $WorkDir)?"))
    if ($remove) {
      Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
      Say "Дистрибутив удалён. Журнал установки: $keptLog"
    } else {
      Say "Дистрибутив и журнал установки: $WorkDir"
      if (-not $KeepFiles -and (AskYes 'Открыть папку с дистрибутивом?' $false)) { Invoke-Item $WorkDir }
    }
  } else { Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# The same run without questions:
$repeat = @("-Version $Version", "-Mode $Mode", '-Yes')
if ($moveSvc) { $repeat += '-MoveService' } elseif ($svcToMove) { $repeat += '-KeepService' }
if ($withClient) { $repeat += $(if ($doCom) { '-Com' } else { '-NoCom' }) }
$repeat += $(if ($doAdmin) { '-Admin' } else { '-NoAdmin' })
$repeat += $(if ($remove) { '-RemoveFiles' } else { '-KeepFiles' })
Say ''
Say 'Повторить то же самое на другой машине без вопросов:' 'White'
Say ("  powershell -ExecutionPolicy Bypass -File .\install-1c-platform.ps1 " + ($repeat -join ' '))
