#!/usr/bin/env bash
# manage.sh — Апдейкон: установка, обновление, удаление.
#
#   bash manage.sh
#   bash <(curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/manage.sh)

set -euo pipefail
cd "$(pwd 2>/dev/null || echo ~)" 2>/dev/null || cd ~

# ── Цвета и утилиты ───────────────────────────────────────────────────────────
GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'
CYAN='\033[1;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
ORANGE='\033[1;33m'

log()  { printf "${GREEN}  ✓${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}  !${NC}  %s\n" "$*"; }
err()  { printf "${RED}  ✗${NC}  %s\n" "$*" >&2; }
step() { printf "${CYAN}${BOLD}▶${NC}  %s\n" "$*"; }

LOG_FILE="/tmp/updatecon-$(date +%Y%m%d-%H%M%S).log"

run_spin() {
  local msg="$1"; shift
  printf "  ${CYAN}⠋${NC}  %s..." "$msg"
  "$@" >> "$LOG_FILE" 2>&1 &
  local pid=$! frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CYAN}${frames:$i:1}${NC}  %s..." "$msg"
    i=$(( (i+1) % 10 )); sleep 0.12
  done
  wait "$pid" || {
    printf "\r  ${RED}✗${NC}  %s — ошибка!\n" "$msg"
    tail -n 20 "$LOG_FILE" | sed 's/^/      /' >&2
    echo; err "Лог: $LOG_FILE"; exit 1
  }
  printf "\r  ${GREEN}✓${NC}  %s   \n" "$msg"
}

port_free() {
  ! ss -tlnp 2>/dev/null | grep -qE ":$1\b" && \
  ! (command -v netstat >/dev/null && netstat -tlnp 2>/dev/null | grep -qE ":$1\b")
}

# ── Helpers ───────────────────────────────────────────────────────────────────
_find_project_dir() {
  local s; s="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd 2>/dev/null || true)"
  [ -f "${s}/docker-compose.yml" ]          && { echo "$s"; return; }
  [ -f "${HOME}/updatecon/docker-compose.yml" ] && { echo "${HOME}/updatecon"; return; }
  local c; c="$(pwd 2>/dev/null || true)"
  [ -n "$c" ] && [ -f "${c}/docker-compose.yml" ] && { echo "$c"; return; }
  echo ""
}

_detect_dc() {
  if docker compose version >/dev/null 2>&1; then echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"
  else err "Docker Compose не найден."; exit 1; fi
}

# ── Проверка статуса ─────────────────────────────────────────────────────────
# Возвращает: installed / not_installed
_install_status() {
  local dir; dir="$(_find_project_dir)"
  [ -n "$dir" ] && echo "installed" || echo "not_installed"
}

# Возвращает: available / uptodate / unknown
_update_status() {
  local image="ghcr.io/imironru/updatecon:latest"
  # Локальный digest
  local local_digest
  local_digest="$(docker inspect --format='{{index .RepoDigests 0}}' "$image" 2>/dev/null \
    | grep -o 'sha256:[a-f0-9]*')" || true
  [ -z "$local_digest" ] && { echo "unknown"; return; }

  # Анонимный токен ghcr.io
  local token
  token="$(curl -sf --max-time 5 \
    "https://ghcr.io/token?scope=repository:imironru/updatecon:pull&service=ghcr.io" \
    | grep -o '"token":"[^"]*"' | cut -d'"' -f4)" || { echo "unknown"; return; }
  [ -z "$token" ] && { echo "unknown"; return; }

  # Удалённый digest (HEAD-запрос, без скачивания)
  local remote_digest
  remote_digest="$(curl -sf --max-time 5 \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    --head "https://ghcr.io/v2/imironru/updatecon/manifests/latest" \
    | grep -i '^docker-content-digest:' | awk '{print $2}' | tr -d '\r\n')" || { echo "unknown"; return; }
  [ -z "$remote_digest" ] && { echo "unknown"; return; }

  [ "$local_digest" = "$remote_digest" ] && echo "uptodate" || echo "available"
}

