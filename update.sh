#!/usr/bin/env bash
# update.sh — обновление Апдейкон до последней версии.
#
#   bash update.sh
#   bash <(curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/update.sh)
#
# Скачивает готовый Docker-образ из ghcr.io и перезапускает сервисы.
# .env и данные PostgreSQL не трогаются.

set -euo pipefail

GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'
CYAN='\033[1;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { printf "${GREEN}  ✓${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}  !${NC}  %s\n" "$*"; }
err()  { printf "${RED}  ✗${NC}  %s\n" "$*" >&2; }

LOG_FILE="/tmp/updatecon-update-$(date +%Y%m%d-%H%M%S).log"

run_spin() {
  local msg="$1"; shift
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

echo
echo -e "${CYAN}${BOLD}  ▶  Обновление Апдейкон${NC}"
echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
echo

cd "$PROJECT_DIR"

# Обновляем docker-compose.yml из репозитория чтобы гарантировать
# наличие image: ghcr.io/... (старые инсталляции могли не иметь этой строки)
RAW="https://raw.githubusercontent.com/iMironRU/updatecon/main/docker-compose.yml"
if curl -fsSL --max-time 10 "$RAW" -o docker-compose.yml.new >> "$LOG_FILE" 2>&1; then
  mv docker-compose.yml.new docker-compose.yml
  log "docker-compose.yml обновлён"
else
  warn "Не удалось обновить docker-compose.yml — продолжаем с текущим"
  rm -f docker-compose.yml.new
fi

run_spin "Скачиваем образ из ghcr.io" $DC pull

run_spin "Перезапускаем сервисы" $DC up -d

# ── Проверка ──────────────────────────────────────────────────────────────────
PORT="$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)"
printf "  ${CYAN}⠋${NC}  Ждём веб-сервер..."
OK=0
for i in $(seq 1 20); do
  curl -fsS "http://localhost:${PORT}/api/health" >> "$LOG_FILE" 2>&1 && { OK=1; break; }
  sleep 3
done
[ "$OK" = "1" ] \
  && printf "\r  ${GREEN}✓${NC}  Веб-сервер отвечает   \n" \
  || printf "\r  ${YELLOW}!${NC}  Не ответил — проверьте: %s logs web\n" "$DC"

echo
echo -e "${GREEN}${BOLD}  ✓  Апдейкон обновлён.${NC}"
echo

rm -f "$LOG_FILE"
