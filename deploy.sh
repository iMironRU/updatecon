#!/usr/bin/env bash
# deploy.sh — установка Апдейкон на Ubuntu / Debian.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/deploy.sh)
#
# Повторный запуск безопасен: .env и данные не трогаются.

set -euo pipefail

# Если текущая директория была удалена (после uninstall.sh) — уходим в домашнюю
cd "$(pwd 2>/dev/null || echo ~)" 2>/dev/null || cd ~

# ── Цвета и утилиты ───────────────────────────────────────────────────────────
GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'
CYAN='\033[1;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { printf "${GREEN}  ✓${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}  !${NC}  %s\n" "$*"; }
err()  { printf "${RED}  ✗${NC}  %s\n" "$*" >&2; }
step() { printf "${CYAN}${BOLD}▶${NC}  %s\n" "$*"; }

LOG_FILE="/tmp/updatecon-install-$(date +%Y%m%d-%H%M%S).log"

# Запускает команду тихо, показывает спиннер. При ошибке — печатает хвост лога.
run_spin() {
  local msg="$1"; shift
  printf "  ${CYAN}⠋${NC}  %s..." "$msg"
  "$@" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    local f="${frames:$i:1}"
    printf "\r  ${CYAN}%s${NC}  %s..." "$f" "$msg"
    i=$(( (i+1) % 10 ))
    sleep 0.12
  done
  wait "$pid" || {
    printf "\r  ${RED}✗${NC}  %s — ошибка! Подробности:\n" "$msg"
    tail -n 20 "$LOG_FILE" | sed 's/^/      /' >&2
    echo; err "Лог: $LOG_FILE"; exit 1
  }
  printf "\r  ${GREEN}✓${NC}  %s   \n" "$msg"
}

port_free() {
  ! ss -tlnp 2>/dev/null | grep -qE ":$1\b" && \
  ! (command -v netstat >/dev/null && netstat -tlnp 2>/dev/null | grep -qE ":$1\b")
}

# ── 1. OS-проверка ────────────────────────────────────────────────────────────
OS_ID="$(. /etc/os-release 2>/dev/null && echo "$ID" || echo unknown)"
OS_VER="$(. /etc/os-release 2>/dev/null && echo "$VERSION_ID" || echo 0)"
case "$OS_ID" in
  ubuntu)
    [ "${OS_VER%%.*}" -ge 20 ] 2>/dev/null || { err "Требуется Ubuntu 20.04+. Обнаружено: $OS_VER"; exit 1; }
    ;;
  debian)
    [ "${OS_VER%%.*}" -ge 11 ] 2>/dev/null || { err "Требуется Debian 11+. Обнаружено: $OS_VER"; exit 1; }
    ;;
  *) warn "Непроверенная ОС: $OS_ID $OS_VER" ;;
esac

# ── 2. Найти / получить репозиторий ──────────────────────────────────────────
REPO_URL="https://github.com/iMironRU/updatecon.git"
REPO_DIR="updatecon"

_ensure_repo() {
  if command -v git >/dev/null 2>&1; then return; fi
  apt-get update -qq && apt-get install -y -qq git
}

if [ ! -f "$(pwd)/docker-compose.yml" ]; then
  if [ -d "$REPO_DIR/.git" ]; then
    run_spin "Обновляем репозиторий" bash -c "cd '$REPO_DIR' && git pull --ff-only"
    cd "$REPO_DIR"
  else
    [ -d "$REPO_DIR" ] && rm -rf "$REPO_DIR"
    run_spin "Устанавливаем git" _ensure_repo
    run_spin "Клонируем репозиторий" git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
  fi
fi

SEED_FILE="data/seed.sql.gz"
IS_FRESH=false
[ ! -f .env ] && IS_FRESH=true

# ── 3. Сбор всех параметров ДО начала установки ──────────────────────────────
echo
echo -e "${CYAN}${BOLD}  ▶  Установка Апдейкон${NC}"
echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
echo