# ── Главное меню ─────────────────────────────────────────────────────────────
main_menu() {
  local inst upd

  # Проверяем статус (с индикатором)
  printf "  ${DIM}Проверяем статус...${NC}"
  inst="$(_install_status)"
  if [ "$inst" = "installed" ]; then
    upd="$(_update_status)"
  else
    upd="unknown"
  fi
  printf "\r\033[K"  # стираем строку

  # Отрисовка меню
  echo
  echo -e "${CYAN}${BOLD}  ▶  Апдейкон — управление${NC}"
  echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
  echo

  # Строка статуса
  if [ "$inst" = "installed" ]; then
    local ver_info=""
    local dir; dir="$(_find_project_dir)"
    local dc; dc="$(_detect_dc)" 2>/dev/null || true
    if [ -n "$dc" ] && [ -n "$dir" ]; then
      # cd, not -f: docker compose then honours COMPOSE_FILE from .env (proxy mode)
      ver_info="$(cd "$dir" && $dc exec -T web \
        sh -c 'cat /app/public/version.json 2>/dev/null' 2>/dev/null \
        | grep -o '"date":"[^"]*"' | cut -d'"' -f4 | cut -c1-10 || true)"
    fi
    if [ -n "$ver_info" ] && [ "$ver_info" != "dev" ]; then
      echo -e "  Статус: ${GREEN}установлен${NC} · сборка ${BOLD}${ver_info}${NC}"
    else
      echo -e "  Статус: ${GREEN}установлен${NC}"
    fi
  else
    echo -e "  Статус: ${DIM}не установлен${NC}"
  fi
  echo

  # Пункты меню
  if [ "$inst" = "not_installed" ]; then
    echo -e "  ${BOLD}1.${NC}  Установить"
    echo -e "  ${DIM}2.  Обновить          — сначала установите${NC}"
    echo -e "  ${DIM}3.  Настройки .env    — сначала установите${NC}"
    echo -e "  ${DIM}4.  Удалить            — не установлено${NC}"
  else
    echo -e "  ${DIM}1.  Установить        — уже установлено${NC}"
    case "$upd" in
      available)
        echo -e "  ${BOLD}2.${NC}  Обновить          ${ORANGE}↑ доступно обновление${NC}"
        ;;
      uptodate)
        echo -e "  ${DIM}2.  Обновить          — актуальная версия${NC}"
        ;;
      *)
        echo -e "  ${BOLD}2.${NC}  Обновить"
        ;;
    esac
    echo -e "  ${BOLD}3.${NC}  Настройки .env    ${DIM}(пароли, ИТС, порт)${NC}"
    echo -e "  ${BOLD}4.${NC}  Удалить"
  fi

  echo
  echo -e "  ${BOLD}0.${NC}  Выход"
  echo
  echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
  echo

  local choice
  read -rp "  Введите номер: " choice

  case "$choice" in
    1)
      if [ "$inst" = "installed" ]; then
        warn "Уже установлен. Для переустановки сначала удалите (пункт 4)."
        echo; read -rp "  Нажмите Enter..." _; main_menu
      else
        do_install
      fi ;;
    2)
      if [ "$inst" = "not_installed" ]; then
        err "Апдейкон не установлен."; echo
        read -rp "  Нажмите Enter..." _; main_menu
      elif [ "$upd" = "uptodate" ]; then
        log "Уже установлена актуальная версия — обновление не требуется."
        echo; read -rp "  Нажмите Enter..." _; main_menu
      else
        do_update
      fi ;;
    3)
      if [ "$inst" = "not_installed" ]; then
        err "Апдейкон не установлен."; echo
        read -rp "  Нажмите Enter..." _; main_menu
      else
        do_settings
      fi ;;
    4)
      if [ "$inst" = "not_installed" ]; then
        err "Апдейкон не установлен."; echo
        read -rp "  Нажмите Enter..." _; main_menu
      else
        do_uninstall
      fi ;;
    0|"")
      echo "  До свидания."; rm -f "$LOG_FILE"; exit 0 ;;
    *)
      err "Неверный выбор."; echo
      read -rp "  Нажмите Enter..." _; main_menu ;;
  esac
}

# ── Установка ─────────────────────────────────────────────────────────────────
do_install() {
  # One installer: deploy.sh (both modes — own Caddy or behind a proxy — and auto-update).
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  if [ -n "$here" ] && [ -f "$here/deploy.sh" ]; then
    bash "$here/deploy.sh"
  else
    bash <(curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/deploy.sh)
  fi
}

