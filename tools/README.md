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
irm https://raw.githubusercontent.com/iMironRU/updatecon/main/tools/install-1c-platform.ps1 -OutFile $env:TEMP\install-1c-platform.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\install-1c-platform.ps1 -Version 8.5
```

Скрипт спросит, что установить: 1 — клиент и конфигуратор, 2 — клиент, конфигуратор и сервер 1С
со службой «Агент сервера», 3 — только сервер. Без вопросов: `-Mode client|full|server`.
Дистрибутив скачивается во временную папку (`%TEMP%`), после установки скрипт спросит, удалить
его или открыть папку с ним (`-RemoveFiles` / `-KeepFiles` — не спрашивать). Ещё параметры:
`-DryRun` — только проверить вход на портал и найти дистрибутив, `-WorkDir D:\distr` — своя папка.
Для распаковки `.rar` нужен Windows 11 или 7-Zip.

## Linux

```bash
curl -fsSL -o /tmp/install-1c-platform.sh https://raw.githubusercontent.com/iMironRU/updatecon/main/tools/install-1c-platform.sh && sudo bash /tmp/install-1c-platform.sh --version 8.5
```

Скрипт спросит, что установить: 1 — сервер 1С и модули веб-сервера (служба в systemd включается,
если другая служба сервера 1С не работает), 2 — сервер, клиент и конфигуратор, 3 — только клиент.
Без вопросов: `--mode server|full|client`. Дистрибутив скачивается в `/tmp`, после установки скрипт
спросит, удалить ли его (`--remove-files` / `--keep-files`). Ещё: `--no-service`, `--no-deps`,
`--dry-run`, `--workdir DIR`. Для Linux — сборки 8.3.20 и новее.

Уже установленные версии платформы не удаляются. Скрипты генерируются из шаблонов `src/scripts`
(`platformScript` в `src/db/scripts.ts` с пустой версией) — после правки шаблонов их нужно
сгенерировать заново.
