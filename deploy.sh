#!/usr/bin/env bash
# deploy.sh — полная установка Апдейкон на чистый Linux-сервер.
#
# Быстрый старт (Ubuntu / Debian):
#   bash <(curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/deploy.sh)
#
# Повторный запуск безопасен: .env и данные не трогаются.

set -euo pipefail

GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; CYAN='\033[1;36m'; NC='\033[0m'
log()  { printf "${GREEN}[deploy]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[deploy]${NC} %s\n" "$*"; }
err()  { printf "${RED}[deploy]${NC} %s\n" "$*" >&2; }
box()  { printf "${CYAN}%s${NC}\n" "$*"; }

# ── 1. OS-проверка ────────────────────────────────────────────────────────────
OS_ID="$(. /etc/os-release 2>/dev/null && echo "$ID" || echo unknown)"
OS_VER="$(. /etc/os-release 2>/dev/null && echo "$VERSION_ID" || echo 0)"

case "$OS_ID" in
  ubuntu)
    MIN=20; CUR="${OS_VER%%.*}"
    if [ "$CUR" -lt "$MIN" ] 2>/dev/null; then
      err "Требуется Ubuntu 20.04 или новее. Обнаружено: Ubuntu $OS_VER"
      exit 1
    fi
    log "ОС: Ubuntu $OS_VER ✓"
    ;;
  debian)
    MIN=11; CUR="${OS_VER%%.*}"
    if [ "$CUR" -lt "$MIN" ] 2>/dev/null; then
      err "Требуется Debian 11 или новее. Обнаружено: Debian $OS_VER"
      exit 1
    fi
    log "ОС: Debian $OS_VER ✓"
    ;;
  *)
    warn "Непроверенная ОС: $OS_ID $OS_VER. Продолжаем, но могут быть сюрпризы."
    ;;
esac

# ── 2. Клонирование репозитория (если запущено не из него) ───────────────────
REPO_URL="https://github.com/iMironRU/updatecon.git"
REPO_DIR="updatecon"

if [ ! -f "$(pwd)/docker-compose.yml" ]; then
  if ! command -v git >/dev/null 2>&1; then
    log "Устанавливаем git…"
    sudo apt-get update -qq && sudo apt-get install -y -qq git
  fi
  if [ -d "$REPO_DIR/.git" ]; then
    log "Директория $REPO_DIR уже существует — обновляем (git pull)…"
    cd "$REPO_DIR"
    git pull --ff-only
  else
    if [ -d "$REPO_DIR" ]; then
      warn "Директория $REPO_DIR существует но не является git-репозиторием (прерванная установка?) — удаляем и клонируем заново…"
      rm -rf "$REPO_DIR"
    fi
    log "Клонируем репозиторий в ./$REPO_DIR …"
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
  fi
else
  log "Запуск из директории репозитория: $(pwd)"
fi

# ── 3. Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Docker не найден — устанавливаем через get.docker.com…"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "${SUDO_USER:-$USER}" 2>/dev/null || true
  log "Docker установлен."
  warn "Если впервые — перелогиньтесь чтобы применить членство в группе docker."
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  err "Плагин Docker Compose не найден. Установите: https://docs.docker.com/compose/install/"
  exit 1
fi
log "Compose: $DC ✓"