# ── Настройки .env ───────────────────────────────────────────────────────────
do_settings() {
  local dir; dir="$(_find_project_dir)"
  local dc; dc="$(_detect_dc)"
  local env_file="${dir}/.env"

  if [ ! -f "$env_file" ]; then
    err "Файл .env не найден: $env_file"; echo
    read -rp "  Нажмите Enter..." _; main_menu; return
  fi

  # ── Вспомогательные функции ──────────────────────────────────────────────────
  # Читает значение переменной из .env
  _env_get() { grep -E "^${1}=" "$env_file" 2>/dev/null | cut -d= -f2- || true; }

  # Устанавливает (или добавляет) переменную в .env
  _env_set() {
    local key="$1" val="$2"
    if grep -qE "^${key}=" "$env_file" 2>/dev/null; then
      # Заменяем существующую строку
      local tmpf; tmpf=$(mktemp)
      grep -v "^${key}=" "$env_file" > "$tmpf"
      printf '%s=%s\n' "$key" "$val" >> "$tmpf"
      mv "$tmpf" "$env_file"
    else
      printf '%s=%s\n' "$key" "$val" >> "$env_file"
    fi
  }

  settings_menu() {
    echo
    echo -e "${CYAN}${BOLD}  ▶  Настройки .env${NC}"
    echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
    echo

    local admin_login; admin_login="$(_env_get ADMIN_LOGIN)"
    local its_login;   its_login="$(_env_get ITS_LOGIN)"
    local web_port;    web_port="$(_env_get WEB_PORT)"

    # Маскируем пароли — показываем только наличие
    local admin_set its_set
    [ -n "$(_env_get ADMIN_PASSWORD)" ] && admin_set="${GREEN}задан${NC}" || admin_set="${YELLOW}не задан${NC}"
    [ -n "$(_env_get ITS_PASSWORD)" ]   && its_set="${GREEN}задан${NC}"   || its_set="${YELLOW}не задан${NC}"

    echo -e "  ${BOLD}1.${NC}  Логин + пароль ИТС  ${DIM}${its_login:-не задан}${NC}  пароль: $(echo -e "${its_set}")"
    echo -e "  ${BOLD}2.${NC}  Логин + пароль админки  ${DIM}${admin_login:-не задан}${NC}  пароль: $(echo -e "${admin_set}")"
    echo -e "  ${BOLD}3.${NC}  Внешний порт        ${DIM}${web_port:-80}${NC}"
    echo
    echo -e "  ${BOLD}0.${NC}  Назад"
    echo
    echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
    echo

    local schoice
    read -rp "  Введите номер: " schoice

    case "$schoice" in
      1)
        local cur_l; cur_l="$(_env_get ITS_LOGIN)"
        read -rp "  ИТС логин [${cur_l}]: " v_l
        v_l="${v_l:-$cur_l}"
        [ -z "$v_l" ] && { warn "Логин не может быть пустым — отмена."; echo; settings_menu; return; }
        local p1 p2
        read -rsp "  ИТС пароль (Enter — оставить без изменений): " p1; echo
        if [ -n "$p1" ]; then
          read -rsp "  Повторите пароль: " p2; echo
          [ "$p1" != "$p2" ] && { err "Пароли не совпадают — отмена."; echo; settings_menu; return; }
          _env_set ITS_PASSWORD "$p1"
          log "ITS_PASSWORD сохранён"
        fi
        _env_set ITS_LOGIN "$v_l"
        log "ITS_LOGIN сохранён: $v_l"
        _apply_env "$dir" "$dc" && echo
        settings_menu ;;
      2)
        local cur_a; cur_a="$(_env_get ADMIN_LOGIN)"
        read -rp "  Логин админки [${cur_a:-admin}]: " v_a
        v_a="${v_a:-${cur_a:-admin}}"
        local p1 p2
        read -rsp "  Пароль админки (Enter — оставить без изменений): " p1; echo
        if [ -n "$p1" ]; then
          read -rsp "  Повторите пароль: " p2; echo
          [ "$p1" != "$p2" ] && { err "Пароли не совпадают — отмена."; echo; settings_menu; return; }
          _env_set ADMIN_PASSWORD "$p1"
          log "ADMIN_PASSWORD сохранён"
        fi
        _env_set ADMIN_LOGIN "$v_a"
        log "ADMIN_LOGIN сохранён: $v_a"
        _apply_env "$dir" "$dc" && echo
        settings_menu ;;
      3)
        local cur; cur="$(_env_get WEB_PORT)"
        read -rp "  Внешний порт [${cur:-80}]: " v
        v="${v:-${cur:-80}}"
        if ! echo "$v" | grep -qE '^[0-9]+$' || [ "$v" -lt 1 ] || [ "$v" -gt 65535 ]; then
          err "Некорректный порт."; echo; settings_menu; return
        fi
        _env_set WEB_PORT "$v"
        log "WEB_PORT сохранён: $v"
        _apply_env "$dir" "$dc" && echo
        settings_menu ;;
      0|"")
        main_menu ;;
      *)
        err "Неверный выбор."; echo; settings_menu ;;
    esac
  }

  settings_menu
}

# Применяет изменения .env — перезапускает web и worker без остановки БД
_apply_env() {
  local dir="$1" dc="$2"
  printf "  ${CYAN}⠋${NC}  Применяем настройки..."
  (cd "$dir" && $dc up -d web worker) >> "$LOG_FILE" 2>&1
  local rc=$?
  if [ $rc -eq 0 ]; then
    printf "\r  ${GREEN}✓${NC}  Настройки применены — сервисы перезапущены   \n"
  else
    printf "\r  ${YELLOW}!${NC}  Не удалось перезапустить — проверьте: $dc logs web\n"
  fi
  return $rc
}

