import { eq, sql } from "drizzle-orm";
import { db, rows } from "./client.js";
import { settings, updateJobEvents, updateJobs } from "./schema.js";
import { refreshCatalogAndTouch } from "./catalog-summary.js";
import { runAllLstImports } from "./import-lst.js";
import {
  DEFAULT_SMART_REFRESH_POLICY,
  runAllReleasesImports,
  type SmartRefreshPolicy,
} from "../releases/import-releases.js";

type UpdateStage = "starting" | "lst" | "releases" | "done";
type UpdateLevel = "info" | "success" | "error";
type UpdateLogDetail = "brief" | "normal" | "detailed";
export type UpdateLogLevel = UpdateLogDetail;

const UPDATE_LOG_LEVELS: readonly UpdateLogLevel[] = ["brief", "normal", "detailed"];

export function isUpdateLogLevel(value: unknown): value is UpdateLogLevel {
  return typeof value === "string" && UPDATE_LOG_LEVELS.includes(value as UpdateLogLevel);
}

export async function getUpdateLogLevel(): Promise<UpdateLogLevel> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "update_log_level"))
    .limit(1);
  return isUpdateLogLevel(row?.value) ? row.value : "normal";
}

export function isUpdateConcurrency(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 8;
}

export async function getUpdateConcurrency(): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "update_request_concurrency"))
    .limit(1);
  const value = Number(row?.value ?? 4);
  return isUpdateConcurrency(value) ? value : 4;
}

async function numericSetting(key: string, fallback: number, min: number, max: number): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  const value = Number(row?.value ?? fallback);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export async function getSmartRefreshPolicy(): Promise<SmartRefreshPolicy> {
  const [latestIntervalHours, recentIntervalDays, archiveIntervalDays, recentReleaseAgeDays, retryBaseMinutes, archivePageLimit, metadataCacheDays] =
    await Promise.all([
      numericSetting("update_latest_interval_hours", DEFAULT_SMART_REFRESH_POLICY.latestIntervalHours, 1, 168),
      numericSetting("update_recent_interval_days", DEFAULT_SMART_REFRESH_POLICY.recentIntervalDays, 1, 90),
      numericSetting("update_archive_interval_days", DEFAULT_SMART_REFRESH_POLICY.archiveIntervalDays, 7, 730),
      numericSetting("update_recent_release_age_days", DEFAULT_SMART_REFRESH_POLICY.recentReleaseAgeDays, 30, 3650),
      numericSetting("update_retry_base_minutes", DEFAULT_SMART_REFRESH_POLICY.retryBaseMinutes, 1, 1440),
      numericSetting("update_archive_page_limit", DEFAULT_SMART_REFRESH_POLICY.archivePageLimit, 100, 10_000),
      numericSetting("update_metadata_cache_days", DEFAULT_SMART_REFRESH_POLICY.metadataCacheDays, 1, 365),
    ]);
  return {
    latestIntervalHours,
    recentIntervalDays,
    archiveIntervalDays,
    recentReleaseAgeDays,
    retryBaseMinutes,
    archivePageLimit,
    metadataCacheDays,
  };
}

export function isSmartRefreshPolicy(value: SmartRefreshPolicy): boolean {
  return Number.isFinite(value.latestIntervalHours) && value.latestIntervalHours >= 1 && value.latestIntervalHours <= 168
    && Number.isFinite(value.recentIntervalDays) && value.recentIntervalDays >= 1 && value.recentIntervalDays <= 90
    && Number.isFinite(value.archiveIntervalDays) && value.archiveIntervalDays >= 7 && value.archiveIntervalDays <= 730
    && value.archiveIntervalDays >= value.recentIntervalDays
    && Number.isFinite(value.recentReleaseAgeDays) && value.recentReleaseAgeDays >= 30 && value.recentReleaseAgeDays <= 3650
    && Number.isFinite(value.retryBaseMinutes) && value.retryBaseMinutes >= 1 && value.retryBaseMinutes <= 1440
    && Number.isInteger(value.archivePageLimit) && value.archivePageLimit >= 100 && value.archivePageLimit <= 10_000
    && Number.isFinite(value.metadataCacheDays) && value.metadataCacheDays >= 1 && value.metadataCacheDays <= 365;
}

function isDetailVisible(level: UpdateLogLevel, detail: UpdateLogDetail): boolean {
  const rank: Record<UpdateLogLevel, number> = { brief: 0, normal: 1, detailed: 2 };
  return rank[detail] <= rank[level];
}