# ── 4. .env — создание при первом запуске ────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env

  # Случайный пароль БД
  DB_PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${DB_PW}/" .env
  sed -i "s|postgres://upd:changeme@|postgres://upd:${DB_PW}@|" .env

  # Логин/пароль админки
  echo
  box "══════════════════════════════════════════════"
  box "  Настройка учётных данных административной"
  box "  панели Апдейкон (/admin)"
  box "══════════════════════════════════════════════"
  echo

  read -rp "  Логин администратора   [admin]: " ADMIN_LOGIN
  ADMIN_LOGIN="${ADMIN_LOGIN:-admin}"

  while true; do
    read -rsp "  Пароль администратора  (мин. 6 символов): " ADMIN_PW; echo
    if [ ${#ADMIN_PW} -ge 6 ]; then break; fi
    warn "  Пароль слишком короткий, попробуйте ещё раз."
  done

  sed -i "s/^ADMIN_LOGIN=.*/ADMIN_LOGIN=${ADMIN_LOGIN}/" .env
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${ADMIN_PW}/" .env

  log ".env создан. Пароль БД сгенерирован автоматически."
  echo
  warn "ИТС-кредиты (необязательно): отредактируйте .env и задайте ITS_LOGIN / ITS_PASSWORD"
  warn "чтобы включить автоматическую синхронизацию с downloads.v8.1c.ru"
  echo
else
  log ".env уже существует — оставляем без изменений."
fi

mkdir -p data

# ── 5. Сборка образов ─────────────────────────────────────────────────────────
log "Сборка Docker-образов…"
$DC build

# ── 6. Запуск PostgreSQL для возможного восстановления дампа ──────────────────
log "Запускаем PostgreSQL…"
$DC up -d db
log "Ждём готовности БД…"
for i in $(seq 1 30); do
  $DC exec -T db pg_isready -U upd >/dev/null 2>&1 && break || sleep 2
done

# ── 7. Дамп данных (начальное заполнение) ────────────────────────────────────
SEED_FILE="data/seed.sql.gz"
if [ -f "$SEED_FILE" ]; then
  # Проверяем, применены ли уже миграции
  TABLE_EXISTS=$($DC exec -T db psql -U upd -d upd -tAc \
    "SELECT count(*) FROM information_schema.tables \
     WHERE table_schema='public' AND table_name='configurations'" 2>/dev/null || echo 0)

  if [ "$TABLE_EXISTS" = "0" ]; then
    echo
    box "══════════════════════════════════════════════════"
    box "  Найден дамп данных ($SEED_FILE)"
    box "  Восстановить начальный набор конфигураций 1С?"
    box "  (603 конфигурации, >200k рёбер обновлений)"
    box "══════════════════════════════════════════════════"
    echo
    read -rp "  Восстановить дамп? [Y/n]: " RESTORE_SEED
    RESTORE_SEED="${RESTORE_SEED:-Y}"

    if [[ "$RESTORE_SEED" =~ ^[Yy] ]]; then
      log "Запускаем воркер для применения миграций…"
      $DC up -d worker

      log "Ждём создания таблиц (до 60 сек)…"
      MIGRATED=0
      for i in $(seq 1 30); do
        READY=$($DC exec -T db psql -U upd -d upd -tAc \
          "SELECT count(*) FROM information_schema.tables \
           WHERE table_schema='public' AND table_name='configurations'" 2>/dev/null \
          | tr -d '[:space:]' || echo 0)
        if [ "$READY" = "1" ]; then
          MIGRATED=1; break
        fi
        sleep 2
      done

      $DC stop worker

      if [ "$MIGRATED" != "1" ]; then
        err "Таблицы не появились за 60 сек — проверьте: $DC logs worker"
        exit 1
      fi
      log "Миграции применены ✓"

      log "Восстанавливаем дамп…"
      zcat "$SEED_FILE" | $DC exec -T db psql -U upd -d upd -q
      log "Дамп восстановлен ✓"

      # Данные уже есть — не нужен немедленный импорт при старте
      sed -i "s/^IMPORT_ON_START=.*/IMPORT_ON_START=0/" .env
    fi
  else
    log "В БД уже есть данные — дамп пропускаем."
  fi
fi

# ── 8. Полный запуск стека ────────────────────────────────────────────────────
log "Запускаем полный стек…"
$DC up -d

# ── 9. Проверка готовности веб-сервера ────────────────────────────────────────
PORT="$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)"
log "Ждём веб-сервер на порту ${PORT}…"
OK=0
for i in $(seq 1 40); do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    OK=1; break
  fi
  sleep 3
done
[ "$OK" = "1" ] && log "Веб-сервер отвечает ✓" || warn "Веб-сервер не ответил за 2 минуты — проверьте: $DC logs web"

# ── 10. Итог ──────────────────────────────────────────────────────────────────
HOST_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null \
  || hostname -I 2>/dev/null | awk '{print $1}' \
  || echo '<адрес-сервера>')"

ADMIN_LOGIN_SHOW="$(grep -E '^ADMIN_LOGIN=' .env | cut -d= -f2 || echo admin)"

echo
echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${GREEN}Апдейкон успешно запущен!${NC}               ${CYAN}║${NC}"
echo -e "${CYAN}╠════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}                                                ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Сайт:    ${GREEN}http://${HOST_IP}:${PORT}/${NC}"
echo -e "${CYAN}║${NC}  Админка: ${GREEN}http://${HOST_IP}:${PORT}/admin${NC}"
echo -e "${CYAN}║${NC}  Логин:   ${YELLOW}${ADMIN_LOGIN_SHOW}${NC}"
echo -e "${CYAN}║${NC}                                                ${CYAN}║${NC}"
echo -e "${CYAN}╠════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Полезные команды:                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}    $DC logs -f worker   # прогресс импорта  ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}    $DC logs -f web       # веб-сервер        ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}    $DC down              # остановить         ${CYAN}║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo
