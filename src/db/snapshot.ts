/**
 * snapshot.ts — the database as a file, so installations without an ITS
 * account (or a brand-new one) can take fresh data from GitHub.
 *
 * Publisher (scripts/snapshot.sh): «Обновить всё» on a local database, then
 * createSnapshot() → snapshot.ndjson.gz + snapshot.json, uploaded to the
 * `data` release of the repository (one file, overwritten — git history
 * does not grow).
 *
 * Installation: syncSnapshot() reads snapshot.json, and when it is new and
 * fits the schema, downloads the file and replaces the data tables in ONE
 * transaction. DELETE, not TRUNCATE: the site keeps serving the old data
 * until COMMIT instead of waiting on a lock. Never touched: settings
 * (passwords, ITS account), import history. Kept across: manual project
 * links and manual tags (re-applied by template + edition, which are stable;
 * ids come from the snapshot).
 *
 * File format (gzip, one JSON per line, rows made and read by Postgres
 * itself — row_to_json / json_populate_recordset — so types round-trip):
 *   {"format":1, …}                 header
 *   {"table":"configurations","columns":[…],"rows":N}
 *   {…row…}
 *   …
 */

import { createGzip, createGunzip } from "node:zlib";
import { createReadStream, createWriteStream, readFileSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "./client.js";
import { importRuns, settings } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_URL = (process.env.SNAPSHOT_URL ?? "https://github.com/iMironRU/updatecon/releases/download/data/").replace(/\/?$/, "/");
const FILE = "snapshot.ndjson.gz", META = "snapshot.json";

// Parents first (insert order); deleted in reverse.
const TABLES: { name: string; order: string }[] = [
  { name: "configurations", order: "id" },
  { name: "release_projects", order: "nick" },
  { name: "update_edges", order: "id" },
  { name: "version_meta", order: "id" },
  { name: "patches", order: "id" },
  { name: "template_tags", order: "template_key, tag" },
  { name: "package_manifests", order: "dir" },
  { name: "solutions_info", order: "url" },
  { name: "transitions", order: "id" },
  { name: "platform_builds", order: "version" },
];
const SERIAL = ["configurations", "update_edges", "version_meta", "patches", "transitions"];

export interface SnapshotMeta {
  format: 1;
  created_at: string;
  commit: string | null;               // app version that made it
  migrations: number;                  // schema version: drizzle journal entries
  migration: string;
  tables: Record<string, number>;
  last_update: string | null;          // newest «Обновить всё» / LST import in it
  sha256: string;
  bytes: number;
}

function journal(): { count: number; last: string } {
  const j = JSON.parse(readFileSync(join(__dirname, "../../drizzle/meta/_journal.json"), "utf8"));
  return { count: j.entries.length, last: j.entries[j.entries.length - 1]?.tag ?? "" };
}
const rowsOf = <T>(r: unknown): T[] => ((r as any).rows ?? r) as T[];

// ── Publisher ──────────────────────────────────────────────────────────────

export async function createSnapshot(outDir: string, opts: { commit?: string; log?: (m: string) => void } = {}): Promise<SnapshotMeta> {
  const log = opts.log ?? console.log;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, FILE);
  const gz = createGzip({ level: 9 });
  const out = createWriteStream(file);
  const done = pipeline(gz, out);
  const write = (line: string) => new Promise<void>((res) => (gz.write(line + "\n") ? res() : gz.once("drain", () => res())));

  const j = journal();
  const tables: Record<string, number> = {};
  await write(JSON.stringify({ format: 1, created_at: new Date().toISOString(), migrations: j.count }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");   // one consistent picture
    for (const t of TABLES) {
      const cols = (await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [t.name],
      )).rows.map((r) => r.column_name as string);
      const n = Number((await client.query(`SELECT count(*) AS n FROM ${t.name}`)).rows[0].n);
      await write(JSON.stringify({ table: t.name, columns: cols, rows: n }));
      await client.query(`DECLARE snap NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM ${t.name} t ORDER BY ${t.order}`);
      for (;;) {
        const r = await client.query("FETCH 5000 FROM snap");
        if (!r.rows.length) break;
        for (const row of r.rows) await write(row.j);
      }
      await client.query("CLOSE snap");
      tables[t.name] = n;
      log(`  ${t.name}: ${n.toLocaleString("ru-RU")}`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  gz.end();
  await done;

  const last = rowsOf<{ t: string | null }>(await db.execute(sql`
    SELECT max(finished_at)::text AS t FROM import_runs WHERE status IN ('ok', 'partial') AND source IN ('all', 'lst', 'releases')`))[0]?.t ?? null;
  const meta: SnapshotMeta = {
    format: 1, created_at: new Date().toISOString(), commit: opts.commit ?? null,
    migrations: j.count, migration: j.last, tables, last_update: last,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), bytes: statSync(file).size,
  };
  writeFileSync(join(outDir, META), JSON.stringify(meta, null, 2));
  return meta;
}

// ── Installation ───────────────────────────────────────────────────────────

export async function remoteMeta(): Promise<SnapshotMeta | null> {
  if (/^off\/?$/i.test(SNAPSHOT_URL)) return null;
  const r = await fetch(SNAPSHOT_URL + META, { signal: AbortSignal.timeout(30_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${META}: HTTP ${r.status}`);
  return (await r.json()) as SnapshotMeta;
}

export async function appliedSnapshot(): Promise<{ sha256: string; created_at: string; applied_at: string } | null> {
  const [row] = await db.select().from(settings).where(sql`key = 'snapshot_applied'`);
  try { return row?.value ? JSON.parse(row.value) : null; } catch { return null; }
}

async function download(meta: SnapshotMeta, log: (m: string) => void, signal?: AbortSignal): Promise<string> {
  const path = join(tmpdir(), `updatecon-${meta.sha256.slice(0, 12)}.ndjson.gz`);
  log(`Скачиваем снимок: ${(meta.bytes / 1024 / 1024).toFixed(1)} МБ…`);
  const r = await fetch(SNAPSHOT_URL + FILE, { signal: signal ?? AbortSignal.timeout(10 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`${FILE}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(path));
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (sha !== meta.sha256) {
    unlinkSync(path);
    throw new Error("контрольная сумма не совпала — снимок, вероятно, как раз перезаливается; попробуйте позже");
  }
  return path;
}

async function apply(path: string, meta: SnapshotMeta, log: (m: string) => void, onProgress?: (c: number, t: number) => void) {
  const total = Object.values(meta.tables).reduce((s, n) => s + n, 0);
  const client = await pool.connect();
  let done = 0;
  try {
    await client.query("BEGIN");
    // Local choices that must survive: manual links (by stable template + edition) and manual tags.
    const links = (await client.query(`
      SELECT p.nick, c.template_key, c.edition FROM release_projects p
      LEFT JOIN configurations c ON c.id = p.config_id WHERE p.match_method = 'manual'`)).rows;
    const tags = (await client.query(`SELECT template_key, tag, kind, source FROM template_tags WHERE source = 'manual'`)).rows;

    for (const t of [...TABLES].reverse()) await client.query(`DELETE FROM ${t.name}`);

    const own = new Map<string, Set<string>>();
    for (const t of TABLES) {
      own.set(t.name, new Set((await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [t.name],
      )).rows.map((r) => r.column_name as string)));
    }

    let table = "", cols: string[] = [], batch: string[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const list = cols.map((c) => `"${c}"`).join(", ");
      await client.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(null::${table}, $1::json)`,
        ["[" + batch.join(",") + "]"]);
      done += batch.length;
      batch = [];
      onProgress?.(done, total);
    };
    const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
    let first = true;
    for await (const line of lines) {
      if (!line) continue;
      if (first) { first = false; continue; }                     // header
      if (line.startsWith('{"table":')) {
        await flush();
        const h = JSON.parse(line) as { table: string; columns: string[]; rows: number };
        if (!TABLES.some((t) => t.name === h.table)) throw new Error(`неизвестная таблица в снимке: ${h.table}`);
        table = h.table;
        cols = h.columns.filter((c) => own.get(table)!.has(c));   // a newer local schema: extra columns take defaults
        log(`  ${table}: ${h.rows.toLocaleString("ru-RU")}`);
        continue;
      }
      batch.push(line);
      if (batch.length >= 1000) await flush();
    }
    await flush();

    for (const t of SERIAL) await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT max(id) FROM ${t}), 1))`);

    // Re-apply local choices on the new ids.
    let relinked = 0;
    for (const l of links) {
      // A project the snapshot does not have any more simply has nothing to re-link.
      const r = await client.query(`
        UPDATE release_projects SET match_method = 'manual',
          config_id = (SELECT id FROM configurations WHERE template_key = $2 AND edition = $3)
        WHERE nick = $1`, [l.nick, l.template_key, l.edition]);
      relinked += r.rowCount ?? 0;
    }
    for (const t of tags) {
      await client.query(`INSERT INTO template_tags (template_key, tag, kind, source) VALUES ($1, $2, $3, $4)
        ON CONFLICT (template_key, tag) DO UPDATE SET kind = excluded.kind, source = excluded.source`, [t.template_key, t.tag, t.kind, t.source]);
    }
    if (links.length || tags.length) log(`  сохранены ручные привязки: ${relinked}, ручные теги: ${tags.length}`);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface SyncResult { status: "applied" | "up-to-date" | "unavailable" | "incompatible"; meta?: SnapshotMeta; message: string }

/**
 * Take the published snapshot when it differs from the one applied here
 * (force: even if it is the same). Records an import_runs row (source
 * 'snapshot') so caches and «последнее обновление» follow.
 */
export async function syncSnapshot(opts: { force?: boolean; onLog?: (m: string) => void; onProgress?: (c: number, t: number) => void; signal?: AbortSignal } = {}): Promise<SyncResult> {
  const log = opts.onLog ?? ((m: string) => console.log(`[snapshot] ${m}`));
  const started = new Date();
  let meta: SnapshotMeta | null;
  try { meta = await remoteMeta(); }
  catch (e) { log(`Снимок недоступен: ${(e as Error).message}`); return { status: "unavailable", message: (e as Error).message }; }
  if (!meta) { log("Снимок базы не опубликован"); return { status: "unavailable", message: "не опубликован" }; }

  const date = new Date(meta.created_at).toLocaleString("ru-RU");
  log(`Снимок от ${date}: ${meta.tables.configurations?.toLocaleString("ru-RU")} редакций, ${meta.tables.update_edges?.toLocaleString("ru-RU")} рёбер`);
  const applied = await appliedSnapshot();
  if (!opts.force && applied?.sha256 === meta.sha256) { log("Этот снимок уже применён"); return { status: "up-to-date", meta, message: "уже применён" }; }
  const mine = journal();
  if (mine.count < meta.migrations) {
    const msg = `снимок сделан на более новой версии (миграция ${meta.migration}) — сначала обновите приложение`;
    log(`⚠ ${msg}`);
    return { status: "incompatible", meta, message: msg };
  }

  const path = await download(meta, log, opts.signal);
  try {
    log("Заменяем данные (одной транзакцией — сайт работает со старыми до конца)…");
    await apply(path, meta, log, opts.onProgress);
  } finally {
    try { unlinkSync(path); } catch { /* gone */ }
  }
  const value = JSON.stringify({ sha256: meta.sha256, created_at: meta.created_at, applied_at: new Date().toISOString() });
  await db.insert(settings).values({ key: "snapshot_applied", value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  await db.insert(importRuns).values({
    source: "snapshot", fileSha256: meta.sha256, fileBytes: meta.bytes,
    configsFound: meta.tables.configurations ?? 0, edgesUpserted: meta.tables.update_edges ?? 0, edgesUnchanged: 0,
    status: "ok", message: `снимок от ${date}${meta.commit ? ` (${meta.commit})` : ""}`, startedAt: started, finishedAt: new Date(),
  });
  log(`✓ Снимок от ${date} применён`);
  return { status: "applied", meta, message: `снимок от ${date}` };
}

// ── CLI: node dist/db/snapshot.js create <dir> [--commit abc123] ──────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, dir] = process.argv.slice(2);
  const commit = process.argv.includes("--commit") ? process.argv[process.argv.indexOf("--commit") + 1] : undefined;
  (async () => {
    if (cmd === "create" && dir) {
      console.log("Выгружаем таблицы…");
      const m = await createSnapshot(dir, { commit });
      console.log(`Готово: ${join(dir, FILE)} — ${(m.bytes / 1024 / 1024).toFixed(1)} МБ, sha256 ${m.sha256.slice(0, 16)}…`);
    } else if (cmd === "check" && dir) {
      // Before publishing: a snapshot that lost a noticeable share of rows
      // against the published one is a broken import, not news — refuse it.
      const mine = JSON.parse(readFileSync(join(dir, META), "utf8")) as SnapshotMeta;
      const prev = await remoteMeta().catch(() => null);
      if (!prev) { console.log("no published snapshot yet — nothing to compare"); return; }
      const bad = ["configurations", "update_edges", "version_meta", "release_projects", "platform_builds"]
        .filter((t) => (prev.tables[t] ?? 0) > 0 && (mine.tables[t] ?? 0) < prev.tables[t] * 0.95)
        .map((t) => `${t}: ${prev.tables[t]} → ${mine.tables[t] ?? 0}`);
      if (mine.migrations < prev.migrations) bad.push(`schema older than the published one (${mine.migrations} < ${prev.migrations})`);
      if (bad.length) { console.error("refusing to publish:\n  " + bad.join("\n  ")); process.exitCode = 1; return; }
      console.log("ok against the published snapshot: " + Object.entries(mine.tables).map(([t, n]) => `${t} ${n}`).join(", "));
    } else if (cmd === "apply") {
      const r = await syncSnapshot({ force: process.argv.includes("--force") });
      console.log(r.status, r.message);
    } else {
      console.log("usage: snapshot.js create <dir> [--commit <sha>] | check <dir> | apply [--force]");
      process.exitCode = 2;
    }
  })().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
}
