#!/usr/bin/env bash
# Апдейкон — установка платформы 1С:Предприятие @@VERSION_TITLE@@ (64-bit) для Linux
# Сформировано на @@SITE@@ @@DATE@@
#
# Что делает скрипт:
#   1. Показывает, какие версии платформы уже стоят (/opt/1cv8/x86_64) и какие есть на портале 1С.
#   2. Предлагает: обновить установленную линейку, поставить 8.5, поставить любую сборку,
#      удалить старые версии. Состав — сервер 1С с модулями веб-сервера, с клиентом или только клиент.
#   3. Скачивает дистрибутив с портала 1С (releases.1c.ru) под вашей учётной записью ИТС в /tmp,
#      ставит зависимости (apt или dnf) и запускает установщик без вопросов.
#      Логин и пароль ИТС уходят только на серверы 1С.
#   4. Сервер включается службой systemd (srv1cv8-<версия>@default); при обновлении службу
#      можно перевести на новую сборку.
#   5. После установки — по запросу: служба сервера администрирования ras (удалённая консоль),
#      удаление скачанного дистрибутива.
#
# Запуск (от root):
#   sudo bash @@FILE@@
#
# Параметры (все необязательные; что не задано — скрипт спросит):
#   --version 8.5   номер сборки (8.5.1.1529) или линейка (8.5, 8.3.27) — последняя сборка линейки@@VERSION_DEFAULT_NOTE@@
#   --mode server   server — сервер 1С и модули веб-сервера; full — ещё и клиент с конфигуратором;
#                   client — только клиент и конфигуратор
#   --client        то же, что --mode full;  --no-server вместе с --client — только клиент
#   --move-service / --keep-service   при обновлении перевести службу сервера на новую сборку / оставить
#   --ras / --no-ras   включить службу ras (удалённое администрирование) / не спрашивать
#   --remove-files / --keep-files   удалить или оставить дистрибутив после установки
#   --yes           не спрашивать подтверждение перед установкой
#   --no-service    не включать службу сервера;  --no-deps — не ставить зависимости
#   --workdir DIR   куда скачивать (по умолчанию /tmp)
#   --dry-run       только войти на портал и найти дистрибутив, ничего не скачивая
# Логин и пароль ИТС можно передать через переменные окружения ITS_LOGIN и ITS_PASSWORD.
# Для Linux — сборки 8.3.20 и новее (в старых нет единого установщика).

set -uo pipefail

VERSION=@@VERSION_Q@@
SITE=@@SITE_Q@@
UA='1C+Enterprise/8.3'
ROOT=/opt/1cv8/x86_64

