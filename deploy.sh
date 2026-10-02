#!/usr/bin/env bash
# deploy.sh — установка Апдейкон на Ubuntu / Debian.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/deploy.sh)
#
# Два варианта:
#   1) отдельный сервер — свой Caddy на 80/443 сам получает HTTPS (docker-compose.yml);
#   2) за уже работающим прокси (Nginx Proxy Manager, nginx, Traefik) — без Caddy,
#      веб в Docker-сети прокси и на 127.0.0.1 (docker-compose.proxy.yml, COMPOSE_FILE в .env).
# По желанию — ночное автообновление приложения (/etc/cron.d/updatecon → update.sh).
# Без учётки ИТС база берётся из готового снимка на GitHub (воркер, src/db/snapshot.ts).
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
  # Как сайт будет открываться снаружи
  DEFAULT_MODE=1
  { port_free 80 && port_free 443; } || DEFAULT_MODE=2
  echo -e "  ${BOLD}Как сайт будет открываться снаружи?${NC}"
  echo    "    1) Апдейкон сам получит HTTPS — свой Caddy на портах 80/443 (отдельный сервер)"
  echo    "    2) За уже работающим прокси — Nginx Proxy Manager, nginx, Traefik (80/443 заняты им)"
  [ "$DEFAULT_MODE" = 2 ] && warn "  Порты 80/443 уже заняты — подходит вариант 2."
  while true; do
    read -rp "  Вариант [$DEFAULT_MODE]: " MODE_INPUT
    MODE_INPUT="${MODE_INPUT:-$DEFAULT_MODE}"
    case "$MODE_INPUT" in
      1) if port_free 80 && port_free 443; then PROXY_MODE=caddy; break; fi
         warn "  Порты 80/443 заняты — Caddy их не получит. Выберите 2 или освободите порты." ;;
      2) PROXY_MODE=proxy; break ;;
      *) warn "  Введите 1 или 2." ;;
    esac
  done

  if [ "$PROXY_MODE" = caddy ]; then
    WEB_PORT_INPUT=80          # Caddy: 80/443, домен и сертификат — в админке
  else
    # Прокси в Docker (NPM, Traefik): веб подключится к его сети как updatecon:3000.
    PROXY_NET_DEFAULT="updatecon-proxy"
    if command -v docker >/dev/null 2>&1; then
      PC="$(docker ps --filter publish=443 --format '{{.Names}}' 2>/dev/null | head -1 || true)"
      if [ -n "$PC" ]; then
        PN="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$PC" 2>/dev/null \
              | tr ' ' '\n' | grep -vE '^(bridge|host|none)?$' | head -1 || true)"
        [ -n "$PN" ] && { PROXY_NET_DEFAULT="$PN"; echo "  Найден прокси в Docker: ${BOLD}$PC${NC}, сеть ${BOLD}$PN${NC}"; }
      fi
    fi
    while true; do
      read -rp "  Docker-сеть прокси [$PROXY_NET_DEFAULT]: " PROXY_NET
      PROXY_NET="${PROXY_NET:-$PROXY_NET_DEFAULT}"
      [[ "$PROXY_NET" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] && break
      warn "  Имя сети: латиница, цифры, _ . -"
    done
    # Прокси на самом хосте (nginx, apache): http://127.0.0.1:<порт>
    while true; do
      read -rp "  Локальный порт для прокси на этом сервере (127.0.0.1) [3000]: " WEB_PORT_INPUT
      WEB_PORT_INPUT="${WEB_PORT_INPUT:-3000}"
      if ! [[ "$WEB_PORT_INPUT" =~ ^[0-9]+$ ]] || [ "$WEB_PORT_INPUT" -lt 1 ] || [ "$WEB_PORT_INPUT" -gt 65535 ]; then
        warn "  Некорректный порт, введите число от 1 до 65535."; continue
      fi
      port_free "$WEB_PORT_INPUT" || { warn "  Порт $WEB_PORT_INPUT занят. Выберите другой."; continue; }
      break
    done
  fi

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
  echo -e "  ${YELLOW}Учётка ИТС${NC} нужна, чтобы сервер сам собирал данные с сайтов 1С (необязательно)."
  echo   "  Без неё база берётся из готового снимка на GitHub и обновляется каждую ночь."
  echo   "  Учётку можно задать позже в админке: Настройки → Доступ к ИТС."
  read -rp "  Логин ИТС (Enter — пропустить): " ITS_LOGIN_INPUT
  ITS_PW_INPUT=""
  if [ -n "$ITS_LOGIN_INPUT" ]; then
    read -rsp "  Пароль ИТС: " ITS_PW_INPUT; echo
  fi

  # Ночное автообновление приложения
  echo
  read -rp "  Обновлять Апдейкон автоматически каждую ночь (в 3:30)? [Y/n]: " AUTO_UP
  AUTO_UP="${AUTO_UP:-Y}"

  # Восстановить дамп?
  RESTORE_SEED="n"
  if [ -f "$SEED_FILE" ]; then
    echo
    read -rp "  Сразу загрузить начальный дамп данных (дальше — свежий снимок с GitHub)? [Y/n]: " RESTORE_SEED
    RESTORE_SEED="${RESTORE_SEED:-Y}"
  fi

  # Сводка
  echo
  echo -e "${CYAN}  ┌─ Параметры установки ─────────────────${NC}"
  if [ "$PROXY_MODE" = caddy ]; then
    echo -e "  │  Режим:         ${BOLD}свой Caddy (80/443)${NC}"
  else
    echo -e "  │  Режим:         ${BOLD}за прокси, сеть $PROXY_NET${NC}"
    echo -e "  │  Локальный порт:${BOLD} 127.0.0.1:$WEB_PORT_INPUT${NC}"
  fi
  echo -e "  │  Автообновление:${BOLD} $( [[ "$AUTO_UP" =~ ^[Yy] ]] && echo "да, каждую ночь" || echo "нет" )${NC}"
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
  PROXY_NET="$(grep -E '^PROXY_NETWORK=' .env | cut -d= -f2 || true)"
  grep -qE '^COMPOSE_FILE=docker-compose.proxy.yml' .env && PROXY_MODE=proxy || PROXY_MODE=caddy
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
  if [ "$PROXY_MODE" = proxy ]; then
    sed -i "s|^CADDY_API=.*|CADDY_API=off|" .env
    { echo; echo "# ── Режим «за внешним прокси» (deploy.sh) ──"
      echo "COMPOSE_FILE=docker-compose.proxy.yml"
      echo "PROXY_NETWORK=${PROXY_NET}"; } >> .env
  fi
  [[ "${AUTO_UP:-n}" =~ ^[Yy] ]] && echo "AUTO_UPDATE=1" >> .env
  log ".env создан"
fi

# Прокси в Docker видит веб через общую сеть; если её ещё нет — создаём
# (прокси на хосте её не использует, ему хватает 127.0.0.1:WEB_PORT).
if [ "${PROXY_MODE:-caddy}" = proxy ] && [ -n "${PROXY_NET:-}" ]; then
  docker network inspect "$PROXY_NET" >/dev/null 2>&1 \
    || { docker network create "$PROXY_NET" >> "$LOG_FILE" 2>&1 && log "Создана Docker-сеть $PROXY_NET — подключите к ней прокси"; }
fi

# Ночное автообновление: свежий update.sh из репозитория, затем образ и compose.
if $IS_FRESH && [[ "${AUTO_UP:-n}" =~ ^[Yy] ]]; then
  if [ -w /etc/cron.d ]; then
    cat > /etc/cron.d/updatecon <<CRON
# Апдейкон: ночное обновление приложения (deploy.sh). Удалите файл, чтобы отключить.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * root curl -fsSL https://raw.githubusercontent.com/iMironRU/updatecon/main/update.sh -o /tmp/updatecon-update.sh && UPDATECON_DIR="$(pwd)" bash /tmp/updatecon-update.sh >> /var/log/updatecon-update.log 2>&1
CRON
    chmod 644 /etc/cron.d/updatecon
    log "Автообновление включено: каждую ночь в 3:30 (/etc/cron.d/updatecon)"
  else
    warn "Нет прав на /etc/cron.d — автообновление не включено (запустите установку от root)"
  fi
fi

mkdir -p data

# ── 6. Получаем образы ───────────────────────────────────────────────────────
# Пробуем скачать готовый образ из ghcr.io; если недоступен — собираем локально.
if $DC pull >> "$LOG_FILE" 2>&1; then
  log "Образы скачаны из ghcr.io"
else
  run_spin "Сборка Docker-образов (нет готового образа, собираем)" $DC build
fi

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

  # Страховка: дамп данных может не нести позиции счётчиков id — без этого
  # первая же вставка нового приложения/ребра упадёт на первичном ключе.
  $DC exec -T db psql -U upd -d upd -q >> "$LOG_FILE" 2>&1 <<'SQL' || true
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['configurations','update_edges','version_meta','patches','import_runs'] LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), greatest((SELECT max(id) FROM %I), 1))', t, t);
  END LOOP;
END $$;
SQL

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
if [ "${PROXY_MODE:-caddy}" = proxy ]; then
  echo -e "  ${BOLD}Добавьте в прокси хост${NC} (свой домен → Апдейкон):"
  echo -e "    прокси в Docker-сети ${BOLD}${PROXY_NET}${NC}:  ${GREEN}http://updatecon:3000${NC}"
  echo -e "    прокси на этом сервере:           ${GREEN}http://127.0.0.1:${PORT}${NC}"
  echo -e "  HTTPS-сертификат выпускает прокси. Затем: ${GREEN}https://<домен>/admin${NC}"
else
  echo -e "  ${BOLD}Сайт:${NC}     ${GREEN}http://${HOST_IP}${PORT_SUFFIX}/${NC}"
  echo -e "  ${BOLD}Админка:${NC}  ${GREEN}http://${HOST_IP}${PORT_SUFFIX}/admin${NC}  (домен и HTTPS — в Настройках)"
fi
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
