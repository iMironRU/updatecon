#!/usr/bin/env bash
# Апдейкон — обновление конфигурации 1С по цепочке
# Бухгалтерия предприятия, редакция 3.0: 3.0.193.19 -> 3.0.207.25 (4 шага)
# Сформировано на upd.imiron.ru 2026-10-04
#
# Что делает скрипт:
#   1. Скачивает файлы обновлений с downloads.v8.1c.ru под вашей учётной записью ИТС
#      (так же, как конфигуратор при обновлении через интернет). Логин и пароль ИТС
#      уходят только на сервер 1С и нигде не сохраняются.
#   2. Делает выгрузку информационной базы (.dt), чтобы можно было откатиться.
#   3. Применяет обновления по порядку в пакетном режиме конфигуратора
#      и после каждого шага обновляет конфигурацию базы данных.
#   4. Запускает базу в режиме предприятия, чтобы выполнились обработчики обновления.
#   При ошибке скрипт останавливается и показывает журнал конфигуратора.
#
# Перед запуском:
#   - все пользователи должны выйти из базы;
#   - у пользователя базы, под которым идёт обновление, должны быть административные права;
#   - доработанные конфигурации (с изменениями или снятые с поддержки) этим скриптом
#     не обновить, их обновляют вручную в конфигураторе;
#   - без графического сеанса нужен xvfb (Debian/Ubuntu: apt install xvfb).
#
# Запуск:
#   bash updatecon-Accounting-3.0.193.19-3.0.207.25.sh
#
# Параметры (все необязательные, недостающее скрипт спросит):
#   --base /srv/1c/buh           файловая база: каталог с файлом 1Cv8.1CD
#   --server srv1c --ref buh     база на сервере 1С: сервер (можно с портом) и имя базы
#   --user Администратор         пользователь базы
#   --platform /opt/1cv8/x86_64/8.3.27.2342/1cv8
#   --workdir ~/updatecon        куда скачивать обновления и писать журналы
#   --no-backup                  не делать выгрузку .dt
#   --handlers-each-step         запускать обработчики обновления после каждого шага
#   --download-only              только скачать файлы обновлений
# Логин и пароль ИТС можно передать через переменные окружения ITS_LOGIN и ITS_PASSWORD,
# пароль пользователя базы — через IB_PASSWORD.

set -uo pipefail

TITLE='Бухгалтерия предприятия, редакция 3.0'
FROM_VERSION='3.0.193.19'
TO_VERSION='3.0.207.25'
SITE='https://upd.imiron.ru'
STEP_VERSIONS=('3.0.195.36' '3.0.198.19' '3.0.203.24' '3.0.207.25')
STEP_FILES=('01-3.0.195.36.cfu' '02-3.0.198.19.cfu' '03-3.0.203.24.cfu' '04-3.0.207.25.cfu')
STEP_URLS=('https://downloads.v8.1c.ru/tmplts/1c/Accounting/3_0_195_36/1cv8.cfu' 'https://downloads.v8.1c.ru/tmplts/1c/Accounting/3_0_198_19/1cv8.cfu' 'https://downloads.v8.1c.ru/tmplts/1c/Accounting/3_0_203_24/1cv8.cfu' 'https://downloads.v8.1c.ru/tmplts/1c/Accounting/3_0_207_25/1cv8.cfu')
STEP_PLATFORMS=('8.3.27.1688' '8.3.27.1688' '8.3.27.1688' '8.3.27.1688')
COUNT=${#STEP_VERSIONS[@]}

BASE='' SERVER='' REF='' IB_USER='' USER_SET=0 PLATFORM='' WORKDIR=''
NO_BACKUP=0 EACH_STEP=0 DOWNLOAD_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE=${2:-}; shift 2 ;;
    --server) SERVER=${2:-}; shift 2 ;;
    --ref) REF=${2:-}; shift 2 ;;
    --user) IB_USER=${2:-}; USER_SET=1; shift 2 ;;
    --platform) PLATFORM=${2:-}; shift 2 ;;
    --workdir) WORKDIR=${2:-}; shift 2 ;;
    --no-backup) NO_BACKUP=1; shift ;;
    --handlers-each-step) EACH_STEP=1; shift ;;
    --download-only) DOWNLOAD_ONLY=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (список: --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
head_line() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }
ask_yes() { local a; read -r -p "$1 (да/нет) " a; case "$a" in д|да|Д|Да|y|Y|yes) return 0 ;; *) return 1 ;; esac; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
# A value for a curl config file: quotes and backslashes escaped.
cfg_esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

command -v curl >/dev/null || die "Нужен curl (Debian/Ubuntu: apt install curl)"

head_line "Апдейкон: $TITLE"
say "Обновление $FROM_VERSION -> $TO_VERSION, шагов: $COUNT"