export interface UpdateCallbacks {
  signal?: AbortSignal;
  onEvent?: (event: { stage: UpdateStage; level: UpdateLevel; message: string }) => void;
  onProgress?: (current: number, total: number, project: string) => void;
  onRuntime?: (runtime: UpdateRuntimeSnapshot) => void;
}

interface UpdateRuntimeSnapshot {
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string;
  pagesCurrent: number;
  pagesTotal: number;
  activeWorkers: number;
  maxWorkers: number;
  requestsCompleted: number;
  requestRetries: number;
  queuePending: number;
  queueRetry: number;
  estimatedFinishAt: Date | null;
}

export interface UpdateTarget {
  projectId: number;
  projectName: string;
  accountId?: number;
}

export class MultiSourceProgress {
  private readonly values = new Map<string, { current: number; total: number }>();

  update(source: string, current: number, total: number): { current: number; total: number } {
    this.values.set(source, {
      current: Math.max(0, current),
      total: Math.max(0, total),
    });
    return [...this.values.values()].reduce((sum, value) => ({
      current: sum.current + value.current,
      total: sum.total + value.total,
    }), { current: 0, total: 0 });
  }
}

export type UpdateMode = "full" | "retry" | "archive" | "lst";

export interface UpdateJobRequest {
  mode: UpdateMode;
  targets?: UpdateTarget[];
  forceAllResources?: boolean;
}

export class UpdateJobAlreadyActiveError extends Error {
  constructor(readonly jobId: number) {
    super(`Задача #${jobId} уже выполняется или ожидает запуска`);
    this.name = "UpdateJobAlreadyActiveError";
  }
}

export function parseUpdateJobRequest(value: unknown): UpdateJobRequest {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode = ["full", "retry", "archive", "lst"].includes(String(source.mode))
    ? String(source.mode) as UpdateMode
    : "full";
  const targets = Array.isArray(source.targets)
    ? source.targets.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const target = entry as Record<string, unknown>;
        const projectId = Number(target.projectId);
        const projectName = String(target.projectName ?? "").trim();
        const accountId = target.accountId == null ? undefined : Number(target.accountId);
        if (!Number.isInteger(projectId) || projectId <= 0 || !projectName) return [];
        if (accountId !== undefined && (!Number.isInteger(accountId) || accountId <= 0)) return [];
        return [{ projectId, projectName, accountId }];
      })
    : undefined;
  return {
    mode,
    targets: targets?.length ? targets : undefined,
    forceAllResources: source.forceAllResources === true,
  };
}

export async function createUpdateJob(
  origin: "manual" | "scheduled" | "retry",
  request: UpdateJobRequest = { mode: "full" },
  status: "queued" | "running" = "running",
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(801003)`);
    const [active] = await tx.select({ id: updateJobs.id }).from(updateJobs)
      .where(sql`${updateJobs.status} IN ('queued', 'running')`)
      .orderBy(updateJobs.id)
      .limit(1);
    if (active) throw new UpdateJobAlreadyActiveError(active.id);
    const [job] = await tx
      .insert(updateJobs)
      .values({
        origin,
        status,
        stage: "starting",
        message: status === "queued" ? "Задача ожидает запуска worker" : "",
        requestPayload: request,
        claimedAt: status === "running" ? new Date() : null,
        heartbeatAt: status === "running" ? new Date() : null,
      })
      .returning({ id: updateJobs.id });
    return job;
  });
}

/** Requeue jobs orphaned by a worker restart; successful pages are checkpointed by job start time. */
export async function recoverInterruptedUpdateJobs(origin: "manual" | "scheduled" | "retry") {
  const message = "Worker перезапущен — задача поставлена на продолжение";
  await db.execute(sql`
    UPDATE update_jobs
    SET status = 'cancelled', stage = 'done', message = 'Задача отменена во время перезапуска worker',
        active_workers = 0, finished_at = now()
    WHERE origin = ${origin} AND status = 'running' AND cancel_requested_at IS NOT NULL
  `);
  const result = await db.execute(sql`
    WITH recovered AS (
      UPDATE update_jobs
      SET status = 'queued', stage = 'starting', message = ${message},
          active_workers = 0, claimed_at = NULL, heartbeat_at = NULL,
          resume_count = resume_count + 1, finished_at = NULL
      WHERE origin = ${origin} AND status = 'running' AND cancel_requested_at IS NULL
      RETURNING id
    )
    INSERT INTO update_job_events (job_id, stage, level, message)
    SELECT id, 'system', 'info', ${message} FROM recovered
    RETURNING job_id
  `);
  return (rows(result) as unknown[]).length;
}

export async function claimNextUpdateJob(): Promise<{
  id: number;
  startedAt: Date;
  request: UpdateJobRequest;
} | null> {
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id
      FROM update_jobs
      WHERE status = 'queued' AND cancel_requested_at IS NULL
      ORDER BY CASE WHEN origin = 'manual' THEN 0 ELSE 1 END, started_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE update_jobs job
    SET status = 'running', stage = 'starting', message = '',
        claimed_at = now(), heartbeat_at = now(), finished_at = NULL
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id, job.started_at AS "startedAt", job.request_payload AS "requestPayload"
  `);
  const row = rows(result)[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    startedAt: new Date(String(row.startedAt)),
    request: parseUpdateJobRequest(row.requestPayload),
  };
}

