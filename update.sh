#!/usr/bin/env bash
# update.sh — обновление Апдейкон до последней версии.
#
#   bash update.sh
#   bash <(curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/update.sh)
#
# Скачивает готовый Docker-образ из ghcr.io и перезапускает сервисы.
# .env и данные PostgreSQL не трогаются. Работает в обоих режимах установки:
# свой Caddy (docker-compose.yml) и за внешним прокси (COMPOSE_FILE в .env).
# Ночное автообновление (deploy.sh → /etc/cron.d/updatecon) запускает его с
# UPDATECON_DIR=<папка установки>.

set -euo pipefail

GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'
CYAN='\033[1;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { printf "${GREEN}  ✓${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}  !${NC}  %s\n" "$*"; }
err()  { printf "${RED}  ✗${NC}  %s\n" "$*" >&2; }

LOG_FILE="/tmp/updatecon-update-$(date +%Y%m%d-%H%M%S).log"

run_spin() {
  local msg="$1"; shift
  # Not a terminal (cron): no spinner, plain lines for the log.
  if [ ! -t 1 ]; then
    "$@" >> "$LOG_FILE" 2>&1 || { echo "  ✗ $msg — ошибка:"; tail -n 20 "$LOG_FILE"; exit 1; }
    echo "  ✓ $msg"; return 0
  fi
  printf "  ${CYAN}⠋${NC}  %s..." "$msg"
  "$@" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CYAN}${frames:$i:1}${NC}  %s..." "$msg"
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

# ── Находим директорию проекта ────────────────────────────────────────────────
_find_project_dir() {
  if [ -n "${UPDATECON_DIR:-}" ] && [ -f "${UPDATECON_DIR}/docker-compose.yml" ]; then echo "$UPDATECON_DIR"; return; fi
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd 2>/dev/null || true)"
  if [ -f "${script_dir}/docker-compose.yml" ]; then echo "$script_dir"; return; fi
  if [ -f "${HOME}/updatecon/docker-compose.yml" ]; then echo "${HOME}/updatecon"; return; fi
  local cwd; cwd="$(pwd 2>/dev/null || true)"
  if [ -n "$cwd" ] && [ -f "${cwd}/docker-compose.yml" ]; then echo "$cwd"; return; fi
  echo ""
}
PROJECT_DIR="$(_find_project_dir)"

if [ -z "$PROJECT_DIR" ]; then
  err "Директория проекта не найдена. Убедитесь что Апдейкон установлен."
  exit 1
fi

# ── Определяем compose ────────────────────────────────────────────────────────
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  err "Docker Compose не найден."; exit 1
fi

[ -t 1 ] || echo "── $(date '+%F %T') ──"
echo
echo -e "${CYAN}${BOLD}  ▶  Обновление Апдейкон${NC}"
echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
echo

cd "$PROJECT_DIR"

# Обновляем конфиг-файлы из репозитория.
# Важно: скачиваем все файлы, которые монтируются в контейнеры — иначе Docker
# создаст директорию вместо отсутствующего файла и запуск упадёт.
RAW_BASE="https://raw.githubusercontent.com/iMironRU/updatecon/main"

_fetch_file() {
  local name="$1"
  if curl -fsSL --max-time 10 "${RAW_BASE}/${name}" -o "${name}.new" >> "$LOG_FILE" 2>&1; then
    # Если на диске директория с тем же именем — удалить её
    [ -d "$name" ] && rm -rf "$name"
    mv "${name}.new" "$name"
    return 0
  else
    rm -f "${name}.new"
    return 1
  fi
}

if _fetch_file "docker-compose.yml"; then
  log "docker-compose.yml обновлён"
else
  warn "Не удалось обновить docker-compose.yml — продолжаем с текущим"
fi

# Режим «за внешним прокси» (deploy.sh, вариант 2)
if grep -qE '^COMPOSE_FILE=docker-compose.proxy.yml' .env 2>/dev/null; then
  _fetch_file "docker-compose.proxy.yml" && log "docker-compose.proxy.yml обновлён" \
    || warn "Не удалось обновить docker-compose.proxy.yml — продолжаем с текущим"
fi

if _fetch_file "Caddyfile"; then
  log "Caddyfile обновлён"
else
  warn "Не удалось обновить Caddyfile — продолжаем с текущим"
fi

run_spin "Скачиваем образ из ghcr.io" $DC pull

run_spin "Перезапускаем сервисы" $DC up -d

# ── Проверка ──────────────────────────────────────────────────────────────────
# WEB_PORT пустой когда используется Caddy (трафик идёт через :80).
# Проверяем: сначала через Caddy (:80), затем прямой порт.
WEB_PORT_RAW="$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
printf "  ${CYAN}⠋${NC}  Ждём веб-сервер..."
OK=0
for i in $(seq 1 20); do
  curl -fsS "http://localhost:80/api/health" >> "$LOG_FILE" 2>&1 && { OK=1; break; }
  if [ -n "$WEB_PORT_RAW" ]; then
    curl -fsS "http://localhost:${WEB_PORT_RAW}/api/health" >> "$LOG_FILE" 2>&1 && { OK=1; break; }
  fi
  sleep 3
done
[ "$OK" = "1" ] \
  && printf "\r  ${GREEN}✓${NC}  Веб-сервер отвечает   \n" \
  || printf "\r  ${YELLOW}!${NC}  Не ответил — проверьте: %s logs web\n" "$DC"

echo
echo -e "${GREEN}${BOLD}  ✓  Апдейкон обновлён.${NC}"
echo

rm -f "$LOG_FILE"