# ── Files ────────────────────────────────────────────────────────────────────
[ -n "$WORKDIR" ] || WORKDIR="$PWD/"'updatecon-Accounting-3.0.193.19-3.0.207.25'
mkdir -p "$WORKDIR" || die "Не удалось создать каталог $WORKDIR"
WORKDIR=$(cd "$WORKDIR" && pwd)

missing=0
for f in "${STEP_FILES[@]}"; do [ -s "$WORKDIR/$f" ] || missing=1; done
if [ "$missing" = 1 ]; then
  ITS_LOGIN=${ITS_LOGIN:-}
  ITS_PASSWORD=${ITS_PASSWORD:-}
  if [ -z "$ITS_LOGIN" ] || [ -z "$ITS_PASSWORD" ]; then
    say "Файлы обновлений скачиваются под учётной записью ИТС (портал 1С)."
    read -r -p "Логин ИТС: " ITS_LOGIN
    read -r -s -p "Пароль ИТС: " ITS_PASSWORD; echo
  fi
  for i in $(seq 0 $((COUNT - 1))); do
    dest="$WORKDIR/${STEP_FILES[$i]}"
    [ -s "$dest" ] && continue
    say "Скачиваю $((i + 1)) из $COUNT: ${STEP_VERSIONS[$i]}"
    # The account goes to curl through stdin, not the command line (ps would show it).
    code=$(printf 'user = "%s:%s"\n' "$(cfg_esc "$ITS_LOGIN")" "$(cfg_esc "$ITS_PASSWORD")" |
      curl -S --progress-bar -L --retry 2 -A '1C+Enterprise/8.3' -K - -o "$dest.part" -w '%{http_code}' "${STEP_URLS[$i]}") || true
    if [ "$code" = 401 ] || [ "$code" = 403 ]; then
      rm -f "$dest.part"; die "Сервер 1С не отдал файл: неверный логин или пароль ИТС, или у учётной записи нет подписки на обновления этой конфигурации (для партнёрских решений нужна подписка на сам продукт)."
    fi
    if [ "$code" != 200 ]; then
      rm -f "$dest.part"; die "Не удалось скачать ${STEP_URLS[$i]} (HTTP ${code:-нет ответа})"
    fi
    mv -f "$dest.part" "$dest"
  done
fi
ok "Файлы обновлений: $WORKDIR"
[ "$DOWNLOAD_ONLY" = 1 ] && exit 0

# ── Platform ─────────────────────────────────────────────────────────────────
NEED=''
for p in "${STEP_PLATFORMS[@]}"; do
  [ -n "$p" ] || continue
  if [ -z "$NEED" ] || ! ver_ge "$NEED" "$p"; then NEED=$p; fi
done
FOUND=''
if [ -n "$PLATFORM" ]; then
  [ -x "$PLATFORM" ] || die "Не найден исполняемый файл $PLATFORM"
  EXE=$PLATFORM
  FOUND=$(basename "$(dirname "$EXE")")
  printf '%s' "$FOUND" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || FOUND=''
else
  EXE=''
  for d in /opt/1cv8/x86_64/*/ /opt/1cv8/*/; do
    v=$(basename "$d")
    printf '%s' "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || continue
    [ -x "$d/1cv8" ] || continue
    if [ -z "$FOUND" ] || ! ver_ge "$FOUND" "$v"; then FOUND=$v; EXE="${d%/}/1cv8"; fi
  done
  if [ -z "$EXE" ] && [ -x /opt/1C/v8.3/x86_64/1cv8 ]; then EXE=/opt/1C/v8.3/x86_64/1cv8; fi
  [ -n "$EXE" ] || die "Не найдена платформа 1С:Предприятие. Установите её (скрипт установки есть на $SITE/platform) или укажите путь: --platform /opt/1cv8/x86_64/<версия>/1cv8"
fi
say "Платформа: $EXE"
if [ -n "$NEED" ] && [ -n "$FOUND" ] && ! ver_ge "$FOUND" "$NEED"; then
  warn "Для этой цепочки нужна платформа не ниже $NEED, а найдена $FOUND."
  warn "Скрипт установки нужной платформы: $SITE/platform"
  ask_yes "Всё равно продолжить?" || exit 1
fi

# Batch mode still needs a display; without one, run 1C inside xvfb.
RUN=()
if [ -z "${DISPLAY:-}" ]; then
  command -v xvfb-run >/dev/null || die "Нет графического сеанса. Установите xvfb (Debian/Ubuntu: apt install xvfb) и запустите снова."
  RUN=(xvfb-run -a)
fi

# ── Infobase ─────────────────────────────────────────────────────────────────
if [ -z "$BASE" ] && { [ -z "$SERVER" ] || [ -z "$REF" ]; }; then
  echo
  say "Где находится база?  1 — файловая (каталог с файлом 1Cv8.1CD),  2 — на сервере 1С"
  read -r -p "Введите 1 или 2: " kind
  if [ "$kind" = 2 ]; then
    read -r -p "Сервер 1С (например srv1c или srv1c:1541): " SERVER
    read -r -p "Имя базы на сервере: " REF
  else
    read -r -p "Путь к каталогу базы: " BASE
  fi
