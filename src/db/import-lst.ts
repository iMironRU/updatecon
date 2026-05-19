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
import { eq, and, desc, sql } from "drizzle-orm";
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

export async function runImport(argPath?: string) {
  // Source: explicit file arg / LST_FILE env -> file mode (dev/replay);
  // otherwise stream from ITS with Basic auth (production).
  const _argPath = argPath ?? process.argv[2];
  const startedAt = new Date();
  const fetched = await resolveLst(_argPath);
  const raw = fetched.text;
  const fileSha = sha256(raw);
  const fileBytes = fetched.bytes;
  console.log(`source: ${fetched.source} (${(fileBytes/1024/1024).toFixed(1)} MB)`);

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
    console.log(
      `SKIP: file identical to last successful import (sha ${fileSha.slice(0, 12)}…). Nothing to do.`,
    );
    await pool.end();
    return;
  }

  // ── Config id cache (name -> id), created on demand ───────────────────
  const cfgCache = new Map<string, number>();
  const existingCfgs = await db
    .select({ id: configurations.id, name: configurations.name })
    .from(configurations);
  for (const c of existingCfgs) cfgCache.set(c.name, c.id);

  async function configId(name: string, vendor: string): Promise<number> {
    const hit = cfgCache.get(name);
    if (hit !== undefined) return hit;
    const ins = await db
      .insert(configurations)
      .values({ name, vendor })
      .onConflictDoNothing({ target: configurations.name })
      .returning({ id: configurations.id });
    let id: number;
    if (ins.length > 0) {
      id = ins[0].id;
    } else {
      const row = await db
        .select({ id: configurations.id })
        .from(configurations)
        .where(eq(configurations.name, name))
        .limit(1);
      id = row[0].id;
    }
    cfgCache.set(name, id);
    return id;
  }

  let configsFound = 0;
  let edgesUpserted = 0;
  let edgesUnchanged = 0;
  const pending: Promise<void>[] = [];

  // Process one parsed record: fan out into from->to edges.
  function handleRecord(rec: UpdateRecord) {
    configsFound++;
    const p = (async () => {
      const cid = await configId(rec.name, rec.vendor);
      const toPv = parseVersion(rec.version);
      if (!toPv) return;
      const edition = toPv.segments[0] ?? 0;

      for (const from of rec.fromVersions) {
        const h = edgeHash(rec.name, from, rec.version, rec.cfuPath);
        const res = await db
          .insert(updateEdges)
          .values({
            configId: cid,
            fromVersion: from,
            toVersion: rec.version,
            edition,
            cfuPath: rec.cfuPath,
            contentHash: h,
            rawJson: rec,
            lastSeenAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              updateEdges.configId,
              updateEdges.fromVersion,
              updateEdges.toVersion,
            ],
            set: {
              lastSeenAt: new Date(),
              // Rewrite payload only when the content actually changed.
              cfuPath: sql`CASE WHEN ${updateEdges.contentHash} <> ${h}
                                THEN excluded.cfu_path ELSE ${updateEdges.cfuPath} END`,
              contentHash: sql`excluded.content_hash`,
              rawJson: sql`CASE WHEN ${updateEdges.contentHash} <> ${h}
                                THEN excluded.raw_json ELSE ${updateEdges.rawJson} END`,
            },
            setWhere: sql`true`,
          })
          .returning({
            inserted: sql<boolean>`(xmax = 0)`,
            hashNow: updateEdges.contentHash,
          });

        // Heuristic: a brand-new row, or hash differs from what we wrote.
        if (res.length > 0 && (res[0] as any).inserted) edgesUpserted++;
        else edgesUnchanged++;
      }
    })();
    pending.push(p);
  }

  const stats = parseLstStream(raw, handleRecord);
  await Promise.all(pending);

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

  console.log(
    `OK: configs=${stats.configsFound} packages=${stats.packagesEmitted} ` +
      `edges new/changed=${edgesUpserted} unchanged=${edgesUnchanged} ` +
      `(${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s)`,
  );
  await pool.end();
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runImport().catch(async (e) => {
    console.error("IMPORT FAILED:", e);
    try { await pool.end(); } catch {}
    process.exit(1);
  });
}
