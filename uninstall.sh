#!/usr/bin/env bash
# uninstall.sh — полное удаление Апдейкон с сервера.
#
#   bash uninstall.sh
#
# Останавливает и удаляет контейнеры, образы, сеть.
# Данные в PostgreSQL удаляются только при явном подтверждении.

set -euo pipefail

GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'
CYAN='\033[1;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { printf "${GREEN}  ✓${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}  !${NC}  %s\n" "$*"; }
err()  { printf "${RED}  ✗${NC}  %s\n" "$*" >&2; }
step() { printf "${CYAN}${BOLD}▶${NC}  %s\n" "$*"; }

# ── Определяем compose ────────────────────────────────────────────────────────
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  err "Docker Compose не найден — возможно, Docker уже удалён."
  DC=""
fi

# ── Находим директорию проекта ────────────────────────────────────────────────
# Приоритет: рядом со скриптом → ~/updatecon → текущая директория (только если
# там есть docker-compose.yml, иначе пустая строка — директория не удаляется).
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

echo
echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${RED}${BOLD}║           Удаление Апдейкон                      ║${NC}"
echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo
warn "Это действие остановит и удалит все контейнеры Апдейкон."
echo

# ── Вопросы ДО удаления ───────────────────────────────────────────────────────
read -rp "  Удалить данные PostgreSQL (все конфигурации и обновления)? [y/N]: " DEL_DATA
DEL_DATA="${DEL_DATA:-n}"

read -rp "  Удалить Docker-образы (updatecon-web, updatecon-worker)? [y/N]: " DEL_IMAGES
DEL_IMAGES="${DEL_IMAGES:-n}"

DIR_TO_DELETE=""
if [ -n "$PROJECT_DIR" ]; then
  read -rp "  Удалить директорию $PROJECT_DIR ? [y/N]: " DEL_DIR
  DEL_DIR="${DEL_DIR:-n}"
  [[ "$DEL_DIR" =~ ^[Yy] ]] && DIR_TO_DELETE="$PROJECT_DIR"
else
  warn "  Директория проекта не найдена — пропускаем этот пункт."
fi

echo
echo -e "${CYAN}  ┌─ Будет выполнено ──────────────────────────────┐${NC}"
echo -e "  │  • Остановить и удалить контейнеры             │"
[[ "$DEL_DATA"   =~ ^[Yy] ]] && echo -e "  │  • ${RED}Удалить данные PostgreSQL (необратимо!)${NC}    │"
[[ "$DEL_IMAGES" =~ ^[Yy] ]] && echo -e "  │  • Удалить Docker-образы                       │"
[ -n "$DIR_TO_DELETE"       ] && echo -e "  │  • Удалить директорию проекта                  │"
echo -e "${CYAN}  └────────────────────────────────────────────────┘${NC}"
echo
read -rp "  Подтвердить удаление? [y/N]: " CONFIRM
[[ "${CONFIRM:-n}" =~ ^[Yy] ]] || { echo "  Отмена."; exit 0; }
echo

# ── Выполнение ────────────────────────────────────────────────────────────────
step "Удаление начато"

if [ -n "$DC" ] && [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
  cd "$PROJECT_DIR"

  if [[ "$DEL_DATA" =~ ^[Yy] ]]; then
    printf "  Останавливаем контейнеры и удаляем volumes..."
    $DC down -v >> /tmp/updatecon-uninstall.log 2>&1 \
      && printf "\r  ${GREEN}✓${NC}  Контейнеры и данные удалены   \n" \
      || { printf "\r  ${YELLOW}!${NC}  Ошибка при удалении volumes\n"; $DC down >> /tmp/updatecon-uninstall.log 2>&1 || true; }
  else
    printf "  Останавливаем контейнеры (данные сохранены)..."
    $DC down >> /tmp/updatecon-uninstall.log 2>&1 \
      && printf "\r  ${GREEN}✓${NC}  Контейнеры остановлены   \n" \
      || printf "\r  ${YELLOW}!${NC}  Ошибка, возможно уже остановлены\n"
  fi

  if [[ "$DEL_IMAGES" =~ ^[Yy] ]]; then
    printf "  Удаляем Docker-образы..."
    docker rmi updatecon-web updatecon-worker >> /tmp/updatecon-uninstall.log 2>&1 \
      && printf "\r  ${GREEN}✓${NC}  Образы удалены   \n" \
      || printf "\r  ${YELLOW}!${NC}  Образы не найдены или уже удалены\n"
  fi
else
  warn "docker-compose.yml не найден — пропускаем остановку контейнеров."
fi

if [ -n "$DIR_TO_DELETE" ]; then
  printf "  Удаляем директорию %s..." "$DIR_TO_DELETE"
  cd /tmp  # уходим из директории перед удалением, иначе shell потеряет cwd
  rm -rf "$DIR_TO_DELETE" \
    && printf "\r  ${GREEN}✓${NC}  Директория удалена   \n" \
    || printf "\r  ${RED}✗${NC}  Не удалось удалить директорию\n"
fi

echo
echo -e "${GREEN}${BOLD}  Апдейкон удалён.${NC}"
if ! [[ "$DEL_DATA" =~ ^[Yy] ]]; then
  warn "Данные PostgreSQL сохранены в Docker volume 'updatecon_pgdata'."
  warn "Удалить вручную: docker volume rm updatecon_pgdata"
fi
echo
