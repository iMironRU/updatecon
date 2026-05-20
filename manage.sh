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
      ver_info="$($dc -f "${dir}/docker-compose.yml" exec -T web \
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
  echo
  echo -e "${CYAN}${BOLD}  ▶  Установка Апдейкон${NC}"
  echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
  echo

  # OS-проверка
  OS_ID="$(. /etc/os-release 2>/dev/null && echo "$ID" || echo unknown)"
  OS_VER="$(. /etc/os-release 2>/dev/null && echo "$VERSION_ID" || echo 0)"
  case "$OS_ID" in
    ubuntu) [ "${OS_VER%%.*}" -ge 20 ] 2>/dev/null || { err "Требуется Ubuntu 20.04+"; exit 1; } ;;
    debian) [ "${OS_VER%%.*}" -ge 11 ] 2>/dev/null || { err "Требуется Debian 11+"; exit 1; } ;;
    *) warn "Непроверенная ОС: $OS_ID $OS_VER" ;;
  esac

  # Клонирование репозитория
  local REPO_URL="https://github.com/iMironRU/updatecon.git"
  local REPO_DIR="updatecon"
  if [ ! -f "$(pwd)/docker-compose.yml" ]; then
    if [ -d "$REPO_DIR/.git" ]; then
      run_spin "Обновляем репозиторий" bash -c "cd '$REPO_DIR' && git pull --ff-only"
      cd "$REPO_DIR"
    else
      [ -d "$REPO_DIR" ] && rm -rf "$REPO_DIR"
      if ! command -v git >/dev/null 2>&1; then
        run_spin "Устанавливаем git" bash -c "apt-get update -qq && apt-get install -y -qq git"
      fi
      run_spin "Клонируем репозиторий" git clone "$REPO_URL" "$REPO_DIR"
      cd "$REPO_DIR"
    fi
  fi

  local SEED_FILE="data/seed.sql.gz"
  local IS_FRESH=false
  [ ! -f .env ] && IS_FRESH=true

  # Сбор параметров
  local WEB_PORT_INPUT ADMIN_LOGIN ADMIN_PW ITS_LOGIN_INPUT="" ITS_PW_INPUT="" RESTORE_SEED="n"
  if $IS_FRESH; then
    while true; do
      read -rp "  Внешний порт сайта [80]: " WEB_PORT_INPUT
      WEB_PORT_INPUT="${WEB_PORT_INPUT:-80}"
      [[ "$WEB_PORT_INPUT" =~ ^[0-9]+$ ]] && [ "$WEB_PORT_INPUT" -ge 1 ] && [ "$WEB_PORT_INPUT" -le 65535 ] || { warn "Некорректный порт."; continue; }
      port_free "$WEB_PORT_INPUT" || { warn "Порт $WEB_PORT_INPUT занят."; continue; }
      break
    done
    read -rp "  Логин администратора [admin]: " ADMIN_LOGIN; ADMIN_LOGIN="${ADMIN_LOGIN:-admin}"
    while true; do
      read -rsp "  Пароль администратора (мин. 6 символов): " ADMIN_PW; echo
      [ ${#ADMIN_PW} -ge 6 ] && break; warn "Слишком короткий."
    done
    echo
    echo -e "  ${YELLOW}ИТС-кредиты${NC} нужны для авто-синхронизации (необязательно)."
    read -rp "  Логин ИТС (Enter — пропустить): " ITS_LOGIN_INPUT
    [ -n "$ITS_LOGIN_INPUT" ] && { read -rsp "  Пароль ИТС: " ITS_PW_INPUT; echo; }
    [ -f "$SEED_FILE" ] && {
      echo; read -rp "  Восстановить дамп данных (603 конфигурации)? [Y/n]: " RESTORE_SEED
      RESTORE_SEED="${RESTORE_SEED:-Y}"
    }
    echo
    echo -e "${CYAN}  ┌─ Параметры установки ─────────────────${NC}"
    echo -e "  │  Внешний порт:  ${BOLD}$WEB_PORT_INPUT${NC}"
    echo -e "  │  Логин admin:   ${BOLD}$ADMIN_LOGIN${NC}"
    echo -e "  │  Логин ИТС:     ${BOLD}${ITS_LOGIN_INPUT:-не задан}${NC}"
    echo -e "  │  Восст. дамп:   ${BOLD}$( [[ "$RESTORE_SEED" =~ ^[Yy] ]] && echo "да" || echo "нет" )${NC}"
    echo -e "${CYAN}  └───────────────────────────────────────${NC}"
    echo
    local CONFIRM
    read -rp "  Начать установку? [Enter / n]: " CONFIRM
    [[ "${CONFIRM:-y}" =~ ^[Nn] ]] && { echo "  Отмена."; main_menu; return; }
  else
    warn ".env уже существует — конфигурация не изменяется."
    WEB_PORT_INPUT="$(grep -E '^WEB_PORT=' .env | cut -d= -f2 || echo 3000)"
    echo
  fi

  echo; step "Установка началась. Лог: $LOG_FILE"; echo

  # Docker
  ! command -v docker >/dev/null 2>&1 && \
    run_spin "Устанавливаем Docker" bash -c \
      "curl -fsSL https://get.docker.com | sh && usermod -aG docker '${SUDO_USER:-$USER}' 2>/dev/null || true"
  local DC; DC="$(_detect_dc)"; log "Docker готов"

  # .env
  if $IS_FRESH; then
    cp .env.example .env
    local DB_PW; DB_PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${DB_PW}/"   .env
    sed -i "s|postgres://upd:changeme@|postgres://upd:${DB_PW}@|"  .env
    sed -i "s/^WEB_PORT=.*/WEB_PORT=${WEB_PORT_INPUT}/"            .env
    sed -i "s/^ADMIN_LOGIN=.*/ADMIN_LOGIN=${ADMIN_LOGIN}/"         .env
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${ADMIN_PW}/"      .env
    [ -n "$ITS_LOGIN_INPUT" ] && {
      sed -i "s/^ITS_LOGIN=.*/ITS_LOGIN=${ITS_LOGIN_INPUT}/"   .env
      sed -i "s/^ITS_PASSWORD=.*/ITS_PASSWORD=${ITS_PW_INPUT}/" .env
    }
    log ".env создан"
  fi
  mkdir -p data

  # Образы
  $DC pull >> "$LOG_FILE" 2>&1 && log "Образы скачаны из ghcr.io" || \
    run_spin "Сборка Docker-образов" $DC build

  # PostgreSQL
  run_spin "Запуск PostgreSQL" $DC up -d db
  printf "  ${CYAN}⠋${NC}  Ждём готовности БД..."
  for i in $(seq 1 30); do $DC exec -T db pg_isready -U upd >> "$LOG_FILE" 2>&1 && break || sleep 2; done
  printf "\r  ${GREEN}✓${NC}  PostgreSQL готов   \n"
  local DB_PW_SYNC; DB_PW_SYNC="$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2)"
  $DC exec -T db psql -U upd -d upd -c "ALTER USER upd PASSWORD '${DB_PW_SYNC}'" >> "$LOG_FILE" 2>&1 || true

  # Дамп
  if $IS_FRESH && [[ "${RESTORE_SEED:-n}" =~ ^[Yy] ]] && [ -f "$SEED_FILE" ]; then
    $DC up -d worker >> "$LOG_FILE" 2>&1
    printf "  ${CYAN}⠋${NC}  Применяем миграции БД..."
    local MIGRATED=0
    for i in $(seq 1 30); do
      local READY; READY="$($DC exec -T db psql -U upd -d upd -tAc \
        "SELECT count(*) FROM information_schema.tables \
         WHERE table_schema='public' AND table_name='configurations'" 2>/dev/null | tr -d '[:space:]' || echo 0)"
      [ "$READY" = "1" ] && { MIGRATED=1; break; }; sleep 2
    done
    $DC stop worker >> "$LOG_FILE" 2>&1
    [ "$MIGRATED" != "1" ] && { err "Миграции не прошли — см. $LOG_FILE"; exit 1; }
    printf "\r  ${GREEN}✓${NC}  Миграции применены   \n"
    run_spin "Восстанавливаем дамп данных" bash -c "zcat '$SEED_FILE' | $DC exec -T db psql -U upd -d upd -q"
    sed -i "s/^IMPORT_ON_START=.*/IMPORT_ON_START=0/" .env
  fi

  # Запуск
  run_spin "Запуск всех сервисов" $DC up -d
  local PORT; PORT="$(grep -E '^WEB_PORT=' .env | cut -d= -f2 || echo 3000)"
  printf "  ${CYAN}⠋${NC}  Ждём веб-сервер..."
  local OK=0
  for i in $(seq 1 40); do
    curl -fsS "http://localhost:${PORT}/api/health" >> "$LOG_FILE" 2>&1 && { OK=1; break; }; sleep 3
  done
  [ "$OK" = "1" ] && printf "\r  ${GREEN}✓${NC}  Веб-сервер отвечает   \n" \
                  || printf "\r  ${YELLOW}!${NC}  Не ответил — проверьте: $DC logs web\n"

  local HOST_IP; HOST_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' || echo '<IP>')"
  local PORT_SUFFIX; PORT_SUFFIX="$( [ "$PORT" = "80" ] && echo "" || echo ":$PORT" )"
  local ADMIN_SHOW; ADMIN_SHOW="$(grep -E '^ADMIN_LOGIN=' .env | cut -d= -f2 || echo admin)"

  echo
  echo -e "${GREEN}${BOLD}  ✓  Апдейкон успешно запущен!${NC}"
  echo -e "${GREEN}  ──────────────────────────────────────────${NC}"
  echo -e "  ${BOLD}Сайт:${NC}     ${GREEN}http://${HOST_IP}${PORT_SUFFIX}/${NC}"
  echo -e "  ${BOLD}Админка:${NC}  ${GREEN}http://${HOST_IP}${PORT_SUFFIX}/admin${NC}"
  echo -e "  ${BOLD}Логин:${NC}    ${YELLOW}${ADMIN_SHOW}${NC}"
  echo -e "${GREEN}  ──────────────────────────────────────────${NC}"
  echo
  rm -f "$LOG_FILE"
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
      echo "${key}=${val}" >> "$tmpf"
      mv "$tmpf" "$env_file"
    else
      echo "${key}=${val}" >> "$env_file"
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
  local dir; dir="$(_find_project_dir)"
  local dc; dc="$(_detect_dc)"

  echo
  echo -e "${CYAN}${BOLD}  ▶  Обновление Апдейкон${NC}"
  echo -e "${CYAN}  ──────────────────────────────────────────${NC}"
  echo

  cd "$dir"

  # Обновляем docker-compose.yml из репозитория чтобы гарантировать
  # наличие image: ghcr.io/... (старые инсталляции могли не иметь этой строки)
  local RAW="https://raw.githubusercontent.com/iMironRU/updatecon/main/docker-compose.yml"
  if curl -fsSL --max-time 10 "$RAW" -o docker-compose.yml.new 2>>"$LOG_FILE"; then
    mv docker-compose.yml.new docker-compose.yml
    log "docker-compose.yml обновлён"
  else
    warn "Не удалось обновить docker-compose.yml — продолжаем с текущим"
    rm -f docker-compose.yml.new
  fi

  run_spin "Скачиваем образ из ghcr.io" $dc pull
  run_spin "Перезапускаем сервисы" $dc up -d

  local PORT; PORT="$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)"
  printf "  ${CYAN}⠋${NC}  Ждём веб-сервер..."
  local OK=0
  for i in $(seq 1 20); do
    curl -fsS "http://localhost:${PORT}/api/health" >> "$LOG_FILE" 2>&1 && { OK=1; break; }; sleep 3
  done
  [ "$OK" = "1" ] && printf "\r  ${GREEN}✓${NC}  Веб-сервер отвечает   \n" \
                  || printf "\r  ${YELLOW}!${NC}  Не ответил — проверьте: $dc logs web\n"
  echo
  echo -e "${GREEN}${BOLD}  ✓  Апдейкон обновлён.${NC}"
  echo
  rm -f "$LOG_FILE"
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
