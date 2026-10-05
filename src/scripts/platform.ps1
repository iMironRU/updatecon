<#
  Апдейкон — установка платформы 1С:Предприятие @@VERSION_TITLE@@ (64-bit) для Windows
  Сформировано на @@SITE@@ @@DATE@@

  Что делает скрипт:
    1. Входит на портал 1С (releases.1c.ru) под вашей учётной записью ИТС и скачивает
       дистрибутив «Технологическая платформа 1С:Предприятия (64-bit) для Windows».
       Логин и пароль ИТС уходят только на серверы 1С и нигде не сохраняются.
    2. Распаковывает его и устанавливает без вопросов: толстый и тонкий клиент, конфигуратор.
    3. С параметром -Server ставит ещё сервер 1С:Предприятия и регистрирует его службой Windows.
  Уже установленные версии платформы не удаляются.

  Запуск (PowerShell от имени администратора):
    powershell -ExecutionPolicy Bypass -File .\@@FILE@@

  Параметры:
    -Version 8.5   какую платформу поставить: номер сборки (8.5.1.1529) или линейка (8.5, 8.3.27) —
                   тогда последняя сборка этой линейки; без параметра — @@VERSION_DEFAULT@@
    -Server        установить также сервер 1С:Предприятия и службу «Агент сервера»
    -WorkDir "D:\distr"   куда скачать и распаковать дистрибутив
    -DryRun        только войти на портал и найти дистрибутив, ничего не скачивая
  Логин и пароль ИТС можно передать через переменные окружения ITS_LOGIN и ITS_PASSWORD.
  Для распаковки .rar нужен Windows 11 или установленный 7-Zip (7-zip.org).
#>
param([string]$Version, [switch]$Server, [string]$WorkDir, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Site = @@SITE_Q@@
$UA = '1C+Enterprise/8.3'
if (-not $Version) { $Version = @@VERSION_Q@@ }

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Fail([string]$Text) { Write-Host ''; Write-Host "ОШИБКА: $Text" -ForegroundColor Red; exit 1 }
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
function Plain([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# ── Which build ──────────────────────────────────────────────────────────────
# A line (8.5, 8.3.27) or nothing: the newest build from the Апдейкон catalog.
$Version = "$Version".Trim()
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  try { $builds = @((Invoke-RestMethod "$Site/api/platform" -UseBasicParsing).builds | Where-Object { $_.v -match '^8\.[35]\.' }) }
  catch { Fail "Не удалось получить список сборок с ${Site}: $($_.Exception.Message). Укажите номер сборки: -Version 8.5.1.1529" }
  $newest = { param($prefix) $builds | Where-Object { $_.v -like "$prefix.*" } | Sort-Object { [version]$_.v } -Descending | Select-Object -First 1 -ExpandProperty v }
  if (-not $Version) {
    $l83 = & $newest '8.3'; $l85 = & $newest '8.5'
    Say ''
    Say 'Какую платформу поставить?'
    Say "  1 — 8.3, последняя сборка $l83"
    Say "  2 — 8.5, последняя сборка $l85"
    Say '  или введите номер сборки (8.3.24.1819) или линейку (8.3.24)'
    $answer = (Read-Host 'Выбор [1]').Trim()
    if (-not $answer -or $answer -eq '1') { $Version = $l83 } elseif ($answer -eq '2') { $Version = $l85 } else { $Version = $answer }
  }
  if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    $line = $Version
    $Version = & $newest $line
    if (-not $Version) { Fail "В каталоге нет сборок линейки $line. Список: $Site/platform" }
  }
}
if ($Version -notmatch '^8\.[35]\.') { Fail "Скрипт ставит платформы 8.3 и 8.5, а указана $Version" }
$Under = $Version.Replace('.', '_')
$Major = (($Version -split '\.')[0..1]) -join '.'
$Nick = 'Platform' + $Major.Replace('.', '')

Say ''
Say "Апдейкон: платформа 1С:Предприятие $Version (64-bit) для Windows" 'Cyan'

$isAdmin = $false
try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
if (-not $isAdmin -and -not $DryRun) { Fail 'Нужны права администратора: откройте PowerShell через «Запуск от имени администратора» и запустите скрипт снова.' }

$programFiles = $env:ProgramFiles
if (-not $programFiles) { $programFiles = 'C:\Program Files' }
$installDir = "$programFiles\1cv8\$Version"
$installed = Test-Path "$installDir\bin\1cv8.exe"
if ($installed -and -not $Server) {
  Say "Платформа $Version уже установлена: $installDir" 'Green'
  exit 0
}

if (-not $WorkDir) { $WorkDir = Join-Path (Get-Location) "updatecon-platform-$Under" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path
$unpacked = Join-Path $WorkDir 'setup'

if (-not $installed) {
  $msi = Get-ChildItem -Path $unpacked -Filter '*.msi' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $msi) {
    $archive = Get-ChildItem -Path $WorkDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "^windows64full_$Under\.(rar|zip)$" } | Select-Object -First 1
    if (-not $archive) {
      # ── Portal login (login.1c.ru), then the build's file list ─────────────
      $itsLogin = $env:ITS_LOGIN
      $itsPass = $env:ITS_PASSWORD
      if (-not $itsLogin -or -not $itsPass) {
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
  $servicesBefore = @(Get-Service | Where-Object { $_.Name -like '1C:Enterprise*Server Agent*' } | ForEach-Object { $_.Name })
  $props = @('DESIGNERALLCLIENTS=1', 'THICKCLIENT=1', 'THINCLIENTFILE=1', 'THINCLIENT=1', 'WEBSERVEREXT=0',
             'CONFREPOSSERVER=0', 'CONVERTER77=0', 'LANGUAGES=RU')
  if ($Server) { $props += @('SERVER=1', 'SERVERCLIENT=1') } else { $props += @('SERVER=0', 'SERVERCLIENT=0') }
  $transforms = @('adminstallrelogon.mst', '1049.mst') | Where-Object { Test-Path (Join-Path $msi.DirectoryName $_) }
  $log = Join-Path $WorkDir 'install.log'
  $line = '/i "' + $msi.FullName + '" /qn /norestart'
  if ($transforms) { $line += ' TRANSFORMS="' + (($transforms | ForEach-Object { Join-Path $msi.DirectoryName $_ }) -join ';') + '"' }
  $line += ' ' + ($props -join ' ') + ' /l*v "' + $log + '"'
  Say 'Устанавливаю платформу (несколько минут)...'
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $line -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "Установщик завершился с кодом $($p.ExitCode). Журнал установки: $log" }
  if ($p.ExitCode -eq 3010) { Say 'Установщик просит перезагрузить компьютер после установки.' 'Yellow' }
  if (-not (Test-Path "$installDir\bin\1cv8.exe")) { Fail "Установщик закончил работу, но $installDir\bin\1cv8.exe не появился. Журнал установки: $log" }
  Say "Платформа $Version установлена: $installDir" 'Green'
} else {
  Say "Платформа $Version уже установлена: $installDir" 'Green'
  $servicesBefore = @()
}

# ── Server agent service ─────────────────────────────────────────────────────
if ($Server) {
  $ragent = "$installDir\bin\ragent.exe"
  $services = @(Get-Service | Where-Object { $_.Name -like '1C:Enterprise*Server Agent*' })
  $new = @($services | Where-Object { $servicesBefore -notcontains $_.Name })
  if ($new.Count -gt 0) {
    Say "Служба сервера установлена: $($new[0].Name)" 'Green'
  } elseif (-not (Test-Path $ragent)) {
    Fail "Нет файла $ragent — серверная часть не установилась. Журнал установки: $(Join-Path $WorkDir 'install.log')"
  } elseif ($services.Count -gt 0) {
    Say "Служба сервера 1С уже есть: $($services[0].Name). Её не трогаю, чтобы не было конфликта портов." 'Yellow'
    Say "Чтобы перевести сервер на $Version, остановите службу и укажите в ней путь $ragent" 'Yellow'
  } else {
    $srvinfo = "$programFiles\1cv8\srvinfo"
    New-Item -ItemType Directory -Force -Path $srvinfo | Out-Null
    $bin = '"' + $ragent + '" -srvc -agent -regport 1541 -port 1540 -range 1560:1591 -d "' + $srvinfo + '" -debug'
    $svc = "1C:Enterprise $Major Server Agent (x86-64)"
    New-Service -Name $svc -BinaryPathName $bin -DisplayName "Агент сервера 1С:Предприятия $Major (x86-64)" -StartupType Automatic | Out-Null
    Start-Service -Name $svc
    Say "Служба «$svc» установлена и запущена (порты 1540, 1541, 1560-1591)." 'Green'
    Say 'Служба работает под учётной записью LocalSystem; при необходимости смените её в свойствах службы.'
  }
}

Say ''
Say "Готово. Дистрибутив и журнал установки: $WorkDir" 'Green'
