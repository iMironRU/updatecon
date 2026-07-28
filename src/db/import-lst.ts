/**
 * import-lst.ts — stream a v8cscdsc.lst into Postgres.
 *
 * Pipeline:
 *   1. Read file, compute SHA-256.
 *   2. If the last successful run has the same SHA -> record a "skipped"
 *      run and exit. (File-level delta: zero work on unchanged file.)
 *   3. Otherwise stream-parse with the verified parser. Each record
 *      "to <- [from...]" fans out into one edge per from-version.
 *   4. Per edge: compute content_hash and compare it with the current DB
 *      snapshot. Only new/changed rows are upserted; unchanged rows never
 *      enter the write path. Writes are batched in one transaction.
 *
 * Run:  DATABASE_URL=... tsx import-lst.ts
 *
 * NOTE: the parser currently takes a full string (that's how the file is
 * fetched today). Swapping to a chunked Readable later is additive and does
 * not touch this orchestration.
 */

import { createHash } from "node:crypto";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db, pool } from "./client.js";
import { configurations, updateEdges, importRuns, settings } from "./schema.js";
import { parseLstStream, type UpdateRecord } from "../parser/lst-parser-stream.js";
import { parseVersion } from "../parser/version.js";
import { getLstFromIts } from "./fetch-lst.js";
import {
  enabledAccountCredentials,
  ensureLegacyAccount,
  markAccountError,
  markAccountSuccess,
} from "../accounts/service.js";

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

function edgeKey(configId: number, from: string, to: string): string {
  return `${configId}:${from}:${to}`;
}

export interface LstImportOptions {
  /** Log callback for admin UI; if absent, output goes to stdout */
  onLog?: (msg: string, detail?: "brief" | "normal" | "detailed") => void;
  accountId?: number | null;
  accountLabel?: string;
  login?: string;
  password?: string;
  signal?: AbortSignal;
}

