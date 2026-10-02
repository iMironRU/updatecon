#!/usr/bin/env bash
# snapshot.sh — refresh the local database and publish it for installations.
#
#   bash scripts/snapshot.sh              «Обновить всё» (ITS account from ./.env), dump, upload
#   bash scripts/snapshot.sh --no-import  dump what the local database has now, upload
#   bash scripts/snapshot.sh --no-upload  …but keep the files in data/snapshot/ only
#
# Uses the local database of scripts/dev-local.sh (container updatcon-dev-pg).
# The files go to the `data` release of the GitHub repository, overwritten
# each time (git history does not grow); installations take them from
# https://github.com/iMironRU/updatecon/releases/download/data/ (src/db/snapshot.ts).

set -euo pipefail
cd "$(dirname "$0")/.."

PG=updatcon-dev-pg
export DATABASE_URL="postgres://upd:upd@localhost:55432/upd"
OUT=data/snapshot
IMPORT=1; UPLOAD=1
for a in "$@"; do
  case "$a" in --no-import) IMPORT=0;; --no-upload) UPLOAD=0;; *) echo "unknown option: $a" >&2; exit 2;; esac
done

docker start "$PG" >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U upd -q 2>/dev/null && break; sleep 1; done

echo "[snapshot] building…"
npm run build --silent

if [ "$IMPORT" = 1 ]; then
  if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ITS_LOGIN=*|ITS_PASSWORD=*) export "${line%$'\r'}";; esac
    done < .env
  fi
  # Continue the published lineage: ids (and /config/<id> links on installs
  # that live on snapshots) stay the same. A no-op when it is already applied.
  echo "[snapshot] taking the published snapshot first…"
  node dist/db/snapshot.js apply
  echo "[snapshot] «Обновить всё» on the local database…"
  node dist/db/pipeline.js
fi

echo "[snapshot] dumping…"
node dist/db/snapshot.js create "$OUT" --commit "$(git rev-parse --short HEAD)"

if [ "$UPLOAD" = 1 ]; then
  node dist/db/snapshot.js check "$OUT"
  gh release view data >/dev/null 2>&1 || gh release create data --latest=false \
    --title "Снимок базы данных" \
    --notes "Готовая база Апдейкона для установок без учётки ИТС: snapshot.ndjson.gz + snapshot.json. Обновляется scripts/snapshot.sh; установки берут её сами (src/db/snapshot.ts)."
  # The data first, then its description: an install reading the new json always finds its file.
  gh release upload data "$OUT/snapshot.ndjson.gz" --clobber
  gh release upload data "$OUT/snapshot.json" --clobber
  echo "[snapshot] published: https://github.com/iMironRU/updatecon/releases/tag/data"
fi
