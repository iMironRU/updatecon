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
import { parseVersion, compareVersions } from "../parser/version.js";
import { templateCodeFor } from "./template.js";
import { refreshTags } from "./tags.js";
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

  // ── Step 2: resolve application editions — (template folder, edition) ──
  // Identity is the template folder of the package + first version segment,
  // NOT the metadata name (see template.ts). Name/vendor follow the latest
  // record of each group.
  interface Group {
    key: string;          // `${templateKey}#${edition}`
    templateCode: string;
    templateKey: string;
    edition: number;
    name: string;
    vendor: string;
    latest: string;       // highest to-version seen, drives name/vendor
  }
  const groupOf = (rec: UpdateRecord): Group | null => {
    const pv = parseVersion(rec.version);
    if (!pv) return null;
    const templateCode = templateCodeFor(rec.cfuPath, rec.name);
    const templateKey = templateCode.toLowerCase();
    const edition = pv.segments[0] ?? 0;
    return { key: `${templateKey}#${edition}`, templateCode, templateKey, edition,
             name: rec.name, vendor: rec.vendor, latest: rec.version };
  };
  const groups = new Map<string, Group>();
  for (const rec of allRecords) {
    if (rec.fromVersions.length === 0) continue; // no edges → no application
    const g = groupOf(rec);
    if (!g) continue;
    const prev = groups.get(g.key);
    if (!prev || compareVersions(g.latest, prev.latest) > 0) groups.set(g.key, g);
  }

  log("Загрузка приложений из БД...");
  const cfgCache = new Map<string, number>(); // group key → configurations.id
  const existingCfgs = await db
    .select({
      id: configurations.id, name: configurations.name, vendor: configurations.vendor,
      templateKey: configurations.templateKey, edition: configurations.edition,
    })
    .from(configurations);
  const renamed: { id: number; name: string; vendor: string }[] = [];
  for (const c of existingCfgs) {
    if (c.templateKey === null || c.edition === null) continue;
    const key = `${c.templateKey}#${c.edition}`;
    cfgCache.set(key, c.id);
    const g = groups.get(key);
    if (g && (g.name !== c.name || g.vendor !== c.vendor)) {
      renamed.push({ id: c.id, name: g.name, vendor: g.vendor });
    }
  }

  const newGroups = [...groups.values()].filter((g) => !cfgCache.has(g.key));
  if (newGroups.length > 0) {
    log(`Добавляем ${newGroups.length} новых приложений (шаблон + редакция)...`);
    const CFGCHUNK = 500;
    for (let i = 0; i < newGroups.length; i += CFGCHUNK) {
      await db.insert(configurations)
        .values(newGroups.slice(i, i + CFGCHUNK).map((g) => ({
          name: g.name, vendor: g.vendor,
          templateCode: g.templateCode, templateKey: g.templateKey, edition: g.edition,
        })))
        .onConflictDoNothing({ target: [configurations.templateKey, configurations.edition] });
    }
    const newRows = await db
      .select({ id: configurations.id, templateKey: configurations.templateKey, edition: configurations.edition })
      .from(configurations)
      .where(inArray(configurations.templateKey, [...new Set(newGroups.map((g) => g.templateKey))]));
    for (const row of newRows) cfgCache.set(`${row.templateKey}#${row.edition}`, row.id);
  }
  for (const r of renamed) {
    await db.update(configurations)
      .set({ name: r.name, vendor: r.vendor })
      .where(eq(configurations.id, r.id));
  }
  if (renamed.length > 0) log(`Обновлены имя/вендор у ${renamed.length} приложений`);
  log(`Приложений (шаблон + редакция): ${groups.size}`);

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
    const g = groupOf(rec);
    if (!g) continue;
    const cid = cfgCache.get(g.key);
    if (cid === undefined) continue;
    const edition = g.edition;
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
  // We always fire the UPDATE on conflict (setWhere: true) and use CASE WHEN
  // to avoid rewriting payload when hash hasn't changed.
  // last_seen_at is always bumped so every run marks all visible edges.
  let edgesUpserted = 0;
  let edgesUnchanged = 0;
  const BULK = 500;
  const totalEdges = dedupedEdges.length;
  log(`Запись в БД: 0 / ${totalEdges}...`);
  const now = new Date();
  for (let i = 0; i < totalEdges; i += BULK) {
    const batch = dedupedEdges.slice(i, i + BULK);
    let results: { inserted: boolean }[];
    try {
      results = await db
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
            lastSeenAt:   now,
            cfuPath:      sql`excluded.cfu_path`,
            contentHash:  sql`excluded.content_hash`,
            rawJson:      sql`excluded.raw_json`,
          },
          setWhere: sql`true`,
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
    } catch (batchErr) {
      const msg = (batchErr as Error).message ?? String(batchErr);
      log(`✗ Ошибка на батче ${i}–${i + batch.length}: ${msg}`);
      throw batchErr;
    }

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

  // New templates / renames may change product-line tags.
  const tagStats = await refreshTags();
  log(`Теги линеек: своих=${tagStats.own}, «на базе»=${tagStats.based} (по версиям ${tagStats.byVersions})`);

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