MODE='' CLIENT_FLAG=0 NOSERVER_FLAG=0 SVC_MOVE='' RAS='' FILES='' YES=0 SERVICE=1 DEPS=1 WORKDIR='' DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift 2 ;;
    --mode) MODE=${2:-}; shift 2 ;;
    --client) CLIENT_FLAG=1; shift ;;
    --no-server) NOSERVER_FLAG=1; shift ;;
    --move-service) SVC_MOVE=move; shift ;;
    --keep-service) SVC_MOVE=keep; shift ;;
    --ras) RAS=yes; shift ;;
    --no-ras) RAS=no; shift ;;
    --remove-files) FILES=remove; shift ;;
    --keep-files) FILES=keep; shift ;;
    --yes) YES=1; shift ;;
    --no-service) SERVICE=0; shift ;;
    --no-deps) DEPS=0; shift ;;
    --workdir) WORKDIR=${2:-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (список: --help)" >&2; exit 2 ;;
  esac
done
if [ -z "$MODE" ]; then
  if [ "$CLIENT_FLAG" = 1 ] && [ "$NOSERVER_FLAG" = 1 ]; then MODE=client
  elif [ "$CLIENT_FLAG" = 1 ]; then MODE=full; fi
fi
INTERACTIVE=1
[ -n "$VERSION$MODE" ] || [ "$DRY_RUN" = 1 ] && INTERACTIVE=0
PARAM_VERSION=$VERSION PARAM_MODE=$MODE PARAM_DRY=$DRY_RUN

# ── Helpers ──────────────────────────────────────────────────────────────────
say() { printf '%s\n' "$*"; }
head_line() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
title() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }
# ask_yes "question" default(1|0)
ask_yes() {
  local hint a; if [ "${2:-1}" = 1 ]; then hint='да/нет [да]'; else hint='да/нет [нет]'; fi
  read -r -p "$1 ($hint) " a
  [ -z "$a" ] && return $(( ${2:-1} == 1 ? 0 : 1 ))
  case "$a" in д|да|Д|Да|y|Y|yes) return 0 ;; *) return 1 ;; esac
}
# menu "title" default_key key1 "text1" key2 "text2" … → echoes the chosen key
menu() {
  local t=$1 def=$2; shift 2
  local keys=() texts=() i n a
  while [ $# -gt 1 ]; do keys+=("$1"); texts+=("$2"); shift 2; done
  n=${#keys[@]}
  title "$t" >&2
  local defidx=1
  for i in $(seq 0 $((n - 1))); do
    local mark=' '; [ "${keys[$i]}" = "$def" ] && { mark='*'; defidx=$((i + 1)); }
    printf '  %s%d — %s\n' "$mark" $((i + 1)) "${texts[$i]}" >&2
  done
  while true; do
    read -r -p "Выбор [$defidx]: " a
    [ -z "$a" ] && { echo "$def"; return; }
    if [[ "$a" =~ ^[0-9]+$ ]] && [ "$a" -ge 1 ] && [ "$a" -le "$n" ]; then echo "${keys[$((a - 1))]}"; return; fi
    for i in $(seq 0 $((n - 1))); do [ "${keys[$i]}" = "$a" ] && { echo "$a"; return; }; done
    warn "  Введите число от 1 до $n" >&2
  done
}
is_build() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
cfg_esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
line_of() { printf '%s' "$1" | cut -d. -f1-3; }

# Installed builds, one per line: "version client server service state"
installed() {
  local d v c s svc st
  for d in "$ROOT"/*/; do
    [ -d "$d" ] || continue
    v=$(basename "$d"); is_build "$v" || continue
    c=0; [ -x "$d/1cv8" ] && c=1
    s=0; [ -x "$d/ragent" ] && s=1
    [ "$c" = 1 ] || [ "$s" = 1 ] || continue
    svc=''; st=''
    if command -v systemctl >/dev/null; then
      svc=$(systemctl list-units --all --type=service --no-legend --plain "srv1cv8-$v@*" 2>/dev/null | awk '{print $1}' | head -n1)
      [ -n "$svc" ] && st=$(systemctl is-active "$svc" 2>/dev/null)
    fi
    printf '%s %s %s %s %s\n' "$v" "$c" "$s" "${svc:--}" "${st:--}"
  done | sort -V
}
describe() { # $2=client $3=server $4=svc $5=state
  local p=()
  [ "$2" = 1 ] && p+=('клиент, конфигуратор'); [ "$3" = 1 ] && p+=('сервер')
  local s; s=$(IFS=,; echo "${p[*]}" | sed 's/,/, /g')
  if [ "$4" != - ]; then
    case "$5" in active) s="$s (служба работает)" ;; *) s="$s (служба $4: $5)" ;; esac
  fi
  echo "$s"
}
active_server_unit() {   # any running srv1cv8 instance, except the given version
  command -v systemctl >/dev/null || return 0
  systemctl list-units --type=service --state=active --no-legend --plain 'srv1cv8-*' 2>/dev/null | awk '{print $1}' | grep -v "ras" | grep -v -- "-${1:-NONE}@" | head -n1
}

command -v curl >/dev/null || die "Нужен curl (Debian/Ubuntu: apt install curl)"

# ── One pass: overview → action → install → after ────────────────────────────
# Returns 0 to show the menu again, 1 to finish.
run_once() {
  local VERSION=$PARAM_VERSION MODE=$PARAM_MODE DRY_RUN=$PARAM_DRY
  head_line "Апдейкон: установка платформы 1С:Предприятие (64-bit) для Linux"
  if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then die "Нужны права root: sudo bash $0"; fi

  # ── What is installed, what the portal has ─────────────────────────────────
  local HAVE; HAVE=$(installed)
  local BUILDS L83 L85 D83 D85
  BUILDS=$(curl -fsS "$SITE/api/platform") || die "Не удалось получить список сборок с $SITE"
  local VERS; VERS=$(printf '%s' "$BUILDS" | grep -oE '"v":"8\.[35]\.[0-9]+\.[0-9]+"' | cut -d'"' -f4)
  newest() { printf '%s\n' "$VERS" | awk -v p="$1." 'index($0, p) == 1' | sort -V | tail -n1; }
  bdate() { printf '%s' "$BUILDS" | grep -oE "\"v\":\"$1\"[^}]*\"date\":\"[0-9-]+\"" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -n1 | awk -F- '{print $3"."$2"."$1}'; }
  L83=$(newest 8.3); L85=$(newest 8.5); D83=$(bdate "$L83"); D85=$(bdate "$L85")
  echo
  if [ -z "$HAVE" ]; then say "На этом сервере платформа 1С не установлена."
  else
    title "Установлено на этом сервере:"
    while read -r v c s svc st; do printf '  %-14s %s\n' "$v" "$(describe "$v" "$c" "$s" "$svc" "$st")"; done <<< "$HAVE"
  fi
  title "Доступно на портале 1С:"
  printf '  8.3  →  %-14s вышла %s\n' "$L83" "$D83"
  printf '  8.5  →  %-14s вышла %s\n' "$L85" "$D85"

  # ── Action ─────────────────────────────────────────────────────────────────
  local action='' BASE='' BASE_C=0 BASE_S=0 BASE_SVC='-'
  local OLD83 HAS83 HAS85
  OLD83=$(printf '%s\n' "$HAVE" | awk -v n="$L83" '$1 ~ /^8\.3\./ && $1 != n' | sort -V | tail -n1)
  HAS83=$(printf '%s\n' "$HAVE" | awk -v n="$L83" '$1 == n'); HAS85=$(printf '%s\n' "$HAVE" | awk -v n="$L85" '$1 == n')
  if [ -n "$VERSION" ]; then action=install
  else
    local items=() def
    if [ -n "$OLD83" ]; then items+=(up83 "Обновить 8.3: $(echo "$OLD83" | cut -d' ' -f1) → $L83")
    elif [ -n "$HAS83" ]; then items+=(has83 "8.3 уже последняя ($L83)")
    else items+=(i83 "Установить 8.3 ($L83)"); fi
    if [ -n "$HAS85" ]; then items+=(has85 "8.5 уже последняя ($L85)"); else items+=(i85 "Установить 8.5 ($L85)"); fi
    items+=(other "Установить другую сборку (ввести номер или линейку)")
    [ "$(printf '%s\n' "$HAVE" | grep -c .)" -gt 1 ] && items+=(clean "Удалить старые версии платформы")
    items+=(dry "Только проверить вход на портал 1С" quit "Выход")
    if [ -n "$OLD83" ]; then def=up83; elif [ -z "$HAS83" ] && [ -z "$HAS85" ]; then def=i83; elif [ -z "$HAS85" ]; then def=i85; else def=quit; fi
    case "$(menu "Что сделать?" "$def" "${items[@]}")" in
      up83) VERSION=$L83; read -r BASE BASE_C BASE_S BASE_SVC _ <<< "$OLD83"; action=install ;;
      i83) VERSION=$L83; action=install ;;
      i85) VERSION=$L85; action=install ;;
      other) read -r -p "Номер сборки (8.3.24.1819) или линейка (8.3.24, 8.5): " VERSION; action=install ;;
      clean) action=clean ;;
      dry) DRY_RUN=1; VERSION=$L83; action=install ;;
      has83|has85) say "Уже установлена."; return 0 ;;
      *) return 1 ;;
    esac
  fi

  # ── Remove old versions ────────────────────────────────────────────────────
  if [ "$action" = clean ]; then
    local cands=''
    while read -r v c s svc st; do
      local nl; nl=$(printf '%s\n' "$HAVE" | awk -v l="$(line_of "$v")." 'index($1, l) == 1 {print $1}' | sort -V | tail -n1)
      [ "$v" != "$nl" ] && [ "$svc" = - ] && cands="$cands$v $c $s $svc $st"$'\n'
    done <<< "$HAVE"
    if [ -z "$cands" ]; then say "Удалять нечего: в каждой линейке стоит одна сборка (или на ней есть служба сервера)."; return 0; fi
    title "Можно удалить (в каждой линейке остаётся новейшая сборка; версии со службой не трогаю):"
    while read -r v c s svc st; do [ -n "$v" ] && printf '  %-14s %s\n' "$v" "$(describe "$v" "$c" "$s" "$svc" "$st")"; done <<< "$cands"
    ask_yes "Удалить эти версии?" 0 || return 0
    while read -r v _; do
      [ -n "$v" ] || continue
      local un="$ROOT/$v/uninstaller-full"
      if [ -x "$un" ]; then say "  Удаляю $v..."; "$un" --mode unattended >/dev/null 2>&1 && ok "  $v удалена" || warn "  Деинсталлятор $v вернул ошибку"
      else warn "  $v: нет $un — удалите пакеты вручную"; fi
      [ -d "$ROOT/$v" ] && [ -z "$(ls -A "$ROOT/$v" 2>/dev/null)" ] && rmdir "$ROOT/$v"
    done <<< "$cands"
    return 0
  fi

  # ── Resolve the build ──────────────────────────────────────────────────────
  if ! is_build "$VERSION"; then
    local line=$VERSION; VERSION=$(newest "$line")
    [ -n "$VERSION" ] || die "В каталоге нет сборок линейки $line. Список: $SITE/platform"
  fi
  case "$VERSION" in 8.3.*|8.5.*) ;; *) die "Скрипт ставит платформы 8.3 и 8.5, а указана $VERSION" ;; esac
  local v1 v2 v3; IFS=. read -r v1 v2 v3 _ <<< "$VERSION"
  if [ "$v1.$v2" = 8.3 ] && [ "$v3" -lt 20 ]; then die "Для Linux — сборки 8.3.20 и новее: в старых нет единого установщика"; fi
  local NICK="Platform$v1$v2" UNDER INSTALL_DIR EXISTING
  UNDER=$(printf '%s' "$VERSION" | tr . _); INSTALL_DIR="$ROOT/$VERSION"
  EXISTING=$(printf '%s\n' "$HAVE" | awk -v n="$VERSION" '$1 == n')
  if [ -z "$BASE" ]; then
    local b; b=$(printf '%s\n' "$HAVE" | awk -v l="$v1.$v2." -v n="$VERSION" 'index($1, l) == 1 && $1 != n' | sort -V | tail -n1)
    [ -n "$b" ] && read -r BASE BASE_C BASE_S BASE_SVC _ <<< "$b"
  fi

  # ── Components ─────────────────────────────────────────────────────────────
  [ -z "$MODE" ] && [ "$DRY_RUN" = 1 ] && MODE=server
  if [ -z "$MODE" ]; then
    local same='' sfx=''
    if [ -n "$BASE" ]; then
      if [ "$BASE_S" = 1 ] && [ "$BASE_C" = 1 ]; then same=full; elif [ "$BASE_S" = 1 ]; then same=server; else same=client; fi
      sfx=" — как у $BASE"
    fi
    local t1="Сервер 1С и модули веб-сервера" t2="Сервер 1С, клиент и конфигуратор" t3="Только клиент и конфигуратор"
    case "$same" in server) t1="$t1$sfx" ;; full) t2="$t2$sfx" ;; client) t3="$t3$sfx" ;; esac
    MODE=$(menu "Что установить?" "${same:-server}" server "$t1" full "$t2" client "$t3")
  fi
  local SERVER=1 CLIENT=0
  case "$MODE" in server) ;; full) CLIENT=1 ;; client) SERVER=0 CLIENT=1 ;; *) die "--mode: server, full или client" ;; esac
  if [ -n "$EXISTING" ]; then
    local ec es; read -r _ ec es _ <<< "$EXISTING"
    [ "$SERVER" = 1 ] && [ "$es" = 0 ] && die "Платформа $VERSION уже установлена без сервера: запустите установщик вручную ($ROOT/$VERSION) или удалите её."
    [ "$CLIENT" = 1 ] && [ "$ec" = 0 ] && die "Платформа $VERSION уже установлена без клиента: запустите установщик вручную или удалите её."
  fi
  local COMPONENTS=''
  [ "$SERVER" = 1 ] && COMPONENTS="server,ws"
  [ "$CLIENT" = 1 ] && COMPONENTS="${COMPONENTS:+$COMPONENTS,}client_full"
  COMPONENTS="$COMPONENTS,ru"

  # Service: a running agent on the base build can be moved to the new one.
  local move=0 svc_to_move=''
  if [ "$SERVER" = 1 ] && [ "$SERVICE" = 1 ] && [ -n "$BASE" ] && [ "$BASE_SVC" != - ]; then
    svc_to_move=$BASE_SVC
    if [ "$SVC_MOVE" = move ]; then move=1
    elif [ "$SVC_MOVE" != keep ] && [ "$DRY_RUN" = 0 ]; then
      echo; say "На $BASE работает служба сервера $svc_to_move."
      warn "Перевод службы на новую сборку останавливает её: все сеансы на этом сервере отвалятся."
      ask_yes "Перевести службу на $VERSION после установки?" 0 && move=1
    fi
  fi

  # ── Summary ────────────────────────────────────────────────────────────────
  if [ -z "$WORKDIR" ]; then WORKDIR="${TMPDIR:-/tmp}"; WORKDIR="${WORKDIR%/}/updatecon-platform-$UNDER"; fi
  local need=3500 free; free=$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}')
  local other; other=$(active_server_unit "$VERSION")
  head_line "Сводка"
  printf '  Сборка:        %s  (вышла %s, изменения: %s/platform?build=%s)\n' "$VERSION" "$(bdate "$VERSION")" "$SITE" "$VERSION"
  case "$MODE" in server) say "  Состав:        сервер 1С и модули веб-сервера" ;; full) say "  Состав:        сервер 1С, клиент и конфигуратор" ;; client) say "  Состав:        клиент и конфигуратор" ;; esac
  say "  Куда:          $INSTALL_DIR"
  if [ -n "$EXISTING" ]; then say "  Уже установлена — скачивать и ставить не нужно"; else say "  Скачать:       ~1 ГБ в $WORKDIR"; fi
  if [ "$SERVER" = 1 ] && [ "$SERVICE" = 1 ]; then
    if [ "$move" = 1 ]; then say "  Служба:        $svc_to_move будет переведена на $VERSION"
    elif [ -n "$svc_to_move" ]; then say "  Служба:        $svc_to_move остаётся на $BASE"
    elif [ -n "$other" ]; then say "  Служба:        уже работает $other, новую не включаю"
    else say "  Служба:        будет включена srv1cv8-$VERSION@default, порты 1540, 1541, 1560-1591"; fi
  fi
  [ -n "$free" ] && printf '  Место в /opt:  свободно %s МБ, нужно около %s МБ\n' "$free" "$need"
  if [ -z "$EXISTING" ] && [ -n "$free" ] && [ "$free" -lt "$need" ]; then die "Мало места в /opt: освободите хотя бы $need МБ."; fi
  if [ "$YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then ask_yes "Продолжить?" || return 0; fi

  # ── Dependencies ───────────────────────────────────────────────────────────
  mkdir -p "$WORKDIR" || die "Не удалось создать каталог $WORKDIR"
  WORKDIR=$(cd "$WORKDIR" && pwd)
  local UNPACKED="$WORKDIR/setup"
  if [ "$DRY_RUN" = 0 ] && [ "$DEPS" = 1 ] && [ -z "$EXISTING" ]; then
    say "Ставлю зависимости..."
    if command -v apt-get >/dev/null; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >/dev/null 2>&1
      apt-get install -y -qq unzip libfontconfig1 libfreetype6 libgsf-1-114 libglib2.0-0 >/dev/null 2>&1 ||
        warn "  Часть зависимостей не установилась — установщик 1С скажет, чего не хватает."
    elif command -v dnf >/dev/null || command -v yum >/dev/null; then
      local pm; pm=$(command -v dnf || command -v yum)
      "$pm" install -y -q unzip fontconfig freetype libgsf glib2 >/dev/null 2>&1 ||
        warn "  Часть зависимостей не установилась — установщик 1С скажет, чего не хватает."
    else warn "  Неизвестный пакетный менеджер — зависимости не ставлю."; fi
    [ "$CLIENT" = 1 ] && warn "  Клиенту нужны ещё графические библиотеки (WebKitGTK и др.): если клиент не запустится, поставьте их по документации 1С."
  fi

  # ── Download + unpack + install ────────────────────────────────────────────
  find_installer() { find "$UNPACKED" -maxdepth 3 -name 'setup-full-*.run' 2>/dev/null | head -n1; }
  if [ -z "$EXISTING" ]; then
    local INSTALLER; INSTALLER=$(find_installer)
    if [ -z "$INSTALLER" ]; then
      local ARCHIVE; ARCHIVE=$(find "$WORKDIR" -maxdepth 1 -type f \( -name "server64_$UNDER.zip" -o -name "server64_$UNDER.tar.gz" \) | head -n1)
      if [ -z "$ARCHIVE" ]; then
        local LOGIN=${ITS_LOGIN:-} PASS=${ITS_PASSWORD:-}
        if [ -z "$LOGIN" ] || [ -z "$PASS" ]; then
          echo; say "Дистрибутив скачивается с портала 1С под учётной записью ИТС."
          read -r -p "Логин ИТС: " LOGIN
          read -r -s -p "Пароль ИТС: " PASS; echo
        fi
        local JAR; JAR=$(mktemp); chmod 600 "$JAR"; trap 'rm -f "$JAR"' RETURN
        local LOGIN_URL='https://login.1c.ru/login?service=https%3A%2F%2Freleases.1c.ru%2Fpublic%2Fsecurity_check'
        say "Вхожу на портал 1С..."
        local page EXECUTION
        page=$(curl -sSL --retry 2 -A "$UA" -c "$JAR" -b "$JAR" "$LOGIN_URL") || die "Портал 1С недоступен: проверьте интернет и прокси"
        EXECUTION=$(printf '%s' "$page" | tr '\n' ' ' | sed -n 's/.*name="execution"[[:space:]]*value="\([^"]*\)".*/\1/p')
        [ -n "$EXECUTION" ] || die "Страница входа 1С изменилась, скрипт нужно обновить: $SITE/platform"
        # The account goes to curl through stdin, not the command line (ps would show it).
        { printf 'data-urlencode = "username=%s"\n' "$(cfg_esc "$LOGIN")"
          printf 'data-urlencode = "password=%s"\n' "$(cfg_esc "$PASS")"; } |
          curl -sSL -A "$UA" -c "$JAR" -b "$JAR" -K - --data-urlencode "execution=$EXECUTION" \
            --data-urlencode "_eventId=submit" -o /dev/null "$LOGIN_URL" || die "Портал 1С не ответил на вход"
        local list; list=$(curl -sSL -A "$UA" -c "$JAR" -b "$JAR" "https://releases.1c.ru/version_files?nick=$NICK&ver=$VERSION") ||
          die "Не удалось открыть страницу сборки $VERSION на портале 1С"
        case "$list" in *'name="execution"'*) die "Портал 1С не принял логин и пароль ИТС. Звёздочек при вводе не видно — проверьте раскладку и число символов." ;; esac
        local href NAME file_page MIRRORS
        href=$(printf '%s' "$list" | grep -oE "href=\"/version_file\?[^\"]*server64_$UNDER\.(zip|tar\.gz)\"" | head -n1 | sed -e 's/^href="//' -e 's/"$//' -e 's/&amp;/\&/g')
        [ -n "$href" ] || die "У сборки $VERSION на портале нет дистрибутива «Технологическая платформа (64-bit) для Linux»."
        NAME=$(printf '%s' "$href" | sed -e 's/.*%5[cC]//' -e 's/.*[\\/]//')
        file_page=$(curl -sSL -A "$UA" -c "$JAR" -b "$JAR" "https://releases.1c.ru$href") || die "Не удалось открыть страницу файла $NAME"
        MIRRORS=$(printf '%s' "$file_page" | grep -oE 'https://dl[0-9]*\.1c\.ru/[^"]+' | sed 's/&amp;/\&/g' | awk '!seen[$0]++')
        [ -n "$MIRRORS" ] || die "Не найдена ссылка на скачивание $NAME, скрипт нужно обновить: $SITE/platform"
        ok "Дистрибутив: $NAME"
        if [ "$DRY_RUN" = 1 ]; then ok "Проверка прошла: вход на портал работает, ссылка на скачивание найдена ($(printf '%s\n' "$MIRRORS" | wc -l | tr -d ' '))."; return 0; fi
        local DEST="$WORKDIR/$NAME" done_ok=0 m
        for m in $MIRRORS; do
          say "Скачиваю $NAME..."
          if curl -fS --progress-bar -L --retry 2 -A "$UA" -c "$JAR" -b "$JAR" -o "$DEST.part" "$m"; then mv -f "$DEST.part" "$DEST"; done_ok=1; break; fi
          rm -f "$DEST.part"; warn "  Не получилось, пробую зеркало..."
        done
        [ "$done_ok" = 1 ] || die "Не удалось скачать $NAME ни с одного зеркала 1С."
        ARCHIVE=$DEST
      fi
      [ "$DRY_RUN" = 1 ] && { ok "Дистрибутив уже скачан: $ARCHIVE"; return 0; }
      say "Распаковываю $(basename "$ARCHIVE")..."
      mkdir -p "$UNPACKED"
      case "$ARCHIVE" in
        *.zip) if command -v unzip >/dev/null; then unzip -o -q "$ARCHIVE" -d "$UNPACKED"
               elif command -v python3 >/dev/null; then python3 -m zipfile -e "$ARCHIVE" "$UNPACKED"
               else die "Нечем распаковать .zip: установите unzip"; fi ;;
        *.tar.gz) tar -xzf "$ARCHIVE" -C "$UNPACKED" ;;
      esac
      INSTALLER=$(find_installer)
      [ -n "$INSTALLER" ] || die "В дистрибутиве нет установщика setup-full-*.run"
    fi
    [ "$DRY_RUN" = 1 ] && { ok "Установщик уже распакован: $INSTALLER"; return 0; }
    chmod +x "$INSTALLER"
    say "Устанавливаю платформу ($COMPONENTS), несколько минут..."
    "$INSTALLER" --mode unattended --enable-components "$COMPONENTS" ||
      die "Установщик 1С завершился с ошибкой. Запустите его вручную, чтобы увидеть подробности: $INSTALLER"
    [ -d "$INSTALL_DIR" ] || die "Установщик закончил работу, но каталога $INSTALL_DIR нет"
    ok "Платформа $VERSION установлена: $INSTALL_DIR"
  else
    [ "$DRY_RUN" = 1 ] && { say "Платформа $VERSION уже установлена: проверять нечего."; return 0; }
    ok "Платформа $VERSION уже установлена: $INSTALL_DIR"
  fi

  # ── Server service (systemd) ───────────────────────────────────────────────
  local INSTANCE=''
  if [ "$SERVER" = 1 ] && [ "$SERVICE" = 1 ]; then
    if ! command -v systemctl >/dev/null; then warn "systemd не найден — службу сервера настройте вручную."
    else
      local UNIT; UNIT=$(find "$INSTALL_DIR" -maxdepth 1 -name 'srv1cv8*@.service' ! -name '*ras*' 2>/dev/null | head -n1)
      if [ -z "$UNIT" ]; then warn "В $INSTALL_DIR нет файла службы srv1cv8-*@.service — службу настройте вручную."
      else
        INSTANCE="$(basename "$UNIT" .service)default"
        if [ "$move" = 1 ]; then
          say "  Останавливаю $svc_to_move..."
          systemctl disable --now "$svc_to_move" >/dev/null 2>&1
          systemctl link "$UNIT" >/dev/null 2>&1
          if systemctl enable --now "$INSTANCE" >/dev/null 2>&1; then ok "  Служба переведена на $VERSION: $INSTANCE запущена."
          else warn "  Не удалось запустить $INSTANCE: systemctl status $INSTANCE"; fi
        elif systemctl is-active --quiet "$INSTANCE" 2>/dev/null; then ok "Служба $INSTANCE уже работает."
        elif [ -n "$other" ]; then
          warn "Уже работает служба сервера 1С: $other. Новую не включаю, чтобы не было конфликта портов."
          say  "  Перевести: запустите скрипт снова и ответьте «да» на вопрос о переводе службы."
        else
          systemctl link "$UNIT" >/dev/null 2>&1
          if systemctl enable --now "$INSTANCE" >/dev/null 2>&1; then ok "Служба $INSTANCE включена и запущена (порты 1540, 1541, 1560-1591)."
          else warn "Не удалось запустить службу $INSTANCE: systemctl status $INSTANCE"; fi
        fi
      fi
    fi
  fi

  # ── After the install: ras ─────────────────────────────────────────────────
  head_line "После установки"
  local do_ras=0
  if [ "$SERVER" = 1 ] && command -v systemctl >/dev/null; then
    local RAS_UNIT; RAS_UNIT=$(find "$INSTALL_DIR" -maxdepth 1 -name 'ras-*@.service' 2>/dev/null | head -n1)
    if [ -n "$RAS_UNIT" ]; then
      if [ "$RAS" = yes ]; then do_ras=1
      elif [ "$RAS" != no ]; then ask_yes "Включить службу ras $VERSION (удалённое администрирование кластера: консоль с Windows, rac, порт 1545)?" 0 && do_ras=1; fi
      if [ "$do_ras" = 1 ]; then
        local RAS_INST; RAS_INST="$(basename "$RAS_UNIT" .service)default"
        systemctl link "$RAS_UNIT" >/dev/null 2>&1
        if systemctl enable --now "$RAS_INST" >/dev/null 2>&1; then ok "  Служба $RAS_INST включена (порт 1545)."; else warn "  Не удалось запустить $RAS_INST"; fi
      fi
    fi
  fi

  # ── The downloaded distribution ────────────────────────────────────────────
  echo; ok "Готово: платформа $VERSION — $INSTALL_DIR"
  local removed=0
  if [ -d "$WORKDIR" ]; then
    local size; size=$(du -sm "$WORKDIR" 2>/dev/null | cut -f1)
    local f=$FILES
    if [ -z "$f" ]; then if ask_yes "Удалить скачанный дистрибутив (${size:-?} МБ, $WORKDIR)?"; then f=remove; else f=keep; fi; fi
    if [ "$f" = remove ]; then rm -rf "$WORKDIR"; removed=1; say "Дистрибутив удалён."; else say "Дистрибутив: $WORKDIR"; fi
  fi
  # The same run without questions:
  local rep="--version $VERSION --mode $MODE --yes"
  if [ "$move" = 1 ]; then rep="$rep --move-service"; elif [ -n "$svc_to_move" ]; then rep="$rep --keep-service"; fi
  if [ "$SERVER" = 1 ]; then if [ "$do_ras" = 1 ]; then rep="$rep --ras"; else rep="$rep --no-ras"; fi; fi
  if [ "$removed" = 1 ]; then rep="$rep --remove-files"; else rep="$rep --keep-files"; fi
  echo; title "Повторить то же самое на другом сервере без вопросов:"
  say "  sudo bash @@FILE@@ $rep"
  return 0
}

while true; do
  run_once || break
  [ "$INTERACTIVE" = 1 ] || break
  echo; read -r -p "Enter — вернуться в меню " _
done