export async function runImport(opts: LstImportOptions = {}) {
  const log = (msg: string, detail: "brief" | "normal" | "detailed" = "normal") => {
    if (opts.onLog) opts.onLog(msg, detail); else console.log(msg);
  };

  const startedAt = new Date();

  log("Загрузка актуального v8cscdsc.lst с downloads.v8.1c.ru...");
  const fetched = await getLstFromIts(opts.login, opts.password);
  const raw = fetched.text;
  const fileSha = sha256(raw);
  const fileBytes = fetched.bytes;
  log(`Источник: ${fetched.source} (${(fileBytes / 1024 / 1024).toFixed(1)} МБ)`, "detailed");
  log(`SHA-256: ${fileSha.slice(0, 16)}…`, "detailed");

  // ── File-level delta ──────────────────────────────────────────────────
  const sameSuccessfulFile = await db
    .select()
    .from(importRuns)
    .where(and(
      eq(importRuns.source, "lst"),
      eq(importRuns.status, "ok"),
      eq(importRuns.fileSha256, fileSha),
    ))
    .orderBy(desc(importRuns.id))
    .limit(1);

  const [lstPolicy] = await db.select({ updatedAt: settings.updatedAt })
    .from(settings).where(eq(settings.key, "lst_policy_revision")).limit(1);
  const policyChanged = Boolean(
    lstPolicy?.updatedAt
    && (!sameSuccessfulFile[0]?.finishedAt
      || lstPolicy.updatedAt > sameSuccessfulFile[0].finishedAt),
  );

  if (sameSuccessfulFile.length > 0 && !policyChanged) {
    await db.insert(importRuns).values({
      accountId: opts.accountId ?? null,
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
  log("Парсинг LST...", "detailed");
  const allRecords: UpdateRecord[] = [];
  const stats = parseLstStream(raw, (rec) => allRecords.push(rec));
  const distinctConfigCount = new Set(allRecords.map((record) => record.name)).size;
  log(`Распарсено: ${distinctConfigCount} конфигураций, ${stats.packagesEmitted} пакетов`);

  // ── Step 2: resolve config IDs — bulk, 2 queries total ───────────────
  log("Загрузка конфигураций из БД...", "detailed");
  const cfgCache = new Map<string, number>();
  const existingCfgs = await db
    .select({
      id: configurations.id,
      name: configurations.name,
      excludeFromUpdates: configurations.excludeFromUpdates,
    })
    .from(configurations);
  for (const c of existingCfgs) cfgCache.set(c.name, c.id);
  const excludedNames = new Set(
    existingCfgs.filter((config) => config.excludeFromUpdates).map((config) => config.name),
  );
  if (excludedNames.size) {
    log(`Исключено из обновления администратором: ${excludedNames.size} конфигураций`);
  }

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
  log(`Конфигураций в кэше: ${cfgCache.size}`, "detailed");

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
  // Build the deduplicated map immediately. Previously we first retained a
  // second 200k+ element array and then copied it into a Map.
  const edgeMap = new Map<string, EdgeRow>();
  let expandedEdgeCount = 0;
  for (const rec of allRecords) {
    if (excludedNames.has(rec.name)) continue;
    const cid = cfgCache.get(rec.name);
    if (cid === undefined) continue;
    const toPv = parseVersion(rec.version);
    if (!toPv) continue;
    const edition = toPv.segments[0] ?? 0;
    for (const from of rec.fromVersions) {
      const edge: EdgeRow = {
        configId: cid,
        fromVersion: from,
        toVersion: rec.version,
        edition,
        cfuPath: rec.cfuPath,
        contentHash: edgeHash(rec.name, from, rec.version, rec.cfuPath),
        rawJson: rec,
      };
      expandedEdgeCount++;
      // Keep the last occurrence, matching the previous deduplication logic.
      edgeMap.set(edgeKey(edge.configId, edge.fromVersion, edge.toVersion), edge);
    }
  }
  // Deduplicate: LST may contain multiple records with the same
  // (configId, fromVersion, toVersion) key. Bulk INSERT can't update
  // the same row twice in one statement — keep the last occurrence.
  const dedupedEdges = [...edgeMap.values()];
  if (dedupedEdges.length < expandedEdgeCount) {
    log(`Дедупликация: ${expandedEdgeCount} → ${dedupedEdges.length} рёбер`, "detailed");
  }

  // ── Step 4: compare hashes, then atomically upsert only the delta ──────
  // PostgreSQL used to perform a unique-index conflict check for every edge
  // even when only a handful changed. A single read snapshot makes the usual
  // small-delta import almost write-free while preserving all stored fields.
  log(`Сравнение ${dedupedEdges.length} рёбер с БД...`, "detailed");
  const incomingConfigIds = [...new Set(dedupedEdges.map((edge) => edge.configId))];
  const existingRows = incomingConfigIds.length
    ? await db.select({
        configId: updateEdges.configId,
        fromVersion: updateEdges.fromVersion,
        toVersion: updateEdges.toVersion,
        contentHash: updateEdges.contentHash,
      }).from(updateEdges).where(inArray(updateEdges.configId, incomingConfigIds))
    : [];
  const existingHashes = new Map(
    existingRows.map((edge) => [
      edgeKey(edge.configId, edge.fromVersion, edge.toVersion),
      edge.contentHash,
    ]),
  );
  const changedEdges = dedupedEdges.filter((edge) =>
    existingHashes.get(edgeKey(edge.configId, edge.fromVersion, edge.toVersion)) !== edge.contentHash,
  );

  let edgesUpserted = 0;
  let edgesUnchanged = dedupedEdges.length - changedEdges.length;
  const BULK = 2000;
  log(
    `Изменений для записи: ${changedEdges.length}; без изменений: ${edgesUnchanged}`,
    "detailed",
  );
  const now = new Date();
  if (changedEdges.length) {
    log(`Запись в БД: 0 / ${changedEdges.length}...`, "detailed");
    await db.transaction(async (tx) => {
      for (let i = 0; i < changedEdges.length; i += BULK) {
        if (opts.signal?.aborted) {
          const error = new Error("Обновление прервано пользователем");
          error.name = "AbortError";
          throw error;
        }
        const batch = changedEdges.slice(i, i + BULK);
        let results: { inserted: boolean }[];
        try {
          results = await tx
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
                edition:      sql`excluded.edition`,
                cfuPath:      sql`excluded.cfu_path`,
                contentHash:  sql`excluded.content_hash`,
                rawJson:      sql`excluded.raw_json`,
              },
              setWhere: sql`${updateEdges.contentHash} <> excluded.content_hash`,
            })
            .returning({ inserted: sql<boolean>`(xmax = 0)` });
        } catch (batchErr) {
          const msg = (batchErr as Error).message ?? String(batchErr);
          log(`✗ Ошибка на батче ${i}–${i + batch.length}: ${msg}`);
          throw batchErr;
        }

        edgesUpserted += results.length;
        edgesUnchanged += batch.length - results.length;
        const done = Math.min(i + BULK, changedEdges.length);
        log(
          `Запись в БД: ${done} / ${changedEdges.length} ` +
          `(${Math.round(done / changedEdges.length * 100)}%)`,
          "detailed",
        );
      }
    });
  }

  await db.insert(importRuns).values({
    accountId: opts.accountId ?? null,
    source: "lst",
    fileSha256: fileSha,
    fileBytes,
    configsFound: distinctConfigCount,
    edgesUpserted,
    edgesUnchanged,
    status: "ok",
    message: `parsed ${stats.packagesEmitted} packages -> edges ${edgesUpserted} new/changed, ${edgesUnchanged} unchanged`,
    startedAt,
    finishedAt: new Date(),
  });

  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  log(
    `Готово: конфигураций=${distinctConfigCount}, пакетов=${stats.packagesEmitted}, ` +
    `новых/изменённых рёбер=${edgesUpserted}, без изменений=${edgesUnchanged} (${elapsed}с)`,
  );
}