if $IS_FRESH; then
  # Внешний порт
  while true; do
    read -rp "  Внешний порт сайта [80]: " WEB_PORT_INPUT
    WEB_PORT_INPUT="${WEB_PORT_INPUT:-80}"
    if ! [[ "$WEB_PORT_INPUT" =~ ^[0-9]+$ ]] || [ "$WEB_PORT_INPUT" -lt 1 ] || [ "$WEB_PORT_INPUT" -gt 65535 ]; then
      warn "  Некорректный порт, введите число от 1 до 65535."
      continue
    fi
    if ! port_free "$WEB_PORT_INPUT"; then
      warn "  Порт $WEB_PORT_INPUT занят. Выберите другой."
      continue
    fi
    break
  done

  # Логин администратора
  read -rp "  Логин администратора [admin]: " ADMIN_LOGIN
  ADMIN_LOGIN="${ADMIN_LOGIN:-admin}"

  # Пароль администратора
  while true; do
    read -rsp "  Пароль администратора (мин. 6 символов): " ADMIN_PW; echo
    [ ${#ADMIN_PW} -ge 6 ] && break
    warn "  Слишком короткий, попробуйте ещё раз."
  done

  # ИТС (необязательно)
  echo
  echo -e "  ${YELLOW}ИТС-кредиты${NC} нужны для авто-синхронизации с 1С (необязательно)."
  echo   "  Оставьте пустыми — можно задать позже в .env."
  read -rp "  Логин ИТС (Enter — пропустить): " ITS_LOGIN_INPUT
  ITS_PW_INPUT=""
  if [ -n "$ITS_LOGIN_INPUT" ]; then
    read -rsp "  Пароль ИТС: " ITS_PW_INPUT; echo
  fi

  # Восстановить дамп?
  RESTORE_SEED="n"
  if [ -f "$SEED_FILE" ]; then
    echo
    read -rp "  Восстановить начальный дамп данных (603 конфигурации 1С)? [Y/n]: " RESTORE_SEED
    RESTORE_SEED="${RESTORE_SEED:-Y}"
  fi

  # Сводка
  echo
  echo -e "${CYAN}  ┌─ Параметры установки ─────────────────${NC}"
  echo -e "  │  Внешний порт:  ${BOLD}$WEB_PORT_INPUT${NC}"
  echo -e "  │  Логин admin:   ${BOLD}$ADMIN_LOGIN${NC}"
  echo -e "  │  Логин ИТС:     ${BOLD}${ITS_LOGIN_INPUT:-не задан}${NC}"
  echo -e "  │  Восст. дамп:   ${BOLD}$( [[ "$RESTORE_SEED" =~ ^[Yy] ]] && echo "да" || echo "нет" )${NC}"
  echo -e "${CYAN}  └───────────────────────────────────────${NC}"
  echo
  read -rp "  Начать установку? [Enter / n]: " CONFIRM
  [[ "${CONFIRM:-y}" =~ ^[Nn] ]] && { echo "Отмена."; exit 0; }
else
  warn ".env уже существует — конфигурация не изменяется."
  WEB_PORT_INPUT="$(grep -E '^WEB_PORT=' .env | cut -d= -f2 || echo 3000)"
  echo
fi

echo
step "Установка началась. Лог: $LOG_FILE"
echo

# ── 4. Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  run_spin "Устанавливаем Docker" bash -c "curl -fsSL https://get.docker.com | sh \
    && usermod -aG docker '${SUDO_USER:-$USER}' 2>/dev/null || true"
fi

if docker compose version >> "$LOG_FILE" 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  err "Docker Compose не найден."; exit 1
fi
log "Docker готов"

# ── 5. .env ───────────────────────────────────────────────────────────────────
if $IS_FRESH; then
  cp .env.example .env
  DB_PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${DB_PW}/"   .env
  sed -i "s|postgres://upd:changeme@|postgres://upd:${DB_PW}@|"  .env
  sed -i "s/^WEB_PORT=.*/WEB_PORT=${WEB_PORT_INPUT}/"            .env
  sed -i "s/^ADMIN_LOGIN=.*/ADMIN_LOGIN=${ADMIN_LOGIN}/"         .env
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${ADMIN_PW}/"      .env
  [ -n "$ITS_LOGIN_INPUT" ] && {
    sed -i "s/^ITS_LOGIN=.*/ITS_LOGIN=${ITS_LOGIN_INPUT}/"       .env
    sed -i "s/^ITS_PASSWORD=.*/ITS_PASSWORD=${ITS_PW_INPUT}/"    .env
  }
  log ".env создан"
fi

mkdir -p data

# ── 6. Сборка образов ─────────────────────────────────────────────────────────
run_spin "Сборка Docker-образов (может занять 2-5 мин)" $DC build

# ── 7. PostgreSQL ─────────────────────────────────────────────────────────────
run_spin "Запуск PostgreSQL" $DC up -d db
printf "  ${CYAN}⠋${NC}  Ждём готовности БД..."
for i in $(seq 1 30); do
  $DC exec -T db pg_isready -U upd >> "$LOG_FILE" 2>&1 && break || sleep 2
done
printf "\r  ${GREEN}✓${NC}  PostgreSQL готов   \n"

# Если volume существовал до установки, пароль в БД мог отличаться от нового .env.
# Синхронизируем на случай переустановки с сохранёнными данными.
DB_PW_SYNC="$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2)"
$DC exec -T db psql -U upd -d upd -c "ALTER USER upd PASSWORD '${DB_PW_SYNC}'" >> "$LOG_FILE" 2>&1 || true

# ── 8. Восстановление дампа ───────────────────────────────────────────────────
if $IS_FRESH && [[ "${RESTORE_SEED:-n}" =~ ^[Yy] ]] && [ -f "$SEED_FILE" ]; then
  # Запускаем воркер только для применения миграций
  $DC up -d worker >> "$LOG_FILE" 2>&1
  printf "  ${CYAN}⠋${NC}  Применяем миграции БД..."
  MIGRATED=0
  for i in $(seq 1 30); do
    READY=$($DC exec -T db psql -U upd -d upd -tAc \
      "SELECT count(*) FROM information_schema.tables \
       WHERE table_schema='public' AND table_name='configurations'" 2>/dev/null \
      | tr -d '[:space:]' || echo 0)
    [ "$READY" = "1" ] && { MIGRATED=1; break; }
    sleep 2
  done
  $DC stop worker >> "$LOG_FILE" 2>&1
  [ "$MIGRATED" != "1" ] && { err "Таблицы не созданы — см. $LOG_FILE"; exit 1; }
  printf "\r  ${GREEN}✓${NC}  Миграции применены   \n"

  run_spin "Восстанавливаем дамп данных" bash -c \
    "zcat '$SEED_FILE' | $DC exec -T db psql -U upd -d upd -q"

  sed -i "s/^IMPORT_ON_START=.*/IMPORT_ON_START=0/" .env
fi

# ── 9. Полный запуск ──────────────────────────────────────────────────────────
run_spin "Запуск всех сервисов" $DC up -d

# ── 10. Проверка ──────────────────────────────────────────────────────────────
PORT="$(grep -E '^WEB_PORT=' .env | cut -d= -f2 || echo 3000)"
printf "  ${CYAN}⠋${NC}  Ждём веб-сервер..."
OK=0
for i in $(seq 1 40); do
  curl -fsS "http://localhost:${PORT}/api/health" >> "$LOG_FILE" 2>&1 && { OK=1; break; }
  sleep 3
done
[ "$OK" = "1" ] && printf "\r  ${GREEN}✓${NC}  Веб-сервер отвечает   \n" \
                || { printf "\r  ${YELLOW}!${NC}  Не ответил за 2 мин\n"; warn "Проверьте: $DC logs web"; }

# ── 11. Итог ──────────────────────────────────────────────────────────────────
HOST_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null \
  || hostname -I 2>/dev/null | awk '{print $1}' || echo '<IP>')"
ADMIN_SHOW="$(grep -E '^ADMIN_LOGIN=' .env | cut -d= -f2 || echo admin)"

PORT_SUFFIX="$( [ "$PORT" = "80" ] && echo "" || echo ":$PORT" )"

echo
echo -e "${GREEN}${BOLD}  ✓  Апдейкон успешно запущен!${NC}"
echo -e "${GREEN}  ──────────────────────────────────────────${NC}"
echo -e "  ${BOLD}Сайт:${NC}     ${GREEN}http://${HOST_IP}${PORT_SUFFIX}/${NC}"
echo -e "  ${BOLD}Админка:${NC}  ${GREEN}http://${HOST_IP}${PORT_SUFFIX}/admin${NC}"
echo -e "  ${BOLD}Логин:${NC}    ${YELLOW}${ADMIN_SHOW}${NC}"
echo -e "${GREEN}  ──────────────────────────────────────────${NC}"
echo -e "  ${BOLD}Команды управления:${NC}"
echo    "    $DC logs -f worker   # прогресс импорта"
echo    "    $DC logs -f web      # веб-сервер"
echo    "    $DC down             # остановить"
echo    "    bash uninstall.sh    # удалить"
echo

# ── 12. Лог ───────────────────────────────────────────────────────────────────
echo -e "  Лог установки сохранён: ${CYAN}$LOG_FILE${NC}"
read -rp "  Удалить лог? [y/N]: " DEL_LOG
[[ "${DEL_LOG:-n}" =~ ^[Yy] ]] && rm -f "$LOG_FILE" && log "Лог удалён." || log "Лог сохранён: $LOG_FILE"
echo
