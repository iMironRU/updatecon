# Установка платформы 1С:Предприятие одной командой

`install-1c-platform.ps1` (Windows) и `install-1c-platform.sh` (Linux) скачивают дистрибутив
с портала 1С под вашей учётной записью ИТС и ставят платформу без вопросов. Версию выбираете вы:

- номер сборки — `8.5.1.1529`;
- линейка — `8.5`, `8.3`, `8.3.24`: берётся последняя сборка этой линейки (список — из каталога upd.imiron.ru);
- без параметра скрипт спросит: последняя 8.3, последняя 8.5 или свой номер.

Логин и пароль ИТС скрипт спрашивает при запуске (или берёт из `ITS_LOGIN` и `ITS_PASSWORD`)
и отправляет только на серверы 1С.

## Windows

PowerShell **от имени администратора**:

```powershell
irm https://raw.githubusercontent.com/iMironRU/updatecon/main/tools/install-1c-platform.ps1 -OutFile $env:TEMP\install-1c-platform.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\install-1c-platform.ps1 -Version 8.5
```

Ставит клиент и конфигуратор. Параметры: `-Server` — ещё сервер 1С и служба «Агент сервера»,
`-DryRun` — только проверить вход на портал и найти дистрибутив, `-WorkDir D:\distr` — куда скачивать.
Для распаковки `.rar` нужен Windows 11 или 7-Zip.

## Linux

```bash
curl -fsSL -o /tmp/install-1c-platform.sh https://raw.githubusercontent.com/iMironRU/updatecon/main/tools/install-1c-platform.sh
sudo bash /tmp/install-1c-platform.sh --version 8.5
```

Ставит сервер 1С и модули веб-сервера и включает службу в systemd (если другая служба сервера 1С
не работает). Параметры: `--client` — ещё клиент и конфигуратор, `--no-service`, `--no-deps`,
`--dry-run`, `--workdir DIR`. Для Linux — сборки 8.3.20 и новее.

Уже установленные версии платформы не удаляются. Скрипты генерируются из шаблонов `src/scripts`
(`platformScript` в `src/db/scripts.ts` с пустой версией) — после правки шаблонов их нужно
сгенерировать заново.
