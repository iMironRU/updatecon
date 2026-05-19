#!/usr/bin/env bash
# deploy.sh — one-command deploy on a clean Ubuntu host.
#
#   ./deploy.sh
#
# Installs Docker + compose plugin if absent, prepares .env, then builds
# and starts: postgres + web (UI/API) + worker (migrate + scheduled import).
#
# Re-runnable: existing .env and data volume are preserved.

set -euo pipefail

cd "$(dirname "$0")"

log(){ printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
err(){ printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found — installing via get.docker.com…"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  log "Docker installed. You may need to re-login for group changes."
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  err "Docker Compose plugin missing. Install: https://docs.docker.com/compose/install/"
  exit 1
fi
log "Using: $DC"

# ── 2. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  # Generate a strong DB password.
  PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${PW}/" .env
  log ".env created (random POSTGRES_PASSWORD set)."
  err "ACTION REQUIRED: edit .env and set ITS_LOGIN / ITS_PASSWORD"
  err "  (or set LST_FILE=/data/v8cscdsc.lst and drop the file into ./data for dev replay)"
else
  log ".env already exists — leaving it untouched."
fi

mkdir -p data

# ── 3. Build & start ─────────────────────────────────────────────────────────
log "Building images…"
$DC build

log "Starting stack…"
$DC up -d

log "Waiting for web health…"
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$(grep -E '^WEB_PORT=' .env | cut -d= -f2 || echo 3000)/api/health" >/dev/null 2>&1; then
    log "Web is up."
    break
  fi
  sleep 2
done

PORT="$(grep -E '^WEB_PORT=' .env | cut -d= -f2 || echo 3000)"
log "Done."
echo
echo "  Web UI : http://<this-host>:${PORT}/"
echo "  Logs   : $DC logs -f worker   (import progress)"
echo "           $DC logs -f web"
echo "  Stop   : $DC down             (data volume kept)"
echo
echo "  First import runs automatically on worker start (IMPORT_ON_START=1)."
echo "  If using ITS, make sure ITS_LOGIN / ITS_PASSWORD are set in .env, then:"
echo "           $DC restart worker"