/** Fetch and merge v8cscdsc.lst from every enabled ITS account. */
async function runAllLstImportsUnlocked(
  opts: Pick<LstImportOptions, "onLog" | "signal"> = {},
): Promise<{ succeeded: number; failed: number }> {
  await ensureLegacyAccount();
  const accounts = await enabledAccountCredentials();
  if (!accounts.length) throw new Error("Нет включённых учётных записей ИТС");
  let succeeded = 0;
  let failed = 0;
  for (const account of accounts) {
    const accountLog = (message: string, detail?: "brief" | "normal" | "detailed") =>
      opts.onLog?.(`[${account.label}] ${message}`, detail);
    try {
      await runImport({
        ...opts,
        onLog: opts.onLog ? accountLog : undefined,
        accountId: account.id,
        accountLabel: account.label,
        login: account.login,
        password: account.password,
      });
      await markAccountSuccess(account.id);
      succeeded++;
    } catch (error) {
      const aborted = opts.signal?.aborted || (error as Error).name === "AbortError";
      await db.insert(importRuns).values({
        accountId: account.id,
        source: "lst",
        fileSha256: "",
        status: aborted ? "cancelled" : "error",
        message: ((error as Error).message ?? String(error)).slice(0, 2000),
        finishedAt: new Date(),
      });

      // Отмена общей задачи ничего не говорит о состоянии учётной записи ИТС.
      // Не портим её статистику и не продолжаем обход остальных аккаунтов.
      if (aborted) throw error;

      await markAccountError(account.id, error);
      failed++;
      opts.onLog?.(`[${account.label}] ошибка LST: ${(error as Error).message}`);
    }
  }
  if (!succeeded) throw new Error("Импорт LST не выполнен ни для одной учётной записи");
  return { succeeded, failed };
}

/** Prevent the web process and scheduled worker from importing LST together. */
export async function runAllLstImports(
  opts: Pick<LstImportOptions, "onLog" | "signal"> = {},
): Promise<{ succeeded: number; failed: number }> {
  const client = await pool.connect();
  const lockKey = 801001;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [lockKey],
    );
    if (!result.rows[0]?.locked) {
      throw new Error("Импорт LST уже выполняется другим процессом");
    }
    return await runAllLstImportsUnlocked(opts);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [lockKey]); } catch { /* connection lost */ }
    client.release();
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAllLstImports().then(() => pool.end()).catch(async (e) => {
    console.error("IMPORT FAILED:", e);
    try { await pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
}