export async function pruneUpdateHistory(retentionDays = 90, maxJobs = 200): Promise<number> {
  const result = await db.execute(sql`
    WITH removable AS (
      SELECT id
      FROM update_jobs
      WHERE status NOT IN ('queued', 'running')
        AND (
          started_at < now() - (${retentionDays}::int * interval '1 day')
          OR id NOT IN (SELECT id FROM update_jobs ORDER BY id DESC LIMIT ${maxJobs})
        )
    )
    DELETE FROM update_jobs job
    USING removable
    WHERE job.id = removable.id
    RETURNING job.id
  `);
  return rows(result).length;
}

function eventLevel(message: string): UpdateLevel {
  if (/(?:^|\]\s)(?:ошибка|не удалось)|ошибка (?:обновления|страницы|авторизации)|✗|⛔/i.test(message)) {
    return "error";
  }
  if (/готово|заверш|✓/i.test(message)) return "success";
  return "info";
}

export async function executeUpdateJob(
  jobId: number,
  callbacks: UpdateCallbacks = {},
  targets?: UpdateTarget[],
  mode: UpdateMode = "full",
  forceAllResources = false,
): Promise<{ status: "ok" | "error" | "cancelled"; message: string }> {
  const [jobRecord] = await db.select({
    startedAt: updateJobs.startedAt,
    resumeCount: updateJobs.resumeCount,
  })
    .from(updateJobs)
    .where(eq(updateJobs.id, jobId))
    .limit(1);
  if (!jobRecord) throw new Error(`Задача #${jobId} не найдена`);
  const checkpointStartedAt = jobRecord.startedAt;
  const [logLevel, requestConcurrency, refreshPolicy] = await Promise.all([
    getUpdateLogLevel(),
    getUpdateConcurrency(),
    getSmartRefreshPolicy(),
  ]);
  const runtime: UpdateRuntimeSnapshot = {
    progressCurrent: 0,
    progressTotal: 0,
    progressLabel: "",
    pagesCurrent: 0,
    pagesTotal: 0,
    activeWorkers: 0,
    maxWorkers: requestConcurrency,
    requestsCompleted: 0,
    requestRetries: 0,
    queuePending: 0,
    queueRetry: 0,
    estimatedFinishAt: null,
  };
  const cancellation = new AbortController();
  const forwardExternalCancellation = () => cancellation.abort(callbacks.signal?.reason);
  if (callbacks.signal?.aborted) {
    forwardExternalCancellation();
  } else {
    callbacks.signal?.addEventListener("abort", forwardExternalCancellation, { once: true });
  }
  let cancellationCheck: Promise<void> | null = null;
  const checkCancellationRequested = (): Promise<void> => {
    if (cancellation.signal.aborted) return Promise.resolve();
    if (cancellationCheck) return cancellationCheck;
    cancellationCheck = (async () => {
      const [job] = await db.select({ cancelRequestedAt: updateJobs.cancelRequestedAt })
        .from(updateJobs)
        .where(eq(updateJobs.id, jobId))
        .limit(1);
      if (job?.cancelRequestedAt) cancellation.abort("requested");
    })().finally(() => { cancellationCheck = null; });
    return cancellationCheck;
  };
  const cancellationPoll = setInterval(() => {
    void checkCancellationRequested().catch(() => undefined);
  }, 750);
  const signal = cancellation.signal;
  let pendingRuntime: Partial<UpdateRuntimeSnapshot> = { maxWorkers: requestConcurrency };
  let runtimeTimer: ReturnType<typeof setTimeout> | null = null;
  let runtimeWrite: Promise<unknown> = Promise.resolve();
  const flushRuntime = async () => {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    runtimeTimer = null;
    const patch = pendingRuntime;
    pendingRuntime = {};
    if (!Object.keys(patch).length) {
      await runtimeWrite;
      return;
    }
    runtimeWrite = runtimeWrite.catch((err) => {
      console.error("[update-data] runtime flush error:", err);
    }).then(() =>
      db.update(updateJobs).set({ ...patch, heartbeatAt: new Date() }).where(eq(updateJobs.id, jobId)),
    ).catch((err) => {
      console.error("[update-data] runtime write error:", err);
    });
    await runtimeWrite;
  };
  const reportRuntime = (patch: Partial<UpdateRuntimeSnapshot>, immediate = false) => {
    Object.assign(runtime, patch);
    Object.assign(pendingRuntime, patch);
    callbacks.onRuntime?.({ ...runtime });
    if (immediate) {
      void flushRuntime();
    } else if (!runtimeTimer) {
      runtimeTimer = setTimeout(() => { void flushRuntime(); }, 500);
    }
  };
  const projectProgress = new MultiSourceProgress();
  const reportProgress = (current: number, total: number, project: string, source = "default") => {
    const aggregate = projectProgress.update(source, current, total);
    callbacks.onProgress?.(aggregate.current, aggregate.total, project);
    const elapsed = Math.max(1, Date.now() - jobStartedAt);
    const remainingMs = aggregate.current > 0 && aggregate.total > aggregate.current
      ? Math.min(30 * 24 * 60 * 60_000,
          (elapsed / aggregate.current) * (aggregate.total - aggregate.current))
      : 0;
    reportRuntime({
      progressCurrent: aggregate.current,
      progressTotal: aggregate.total,
      progressLabel: project,
      estimatedFinishAt: remainingMs > 0 ? new Date(Date.now() + remainingMs) : null,
    });
  };
  const jobStartedAt = checkpointStartedAt.getTime();
  const pageProgress = new MultiSourceProgress();
  const reportPageProgress = (current: number, total: number, project: string, source = "default") => {
    const aggregate = pageProgress.update(source, current, total);
    const elapsed = Math.max(1, Date.now() - jobStartedAt);
    const remainingMs = aggregate.current > 0 && aggregate.total > aggregate.current
      ? Math.min(30 * 24 * 60 * 60_000,
          (elapsed / aggregate.current) * (aggregate.total - aggregate.current))
      : 0;
    reportRuntime({
      pagesCurrent: aggregate.current,
      pagesTotal: aggregate.total,
      progressLabel: project || runtime.progressLabel,
      queuePending: Math.max(0, aggregate.total - aggregate.current),
      estimatedFinishAt: remainingMs > 0 ? new Date(Date.now() + remainingMs) : null,
    });
  };
  const queueStats = new Map<string, { pending: number; retry: number }>();
  const reportQueueStats = (pending: number, retry: number, source = "default") => {
    queueStats.set(source, { pending, retry });
    const aggregate = [...queueStats.values()].reduce((sum, value) => ({
      pending: sum.pending + value.pending,
      retry: sum.retry + value.retry,
    }), { pending: 0, retry: 0 });
    reportRuntime({ queuePending: aggregate.pending, queueRetry: aggregate.retry });
  };
  const sessionRuntime = new Map<string, {
    activeRequests: number;
    maxConcurrentRequests: number;
    requestsCompleted: number;
    retries: number;
  }>();
  const reportHttpStats = (stats: {
    source: string;
    activeRequests: number;
    maxConcurrentRequests: number;
    requestsCompleted: number;
    retries: number;
  }) => {
    sessionRuntime.set(stats.source, stats);
    const totals = [...sessionRuntime.values()].reduce((sum, item) => ({
      activeRequests: sum.activeRequests + item.activeRequests,
      maxConcurrentRequests: sum.maxConcurrentRequests + item.maxConcurrentRequests,
      requestsCompleted: sum.requestsCompleted + item.requestsCompleted,
      retries: sum.retries + item.retries,
    }), { activeRequests: 0, maxConcurrentRequests: 0, requestsCompleted: 0, retries: 0 });
    reportRuntime({
      activeWorkers: totals.activeRequests,
      maxWorkers: totals.maxConcurrentRequests,
      requestsCompleted: totals.requestsCompleted,
      requestRetries: totals.retries,
    });
  };
  reportRuntime({ maxWorkers: requestConcurrency }, true);
  const eventBuffer: Array<typeof updateJobEvents.$inferInsert> = [];
  let eventWrite: Promise<unknown> = Promise.resolve();
  let eventTimer: ReturnType<typeof setTimeout> | null = null;
  const flushEvents = async () => {
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = null;
    const batch = eventBuffer.splice(0, 250);
    if (batch.length) {
      eventWrite = eventWrite.catch(() => undefined).then(() =>
        db.insert(updateJobEvents).values(batch),
      );
    }
    await eventWrite;
    if (eventBuffer.length) await flushEvents();
  };
  const emit = (
    stage: UpdateStage,
    message: string,
    level = eventLevel(message),
    detail: UpdateLogDetail = "normal",
  ) => {
    // Ошибки всегда видны, даже в кратком журнале.
    if (level !== "error" && !isDetailVisible(logLevel, detail)) return;
    callbacks.onEvent?.({ stage, level, message });
    eventBuffer.push({
      jobId,
      stage,
      level,
      message: message.slice(0, 2000),
    });
    if (eventBuffer.length >= 100) {
      void flushEvents().catch((err) => {
        console.error("[update-data] event flush error:", err);
      });
    } else if (!eventTimer) {
      eventTimer = setTimeout(() => { void flushEvents().catch((err) => {
        console.error("[update-data] event flush error:", err);
      }); }, 200);
    }
  };
  const setStage = async (stage: UpdateStage) => {
    await db.update(updateJobs).set({ stage }).where(eq(updateJobs.id, jobId));
  };

  try {
    let finalMessage: string;
    if (jobRecord.resumeCount > 0) {
      emit(
        "starting",
        `Продолжение задачи после перезапуска worker; уже успешно обработанные страницы будут пропущены`,
        "info",
        "brief",
      );
    }
    if (mode === "archive") {
      emit("starting", "Фоновое заполнение старых страниц релизов запущено", "info", "brief");
      await setStage("releases");
      const releasesResult = await runAllReleasesImports({
        syncLinks: true,
        backfillOnly: true,
        concurrency: requestConcurrency,
        refreshPolicy,
        resumeAfter: checkpointStartedAt,
        signal,
        onLog: (message, detail) => emit("releases", message, eventLevel(message), detail),
        onPageProgress: reportPageProgress,
        onQueueStats: reportQueueStats,
        onRuntimeStats: reportHttpStats,
      });
      finalMessage = releasesResult.failed > 0
        ? `Архив обработан частично: аккаунтов с ошибкой — ${releasesResult.failed}`
        : "Фоновая очередь старых релизов обработана";
    } else if (mode === "retry") {
      emit("starting", "Повторная обработка ошибочных страниц запущена", "info", "brief");
      await setStage("releases");
      const releasesResult = await runAllReleasesImports({
        syncLinks: true,
        retryOnly: true,
        concurrency: requestConcurrency,
        refreshPolicy,
        resumeAfter: checkpointStartedAt,
        signal,
        onLog: (message, detail) => emit("releases", message, eventLevel(message), detail),
        onPageProgress: reportPageProgress,
        onQueueStats: reportQueueStats,
        onRuntimeStats: reportHttpStats,
      });
      finalMessage = releasesResult.failed > 0
        ? `Очередь повторов обработана частично: аккаунтов с ошибкой — ${releasesResult.failed}`
        : "Очередь повторных попыток обработана";
    } else if (mode === "lst") {
      emit("starting", "Обновление графа из онлайн-LST запущено", "info", "brief");
      await setStage("lst");
      emit(
        "lst",
        "Загрузка актуального v8cscdsc.lst для всех включённых ИТС-аккаунтов",
        "info",
        "brief",
      );
      await runAllLstImports({
        signal,
        onLog: (message, detail) => emit("lst", message, eventLevel(message), detail),
      });
      finalMessage = "Конфигурации и граф переходов из онлайн-LST обновлены";
    } else if (targets?.length) {
      const total = targets.length;
      emit(
        "starting",
        forceAllResources
          ? (total === 1
              ? `Принудительное обновление ${targets[0].projectName} запущено`
              : `Принудительное обновление ${total} конфигураций запущено`)
          : (total === 1
              ? `Выборочное обновление ${targets[0].projectName} запущено`
              : `Групповое обновление ${total} конфигураций запущено`),
        "info",
        "brief",
      );
      await setStage("releases");
      emit(
        "releases",
        `${forceAllResources ? "Повторная загрузка всех страниц релизов" : "Загрузка выбранных конфигураций releases.1c.ru"}` +
        `${targets[0].accountId ? " выбранным ИТС-аккаунтом" : " с автоматическим выбором доступного ИТС-аккаунта"}`,
        "info",
        "brief",
      );
      const releasesResult = await runAllReleasesImports({
        targetProjectIds: targets.map((target) => target.projectId),
        targetAccountId: targets[0].accountId,
        syncLinks: true,
        syncPatchesData: false,
        concurrency: requestConcurrency,
        refreshPolicy,
        forceLatest: true,
        forceAllResources,
        resumeAfter: checkpointStartedAt,
        signal,
        onProgress: reportProgress,
        onPageProgress: reportPageProgress,
        onRuntimeStats: reportHttpStats,
        onQueueStats: reportQueueStats,
        onLog: (message, detail) => emit("releases", message, eventLevel(message), detail),
      });
      const failedNames = targets
        .filter((target) => releasesResult.projectIdsFailed.includes(target.projectId))
        .map((target) => target.projectName);
      finalMessage = failedNames.length
        ? `Групповое обновление завершено: успешно — ${releasesResult.projectsSucceeded}, ` +
          `без доступа или с ошибкой — ${failedNames.length} (${failedNames.join(", ")})`
        : total === 1
          ? `${targets[0].projectName} обновлена`
          : `Групповое обновление завершено: успешно — ${releasesResult.projectsSucceeded}`;
    } else {
      emit(
        "starting",
        forceAllResources
          ? "Принудительное обновление всех конфигураций запущено"
          : "Обновление данных запущено",
        "info",
        "brief",
      );
      await setStage("lst");
      emit("lst", "Шаг 1 из 2: загрузка актуального v8cscdsc.lst с 1С", "info", "brief");
      await runAllLstImports({
        signal,
        onLog: (message, detail) => emit("lst", message, eventLevel(message), detail),
      });

      await setStage("releases");
      emit(
        "releases",
        forceAllResources
          ? "Шаг 2 из 2: повторная загрузка страниц всех релизов releases.1c.ru"
          : "Шаг 2 из 2: каталог, версии и страницы релизов releases.1c.ru",
        "info",
        "brief",
      );
      const releasesResult = await runAllReleasesImports({
        syncLinks: true,
        syncPatchesData: false,
        concurrency: requestConcurrency,
        refreshPolicy,
        forceAllResources,
        resumeAfter: checkpointStartedAt,
        signal,
        onLog: (message, detail) => emit("releases", message, eventLevel(message), detail),
        onProgress: reportProgress,
        onPageProgress: reportPageProgress,
        onRuntimeStats: reportHttpStats,
        onQueueStats: reportQueueStats,
      });
      finalMessage = releasesResult.failed > 0
        ? `Данные обновлены частично: ИТС-аккаунтов с ошибкой — ${releasesResult.failed}`
        : forceAllResources
          ? "Все конфигурации и страницы релизов принудительно обновлены"
          : "Данные LST и releases.1c.ru обновлены";
    }

    await checkCancellationRequested();
    if (signal.aborted) {
      const error = new Error("Обновление прервано пользователем");
      error.name = "AbortError";
      throw error;
    }
    emit("done", "Обновление сводного каталога", "info", "detailed");
    await refreshCatalogAndTouch();
    emit("done", finalMessage, "success", "brief");
    await flushEvents();
    reportRuntime({ activeWorkers: 0, queuePending: 0, estimatedFinishAt: null }, true);
    await flushRuntime();
    await db.update(updateJobs).set({
      status: "ok",
      stage: "done",
      message: finalMessage,
      finishedAt: new Date(),
    }).where(eq(updateJobs.id, jobId));
    return { status: "ok", message: finalMessage };
  } catch (error) {
    const aborted = signal.aborted || (error as Error).name === "AbortError";
    const status = aborted ? "cancelled" : "error";
    const message = aborted
      ? "Обновление прервано пользователем"
      : ((error as Error).message ?? String(error));
    emit("done", message, aborted ? "info" : "error", "brief");
    await flushEvents();
    reportRuntime({ activeWorkers: 0, estimatedFinishAt: null }, true);
    await flushRuntime();
    await db.update(updateJobs).set({
      status,
      stage: "done",
      message: message.slice(0, 2000),
      finishedAt: new Date(),
    }).where(eq(updateJobs.id, jobId));
    return { status, message };
  } finally {
    clearInterval(cancellationPoll);
    callbacks.signal?.removeEventListener("abort", forwardExternalCancellation);
  }
}
