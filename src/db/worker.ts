/**
 * worker.ts — migration + scheduled import process.
 *
 * On start:
 *   1. Apply drizzle migrations (idempotent).
 *   2. If IMPORT_ON_START=1, run one import immediately.
 *   3. Schedule recurring imports via IMPORT_CRON.
 *
 * The import itself is the verified pipeline (fetch -> parse -> upsert with
 * two-level hash delta), so a scheduled run over an unchanged file is a
 * cheap no-op.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import cron from "node-cron";
import { db } from "./client.js";
import { runImport } from "./import-lst.js";
import { runReleasesImport } from "../releases/import-releases.js";
import { refreshTags } from "./tags.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log("[worker] applying migrations…");
  // Uses drizzle-orm's built-in migrator — no drizzle-kit CLI needed at runtime.
  await drizzleMigrate(db, {
    migrationsFolder: join(__dirname, "../../drizzle"),
  });
  console.log("[worker] migrations done.");
}

async function safeImport(reason: string) {
  console.log(`[worker] import start (${reason}) ${new Date().toISOString()}`);
  try {
    await runImport();
  } catch (e) {
    console.error("[worker] import error:", (e as Error).message);
  }
  // Enrich data from releases.1c.ru (categories, planned dates, file sizes)
  try {
    await runReleasesImport(undefined, undefined, { syncTotalPage: true, syncSizes: true, syncPatchesData: false });
  } catch (e) {
    console.error("[worker] releases import error:", (e as Error).message);
  }
}

async function main() {
  await migrate();

  // Product-line tags depend on code (the dictionary) as well as on data —
  // recompute on every start so a new release applies new rules at once.
  try {
    const t = await refreshTags();
    console.log(`[worker] tags: own=${t.own} based=${t.based} (by versions ${t.byVersions})`);
  } catch (e) {
    console.error("[worker] tags refresh failed:", (e as Error).message);
  }

  if (process.env.IMPORT_ON_START === "1") {
    await safeImport("on-start");
  }

  const expr = process.env.IMPORT_CRON ?? "0 4 * * *";
  if (!cron.validate(expr)) {
    console.error(`[worker] invalid IMPORT_CRON "${expr}", using "0 4 * * *"`);
  }
  const schedule = cron.validate(expr) ? expr : "0 4 * * *";
  cron.schedule(schedule, () => void safeImport("scheduled"));
  console.log(`[worker] scheduled imports: "${schedule}". Idle.`);
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
