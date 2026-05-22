/**
 * import-lst.ts — stream a v8cscdsc.lst into Postgres.
 *
 * Pipeline:
 *   1. Read file, compute SHA-256.
 *   2. If the last successful run has the same SHA -> record a "skipped"
 *      run and exit. (File-level delta: zero work on unchanged file.)
 *   3. Otherwise stream-parse with the verified parser. Each record
 *      "to <- [from...]" fans out into one edge per from-version.
 *   4. Per edge: compute content_hash. Upsert by (config, from, to);
 *      bump last_seen_at always, rewrite payload only when hash changed.
 *      Count changed vs unchanged.
 *
 * Run:  DATABASE_URL=... tsx import-lst.ts /path/to/v8cscdsc.lst
 *
 * NOTE: the parser currently takes a full string (that's how the file is
 * fetched today). Swapping to a chunked Readable later is additive and does
 * not touch this orchestration.
 */

import { createHash } from "node:crypto";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db, pool } from "./client.js";
import { configurations, updateEdges, importRuns } from "./schema.js";
import { parseLstStream, type UpdateRecord } from "../parser/lst-parser-stream.js";
import { parseVersion } from "../parser/version.js";
import { resolveLst } from "./fetch-lst.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Hash of the semantically significant edge fields. */
function edgeHash(
  configName: string,
  from: string,
  to: string,
  cfu: string,
): string {
  return sha256(`${configName}\u0000${from}\u0000${to}\u0000${cfu}`);
}

export interface LstImportOptions {
  /** Log callback for admin UI; if absent, output goes to stdout */
  onLog?: (msg: string) => void;
}