fi
if [ -n "$BASE" ]; then
  [ -f "$BASE/1Cv8.1CD" ] || die "В каталоге $BASE нет файла 1Cv8.1CD: это не файловая база 1С"
  CONN=(/F "$BASE"); BASE_NAME=$BASE
else
  CONN=(/S "$SERVER\\$REF"); BASE_NAME="$SERVER\\$REF"
fi
if [ "$USER_SET" = 0 ]; then read -r -p "Пользователь базы (Enter, если в базе нет пользователей): " IB_USER; fi
IB_PASS=''
if [ -n "$IB_USER" ]; then
  if [ -n "${IB_PASSWORD:-}" ]; then IB_PASS=$IB_PASSWORD; else read -r -s -p "Пароль пользователя $IB_USER: " IB_PASS; echo; fi
fi

head_line "База: $BASE_NAME"
warn "Все пользователи должны выйти из базы — обновлению нужен монопольный доступ."
ask_yes "Начать обновление?" || exit 1

LAST_LOG=''
run_1c() { # mode, what, extra args...
  local mode=$1 what=$2; shift 2
  local out
  out="$WORKDIR/1c-$(date +%Y%m%d-%H%M%S).log"
  local auth=()
  if [ -n "$IB_USER" ]; then auth=(/N "$IB_USER"); [ -n "$IB_PASS" ] && auth+=(/P "$IB_PASS"); fi
  say "  $what..."
  ${RUN[@]+"${RUN[@]}"} "$EXE" "$mode" "${CONN[@]}" ${auth[@]+"${auth[@]}"} /DisableStartupDialogs /DisableStartupMessages /Out "$out" "$@"
  local rc=$?
  LAST_LOG=$out
  if [ $rc -ne 0 ]; then
    [ -f "$out" ] && sed 's/^/    /' "$out"
    return 1
  fi
}
START_COMMAND='ЗапуститьОбновлениеИнформационнойБазы;ЗавершитьРаботуСистемы'
# Without a display nobody can answer a question in the 1C window: do not wait forever.
LIMIT=()
if [ ${#RUN[@]} -gt 0 ] && command -v timeout >/dev/null; then LIMIT=(timeout 10800); fi
run_handlers() {
  local saved=("${RUN[@]+"${RUN[@]}"}")
  RUN=(${LIMIT[@]+"${LIMIT[@]}"} ${saved[@]+"${saved[@]}"})
  run_1c ENTERPRISE "$1" /C "$START_COMMAND"
  local rc=$?
  RUN=(${saved[@]+"${saved[@]}"})
  return $rc
}
CURRENT=$FROM_VERSION

# ── Backup ───────────────────────────────────────────────────────────────────
BACKUP=''
if [ "$NO_BACKUP" = 0 ]; then
  BACKUP="$WORKDIR/backup-$FROM_VERSION-$(date +%Y%m%d-%H%M).dt"
  head_line "Выгрузка базы для отката"
  run_1c DESIGNER "Выгружаю базу в .dt" /DumpIB "$BACKUP" ||
    die "Не удалось выгрузить базу. Проверьте путь, пользователя и что в базе никто не работает. Журнал: $LAST_LOG"
  ok "  Выгрузка: $BACKUP"
fi

# ── Steps ────────────────────────────────────────────────────────────────────
for i in $(seq 0 $((COUNT - 1))); do
  n=$((i + 1))
  head_line "Шаг $n из $COUNT: $CURRENT -> ${STEP_VERSIONS[$i]}"
  if ! run_1c DESIGNER "Обновляю конфигурацию и конфигурацию базы данных" /UpdateCfg "$WORKDIR/${STEP_FILES[$i]}" /UpdateDBCfg; then
    echo
    warn "Шаг $n не выполнен. Последняя успешно установленная версия: $CURRENT."
    [ -n "$BACKUP" ] && warn "Откат: Конфигуратор -> Администрирование -> Загрузить информационную базу -> $BACKUP"
    die "Журнал конфигуратора: $LAST_LOG"
  fi
  CURRENT=${STEP_VERSIONS[$i]}
  ok "  Готово: $CURRENT"
  if [ "$EACH_STEP" = 1 ] && [ "$n" -lt "$COUNT" ]; then
    run_handlers "Выполняю обработчики обновления" || warn "  1С завершилась с ошибкой, журнал: $LAST_LOG"
  fi
done

# ── Update handlers ──────────────────────────────────────────────────────────
head_line "Обработчики обновления"
run_handlers "Запускаю базу в режиме предприятия" ||
  warn "  1С завершилась с ошибкой. Запустите базу вручную, чтобы закончить обновление. Журнал: $LAST_LOG"

echo
ok "Готово: база обновлена до $TO_VERSION."
[ -n "$BACKUP" ] && say "Выгрузка до обновления: $BACKUP"
say "Файлы обновлений и журналы: $WORKDIR"
