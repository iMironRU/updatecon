# Установка платформы 1С:Предприятие одной командой

`install-1c-platform.ps1` (Windows) и `install-1c-platform.sh` (Linux) скачивают дистрибутив
с портала 1С под вашей учётной записью ИТС и ставят платформу без вопросов. Версию выбираете вы:

- номер сборки — `8.5.1.1529`;
- линейка — `8.5`, `8.3`, `8.3.24`: берётся последняя сборка этой линейки (список — из каталога upd.imiron.ru);
- без параметра скрипт спросит: последняя 8.3, последняя 8.5 или свой номер.

Логин и пароль ИТС скрипт спрашивает при запуске (или берёт из `ITS_LOGIN` и `ITS_PASSWORD`)
и отправляет только на серверы 1С.

## Коротко

Windows, PowerShell **от имени администратора** (версия — по желанию, без неё скрипт спросит):

```powershell
$ver='8.5'; irm https://upd.imiron.ru/1c | iex
```

Linux:

```bash
sudo bash -c "$(curl -fsSL https://upd.imiron.ru/1c.sh)" -- --version 8.5
```

Сайт отдаёт те же скрипты, что лежат здесь (`/1c.ps1`, `/1c.sh`); `/1c` — загрузчик, который
сохраняет скрипт во временную папку и запускает его отдельным процессом.

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

Так же, как на Windows: обзор установленных версий (`/opt/1cv8/x86_64`) и служб systemd, меню
«Что сделать?» (обновить линейку, установить 8.5, другая сборка, удалить старые версии, проверка
портала), состав — сервер и модули веб-сервера / с клиентом / только клиент (`--mode server|full|client`),
перевод службы `srv1cv8-<версия>@default` на новую сборку (`--move-service` / `--keep-service`),
сводка с местом в `/opt`, после установки — служба `ras` по запросу (`--ras` / `--no-ras`), удаление
дистрибутива из `/tmp` (`--remove-files` / `--keep-files`), и снова меню. `--yes` — без подтверждения,
`--dry-run` — только проверить вход на портал. Для Linux — сборки 8.3.20 и новее.

Уже установленные версии платформы не удаляются. Скрипты генерируются из шаблонов `src/scripts`
(`platformScript` в `src/db/scripts.ts` с пустой версией) — после правки шаблонов их нужно
сгенерировать заново.
