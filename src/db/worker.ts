/**
 * worker.ts — migration + scheduled import process.
 *
 * On start:
 *   1. Apply drizzle migrations (idempotent).
 *   2. If IMPORT_ON_START=1, run one import immediately.
 *   3. Schedule recurring imports via IMPORT_CRON.
 *
 * The import is pipeline.ts (LST with its two-level hash delta, then
 * releases.1c.ru), so a scheduled run over an unchanged LST is cheap.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import cron from "node-cron";
import { db } from "./client.js";
import { runFullUpdate } from "./pipeline.js";
import { applyItsCredentials } from "./credentials.js";
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

// The same «Обновить всё» as the admin button: LST, then releases.1c.ru; the
// full log is stored in import_runs and readable in the admin UI.
async function safeImport(trigger: "scheduled" | "on-start") {
  console.log(`[worker] update start (${trigger}) ${new Date().toISOString()}`);
  try {
    // The ITS account may have been changed in the admin UI since the last run.
    const c = await applyItsCredentials();
    console.log(`[worker] ITS account: ${c.source === "none" ? "не задан" : c.source === "admin" ? "из админки" : "из .env"}`);
    const r = await runFullUpdate({ trigger });
    console.log(`[worker] update ${r.status}: ${r.summary}`);
  } catch (e) {
    console.error("[worker] update error:", (e as Error).message);
  }
}

async function main() {
  await migrate();

  // Product-line tags depend on code (the dictionary) as well as on data —
  // recompute on every start so a new release applies new rules at once.
  try {
    const t = await refreshTags();
    console.log(`[worker] tags: own=${t.own} based=${t.based} (solutions ${t.bySolutions}, versions ${t.byVersions})`);
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
