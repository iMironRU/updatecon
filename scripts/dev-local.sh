#!/usr/bin/env bash
# dev-local.sh — run Апдейкон locally to look at it in a browser.
#
#   bash scripts/dev-local.sh          → http://localhost:3100
#
# PostgreSQL runs in Docker (container updatcon-dev-pg, data in the volume
# updatcon-dev-pgdata, port 55432). The script starts (or creates) it, applies
# migrations, restores data/seed.sql.gz into an empty database, builds and
# starts the server. Stopping the script stops the server AND the database
# container — the data stays in the volume for next time.
#
# ITS credentials (imports, patches, downloads) are taken from ./.env if set.

set -euo pipefail
cd "$(dirname "$0")/.."

PG=updatcon-dev-pg
VOL=updatcon-dev-pgdata
PGPORT=55432
PORT="${PORT:-3100}"
export DATABASE_URL="postgres://upd:upd@localhost:${PGPORT}/upd"

# Restarts overlap: the old instance stops the database on exit while the new
# one starts it. So a new instance waits for the previous one to finish, and
# only the instance that owns the pid file stops the database.
PIDFILE=".dev-local.pid"
OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ]; then
  for _ in $(seq 1 40); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 0.5; done
fi
echo $$ > "$PIDFILE"

SERVER_PID=""
stop_all() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  if [ "$(cat "$PIDFILE" 2>/dev/null || true)" = "$$" ]; then
    docker stop "$PG" >/dev/null 2>&1 || true
    rm -f "$PIDFILE"
  fi
}
trap stop_all EXIT INT TERM

if docker inspect "$PG" >/dev/null 2>&1; then
  docker start "$PG" >/dev/null 2>&1 || true   # the wait loop below retries
else
  docker run -d --name "$PG" -e POSTGRES_USER=upd -e POSTGRES_PASSWORD=upd -e POSTGRES_DB=upd \
    -p "${PGPORT}:5432" -v "${VOL}:/var/lib/postgresql/data" postgres:16-alpine >/dev/null
fi
echo "[dev-local] waiting for PostgreSQL…"
for _ in $(seq 1 60); do
  # (re)start if something stopped it meanwhile
  [ "$(docker inspect -f '{{.State.Running}}' "$PG" 2>/dev/null)" = "true" ] || docker start "$PG" >/dev/null 2>&1 || true
  docker exec "$PG" pg_isready -U upd -q 2>/dev/null && break
  sleep 1
done
docker exec "$PG" pg_isready -U upd -q || { echo "[dev-local] PostgreSQL did not start" >&2; exit 1; }

echo "[dev-local] building…"
npm run build --silent
rm -rf dist/admin && cp -R src/admin dist/admin
rm -rf dist/scripts && cp -R src/scripts dist/scripts

echo "[dev-local] migrations…"
node --input-type=module -e '
  import pg from "pg";
  import { drizzle } from "drizzle-orm/node-postgres";
  import { migrate } from "drizzle-orm/node-postgres/migrator";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();'

if [ "$(docker exec "$PG" psql -U upd -d upd -tAc 'select count(*) from configurations')" = "0" ] \
   && [ -f data/seed.sql.gz ]; then
  echo "[dev-local] empty database — restoring data/seed.sql.gz…"
  gzip -dc data/seed.sql.gz | docker exec -i "$PG" psql -U upd -d upd -q >/dev/null
fi

if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ITS_LOGIN=*|ITS_PASSWORD=*) export "${line%$'\r'}";; esac
  done < .env
fi

export PORT CADDY_API="http://127.0.0.1:1"   # no Caddy locally
echo "[dev-local] http://localhost:${PORT}"
node dist/db/server.js &
SERVER_PID=$!
wait "$SERVER_PID"
