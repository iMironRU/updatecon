/**
 * pipeline.ts — «Обновить всё»: the full data refresh as one run, used by the
 * admin button and by the scheduled worker alike.
 *
 *   1. LST (downloads.v8.1c.ru): the update graph, applications, product-line
 *      tags, platform manifests, transitions.
 *   2. releases.1c.ru: projects ↔ applications, release dates, platforms,
 *      sizes, planned releases, long-term support; then 1С:Решения cards and
 *      tags again.
 *   3. Platform builds (releases.1c.ru): every 8.2/8.3/8.5 build with its
 *      date, OS and links (src/releases/platform.ts).
 *
 * The steps are independent sources, so each runs even if an earlier failed.
 * The run ends with a summary of what changed, and the whole log is stored in
 * import_runs (source = 'all') — a nightly run can be read in the admin UI.
 */

import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "./client.js";
import { applyItsCredentials, allItsAccounts } from "./credentials.js";
import { importRuns } from "./schema.js";
import { runImport } from "./import-lst.js";
import { runReleasesImport } from "../releases/import-releases.js";
import { syncPlatform } from "../releases/platform.js";
import { syncExchanges } from "./exchanges.js";

const KEEP_LOGS = 30;   // full logs of the latest runs; older rows keep the summary only

export interface PipelineOptions {
  trigger: "manual" | "scheduled" | "on-start";
  onLog?: (msg: string) => void;
  onProgress?: (current: number, total: number) => void;
  signal?: AbortSignal;
}

interface Snapshot {
  editions: number; edges: number; versions: number; releases: number;
  projects: number; linked: number; transitions: number; solutions: number; tags: number; builds: number;
}