export async function runImport(argPath?: string, opts: LstImportOptions = {}) {
  const log = (msg: string) => {
    if (opts.onLog) opts.onLog(msg); else console.log(msg);
  };

  // Source: explicit file arg / LST_FILE env -> file mode (dev/replay);
  // otherwise stream from ITS with Basic auth (production).
  const _argPath = argPath ?? process.argv[2];
  const startedAt = new Date();

  log("Загрузка файла...");
  const fetched = await resolveLst(_argPath);
  const raw = fetched.text;
  const fileSha = sha256(raw);
  const fileBytes = fetched.bytes;
  log(`Источник: ${fetched.source} (${(fileBytes / 1024 / 1024).toFixed(1)} МБ)`);
  log(`SHA-256: ${fileSha.slice(0, 16)}…`);

  // ── File-level delta ──────────────────────────────────────────────────
  const lastOk = await db
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.source, "lst"), eq(importRuns.status, "ok")))
    .orderBy(desc(importRuns.id))
    .limit(1);

  if (lastOk.length > 0 && lastOk[0].fileSha256 === fileSha) {
    await db.insert(importRuns).values({
      source: "lst",
      fileSha256: fileSha,
      fileBytes,
      status: "skipped",
      message: "identical file (sha match) — no-op",
      finishedAt: new Date(),
    });
    log(`Файл не изменился (sha совпадает) — импорт пропущен`);
    return;
  }

  // ── Step 1: parse all records (sync, fast) ───────────────────────────
  log("Парсинг LST...");
  const allRecords: UpdateRecord[] = [];
  const stats = parseLstStream(raw, (rec) => allRecords.push(rec));
  log(`Распарсено: ${stats.configsFound} конфигов, ${stats.packagesEmitted} пакетов`);

  // ── Step 2: resolve config IDs — bulk, 2 queries total ───────────────
  log("Загрузка конфигураций из БД...");
  const cfgCache = new Map<string, number>();
  const existingCfgs = await db
    .select({ id: configurations.id, name: configurations.name })
    .from(configurations);
  for (const c of existingCfgs) cfgCache.set(c.name, c.id);

  // Find new configs not yet in DB
  const newCfgMap = new Map<string, string>(); // name → vendor
  for (const rec of allRecords) {
    if (!cfgCache.has(rec.name)) newCfgMap.set(rec.name, rec.vendor);
  }
  if (newCfgMap.size > 0) {
    log(`Добавляем ${newCfgMap.size} новых конфигураций...`);
    const newCfgValues = [...newCfgMap.entries()].map(([name, vendor]) => ({ name, vendor }));
    // Bulk insert (idempotent)
    const CFGCHUNK = 500;
    for (let i = 0; i < newCfgValues.length; i += CFGCHUNK) {
      await db.insert(configurations)
        .values(newCfgValues.slice(i, i + CFGCHUNK))
        .onConflictDoNothing({ target: configurations.name });
    }
    // Fetch their IDs in one query
    const newNames = newCfgValues.map((c) => c.name);
    const newRows = await db
      .select({ id: configurations.id, name: configurations.name })
      .from(configurations)
      .where(inArray(configurations.name, newNames));
    for (const row of newRows) cfgCache.set(row.name, row.id);
  }
  log(`Конфигураций в кэше: ${cfgCache.size}`);

  // ── Step 3: build all edge rows in memory ─────────────────────────────
  interface EdgeRow {
    configId: number;
    fromVersion: string;
    toVersion: string;
    edition: number;
    cfuPath: string;
    contentHash: string;
    rawJson: UpdateRecord;
  }
  const allEdges: EdgeRow[] = [];
  for (const rec of allRecords) {
    const cid = cfgCache.get(rec.name);
    if (cid === undefined) continue;
    const toPv = parseVersion(rec.version);
    if (!toPv) continue;
    const edition = toPv.segments[0] ?? 0;
    for (const from of rec.fromVersions) {
      allEdges.push({
        configId: cid,
        fromVersion: from,
        toVersion: rec.version,
        edition,
        cfuPath: rec.cfuPath,
        contentHash: edgeHash(rec.name, from, rec.version, rec.cfuPath),
        rawJson: rec,
      });
    }
  }
  // Deduplicate: LST may contain multiple records with the same
  // (configId, fromVersion, toVersion) key. Bulk INSERT can't update
  // the same row twice in one statement — keep the last occurrence.
  const edgeMap = new Map<string, EdgeRow>();
  for (const e of allEdges) {
    edgeMap.set(`${e.configId}:${e.fromVersion}:${e.toVersion}`, e);
  }
  const dedupedEdges = [...edgeMap.values()];
  if (dedupedEdges.length < allEdges.length) {
    log(`Дедупликация: ${allEdges.length} → ${dedupedEdges.length} рёбер`);
  }

  // ── Step 4: bulk upsert edges — one INSERT per batch of 500 rows ──────
  // excluded.* refers to the proposed value for EACH row in the conflict set,
  // so the CASE WHEN logic is correct in bulk mode.
  let edgesUpserted = 0;
  let edgesUnchanged = 0;
  const BULK = 500;
  const totalEdges = dedupedEdges.length;
  log(`Запись в БД: 0 / ${totalEdges}...`);
  const now = new Date();
  for (let i = 0; i < totalEdges; i += BULK) {
    const batch = dedupedEdges.slice(i, i + BULK);
    const results = await db
      .insert(updateEdges)
      .values(batch.map((e) => ({
        configId:     e.configId,
        fromVersion:  e.fromVersion,
        toVersion:    e.toVersion,
        edition:      e.edition,
        cfuPath:      e.cfuPath,
        contentHash:  e.contentHash,
        rawJson:      e.rawJson,
        lastSeenAt:   now,
      })))
      .onConflictDoUpdate({
        target: [updateEdges.configId, updateEdges.fromVersion, updateEdges.toVersion],
        set: {
          lastSeenAt:  now,
          cfuPath:     sql`excluded.cfu_path`,
          contentHash: sql`excluded.content_hash`,
          rawJson:     sql`excluded.raw_json`,
        },
        // Only fire the UPDATE when content actually changed.
        // Unchanged rows skip the write entirely → much faster on re-imports.
        setWhere: sql`${updateEdges.contentHash} <> excluded.content_hash`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });

    for (const r of results) {
      if ((r as any).inserted) edgesUpserted++;
      else edgesUnchanged++;
    }
    const done = Math.min(i + BULK, totalEdges);
    log(`Запись в БД: ${done} / ${totalEdges} (${Math.round(done / totalEdges * 100)}%)`);
  }

  await db.insert(importRuns).values({
    source: "lst",
    fileSha256: fileSha,
    fileBytes,
    configsFound: stats.configsFound,
    edgesUpserted,
    edgesUnchanged,
    status: "ok",
    message: `parsed ${stats.packagesEmitted} packages -> edges ${edgesUpserted} new/changed, ${edgesUnchanged} unchanged`,
    startedAt,
    finishedAt: new Date(),
  });

  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  log(
    `Готово: конфигов=${stats.configsFound}, пакетов=${stats.packagesEmitted}, ` +
    `новых/изменённых рёбер=${edgesUpserted}, без изменений=${edgesUnchanged} (${elapsed}с)`,
  );
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runImport().then(() => pool.end()).catch(async (e) => {
    console.error("IMPORT FAILED:", e);
    try { await pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
}
