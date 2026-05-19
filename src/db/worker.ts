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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import cron from "node-cron";
import { runImport } from "./import-lst.js";

const pexec = promisify(execFile);

async function migrate() {
  console.log("[worker] applying migrations…");
  // drizzle-kit migrate reads drizzle.config.ts + ./drizzle folder.
  await pexec("npx", ["drizzle-kit", "migrate"], {
    env: process.env,
  }).then(
    ({ stdout }) => stdout && console.log(stdout.trim()),
    (e) => {
      console.error("[worker] migration failed:", e.stderr || e.message);
      throw e;
    },
  );
  console.log("[worker] migrations done.");
}

async function safeImport(reason: string) {
  console.log(`[worker] import start (${reason}) ${new Date().toISOString()}`);
  try {
    await runImport();
  } catch (e) {
    console.error("[worker] import error:", (e as Error).message);
  }
}

async function main() {
  await migrate();

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
