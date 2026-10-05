#!/usr/bin/env bash
# Апдейкон — установка платформы 1С:Предприятие (сборка на выбор) (64-bit) для Linux
# Сформировано на upd.imiron.ru 2026-10-05
#
# Что делает скрипт:
#   1. Входит на портал 1С (releases.1c.ru) под вашей учётной записью ИТС и скачивает
#      дистрибутив «Технологическая платформа 1С:Предприятия (64-bit) для Linux».
#      Логин и пароль ИТС уходят только на серверы 1С и нигде не сохраняются.
#   2. Ставит зависимости (apt или dnf) и запускает установщик без вопросов:
#      сервер 1С:Предприятия и модули веб-сервера, с --client ещё и клиент с конфигуратором.
#   3. Включает службу сервера в systemd, если другая служба сервера 1С ещё не работает.
#   Уже установленные версии платформы не удаляются.
#
# Запуск (от root):
#   sudo bash install-1c-platform.sh
#
# Параметры:
#   --version 8.5   какую платформу поставить: номер сборки (8.5.1.1529) или линейка (8.5, 8.3.27) —
#                   тогда последняя сборка этой линейки; без параметра — скрипт спросит: последняя 8.3, последняя 8.5 или свой номер
#   --client        установить также клиент 1С:Предприятия и конфигуратор
#   --no-server     не устанавливать сервер (только клиент, вместе с --client)
#   --no-service    не включать службу сервера в systemd
#   --no-deps       не ставить зависимости через пакетный менеджер
#   --workdir DIR   куда скачать и распаковать дистрибутив
#   --dry-run       только войти на портал и найти дистрибутив, ничего не скачивая
# Логин и пароль ИТС можно передать через переменные окружения ITS_LOGIN и ITS_PASSWORD.

set -uo pipefail

VERSION=''
SITE='https://upd.imiron.ru'
UA='1C+Enterprise/8.3'

CLIENT=0 SERVER=1 SERVICE=1 DEPS=1 DRY_RUN=0 WORKDIR=''
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift 2 ;;
    --client) CLIENT=1; shift ;;
    --no-server) SERVER=0; shift ;;
    --no-service) SERVICE=0; shift ;;
    --no-deps) DEPS=0; shift ;;
    --workdir) WORKDIR=${2:-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (список: --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
head_line() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }
cfg_esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

command -v curl >/dev/null || die "Нужен curl (Debian/Ubuntu: apt install curl)"

# ── Which build ──────────────────────────────────────────────────────────────
# A line (8.5, 8.3.27) or nothing: the newest build from the Апдейкон catalog.
is_build() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; }
newest() { printf '%s\n' "$BUILDS" | awk -v p="$1." 'index($0, p) == 1' | sort -V | tail -n1; }
if ! is_build "$VERSION"; then
  BUILDS=$(curl -fsS "$SITE/api/platform" | grep -oE '"v":"8\.[35]\.[0-9]+\.[0-9]+"' | cut -d'"' -f4) ||
    die "Не удалось получить список сборок с $SITE. Укажите номер сборки: --version 8.5.1.1529"
  if [ -z "$VERSION" ]; then
    L83=$(newest 8.3); L85=$(newest 8.5)
    echo
    say "Какую платформу поставить?"
    say "  1 — 8.3, последняя сборка $L83"
    say "  2 — 8.5, последняя сборка $L85"
    say "  или введите номер сборки (8.3.24.1819) или линейку (8.3.24)"
    read -r -p "Выбор [1]: " answer
    case "$answer" in ''|1) VERSION=$L83 ;; 2) VERSION=$L85 ;; *) VERSION=$answer ;; esac
  fi
  if ! is_build "$VERSION"; then
    line=$VERSION
    VERSION=$(newest "$line")
    [ -n "$VERSION" ] || die "В каталоге нет сборок линейки $line. Список: $SITE/platform"
  fi
fi
case "$VERSION" in 8.3.*|8.5.*) ;; *) die "Скрипт ставит платформы 8.3 и 8.5, а указана $VERSION" ;; esac
IFS=. read -r v1 v2 v3 _ <<< "$VERSION"
if [ "$v1.$v2" = 8.3 ] && [ "$v3" -lt 20 ]; then die "Для Linux — сборки 8.3.20 и новее: в старых нет единого установщика"; fi
NICK="Platform$v1$v2"
UNDER=$(printf '%s' "$VERSION" | tr . _)
INSTALL_DIR="/opt/1cv8/x86_64/$VERSION"

head_line "Апдейкон: платформа 1С:Предприятие $VERSION (64-bit) для Linux"
[ "$SERVER" = 1 ] || [ "$CLIENT" = 1 ] || die "Нечего устанавливать: --no-server без --client"
if [ "$DRY_RUN" = 0 ] && [ "$(uname -m)" != x86_64 ]; then die "Скрипт ставит 64-bit платформу для x86_64, а здесь $(uname -m)"; fi
if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then die "Нужны права root: sudo bash $0"; fi