# ── Обновление ────────────────────────────────────────────────────────────────
do_update() {
  # One updater: update.sh (handles COMPOSE_FILE / proxy mode); always the newest copy.
  local dir; dir="$(_find_project_dir)"
  local tmp; tmp="$(mktemp)"
  if curl -fsSL --max-time 15 https://raw.githubusercontent.com/iMironRU/updatecon/main/update.sh -o "$tmp"; then
    UPDATECON_DIR="$dir" bash "$tmp"
  elif [ -f "$dir/update.sh" ]; then
    UPDATECON_DIR="$dir" bash "$dir/update.sh"
  else
    err "Не удалось получить update.sh"
  fi
  rm -f "$tmp"
}

# ── Удаление ──────────────────────────────────────────────────────────────────
do_uninstall() {
  local dir; dir="$(_find_project_dir)"
  local dc; dc="$(_detect_dc)"

  echo
  echo -e "${RED}${BOLD}  ✗  Удаление Апдейкон${NC}"
  echo -e "${RED}  ──────────────────────────────────────────${NC}"
  echo
  warn "Это действие остановит и удалит все контейнеры Апдейкон."
  echo

  local DEL_DATA DEL_IMAGES DEL_DIR DIR_TO_DELETE=""
  read -rp "  Удалить данные PostgreSQL (все конфигурации)? [y/N]: " DEL_DATA; DEL_DATA="${DEL_DATA:-n}"
  read -rp "  Удалить Docker-образы? [y/N]: " DEL_IMAGES; DEL_IMAGES="${DEL_IMAGES:-n}"
  if [ -n "$dir" ]; then
    read -rp "  Удалить директорию $dir ? [y/N]: " DEL_DIR; DEL_DIR="${DEL_DIR:-n}"
    [[ "$DEL_DIR" =~ ^[Yy] ]] && DIR_TO_DELETE="$dir"
  fi

  echo
  echo -e "${CYAN}  ┌─ Будет выполнено ─────────────────────${NC}"
  echo -e "  │  • Остановить и удалить контейнеры"
  [[ "$DEL_DATA"   =~ ^[Yy] ]] && echo -e "  │  • ${RED}Удалить данные PostgreSQL (необратимо!)${NC}"
  [[ "$DEL_IMAGES" =~ ^[Yy] ]] && echo -e "  │  • Удалить Docker-образы"
  [ -n "$DIR_TO_DELETE" ]       && echo -e "  │  • Удалить директорию проекта"
  echo -e "${CYAN}  └───────────────────────────────────────${NC}"
  echo
  local CONFIRM
  read -rp "  Подтвердить удаление? [y/N]: " CONFIRM
  [[ "${CONFIRM:-n}" =~ ^[Yy] ]] || { echo "  Отмена."; main_menu; return; }
  echo

  step "Удаление началось"
  if [ -n "$dir" ] && [ -f "${dir}/docker-compose.yml" ]; then
    cd "$dir"
    # The nightly auto-update (deploy.sh) goes with the install.
    [ -f /etc/cron.d/updatecon ] && rm -f /etc/cron.d/updatecon && echo "  ✓  Автообновление отключено"
    if [[ "$DEL_DATA" =~ ^[Yy] ]]; then
      printf "  Останавливаем и удаляем volumes..."
      $dc down -v >> "$LOG_FILE" 2>&1 \
        && printf "\r  ${GREEN}✓${NC}  Контейнеры и данные удалены   \n" \
        || { printf "\r  ${YELLOW}!${NC}  Ошибка\n"; $dc down >> "$LOG_FILE" 2>&1 || true; }
    else
      printf "  Останавливаем контейнеры..."
      $dc down >> "$LOG_FILE" 2>&1 \
        && printf "\r  ${GREEN}✓${NC}  Контейнеры остановлены   \n" \
        || printf "\r  ${YELLOW}!${NC}  Возможно уже остановлены\n"
    fi
    if [[ "$DEL_IMAGES" =~ ^[Yy] ]]; then
      printf "  Удаляем Docker-образы..."
      docker rmi ghcr.io/imironru/updatecon:latest >> "$LOG_FILE" 2>&1 \
        && printf "\r  ${GREEN}✓${NC}  Образы удалены   \n" \
        || printf "\r  ${YELLOW}!${NC}  Образы не найдены\n"
    fi
  fi

  if [ -n "$DIR_TO_DELETE" ]; then
    printf "  Удаляем директорию..."
    cd /tmp
    rm -rf "$DIR_TO_DELETE" \
      && printf "\r  ${GREEN}✓${NC}  Директория удалена   \n" \
      || printf "\r  ${RED}✗${NC}  Не удалось удалить директорию\n"
  fi

  echo
  echo -e "${GREEN}${BOLD}  ✓  Апдейкон удалён.${NC}"
  echo
  rm -f "$LOG_FILE"
}

# ── Точка входа ───────────────────────────────────────────────────────────────
main_menu
