# Развёртывание на VPS

Ниже описан рекомендуемый запуск готового Docker-образа на Linux-сервере. На
VPS нужны только Docker Engine, плагин Docker Compose v2, Git и открытые порты
80/TCP, 443/TCP и 443/UDP. Node.js и PostgreSQL на хосте устанавливать не нужно.

## 1. Подготовка

```bash
git clone https://github.com/ant-m13/release1c.git
cd release1c
cp .env.example .env
chmod 600 .env
```

Сгенерируйте три разных значения:

```bash
openssl rand -hex 24       # POSTGRES_PASSWORD: только URL-безопасные символы
openssl rand -base64 36    # ADMIN_PASSWORD
openssl rand -base64 32    # ITS_CREDENTIALS_KEY
```

Запишите их в `.env`. Ключ `ITS_CREDENTIALS_KEY` после добавления ИТС-аккаунтов
нельзя менять: без прежнего ключа сохранённые пароли расшифровать невозможно.
Файл `.env` не входит в Git и должен храниться вместе с резервными копиями
сервера в защищённом хранилище.

Для готового образа установите:

```dotenv
APP_IMAGE=ghcr.io/ant-m13/release1c:latest
APP_PULL_POLICY=always
IMPORT_ON_START=0
```

Тег `latest` обновляется после успешных проверок ветки `main`. Для полностью
воспроизводимого развёртывания вместо него можно указать неизменяемый тег вида
`sha-0123abc`.

## 2. Первый запуск

```bash
docker compose pull
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 migrate web worker
```

Сервис `migrate` применит миграции и завершится с кодом 0. После этого web и
worker запустятся автоматически, а Caddy начнёт принимать запросы только после
успешной проверки `/api/health`.

Проверьте установку:

```bash
curl --fail http://127.0.0.1/api/health
```

Откройте `http://IP-СЕРВЕРА/admin`, войдите с `ADMIN_LOGIN` и
`ADMIN_PASSWORD`, добавьте ИТС-аккаунты и запустите «Обновить все данные».
Автоматический импорт при первом старте отключён, чтобы сначала можно было
проверить настройки и аккаунты.

## 3. Домен и HTTPS

Создайте DNS-запись `A` на IPv4 VPS и, если используется IPv6, запись `AAAA`.
Убедитесь, что извне доступны 80/TCP и 443/TCP. Затем в административной панели
откройте «Настройки», укажите домен без протокола и примените его. Caddy получит
сертификат и настроит HTTPS автоматически. Порт 2019 публиковать нельзя: это
внутренний административный API Caddy.

После включения HTTPS проверьте:

```bash
curl --fail https://example.ru/api/health
```

## 4. Обновление и откат

Перед обновлением скачайте переносимую копию каталога в административной панели
или сделайте полную резервную копию PostgreSQL. Затем:

```bash
git pull --ff-only
docker compose pull
docker compose up -d --no-build --remove-orphans
docker compose ps
```

Миграции применяются до запуска новой версии web и worker. Данные PostgreSQL и
настройки Caddy находятся в именованных volumes и при пересоздании контейнеров
не удаляются.

Для отката укажите в `.env` предыдущий тег `sha-…` и повторите `pull`/`up`.
Откат приложения после уже применённой миграции базы следует выполнять только
на совместимую версию; надёжный вариант — восстановить сделанную перед
обновлением копию базы.

## 5. Резервное копирование и перенос

Для переноса каталога между установками одинаковой версии используйте
«Настройки → Резервная копия каталога». Такая копия не содержит ИТС-аккаунты,
пароли, журналы и серверные настройки.

Для аварийного восстановления всего VPS дополнительно сохраняйте:

- `.env` с неизменённым `ITS_CREDENTIALS_KEY`;
- дамп PostgreSQL;
- Docker volumes `caddy_data` и `caddy_config` либо возможность повторно
  выпустить сертификат;
- точный тег образа `sha-…`.

Создать полный дамп PostgreSQL без остановки контейнера можно так:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > release1c.dump
```

Перед восстановлением полного дампа остановите web и worker и убедитесь, что
целевой образ совместим со схемой базы. Восстановление с `--clean` заменяет
данные целевой базы, поэтому сначала сохраните её отдельную копию.

## 6. Приватный GHCR и сборка из исходников

Если пакет GHCR закрыт, сначала войдите в реестр с токеном, имеющим только
право `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u GITHUB_USER --password-stdin
```

Чтобы собрать образ непосредственно на VPS, оставьте в `.env`:

```dotenv
APP_IMAGE=release1c:latest
APP_PULL_POLICY=never
```

и запустите:

```bash
docker compose up -d --build
```

Локальный режим `never` не пытается сначала скачать несуществующий образ
`release1c` и поэтому не выводит предупреждение `pull access denied`.

## 7. Диагностика

```bash
docker compose ps
docker compose logs --since=15m web worker migrate caddy db
docker compose config --quiet
docker compose exec db sh -c 'pg_isready -U "$POSTGRES_USER"'
```

Не используйте `docker compose down -v` для обычного обновления или перезапуска:
ключ `-v` удаляет том PostgreSQL. Обычные `docker compose stop`, `restart` и
`down --remove-orphans` сохраняют данные.