COMPONENTS=''
[ "$SERVER" = 1 ] && COMPONENTS="server,ws"
[ "$CLIENT" = 1 ] && COMPONENTS="${COMPONENTS:+$COMPONENTS,}client_full"
COMPONENTS="$COMPONENTS,ru"

[ -n "$WORKDIR" ] || WORKDIR="$PWD/updatecon-platform-$UNDER"
mkdir -p "$WORKDIR" || die "Не удалось создать каталог $WORKDIR"
WORKDIR=$(cd "$WORKDIR" && pwd)
UNPACKED="$WORKDIR/setup"

# ── Dependencies ─────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = 0 ] && [ "$DEPS" = 1 ] && [ ! -x "$INSTALL_DIR/ragent" ]; then
  say "Ставлю зависимости..."
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq unzip libfontconfig1 libfreetype6 libgsf-1-114 libglib2.0-0 >/dev/null 2>&1 ||
      warn "  Часть зависимостей не установилась — установщик 1С скажет, чего не хватает."
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    pm=$(command -v dnf || command -v yum)
    "$pm" install -y -q unzip fontconfig freetype libgsf glib2 >/dev/null 2>&1 ||
      warn "  Часть зависимостей не установилась — установщик 1С скажет, чего не хватает."
  else
    warn "  Неизвестный пакетный менеджер — зависимости не ставлю."
  fi
  [ "$CLIENT" = 1 ] && warn "  Клиенту нужны ещё графические библиотеки (WebKitGTK и др.): если клиент не запустится, поставьте их по документации 1С."
fi

# ── Download ─────────────────────────────────────────────────────────────────
find_installer() { find "$UNPACKED" -maxdepth 3 -name 'setup-full-*.run' 2>/dev/null | head -n1; }
INSTALLER=''
if [ ! -x "$INSTALL_DIR/ragent" ] && [ ! -x "$INSTALL_DIR/1cv8" ]; then
  INSTALLER=$(find_installer)
  if [ -z "$INSTALLER" ]; then
    ARCHIVE=$(find "$WORKDIR" -maxdepth 1 -type f \( -name "server64_$UNDER.zip" -o -name "server64_$UNDER.tar.gz" \) | head -n1)
    if [ -z "$ARCHIVE" ]; then
      ITS_LOGIN=${ITS_LOGIN:-}
      ITS_PASSWORD=${ITS_PASSWORD:-}
      if [ -z "$ITS_LOGIN" ] || [ -z "$ITS_PASSWORD" ]; then
        say "Дистрибутив скачивается с портала 1С под учётной записью ИТС."
        read -r -p "Логин ИТС: " ITS_LOGIN
        read -r -s -p "Пароль ИТС: " ITS_PASSWORD; echo
      fi
      JAR=$(mktemp); chmod 600 "$JAR"; trap 'rm -f "$JAR"' EXIT
      LOGIN_URL='https://login.1c.ru/login?service=https%3A%2F%2Freleases.1c.ru%2Fpublic%2Fsecurity_check'
      say "Вхожу на портал 1С..."
      page=$(curl -sSL -A "$UA" -c "$JAR" -b "$JAR" "$LOGIN_URL") || die "Портал 1С недоступен"
      EXECUTION=$(printf '%s' "$page" | tr '\n' ' ' | sed -n 's/.*name="execution"[[:space:]]*value="\([^"]*\)".*/\1/p')
      [ -n "$EXECUTION" ] || die "Страница входа 1С изменилась, скрипт нужно обновить: $SITE/platform"
      # The account goes to curl through stdin, not the command line (ps would show it).
      { printf 'data-urlencode = "username=%s"\n' "$(cfg_esc "$ITS_LOGIN")"
        printf 'data-urlencode = "password=%s"\n' "$(cfg_esc "$ITS_PASSWORD")"; } |
        curl -sSL -A "$UA" -c "$JAR" -b "$JAR" -K - --data-urlencode "execution=$EXECUTION" \
          --data-urlencode "_eventId=submit" -o /dev/null "$LOGIN_URL" || die "Портал 1С не ответил на вход"
      list=$(curl -sSL -A "$UA" -c "$JAR" -b "$JAR" "https://releases.1c.ru/version_files?nick=$NICK&ver=$VERSION") ||
        die "Не удалось открыть страницу сборки $VERSION на портале 1С"
      case "$list" in *'name="execution"'*) die "Портал 1С не принял логин и пароль ИТС." ;; esac
      href=$(printf '%s' "$list" | grep -oE "href=\"/version_file\?[^\"]*server64_$UNDER\.(zip|tar\.gz)\"" | head -n1 |
        sed -e 's/^href="//' -e 's/"$//' -e 's/&amp;/\&/g')
      [ -n "$href" ] || die "У сборки $VERSION на портале нет дистрибутива «Технологическая платформа (64-bit) для Linux»."
      NAME=$(printf '%s' "$href" | sed -e 's/.*%5[cC]//' -e 's/.*[\\/]//')
      file_page=$(curl -sSL -A "$UA" -c "$JAR" -b "$JAR" "https://releases.1c.ru$href") || die "Не удалось открыть страницу файла $NAME"
      MIRRORS=$(printf '%s' "$file_page" | grep -oE 'https://dl[0-9]*\.1c\.ru/[^"]+' | sed 's/&amp;/\&/g' | awk '!seen[$0]++')
      [ -n "$MIRRORS" ] || die "Не найдена ссылка на скачивание $NAME, скрипт нужно обновить: $SITE/platform"
      ok "Дистрибутив: $NAME"
      if [ "$DRY_RUN" = 1 ]; then
        say "Проверка прошла: вход на портал работает, ссылка на скачивание найдена ($(printf '%s\n' "$MIRRORS" | wc -l | tr -d ' '))."
        exit 0
      fi
      DEST="$WORKDIR/$NAME"
      done_ok=0
      for m in $MIRRORS; do
        say "Скачиваю $NAME..."
        if curl -fS --progress-bar -L --retry 2 -A "$UA" -c "$JAR" -b "$JAR" -o "$DEST.part" "$m"; then
          mv -f "$DEST.part" "$DEST"; done_ok=1; break
        fi
        rm -f "$DEST.part"; warn "  Не получилось, пробую зеркало..."
      done
      [ "$done_ok" = 1 ] || die "Не удалось скачать $NAME ни с одного зеркала 1С."
      ARCHIVE=$DEST
    fi
    [ "$DRY_RUN" = 1 ] && { ok "Дистрибутив уже скачан: $ARCHIVE"; exit 0; }

    say "Распаковываю $(basename "$ARCHIVE")..."
    mkdir -p "$UNPACKED"
    case "$ARCHIVE" in
      *.zip)
        if command -v unzip >/dev/null; then unzip -o -q "$ARCHIVE" -d "$UNPACKED"
        elif command -v python3 >/dev/null; then python3 -m zipfile -e "$ARCHIVE" "$UNPACKED"
        else die "Нечем распаковать .zip: установите unzip"; fi ;;
      *.tar.gz) tar -xzf "$ARCHIVE" -C "$UNPACKED" ;;
    esac
    INSTALLER=$(find_installer)
    [ -n "$INSTALLER" ] || die "В дистрибутиве нет установщика setup-full-*.run (для сборок до 8.3.20 скрипт не подходит)."
  fi
  [ "$DRY_RUN" = 1 ] && { ok "Установщик уже распакован: $INSTALLER"; exit 0; }

  # ── Install ────────────────────────────────────────────────────────────────
  chmod +x "$INSTALLER"
  say "Устанавливаю платформу ($COMPONENTS), несколько минут..."
  "$INSTALLER" --mode unattended --enable-components "$COMPONENTS" ||
    die "Установщик 1С завершился с ошибкой. Запустите его вручную, чтобы увидеть подробности: $INSTALLER"
  [ -d "$INSTALL_DIR" ] || die "Установщик закончил работу, но каталога $INSTALL_DIR нет"
  ok "Платформа $VERSION установлена: $INSTALL_DIR"
