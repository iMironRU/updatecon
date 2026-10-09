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
  schema.ts             Drizzle schema (configurations, update_edges, import_runs, release_projects, …)
  template.ts           application identity: template folder from cfu_path, nick↔template rule
  tags.ts               product-line tags dictionary + refresh (name rule, shared versions)
  manifests.ts          platform generation (8.2/8.3/8.5) from tmplts/<pkg>/1cv8.mft
  transitions.ts        "переходы" between products/editions from LST package sources
  stats.ts              stats page aggregates (/api/stats/more) + platform check (/api/platform-check)
  pipeline.ts           «Обновить всё»: LST → releases.1c.ru → 1С:Решения in one run with a summary;
                        used by the admin button and the scheduled worker; full log kept in import_runs.log
  snapshot.ts           the data tables as one file (snapshot.ndjson.gz + snapshot.json) published in the
                        `data` GitHub release; installs without an ITS account apply it (worker start, nightly,
                        admin button) in one transaction, keeping settings and manual links/tags
  credentials.ts        ITS accounts (settings.its_accounts, several; the first is the main one and
                        lands in process.env.ITS_*; allItsAccounts() for the rest, plus env ITS_ACCOUNTS
                        (JSON [{login,password}], the snapshot workflow's secret) — releases import
                        merges /total over all, manifests retry 401 with the others) / admin password
  metrika.ts            Яндекс Метрика counter (admin UI → settings); server.ts serves index.html itself
                        (not @fastify/static) to put the tag in; the page reports SPA hits + goals
  exchanges.ts          обмены/переходы between standard configurations from the 1CExchenge registry
                        (github.com/iMironRU/1CExchenge data/registry.json, fetched as step 4 of «Обновить
                        всё»); sides mapped to configurations by product key + edition (KEY_TEMPLATE)
  events.ts             the release journal (release_events): recordEvents() = step 5 of «Обновить всё»
                        writes new facts once (unique type+key, the data's own date, attributes frozen:
                        first release, raised_from via SQL plat_min(), branch = an older line updated,
                        patches, platform builds, to85, lts_end; first run fills 180 days); journal(days)
                        feeds /api/news (stats.ts newsEvents falls back to computing when the table is
                        empty). In snapshots. Patches are grouped per config/version/day in the feed.
  push.ts               Web Push «Уведомлять о релизах моих конфигураций»: VAPID keys made once into
                        settings (private sealed), push_subscriptions (endpoint, favourites,
                        last_event_id = journal cursor); notifyReleases() after a snapshot apply /
                        «Обновить всё» (worker + admin) sends the journal entries after the cursor
                        (releases, ДП-branch updates, patches of the favourites); the cursor moves only
                        on delivery; 404/410 or 5 failures delete. sw.js shows the notification and
                        opens data.url. iOS: installed PWA only. Not in snapshots. Library: web-push.
  scripts.ts            scripts for the user's machine (/api/script/chain, /api/script/platform):
                        apply an update chain in designer batch mode / install a platform build,
                        PowerShell + bash; templates in src/scripts (copied to dist/scripts like src/admin)
src/releases/
  solutions.ts          product cards from solutions.1c.ru (industries, base config, …)
  platform.ts           1С:Предприятие builds from releases.1c.ru (dates, OS, notes, bugboard) → platform_builds
  client.ts             pg Pool + Drizzle instance (honours globalThis.__SHARED_POOL__ for tests)
  fetch-lst.ts          ITS Basic-auth fetch OR local file (LST_FILE/argv)
  import-lst.ts         runImport(): two-level hash delta, fan-out to edges
  chain.ts              findChain(): recursive-CTE shortest path
  server.ts             Fastify API + serves public/
  worker.ts             migrate -> optional immediate import -> cron
public/index.html       single-file UI (vanilla JS, no build); /news reads the release journal (events.ts); «Мои конфигурации» = config ids in localStorage uc_fav;
                        clean paths (/config/96) via the History API,
                        server falls back to index.html; old /#/… links are rewritten on load
public/sw.js            PWA service worker: network first, cache fallback for the public pages and
                        GET /api/* (offline answers carry X-Updatecon-Offline: 1 → the page's
                        «Нет связи» bar; 5xx counts as no network); push + notificationclick;
                        never touches the admin panel. Bump CACHE when sw.js changes
public/manifest.webmanifest, public/icons/   install manifest + icons (rendered from icons/*.svg)
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
6. **Application identity = (template folder, edition), NOT the metadata
   name.** Template folder = `cfu_path` prefix before the version folder
   (`1c/Accounting/3_0_197_22/1cv8.cfu` → `1c/Accounting`); edition = first
   version segment. The LST `name` is not unique: other vendors ship products
   with the same metadata name (AlaBait's `БухгалтерияПредприятия` once got
   into 1С:БП chains), regional ports get renamed. One catalog card = one
   (template, edition). `template.ts` and the SQL in
   `drizzle/0005_sleepy_nocturne.sql` must stay in sync.
7. **releases.1c.ru projects are linked by rule, not by fuzzy matching.**
   nick = template name + edition suffix (`Accounting30` → `1c/Accounting`).
   Fallback by version overlap is deliberately strict; manual links from the
   admin UI (`release_projects.match_method = 'manual'`) are never
   overwritten. A wrong link is worse than no link.

## Data model (schema.ts)

- `configurations` — one per application edition: UNIQUE `(template_key,
  edition)`; `template_code` ("1c/Accounting"), `name`/`vendor` follow the
  latest LST record; display fields are copied from the primary releases
  project.
- `release_projects` (nick PK → config_id, match_method rule|versions|manual)
  — every project from releases.1c.ru `/total`, matched or not.
- `template_tags` (template_key, tag PK) — product-line tags (БУХ, ЗУП, УТ,
  УНФ…, dictionary in `src/db/tags.ts`), kind own|based, source
  rule|versions|manual. Recomputed after every LST import and on worker
  start; manual rows are never touched (tag '' = "manually: no tags").
- `package_manifests` (dir PK → app_version, status ok|denied|missing|error)
  — `AppVersion` from each package's `1cv8.mft` (the LST has no platform
  info; the manifest path is the cfu folder + lowercase `1cv8.mft`). Only
  the newest package per edition is fetched, after every LST import.
  Partner packages often answer 401 (denied, retried after 30 days). The
  catalog's `platform` prefers releases.1c.ru's official minimum for its
  newest version (manifests can lag: Клиент ЭДО 2.10 says 8.3, needs 8.5).

- `version_meta.files` / `files_nick` / `files_fetched_at` — the version's files on
  releases.1c.ru (`/version_files`: title + path) read by the releases import, newest
  versions first, 3 per project per run. Download links are built only from these
  paths: they differ per product (`Trade\11_6_1_70\Trade_11_6_1_70_setup1c.zip`,
  the folder is not the nick), a guessed `<nick>\<ver>\updsetup.zip` is «файл не
  найден». Until a version is read, the UI links its file list page. `/api/versions`
  returns them classified (`classifyVersionFiles`: update, full, tech, news, order).
  All versions at once: snapshot workflow input `files_all` runs
  `node dist/releases/backfill-files.js --minutes 300` (one page at a time, ~3 h for 30k
  versions, no sizes; the rest is left for the next run).
  Full distributions of some 1C products ask for a one-time code (2FA) on the portal.
  Update sizes (`file_size_bytes`, the properties JSON of «Дистрибутив обновления») are read
  by the nightly import for its 3 newest versions and by `backfill-sizes.js` (snapshot input
  `sizes_all`, newest first, `size_checked_at` marks a look even when the portal has no size).
  `/api/chain` returns `sizeBytes`/`releaseDate` per step; the UI shows «≈ median of the
  configuration's known sizes» for the rest and an install time estimate (download at a chosen
  speed, localStorage uc_speed, + 15–20 min per update).

- `patches` (uuid unique → config_id, version, title = the portal's name EF_…, description,
  patch_date) — «исправления» from releases.1c.ru `/patches/total?nick=&ver=`, read by the
  releases import for versions of the last 180 days (6 newest per project), upsert by uuid.
  `/api/chain` steps carry `patches` + `patchesUrl` (the portal's page of that version — single
  patch pages redirect to login); `/api/patches` lazy-fetches with an ITS account.

- `update_edges` (config_id, from_version, to_version, edition, cfu_path,
  content_hash, raw_json, first_seen_at, last_seen_at).
  UNIQUE `(config_id, from_version, to_version)`. Indexes on
  `(config_id, edition, from_version)` and `(... to_version)`.
- `import_runs` (file_sha256, counts, status: ok|skipped|error; source lst|releases|all).
  Rows with source `all` are «Обновить всё» runs (status ok|partial|error|cancelled), their
  `log` holds the full text log (kept for the latest 30). Never select `log` into lists or
  public endpoints — server.ts uses `RUN_COLS` / `RUN_LIST` without it.

A parsed record `to <- [from...]` fans out into ONE edge per from-version,
owned by the application edition of its own package (template of `cfuPath`
+ first segment of `to`). API calls address editions by `config_id`
(`config=<name>` is still accepted but ambiguous).

- `transitions` — "переходы": LST packages whose sources are another
  product (УТ базовая → УТ, УТ → КА → ERP, Розница → УНФ) or another
  edition (БП 2.0 → 3.0). Extracted by `src/db/transitions.ts`, a separate
  read-only pass over the LST text (the locked parsers drop source names).
  **Information only** — the user decided transitions are shown ("можно
  перейти"), not chained; locked decision 2 stands.
- `exchanges` (id = registry link id) / `exchange_formats` (line, version PK) — the
  1CExchenge registry: synchronisations and migrations «из → в» with mechanism, plan,
  objects, sources, shippedIn; declared EnterpriseData versions. Replaced whole on each
  import; the registry is the source of truth (its page holds the matrix, we link to it).
  Sides outside the catalog (7.7, mobile apps) keep their label, config id null. The
  config page shows the «Обмены» tab for every configuration, «данных пока нет» without rows.

- `platform_builds` (version PK) — every 8.2/8.3/8.5 platform build from
  releases.1c.ru with its date; for 8.3/8.5 also `os` (win64 win32 linux64
  linux32 arm64 e2k mac — from <h5> groups or, on older pages, file names),
  release notes and bugboard links. Step 3 of «Обновить всё»; a build page is
  fetched once. The /platform page (and `/api/platform`) is built on it plus
  version_meta.min_platform: coverage per line, minimum per configuration.
- `solutions_info` (url PK) — solutions.1c.ru product card for linked
  projects: product kind, enterprise types, countries, developers, **base
  configuration** (official "на базе", outranks the version heuristic in
  `tags.ts`; "Оригинальная" = based on nothing), industries, tasks,
  editions, support phone/e-mail. Fetched at the end of the releases import,
  one page a second, refreshed weekly.

## Database snapshots (data from GitHub)

`npm run snapshot` (scripts/snapshot.sh) runs «Обновить всё» on the local dev
database, dumps the data tables and uploads them to the `data` release
(`--no-import`, `--no-upload` for parts). One asset, overwritten — never commit
dumps to git (+20 MB of history each). Rows are written with `row_to_json` and
read back with `json_populate_recordset`, so types round-trip without pg_dump.
An install takes a snapshot only if its own schema is at least the snapshot's
(`migrations` = drizzle journal entries); otherwise «сначала обновите
приложение». Apply = DELETE + INSERT in one transaction (readers keep the old
data until COMMIT — no TRUNCATE locks), then sequences, then manual project
links (re-resolved by template_key + edition) and manual tags. `settings` and
`import_runs` are never in a snapshot. Ids follow the publisher, so
snapshot-fed installs share /config/<id> links with it. `SNAPSHOT_URL=off`
disables it.

Publishing is automatic: `.github/workflows/snapshot.yml` (nightly 00:00 UTC +
manual) runs on a Postgres service — migrations → **apply the published
snapshot** → «Обновить всё» (`node dist/db/pipeline.js`, ITS account from the
repo secrets ITS_LOGIN / ITS_PASSWORD) → `snapshot.js create` → `snapshot.js
check` (refuses when a key table lost >5 % against the published one or the
schema is older) → upload. Always continue the published lineage — never build
a snapshot from an empty database, or every config id changes. scripts/snapshot.sh
does the same locally. A worker on an EMPTY database also starts from the
snapshot, ITS account or not, then imports on top.

## Admin panel address

Routes are registered under `/admin`. A custom address (settings `admin_path`,
e.g. `/panel-7k2q`, from Настройки → Адрес панели) is mapped onto them by
Fastify `rewriteUrl` (server.ts `adminRewrite`); `/admin` then becomes an unknown
page. Hooks see the rewritten `/admin/…` URL, so auth still applies. The admin
HTML keeps absolute `/admin/…` links and is rewritten when served (`adminHtml`);
redirects and the session cookie path use `ADMIN_BASE`. `admin_link_public = 0`
hides the panel link on the public site (`/api/site` then returns null — the
address is not given away). Forgotten address: `docker compose logs web | grep
панель`, or delete `admin_path` from settings.

## Scripts for the user's machine (scripts.ts, src/scripts)

The chain script downloads `.cfu` files from downloads.v8.1c.ru with Basic auth
(the configurator's own way; partner packages need a subscription to that product,
401 otherwise), dumps the infobase to .dt, then per step `DESIGNER /UpdateCfg
<cfu> /UpdateDBCfg`, and finally `ENTERPRISE /C "ЗапуститьОбновлениеИнформационнойБазы;
ЗавершитьРаботуСистемы"`. Linux needs a display, so 1cv8 runs inside `xvfb-run`.
The platform script logs in to releases.1c.ru through login.1c.ru (CAS form,
`execution` token), takes `windows64full_<ver>.rar` / `server64_<ver>.zip|.tar.gz`
from `/version_files`, and the dl0N.1c.ru mirrors from `/version_file`; Windows
installs the MSI (`/qn`, 1049.mst), Linux runs `setup-full-*.run --mode unattended`
(8.3.20+ only) and links `srv1cv8-<ver>@.service`. The ITS account is asked for
at run time (or ITS_LOGIN / ITS_PASSWORD) and never goes into the script or to us;
curl gets it through `-K -` (stdin), not argv. PowerShell files are sent as UTF-8
with BOM + CRLF (Windows PowerShell 5.1 reads BOM-less files as ANSI). Portal login,
file lookup and `.cfu` download were run for real; the 1C batch apply and the
installers themselves were not (no 1C platform on the dev machine).

`tools/install-1c-platform.{ps1,sh}` — the same platform template generated with an empty
version: `-Version` / `--version` takes a build or a line (8.5, 8.3.24 → newest build from
`/api/platform`), without it the script asks. Regenerate after editing src/scripts.

## SQL inside sql`…` templates — escaping gotcha

The drizzle `sql` tag receives *cooked* template strings, so TS escapes are
applied before Postgres sees the text: `\.` in TS source reaches SQL as a
bare `.` ("any char" in a regex). In TS source write `\\.` to get `\.` in
SQL, and `'\\'` to get a single-backslash string `'\'`.

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
`docker compose up -d`). Two modes: (1) own Caddy on 80/443 — `docker-compose.yml`,
domain/HTTPS from the admin UI; (2) behind an existing reverse proxy (Nginx Proxy
Manager, nginx, Traefik) — `.env` gets `COMPOSE_FILE=docker-compose.proxy.yml`,
`PROXY_NETWORK`, `CADDY_API=off`; web joins the proxy's Docker network as
`updatecon:3000` and listens on 127.0.0.1:WEB_PORT; the admin UI shows «внешний
прокси» instead of the Caddy form. Optional nightly app update:
`/etc/cron.d/updatecon` (03:30) runs the newest update.sh with UPDATECON_DIR;
`AUTO_UPDATE=1` tells the admin UI. update.sh dumps the database first (backups/, 7 kept;
`UPDATECON_BACKUPS` for another folder), remembers the running image, waits up to 60 s for
/api/health and otherwise rolls back (compose files + the previous image tag) and exits 1;
`UPDATECON_FAIL_TEST=1` exercises the rollback. update.sh / manage.sh / uninstall.sh work in
both modes (docker compose reads COMPOSE_FILE from .env — never pass `-f`).
Worker reads the ITS account (admin UI or `.env`); without one it applies the
published snapshot. The production install (upd.send2me.ru) is a standard
proxy-mode install at /opt/updatecon behind Nginx Proxy Manager, updated with its
refresh.sh = git pull + update.sh (no nightly app update) — see the memory note.

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

- **Every change goes through a GitHub issue** (iMironRU/updatecon), even a two-minute
  fix: `bug` = исправления, `enhancement` = развитие. Reference it in the commit
  (`#N`), close it after the deploy with a note on what was verified.

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
