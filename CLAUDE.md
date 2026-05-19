# CLAUDE.md

Context for Claude Code working on **upd1c-chains** — a 1C update-chain
calculator. Read this fully before changing anything.

## What this project is

Parses `v8cscdsc.lst` (the full update list the 1C configurator pulls from
`downloads.v8.1c.ru`), consolidates it into an update graph in PostgreSQL,
and serves a web calculator: "from version X to version Y — which `.cfu`
files, in what order".

Single stack: **Node.js + TypeScript everywhere**. One Docker image runs
both the web server and the scheduled import worker. No separate frontend
container. This is a deliberate, discussed decision — do not introduce other
languages or split services without explicit instruction.

## Layout

```
src/parser/
  version.ts            canonical version model + comparison
  lst-parser.ts         ORACLE: faithful port of 1C ПарсерLST (do not "optimize")
  lst-parser-stream.ts  streaming parser used in production
src/db/
  schema.ts             Drizzle schema (configurations, update_edges, import_runs)
  client.ts             pg Pool + Drizzle instance (honours globalThis.__SHARED_POOL__ for tests)
  fetch-lst.ts          ITS Basic-auth fetch OR local file (LST_FILE/argv)
  import-lst.ts         runImport(): two-level hash delta, fan-out to edges
  chain.ts              findChain(): recursive-CTE shortest path
  server.ts             Fastify API + serves public/
  worker.ts             migrate -> optional immediate import -> cron
public/index.html       single-file UI (vanilla JS, no build)
drizzle/                generated migration SQL (committed)
```

## Locked domain decisions — DO NOT silently change

1. **Version = first 4-segment token only.** `1.3.93.1/3.1.46.23` → `1.3.93.1`.
   The part after `/` is NOT used and NOT stored anywhere. Canonicalization
   happens at parse time in `lst-parser-stream.ts` via `toCore()`. Confirmed
   against TWO working 1C reference implementations. If you ever need the
   second part, that is a product decision — ask, don't add it back.
2. **Edition transitions are NOT chained** (1.0 → 2.0 → 3.0). That is a
   separate 1C procedure, not a `.cfu` apply. Enforced by the `edition`
   filter (first version segment) in `chain.ts` and a guard in the
   `/api/chain` route. This is correct behaviour, not a missing feature.
3. **The 1C `СравнитьВерсии` bug is intentionally NOT ported.** The original
   does `Число()` over a slash-containing string → throws → returns 0
   ("incomparable"), silently breaking chains for every layered config.
   `version.ts compareVersions` compares clean numeric `core` instead. Keep
   it that way.
4. **`lst-parser.ts` is the correctness oracle.** It is a deliberate
   line-for-line twin of the working 1C module. Do not refactor or
   "optimize" it. `lst-parser-stream.ts` must stay byte-identical in output
   to it — there is a parity check; re-run it after any parser change.
5. **PostgreSQL, not Mongo.** Chain = graph, path via recursive CTE; raw
   source payload lives in `update_edges.raw_json` (JSONB).

## Data model (schema.ts)

- `configurations` (id, name UNIQUE, vendor) — one per template.
- `update_edges` (config_id, from_version, to_version, edition, cfu_path,
  content_hash, raw_json, first_seen_at, last_seen_at).
  UNIQUE `(config_id, from_version, to_version)`. Indexes on
  `(config_id, edition, from_version)` and `(... to_version)`.
- `import_runs` (file_sha256, counts, status: ok|skipped|error).

A parsed record `to <- [from...]` fans out into ONE edge per from-version.

## Hash delta (import-lst.ts) — keep this contract

- File level: SHA-256 of the whole file. If equal to the last `status=ok`
  run → record a `skipped` run and do nothing.
- Edge level: `content_hash = sha256(name|from|to|cfu)`. Upsert by the
  unique key; `last_seen_at` always bumped; payload rewritten only when the
  hash changed. A re-run over an unchanged file must touch zero rows.

## Commands

```
npm run typecheck     # tsc --noEmit  (run after EVERY change; CI gate)
npm run generate      # drizzle-kit generate (after schema.ts edits)
npm run migrate       # apply migrations
npm run import:lst <path>   # dev: import from a local .lst
npm run server        # http://localhost:3000
npm run worker        # migrate + scheduled import
npm run build         # tsc -> dist/, then runtime uses node dist/db/*.js
```

Deploy on a clean Ubuntu VM: `./deploy.sh` (installs Docker, writes `.env`,
`docker compose up -d`). Web on `:3000`. Worker reads ITS creds from `.env`
or replays `LST_FILE` from `./data`.

## Module resolution gotcha — IMPORTANT

`tsconfig` uses `NodeNext`. **All relative imports MUST end in `.js`**
(e.g. `import { db } from "./client.js"`) even though the source is `.ts`.
Omitting the extension fails the typecheck. New files must follow this.

## Environment / verification reality

- This was built and verified in a sandbox with **no real PostgreSQL**
  (apt blocked; `pg-mem` used for logic checks). `pg-mem` does NOT support
  Drizzle's `rowMode: array` nor `= ANY(array)` inside a recursive CTE —
  both are standard on real Postgres. So the Drizzle↔PG seam and the
  recursive CTE are the ONLY parts not yet exercised on a real engine.
- Everything else is verified on the real `sample.lst`: parser parity
  (3211/3211, exact match stream vs oracle), idempotent import
  (9930→9930 edges), all route SQL, strict typecheck clean.
- **First task on a real VM:** run a full `v8cscdsc.lst` import, open the
  calculator, confirm a real multi-step chain. That closes the only
  unproven seam.

## Conventions

- Comments and user-facing strings: Russian where it's domain/UI, English
  for code-internal rationale (matches existing files — keep consistent).
- No new dependencies without reason; single-stack discipline.
- After any change: `npm run typecheck` must be clean. After parser
  changes: re-run the stream-vs-oracle parity check on a sample.
- Don't reformat or "tidy" `lst-parser.ts`.

## Roadmap (next work)

The `.lst` source is done — it's the richest one (the graph edge list).
Three other sources remain to consolidate: ITS internet-support (two
portal versions) and the 1C releases site. Architecture is ready: each
source = its own adapter writing into the same `update_edges` + `raw_json`,
with field-merge rules by source priority. Awaiting real samples for those.