async function snapshot(): Promise<Snapshot> {
  const r = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM configurations)::int AS editions,
      (SELECT count(*) FROM update_edges)::int AS edges,
      (SELECT count(DISTINCT to_version) FROM update_edges)::int AS versions,
      (SELECT count(*) FROM version_meta)::int AS releases,
      (SELECT count(*) FROM release_projects)::int AS projects,
      (SELECT count(*) FROM release_projects WHERE config_id IS NOT NULL)::int AS linked,
      (SELECT count(*) FROM transitions)::int AS transitions,
      (SELECT count(*) FROM solutions_info WHERE status = 'ok')::int AS solutions,
      (SELECT count(*) FROM template_tags WHERE tag <> '')::int AS tags,
      (SELECT count(*) FROM platform_builds)::int AS builds
  `);
  return (((r as any).rows ?? r) as Snapshot[])[0];
}

const nf = (n: number) => n.toLocaleString("ru-RU");
const delta = (a: number, b: number) => (b === a ? "" : b > a ? ` (+${nf(b - a)})` : ` (−${nf(a - b)})`);
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}
const ts = () => new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

type StepStatus = "ok" | "unchanged" | "skipped" | "error" | "cancelled";
const STEP_LABEL: Record<StepStatus, string> = {
  ok: "готово", unchanged: "без изменений", skipped: "пропущен", error: "ошибка", cancelled: "прервано",
};

export async function runFullUpdate(opts: PipelineOptions): Promise<{ status: string; summary: string }> {
  const lines: string[] = [];
  const log = (msg: string) => {
    lines.push(`[${ts()}] ${msg}`);
    if (opts.onLog) opts.onLog(msg); else console.log(`[update] ${msg}`);
  };
  const started = new Date();
  const startId = Number(((((await db.execute(sql`SELECT coalesce(max(id), 0) AS id FROM import_runs`)) as any).rows ?? []) as { id: number }[])[0]?.id ?? 0);
  const before = await snapshot();
  const steps: { name: string; status: StepStatus; ms: number }[] = [];
  const errorsBefore = () => lines.filter((l) => /\]\s+✗/.test(l)).length;

  log(`Обновление данных (${{ manual: "вручную", scheduled: "по расписанию", "on-start": "при запуске" }[opts.trigger]})`);

  // ── Step 1: LST ───────────────────────────────────────────────────────────
  log("━━━ Шаг 1 из 4 · Список обновлений (LST, downloads.v8.1c.ru) ━━━");
  let t0 = Date.now();
  try {
    await runImport(undefined, { onLog: log });
    const r = (((await db.execute(sql`
      SELECT status FROM import_runs WHERE source = 'lst' AND id > ${startId} ORDER BY id DESC LIMIT 1
    `)) as any).rows ?? []) as { status: string }[];
    steps.push({ name: "LST", status: r[0]?.status === "skipped" ? "unchanged" : "ok", ms: Date.now() - t0 });
  } catch (e) {
    log(`✗ LST: ${(e as Error).message}`);
    steps.push({ name: "LST", status: "error", ms: Date.now() - t0 });
  }

  // ── Step 2: releases.1c.ru + 1С:Решения ───────────────────────────────────
  if (opts.signal?.aborted) {
    log("⛔ Прервано — шаг 2 не запускался");
    steps.push({ name: "releases.1c.ru", status: "cancelled", ms: 0 });
  } else {
    log("━━━ Шаг 2 из 4 · Сайт релизов (releases.1c.ru) и 1С:Решения ━━━");
    t0 = Date.now();
    if (!process.env.ITS_LOGIN || !process.env.ITS_PASSWORD) {
      log("⚠ ITS_LOGIN / ITS_PASSWORD не заданы — шаг пропущен");
      steps.push({ name: "releases.1c.ru", status: "skipped", ms: 0 });
    } else {
      const errs = errorsBefore();
      try {
        await runReleasesImport(undefined, undefined, {
          syncTotalPage: true, syncSizes: true, syncPatchesData: true,
          extraAccounts: (await allItsAccounts()).slice(1),
          onProgress: (cur, tot) => opts.onProgress?.(cur, tot),
          onLog: log, signal: opts.signal,
        });
        steps.push({ name: "releases.1c.ru", status: "ok", ms: Date.now() - t0 });
      } catch (e) {
        const aborted = (e as Error).name === "AbortError";
        log(aborted ? "⛔ Прервано пользователем" : `✗ releases.1c.ru: ${(e as Error).message}`);
        steps.push({ name: "releases.1c.ru", status: aborted ? "cancelled" : "error", ms: Date.now() - t0 });
      }
      const newErrs = errorsBefore() - errs;
      if (newErrs > 0) log(`Проектов с ошибкой загрузки: ${newErrs} — они обновятся в следующий раз`);
    }
  }

  // ── Step 3: platform builds ───────────────────────────────────────────────
  if (opts.signal?.aborted) {
    if (!steps.some((s) => s.status === "cancelled")) log("⛔ Прервано — шаги 3 и 4 не запускались");
    steps.push({ name: "платформа", status: "cancelled", ms: 0 });
  } else {
    log("━━━ Шаг 3 из 4 · Платформа 1С:Предприятие (releases.1c.ru) ━━━");
    t0 = Date.now();
    if (!process.env.ITS_LOGIN || !process.env.ITS_PASSWORD) {
      log("⚠ ITS_LOGIN / ITS_PASSWORD не заданы — шаг пропущен");
      steps.push({ name: "платформа", status: "skipped", ms: 0 });
    } else {
      try {
        const r = await syncPlatform({ onLog: log, onProgress: (cur, tot) => opts.onProgress?.(cur, tot), signal: opts.signal });
        steps.push({ name: "платформа", status: r.errors && !r.details ? "error" : "ok", ms: Date.now() - t0 });
      } catch (e) {
        log(`✗ Платформа: ${(e as Error).message}`);
        steps.push({ name: "платформа", status: "error", ms: Date.now() - t0 });
      }
    }
  }

  // ── Step 4: the exchanges registry (no ITS account needed) ───────────────
  if (opts.signal?.aborted) {
    steps.push({ name: "обмены", status: "cancelled", ms: 0 });
  } else {
    log("━━━ Шаг 4 из 4 · Реестр обменов и переходов (github.com/iMironRU/1CExchenge) ━━━");
    t0 = Date.now();
    try {
      await syncExchanges({ onLog: log });
      steps.push({ name: "обмены", status: "ok", ms: Date.now() - t0 });
    } catch (e) {
      log(`✗ Обмены: ${(e as Error).message}`);
      steps.push({ name: "обмены", status: "error", ms: Date.now() - t0 });
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const after = await snapshot();
  const errors = lines.filter((l) => /\]\s+✗/.test(l)).length;
  const status = steps.some((s) => s.status === "cancelled") ? "cancelled"
    : steps.every((s) => s.status === "error" || s.status === "skipped") ? "error"
    : steps.some((s) => s.status === "error") ? "partial" : "ok";
  const total = Date.now() - started.getTime();
  log("━━━ Итог ━━━");
  log(steps.map((s) => `${s.name}: ${STEP_LABEL[s.status]}${s.ms ? ", " + dur(s.ms) : ""}`).join(" · "));
  log(`Редакций: ${nf(after.editions)}${delta(before.editions, after.editions)} · рёбер обновления: ${nf(after.edges)}${delta(before.edges, after.edges)} · версий: ${nf(after.versions)}${delta(before.versions, after.versions)}`);
  log(`Релизов с датами: ${nf(after.releases)}${delta(before.releases, after.releases)} · проектов releases.1c.ru: ${nf(after.projects)}, сопоставлено ${nf(after.linked)}${delta(before.linked, after.linked)}`);
  log(`Переходов: ${nf(after.transitions)}${delta(before.transitions, after.transitions)} · карточек 1С:Решений: ${nf(after.solutions)}${delta(before.solutions, after.solutions)} · тегов: ${nf(after.tags)}${delta(before.tags, after.tags)}`);
  log(`Сборок платформы: ${nf(after.builds)}${delta(before.builds, after.builds)}`);
  log(errors ? `✗ Ошибок в логе: ${errors}` : "Ошибок нет");
  log(`${status === "ok" ? "✓ Готово" : status === "partial" ? "⚠ Готово с ошибками" : status === "cancelled" ? "⛔ Прервано" : "✗ Не удалось"} за ${dur(total)}`);

  const summary = steps.map((s) => `${s.name}: ${STEP_LABEL[s.status]}`).join(" · ")
    + ` · редакций ${nf(after.editions)}${delta(before.editions, after.editions)}`
    + ` · релизов ${nf(after.releases)}${delta(before.releases, after.releases)}`
    + (errors ? ` · ошибок ${errors}` : "");

  // LST counts on the summary row, so the run list reads the same as before.
  const lstRow = (((await db.execute(sql`
    SELECT file_sha256, file_bytes, configs_found, edges_upserted, edges_unchanged
    FROM import_runs WHERE source = 'lst' AND id > ${startId} ORDER BY id DESC LIMIT 1
  `)) as any).rows ?? []) as { file_sha256: string; file_bytes: number; configs_found: number; edges_upserted: number; edges_unchanged: number }[];
  const l = lstRow[0];
  await db.insert(importRuns).values({
    source: "all",
    fileSha256: l?.file_sha256 ?? "",
    fileBytes: l?.file_bytes ?? 0,
    configsFound: l?.configs_found ?? 0,
    edgesUpserted: l?.edges_upserted ?? 0,
    edgesUnchanged: l?.edges_unchanged ?? 0,
    status,
    message: summary,
    log: lines.join("\n"),
    startedAt: started,
    finishedAt: new Date(),
  });
  await db.execute(sql`
    UPDATE import_runs SET log = NULL
    WHERE source = 'all' AND log IS NOT NULL
      AND id NOT IN (SELECT id FROM import_runs WHERE source = 'all' ORDER BY id DESC LIMIT ${KEEP_LOGS})
  `);
  return { status, summary };
}

// CLI: node dist/db/pipeline.js — «Обновить всё» on DATABASE_URL (scripts/snapshot.sh,
// the snapshot workflow). Exit 1 when nothing could be updated or it was cancelled.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const c = await applyItsCredentials();
    if (c.source === "none") { console.error("no ITS account (ITS_LOGIN / ITS_PASSWORD or the admin UI)"); process.exitCode = 1; return; }
    const r = await runFullUpdate({ trigger: "manual" });
    console.log(`[update] ${r.status}: ${r.summary}`);
    if (r.status === "error" || r.status === "cancelled") process.exitCode = 1;
  })().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
}
