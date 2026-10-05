<#
  Апдейкон — обновление конфигурации 1С по цепочке
  @@TITLE@@: @@FROM@@ -> @@TO@@ (@@STEPS_TEXT@@)
  Сформировано на @@SITE@@ @@DATE@@

  Что делает скрипт:
    1. Скачивает файлы обновлений с downloads.v8.1c.ru под вашей учётной записью ИТС
       (так же, как конфигуратор при обновлении через интернет). Логин и пароль ИТС
       уходят только на сервер 1С и нигде не сохраняются.
    2. Делает выгрузку информационной базы (.dt), чтобы можно было откатиться.
    3. Применяет обновления по порядку в пакетном режиме конфигуратора
       и после каждого шага обновляет конфигурацию базы данных.
    4. Запускает базу в режиме предприятия, чтобы выполнились обработчики обновления.
    При ошибке скрипт останавливается и показывает журнал конфигуратора.

  Перед запуском:
    - все пользователи должны выйти из базы;
    - у пользователя базы, под которым идёт обновление, должны быть административные права;
    - доработанные конфигурации (с изменениями или снятые с поддержки) этим скриптом
      не обновить, их обновляют вручную в конфигураторе.

  Запуск:
    powershell -ExecutionPolicy Bypass -File .\@@FILE@@

  Параметры (все необязательные, недостающее скрипт спросит):
    -Base "C:\Bases\Buh"            файловая база: папка с файлом 1Cv8.1CD
    -Server "srv1c" -Ref "buh"      база на сервере 1С: сервер (можно с портом) и имя базы
    -User "Администратор"           пользователь базы
    -Platform "C:\Program Files\1cv8\8.3.27.2342\bin\1cv8.exe"
    -WorkDir "D:\updatecon"         куда скачивать обновления и писать журналы
    -NoBackup                       не делать выгрузку .dt
    -HandlersEachStep               запускать обработчики обновления после каждого шага
    -DownloadOnly                   только скачать файлы обновлений
  Логин и пароль ИТС можно передать через переменные окружения ITS_LOGIN и ITS_PASSWORD,
  пароль пользователя базы — через IB_PASSWORD.
