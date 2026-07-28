/**
 * worker.ts — migration + scheduled import process.
 *
 * Database migrations are applied by the one-shot `migrate` compose service.
 * On start the worker optionally imports immediately and schedules repeats.
 *
 * The import itself is the verified pipeline (fetch -> parse -> upsert with
 * two-level hash delta), so a scheduled run over an unchanged file is a
 * cheap no-op.
 */

import cron from "node-cron";
import { ensureLegacyAccount } from "../accounts/service.js";
import {
  claimNextUpdateJob,
  createUpdateJob,
  executeUpdateJob,
  pruneUpdateHistory,
  recoverInterruptedUpdateJobs,
  UpdateJobAlreadyActiveError,
  type UpdateMode,
} from "./update-data.js";
import { countDueReleaseRetries } from "../releases/import-releases.js";
import { db, rows } from "./client.js";
import { settings, updateJobEvents, updateJobs } from "./schema.js";
import { eq, sql } from "drizzle-orm";

let workerBusy = false;

async function maintenanceActive(): Promise<boolean> {
  const [maintenance] = await db.select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "database_maintenance"))
    .limit(1);
  return maintenance?.value === "restore";
}

async function processUpdateQueue() {
  if (workerBusy || await maintenanceActive()) return;
  workerBusy = true;
  try {
    while (!await maintenanceActive()) {
      const job = await claimNextUpdateJob();
      if (!job) break;
      console.log(`[worker] job #${job.id} start (${job.request.mode}) ${new Date().toISOString()}`);
      try {
        const result = await executeUpdateJob(job.id, {
          onEvent: ({ stage, message }) => console.log(`[worker/${stage}] ${message}`),
        }, job.request.targets, job.request.mode, job.request.forceAllResources === true);
        if (result.status === "error") console.error(`[worker] job #${job.id} error:`, result.message);
        else console.log(`[worker] job #${job.id} ${result.status}: ${result.message}`);
      } catch (error) {
        const message = ((error as Error).message || String(error)).slice(0, 2000);
        console.error(`[worker] job #${job.id} crashed:`, error);
        await db.transaction(async (tx) => {
          await tx.update(updateJobs).set({
            status: "error",
            stage: "done",
            message,
            activeWorkers: 0,
            finishedAt: new Date(),
          }).where(eq(updateJobs.id, job.id));
          await tx.insert(updateJobEvents).values({
            jobId: job.id,
            stage: "system",
            level: "error",
            message: `Worker аварийно завершил задачу: ${message}`,
          });
        });
      }
    }
  } finally {
    workerBusy = false;
  }
}

async function enqueueImport(reason: string, mode: UpdateMode = "full") {
  const [activeJob] = await db.select({ id: updateJobs.id })
    .from(updateJobs)
    .where(sql`${updateJobs.status} IN ('queued', 'running')`)
    .limit(1);
  if (activeJob) {
    console.log(`[worker] skip ${reason}: job #${activeJob.id} is already active`);
    return;
  }
  let job: { id: number };
  try {
    job = await createUpdateJob(mode === "retry" ? "retry" : "scheduled", { mode }, "queued");
  } catch (error) {
    if (error instanceof UpdateJobAlreadyActiveError) {
      console.log(`[worker] skip ${reason}: job #${error.jobId} became active`);
      return;
    }
    throw error;
  }
  console.log(`[worker] queued job #${job.id} (${reason})`);
  await processUpdateQueue();
}

async function processDueRetries() {
  if (workerBusy) return;
  const due = await countDueReleaseRetries();
  if (due > 0) {
    console.log(`[worker] due release page retries: ${due}`);
    await enqueueImport("retry-queue", "retry");
  }
}

async function processArchiveBackfill() {
  if (workerBusy) return;
  const result = await db.execute(sql`
    SELECT count(*)::int AS pending
    FROM release_project_versions rpv
    JOIN release_projects rp ON rp.id = rpv.project_id
    WHERE rpv.resources_synced_at IS NULL
      AND rp.exclude_from_updates = false
      AND rp.href IS NOT NULL
  `);
  const pending = Number((rows(result)[0]?.pending) ?? 0);
  if (pending > 0) {
    console.log(`[worker] historical release pages pending: ${pending}`);
    await enqueueImport("archive-backfill", "archive");
  }
}

async function main() {
  await recoverInterruptedUpdateJobs("scheduled");
  await recoverInterruptedUpdateJobs("retry");
  await recoverInterruptedUpdateJobs("manual");
  await ensureLegacyAccount();
  await pruneUpdateHistory();

  if (process.env.IMPORT_ON_START === "1") {
    await enqueueImport("on-start");
  }

  const expr = process.env.IMPORT_CRON ?? "0 4 * * *";
  if (!cron.validate(expr)) {
    console.error(`[worker] invalid IMPORT_CRON "${expr}", using "0 4 * * *"`);
  }
  const schedule = cron.validate(expr) ? expr : "0 4 * * *";
  cron.schedule(schedule, () => void enqueueImport("scheduled"));
  setInterval(() => void processUpdateQueue(), 1000);
  const retryPollMinutes = Math.max(1, Math.min(60, Number(process.env.RETRY_QUEUE_POLL_MINUTES ?? 5) || 5));
  setInterval(() => void processDueRetries(), retryPollMinutes * 60_000);
  const archivePollMinutes = Math.max(15, Math.min(24 * 60,
    Number(process.env.ARCHIVE_BACKFILL_POLL_MINUTES ?? 60) || 60));
  setInterval(() => void processArchiveBackfill(), archivePollMinutes * 60_000);
  setInterval(() => void pruneUpdateHistory(), 24 * 60 * 60_000);
  void processUpdateQueue();
  void processDueRetries();
  void processArchiveBackfill();
  console.log(
    `[worker] scheduled imports: "${schedule}"; retry queue: ${retryPollMinutes} min; ` +
    `archive backfill: ${archivePollMinutes} min. Idle.`,
  );
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