else
  ok "Платформа $VERSION уже установлена: $INSTALL_DIR"
  [ "$DRY_RUN" = 1 ] && exit 0
fi

# ── Server service (systemd) ─────────────────────────────────────────────────
if [ "$SERVER" = 1 ] && [ "$SERVICE" = 1 ]; then
  if ! command -v systemctl >/dev/null; then
    warn "systemd не найден — службу сервера настройте вручную."
  else
    UNIT=$(find "$INSTALL_DIR" -maxdepth 1 -name 'srv1cv8*@.service' 2>/dev/null | head -n1)
    if [ -z "$UNIT" ]; then
      warn "В $INSTALL_DIR нет файла службы srv1cv8-*@.service — службу сервера настройте вручную."
    else
      NAME_UNIT=$(basename "$UNIT" .service)          # srv1cv8-8.3.27.2342@
      INSTANCE="${NAME_UNIT}default"
      ACTIVE=$(systemctl list-units --type=service --state=active --no-legend --plain 'srv1cv8*' 2>/dev/null | awk '{print $1}' | grep -v "^$INSTANCE.service$" | head -n1)
      if [ -n "$ACTIVE" ]; then
        warn "Уже работает служба сервера 1С: $ACTIVE. Новую не включаю, чтобы не было конфликта портов."
        warn "Переключить сервер на $VERSION:"
        say  "  systemctl disable --now $ACTIVE"
        say  "  systemctl link $UNIT"
        say  "  systemctl enable --now $INSTANCE"
      else
        systemctl link "$UNIT" >/dev/null 2>&1
        if systemctl enable --now "$INSTANCE" >/dev/null 2>&1; then
          ok "Служба $INSTANCE включена и запущена (порты 1540, 1541, 1560-1591)."
        else
          warn "Не удалось запустить службу $INSTANCE: systemctl status $INSTANCE"
        fi
      fi
    fi
  fi
fi

echo
ok "Готово. Дистрибутив: $WORKDIR"