#>
param(
  [string]$Base, [string]$Server, [string]$Ref, [string]$User, [string]$Platform, [string]$WorkDir,
  [switch]$NoBackup, [switch]$HandlersEachStep, [switch]$DownloadOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # otherwise Invoke-WebRequest is many times slower
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Title = @@TITLE_Q@@
$FromVersion = @@FROM_Q@@
$ToVersion = @@TO_Q@@
$Site = @@SITE_Q@@
$Steps = @(
@@STEPS@@
)

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Fail([string]$Text) { Write-Host ''; Write-Host "ОШИБКА: $Text" -ForegroundColor Red; exit 1 }
function Q([string]$Text) { '"' + $Text.Replace('"', '""') + '"' }
function Plain([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
# Download with a progress line (Invoke-WebRequest's own progress bar makes Windows
# PowerShell many times slower, so it stays off). Throws on HTTP errors.
function Download([string]$Uri, [string]$Dest, $Cookies, [hashtable]$Headers) {
  $req = [Net.HttpWebRequest]::Create($Uri)
  $req.UserAgent = '1C+Enterprise/8.3'
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
function AskYes([string]$Question) { (Read-Host "$Question (да/нет)") -match '^(д|да|y|yes)$' }

Say ''
Say "Апдейкон: $Title" 'Cyan'
Say ("Обновление {0} -> {1}, шагов: {2}" -f $FromVersion, $ToVersion, $Steps.Count) 'Cyan'
Say ''

# ── Files ────────────────────────────────────────────────────────────────────
if (-not $WorkDir) { $WorkDir = Join-Path (Get-Location) @@WORKDIR_Q@@ }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path

$missing = @($Steps | Where-Object { -not (Test-Path (Join-Path $WorkDir $_.File)) })
if ($missing.Count -gt 0) {
  $itsLogin = $env:ITS_LOGIN
  $itsPass = $env:ITS_PASSWORD
  if (-not $itsLogin -or -not $itsPass) {
    Say 'Файлы обновлений скачиваются под учётной записью ИТС (портал 1С).'
    $itsLogin = Read-Host 'Логин ИТС'
    $itsPass = Plain (Read-Host 'Пароль ИТС (вставка — правой кнопкой мыши)' -AsSecureString)
  }
  $auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($itsLogin + ':' + $itsPass))
  foreach ($s in $missing) {
    $dest = Join-Path $WorkDir $s.File
    Say ("Скачиваю {0} из {1}: {2}" -f $s.N, $Steps.Count, $s.Version)
    try {
      Download $s.Url "$dest.part" $null @{ Authorization = $auth }
    } catch {
      Write-Host ''
      $code = 0
      $ex = $_.Exception
      while ($ex -and -not $ex.Response -and $ex.InnerException) { $ex = $ex.InnerException }
      if ($ex.Response) { $code = [int]$ex.Response.StatusCode }
      Remove-Item "$dest.part" -ErrorAction SilentlyContinue
      if ($code -eq 401 -or $code -eq 403) { Fail 'Сервер 1С не отдал файл: неверный логин или пароль ИТС, или у учётной записи нет подписки на обновления этой конфигурации (для партнёрских решений нужна подписка на сам продукт).' }
      Fail ("Не удалось скачать {0}: {1}" -f $s.Url, $_.Exception.Message)
    }
    Move-Item "$dest.part" $dest -Force
  }
}
Say ("Файлы обновлений: {0}" -f $WorkDir) 'Green'
if ($DownloadOnly) { exit 0 }

# ── Platform ─────────────────────────────────────────────────────────────────
$need = $Steps | Where-Object { $_.Platform } | ForEach-Object { [version]$_.Platform } | Sort-Object | Select-Object -Last 1
if ($Platform) {
  if (-not (Test-Path $Platform)) { Fail "Не найден файл $Platform" }
  $exe = (Resolve-Path $Platform).Path
  $found = $null
  if ((Split-Path (Split-Path $exe -Parent) -Parent | Split-Path -Leaf) -match '^\d+\.\d+\.\d+\.\d+$') { $found = [version]$Matches[0] }
} else {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | ForEach-Object { Join-Path $_ '1cv8' }
  $best = foreach ($r in $roots) {
    if (Test-Path $r) {
      Get-ChildItem -Path $r -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | ForEach-Object {
        $candidate = Join-Path $_.FullName 'bin\1cv8.exe'
        if (Test-Path $candidate) { [pscustomobject]@{ Version = [version]$_.Name; Exe = $candidate } }
      }
    }
  }
  $best = $best | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $best) { Fail "Не найдена платформа 1С:Предприятие. Установите её (скрипт установки есть на $Site/platform) или укажите путь: -Platform ""...\bin\1cv8.exe""" }
  $exe = $best.Exe
  $found = $best.Version
}
Say "Платформа: $exe"
if ($need -and $found -and $found -lt $need) {
  Say "Для этой цепочки нужна платформа не ниже $need, а найдена $found." 'Yellow'
  Say "Скрипт установки нужной платформы: $Site/platform" 'Yellow'
  if (-not (AskYes 'Всё равно продолжить?')) { exit 1 }
}

# ── Infobase ─────────────────────────────────────────────────────────────────
if (-not $Base -and -not ($Server -and $Ref)) {
  Say ''
  Say 'Где находится база?  1 — файловая (папка с файлом 1Cv8.1CD),  2 — на сервере 1С'
  if ((Read-Host 'Введите 1 или 2') -eq '2') {
    $Server = Read-Host 'Сервер 1С (например srv1c или srv1c:1541)'
    $Ref = Read-Host 'Имя базы на сервере'
  } else {
    $Base = Read-Host 'Путь к папке базы'
  }
}
if ($Base) {
  $Base = $Base.Trim().Trim('"')
  if (-not (Test-Path (Join-Path $Base '1Cv8.1CD'))) { Fail "В папке $Base нет файла 1Cv8.1CD: это не файловая база 1С" }
  $conn = '/F ' + (Q $Base)
  $baseName = $Base
} else {
  $conn = '/S ' + (Q ($Server.Trim() + '\' + $Ref.Trim()))
  $baseName = $Server.Trim() + '\' + $Ref.Trim()
}
if (-not $PSBoundParameters.ContainsKey('User')) { $User = Read-Host 'Пользователь базы (Enter, если в базе нет пользователей)' }
$ibPass = ''
if ($User) {
  if ($env:IB_PASSWORD) { $ibPass = $env:IB_PASSWORD } else { $ibPass = Plain (Read-Host "Пароль пользователя $User" -AsSecureString) }
}

Say ''
Say "База: $baseName" 'Cyan'
Say 'Все пользователи должны выйти из базы — обновлению нужен монопольный доступ.' 'Yellow'
if (-not (AskYes 'Начать обновление?')) { exit 1 }

function Run-1C([string]$Mode, [string]$Extra, [string]$What, [switch]$Visible) {
  $out = Join-Path $WorkDir ("1c-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
  $line = "$Mode $conn"
  if ($User) { $line += ' /N ' + (Q $User) + ' /P ' + (Q $ibPass) }
  $line += ' /DisableStartupDialogs /DisableStartupMessages /Out ' + (Q $out) + ' ' + $Extra
  Say "  $What..."
  $style = 'Hidden'
  if ($Visible) { $style = 'Normal' }
  $p = Start-Process -FilePath $exe -ArgumentList $line -PassThru -WindowStyle $style
  $null = $p.Handle              # keeps the exit code readable after WaitForExit
  $p.WaitForExit()
  $script:LastLog = $out
  if ($p.ExitCode -ne 0) {
    if (Test-Path $out) { Get-Content $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow } }
    return $false
  }
  return $true
}
$startCommand = '/C ' + (Q 'ЗапуститьОбновлениеИнформационнойБазы;ЗавершитьРаботуСистемы')
$current = $FromVersion

# ── Backup ───────────────────────────────────────────────────────────────────
$backup = $null
if (-not $NoBackup) {
  $backup = Join-Path $WorkDir ("backup-{0}-{1:yyyyMMdd-HHmm}.dt" -f $FromVersion, (Get-Date))
  Say ''
  Say 'Выгрузка базы для отката' 'Cyan'
  if (-not (Run-1C 'DESIGNER' ('/DumpIB ' + (Q $backup)) 'Выгружаю базу в .dt')) {
    Fail "Не удалось выгрузить базу. Проверьте путь, пользователя и что в базе никто не работает. Журнал: $script:LastLog"
  }
  Say "  Выгрузка: $backup" 'Green'
}

# ── Steps ────────────────────────────────────────────────────────────────────
foreach ($s in $Steps) {
  Say ''
  Say ("Шаг {0} из {1}: {2} -> {3}" -f $s.N, $Steps.Count, $current, $s.Version) 'Cyan'
  $file = Join-Path $WorkDir $s.File
  if (-not (Run-1C 'DESIGNER' ('/UpdateCfg ' + (Q $file) + ' /UpdateDBCfg') 'Обновляю конфигурацию и конфигурацию базы данных')) {
    Say ''
    Say "Шаг $($s.N) не выполнен. Последняя успешно установленная версия: $current." 'Red'
    if ($backup) { Say "Откат: Конфигуратор -> Администрирование -> Загрузить информационную базу -> $backup" 'Yellow' }
    Fail "Журнал конфигуратора: $script:LastLog"
  }
  $current = $s.Version
  Say "  Готово: $current" 'Green'
  if ($HandlersEachStep -and $s.N -lt $Steps.Count) {
    $null = Run-1C 'ENTERPRISE' $startCommand 'Выполняю обработчики обновления (окно 1С закроется само)' -Visible
  }
}

# ── Update handlers ──────────────────────────────────────────────────────────
Say ''
Say 'Обработчики обновления' 'Cyan'
Say '  Откроется окно 1С и закроется само. Если база попросит подтверждение, ответьте в окне.'
if (-not (Run-1C 'ENTERPRISE' $startCommand 'Запускаю базу в режиме предприятия' -Visible)) {
  Say "  1С завершилась с ошибкой. Запустите базу вручную, чтобы закончить обновление. Журнал: $script:LastLog" 'Yellow'
}

Say ''
Say "Готово: база обновлена до $ToVersion." 'Green'
if ($backup) { Say "Выгрузка до обновления: $backup" }
Say "Файлы обновлений и журналы: $WorkDir"
