# Скрипты Апдейкона для проверки

Готовые к запуску скрипты, сгенерированные из шаблонов `src/scripts` (так же их отдаёт
сайт по кнопкам «Скрипт» у цепочки и «установить» у сборки платформы). Если шаблоны
изменятся, примеры нужно сгенерировать заново.

| Файл | Что делает |
|---|---|
| `updatecon-platform-8.3.27.2342.ps1` | Windows: скачать и установить платформу 8.3.27.2342 (клиент и конфигуратор, с `-Server` ещё сервер и служба) |
| `updatecon-platform-8.3.27.2342.sh` | Linux: скачать и установить платформу 8.3.27.2342 (сервер и служба systemd, с `--client` ещё клиент) |
| `updatecon-Accounting-3.0.193.19-3.0.207.25.ps1` | Windows: обновить «Бухгалтерию предприятия 3.0» с 3.0.193.19 до 3.0.207.25 (4 шага) |
| `updatecon-Accounting-3.0.193.19-3.0.207.25.sh` | Linux: то же самое |

Логин и пароль ИТС скрипты спрашивают при запуске (или берут из `ITS_LOGIN` и `ITS_PASSWORD`)
и отправляют только на серверы 1С. Описание всех параметров — в начале каждого файла.

## Как скачать на тестовую машину

Windows (PowerShell):

```powershell
$base = 'https://raw.githubusercontent.com/iMironRU/updatecon/main/examples'
Invoke-WebRequest "$base/updatecon-platform-8.3.27.2342.ps1" -OutFile updatecon-platform-8.3.27.2342.ps1 -UseBasicParsing
```

Linux:

```bash
curl -fLO https://raw.githubusercontent.com/iMironRU/updatecon/main/examples/updatecon-platform-8.3.27.2342.sh
```

## Что проверить

1. **Вход на портал без скачивания.**
   Windows: `powershell -ExecutionPolicy Bypass -File .\updatecon-platform-8.3.27.2342.ps1 -DryRun`.
   Linux: `bash updatecon-platform-8.3.27.2342.sh --dry-run`.
   Ожидается: «Проверка прошла: вход на портал работает, ссылка на скачивание найдена (3)».
2. **Установка платформы** на тестовой машине.
   Windows (PowerShell от имени администратора): `powershell -ExecutionPolicy Bypass -File .\updatecon-platform-8.3.27.2342.ps1`, затем то же с `-Server`.
   Linux: `sudo bash updatecon-platform-8.3.27.2342.sh`, затем `systemctl status srv1cv8-8.3.27.2342@default`.
3. **Скачивание обновлений:** `-DownloadOnly` / `--download-only` — четыре файла `.cfu` в папке `updatecon-Accounting-…`.
4. **Обновление базы** — только на копии. Нужна файловая или серверная база БП 3.0 версии 3.0.193.19:
   `powershell -ExecutionPolicy Bypass -File .\updatecon-Accounting-3.0.193.19-3.0.207.25.ps1` или
   `bash updatecon-Accounting-3.0.193.19-3.0.207.25.sh`. Скрипт спросит путь к базе и пользователя,
   сделает выгрузку `.dt`, поставит 4 шага и запустит обработчики обновления.

Если тестовая база на другой версии или это другая конфигурация, нужен свой скрипт: его
генерирует сайт (кнопка «Скрипт» у построенной цепочки) или адрес
`/api/script/chain?os=windows&config_id=<id>&from=<версия>&to=<версия>`.

Если что-то пошло не так, пришлите вывод скрипта и журналы: `1c-*.log` из рабочей папки
обновления или `install.log` из папки дистрибутива на Windows.
