/**
 * server.ts — Fastify app: API + static web UI in one service.
 *
 * Public endpoints:
 *   GET  /api/health
 *   GET  /api/revision                    -> catalog revision for UI refresh
 *   GET  /api/openapi.json                -> OpenAPI 3.0 specification
 *   GET  /api/configs?q=<substr>           -> matching configurations (enriched)
 *   GET  /api/configs?version=<v>          -> configs that contain this version
 *   GET  /api/versions?config=<name>       -> known versions + version_meta
 *   GET  /api/version-resources?config=&version= -> lazy links for one release
 *   GET  /api/release-changes              -> detected release changes feed
 *   GET  /api/patches?config=&version=      -> patches list for a version
 *   GET  /api/chain?config=&from=&to=      -> computed update chain
 *   GET  /api/stats                        -> import/run summary
 *   GET  /api-docs/                        -> redirect to integrated API page
 *   GET  /*                                -> static UI (public/)
 *
 * Admin endpoints (cookie session auth via ADMIN_LOGIN / ADMIN_PASSWORD):
 *   GET  /admin                            -> admin UI
 *   GET  /admin/api/status                 -> important dashboard metrics
 *   GET  /admin/api/logs                   -> update jobs
 *   GET  /admin/api/jobs/:id               -> persistent job events
 *   POST /admin/api/update                 -> full, archive, LST-only or selected-project online update
 *   GET  /admin/api/update/targets         -> projects/accounts for targeted update
 *   GET  /admin/api/database/status        -> catalog backup status and size
 *   GET  /admin/api/database/backup        -> download catalog-only custom dump
 *   POST /admin/api/database/restore       -> restore catalog-only custom dump
 *   POST /admin/api/data/releases/clear    -> clear releases data, preserve LST
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { PoolClient } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, eq, desc, inArray } from "drizzle-orm";
import { db, pool, rows as extractRows } from "./client.js";
import {
  configurations,
  importRuns,
  settings,
  releaseProjects,
  releaseProjectVersions,
  releaseVersionResources,
  releaseChangeEvents,
  updateJobEvents,
  updateJobs,
} from "./schema.js";
import { findChain } from "./chain.js";
import { setCaddyDomain, getCaddyStatus } from "./caddy.js";
import { parseVersion } from "../parser/version.js";
import {
  createUpdateJob,
  getUpdateConcurrency,
  getUpdateLogLevel,
  getSmartRefreshPolicy,
  isUpdateConcurrency,
  isUpdateLogLevel,
  isSmartRefreshPolicy,
  UpdateJobAlreadyActiveError,
  type UpdateMode,
  type UpdateTarget,
} from "./update-data.js";
import { ReleasesSession } from "../releases/fetch-releases.js";
import {
  compareReleaseVersions,
  isReleaseVersion,
  parseTotalPage,
  TOTAL_CATALOG_PATH,
} from "../releases/parse-releases.js";
import { syncAccountProjectAccess } from "../releases/import-releases.js";
import { backfillChangeFeed } from "../releases/backfill-change-feed.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
import {
  ensureCatalogSummary,
  getCatalogRevision,
  refreshCatalogAndTouch,
} from "./catalog-summary.js";
import {
  accountCredentials,
  createAccount,
  deleteAccount,
  listAccounts,
  markAccountError,
  markAccountSuccess,
  updateAccount,
} from "../accounts/service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATALOG_BACKUP_TABLES = [
  "configurations",
  "update_edges",
  "release_projects",
  "release_project_versions",
  "release_version_transitions",
  "release_version_resources",
  "release_change_events",
  "version_meta",
  "patches",
] as const;

const CATALOG_RESTORE_TRUNCATE = [
  "catalog_summary",
  "account_project_access",
  "release_change_events",
  "release_version_resources",
  "release_version_transitions",
  "release_project_versions",
  "release_projects",
  "patches",
  "version_meta",
  "update_edges",
  "configurations",
] as const;

interface VersionResourcePayload {
  kind: string;
  category: string;
  title: string;
  href: string;
  properties_id: string | null;
  file_name: string | null;
  file_extension: string | null;
  file_size_bytes: number | null;
  published_at: string | null;
  sha512: string | null;
  is_file: boolean;
}

interface VersionMetadataPayload {
  source: "releases" | "lst";
  release_date: string | null;
  min_platform: string | null;
  recommended_platform: string | null;
  file_size_bytes: number | null;
  download_href: string | null;
  is_test: boolean;
  previous_versions: string[];
  resources: VersionResourcePayload[];
}

function versionResourcePayload(row: Record<string, unknown>): VersionResourcePayload {
  return {
    kind: String(row.kind ?? "other"),
    category: String(row.category ?? "other"),
    title: String(row.title ?? ""),
    href: String(row.href ?? ""),
    properties_id: row.properties_id == null ? null : String(row.properties_id),
    file_name: row.file_name == null ? null : String(row.file_name),
    file_extension: row.file_extension == null ? null : String(row.file_extension),
    file_size_bytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
    published_at: row.published_at == null ? null : String(row.published_at),
    sha512: row.sha512 == null ? null : String(row.sha512),
    is_file: Boolean(row.is_file),
  };
}

interface ReleaseChangeCursor {
  occurredAt: Date;
  id: number;
}

function encodeReleaseChangeCursor(occurredAt: unknown, id: number): string {
  const date = occurredAt instanceof Date ? occurredAt : new Date(String(occurredAt));
  return Buffer.from(JSON.stringify([date.toISOString(), id]), "utf8").toString("base64url");
}

function decodeReleaseChangeCursor(value: string): ReleaseChangeCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const occurredAt = new Date(String(parsed[0]));
    const id = Number(parsed[1]);
    if (Number.isNaN(occurredAt.getTime()) || !Number.isSafeInteger(id) || id < 1) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

/** Count unique versions exactly as they are exposed by the public catalog. */
function publicCatalogVersionCountQuery() {
  return sql`
    SELECT
      coalesce(sum(version_count), 0)::int AS c,
      coalesce(sum(lst_only_version_count), 0)::int AS lst_only,
      coalesce(sum(shared_version_count), 0)::int AS shared,
      coalesce(sum(releases_only_version_count), 0)::int AS releases_only
    FROM catalog_summary
  `;
}

function postgresToolConnection() {
  const connection = new URL(
    process.env.DATABASE_URL ?? "postgres://upd:upd@localhost:5432/upd",
  );
  if (connection.protocol !== "postgres:" && connection.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL должен указывать на PostgreSQL");
  }
  const database = decodeURIComponent(connection.pathname.replace(/^\//, ""));
  if (!database) throw new Error("В DATABASE_URL не указано имя базы данных");
  return {
    database,
    env: {
      ...process.env,
      PGHOST: connection.hostname,
      PGPORT: connection.port || "5432",
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password),
      PGDATABASE: database,
      ...(connection.searchParams.get("sslmode")
        ? { PGSSLMODE: connection.searchParams.get("sslmode")! }
        : {}),
    },
  };
}

async function runPostgresTool(
  command: string,
  args: string[],
  timeoutMs = 2 * 60 * 60_000,
): Promise<void> {
  const { env } = postgresToolConnection();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command}: превышено время ожидания`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} завершился с кодом ${code}: ${stderr.trim() || "неизвестная ошибка"}`));
    });
  });
}

async function assertPostgresCustomDump(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || signature.toString("ascii") !== "PGDMP") {
      throw new Error("Выбранный файл не является резервной копией PostgreSQL custom dump");
    }
  } finally {
    await handle.close();
  }
}

async function assertCatalogDumpContents(dumpPath: string, listPath: string): Promise<void> {
  await runPostgresTool("pg_restore", ["--list", `--file=${listPath}`, dumpPath], 10 * 60_000);
  const list = await readFile(listPath, "utf8");
  const expectedTables = new Set<string>(CATALOG_BACKUP_TABLES);
  const foundTables = new Set<string>();

  for (const rawLine of list.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;
    const match = line.match(/^\d+;\s+\d+\s+\d+\s+(TABLE DATA|SEQUENCE SET)\s+(\S+)\s+(\S+)\s+/);
    if (!match) {
      throw new Error("Архив содержит неподдерживаемые объекты и не является копией каталога release1c");
    }
    const [, kind, schema, objectName] = match;
    if (schema !== "public") {
      throw new Error("Архив содержит объекты вне схемы public");
    }
    if (kind === "TABLE DATA") {
      if (!expectedTables.has(objectName)) {
        throw new Error(`Архив содержит недопустимую таблицу ${objectName}`);
      }
      foundTables.add(objectName);
      continue;
    }
    const tableName = objectName.replace(/_id_seq$/, "");
    if (objectName !== `${tableName}_id_seq` || !expectedTables.has(tableName)) {
      throw new Error(`Архив содержит недопустимую последовательность ${objectName}`);
    }
  }

  const missingTables = CATALOG_BACKUP_TABLES.filter((table) => !foundTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`В архиве отсутствуют таблицы каталога: ${missingTables.join(", ")}`);
  }
}

async function databaseMaintenanceActive(): Promise<boolean> {
  const [row] = await db.select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "database_maintenance"))
    .limit(1);
  return row?.value === "restore";
}

async function setDatabaseMaintenance(active: boolean): Promise<void> {
  if (!active) {
    await db.delete(settings).where(eq(settings.key, "database_maintenance"));
    return;
  }
  const now = new Date();
  await db.insert(settings).values({ key: "database_maintenance", value: "restore", updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: "restore", updatedAt: now },
    });
}

async function acquireImportLocks(): Promise<PoolClient | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ lst_locked: boolean; releases_locked: boolean }>(`
      SELECT pg_try_advisory_lock(801001) AS lst_locked,
             pg_try_advisory_lock(801002) AS releases_locked
    `);
    const lstLocked = Boolean(result.rows[0]?.lst_locked);
    const releasesLocked = Boolean(result.rows[0]?.releases_locked);
    if (lstLocked && releasesLocked) return client;
    if (lstLocked) await client.query("SELECT pg_advisory_unlock(801001)");
    if (releasesLocked) await client.query("SELECT pg_advisory_unlock(801002)");
    client.release();
    return null;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseImportLocks(client: PoolClient | null): Promise<void> {
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock(801002), pg_advisory_unlock(801001)");
  } finally {
    client.release();
  }
}

let databaseBackupRunning = false;
let databaseRestoreRunning = false;

function optionalText(value: unknown): string | null {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

function optionalInteger(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Размер должен быть целым неотрицательным числом");
  return number;
}

function optionalDate(value: unknown): string | null {
  const cleaned = optionalText(value);
  if (cleaned && !/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    throw new Error("Дата должна быть указана в формате ГГГГ-ММ-ДД");
  }
  return cleaned;
}

async function touchCatalogRevision(touchLstPolicy = false) {
  await refreshCatalogAndTouch(touchLstPolicy);
}

async function requestUpdateJobCancellation(jobId: number) {
  const requestedAt = new Date();
  const queued = await db.update(updateJobs).set({
    status: "cancelled",
    stage: "done",
    message: "Задача отменена до запуска",
    cancelRequestedAt: requestedAt,
    finishedAt: requestedAt,
  }).where(sql`${updateJobs.id} = ${jobId} AND ${updateJobs.status} = 'queued'`)
    .returning({ id: updateJobs.id });
  const running = await db.update(updateJobs).set({
    cancelRequestedAt: requestedAt,
    message: "Запрошено завершение задачи",
  }).where(sql`${updateJobs.id} = ${jobId}
    AND ${updateJobs.status} = 'running'
    AND ${updateJobs.cancelRequestedAt} IS NULL`)
    .returning({ id: updateJobs.id });
  if (queued.length || running.length) {
    await db.insert(updateJobEvents).values({
      jobId,
      stage: "system",
      level: "info",
      message: queued.length
        ? "Администратор отменил задачу до запуска"
        : "Администратор запросил завершение задачи",
    });
  }
  const [job] = await db.select({
    id: updateJobs.id,
    status: updateJobs.status,
    cancelRequestedAt: updateJobs.cancelRequestedAt,
  }).from(updateJobs).where(eq(updateJobs.id, jobId)).limit(1);
  return { job, requested: queued.length > 0 || running.length > 0 };
}

export async function buildServer() {
  await setDatabaseMaintenance(false);
  await ensureCatalogSummary();
  const app = Fastify({
    logger: true,
    bodyLimit: 1048576,
    trustProxy: process.env.TRUST_PROXY === "1",
  });

  await app.register(fastifySwagger, {
    mode: "static",
    specification: { document: OPENAPI_DOCUMENT },
  });
  await app.register(fastifySwaggerUi, {
    routePrefix: "/api-docs",
    uiHooks: {
      onRequest(request, reply, done) {
        const pathname = request.url.split("?", 1)[0];
        if (pathname === "/api-docs" || pathname === "/api-docs/") {
          void reply.redirect("/#/api");
          return;
        }
        done();
      },
    },
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      tryItOutEnabled: true,
      displayRequestDuration: true,
      filter: true,
    },
    staticCSP: true,
  });

  // ── Admin session auth (cookie-based) ─────────────────────────────────────
  const adminLogin    = process.env.ADMIN_LOGIN;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminLogin || !adminPassword) {
    throw new Error("ADMIN_LOGIN и ADMIN_PASSWORD должны быть заданы");
  }
  const COOKIE_NAME   = "uc_admin_session";
  const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

  // In-memory session store: token → expiry timestamp
  const sessions = new Map<string, number>();

  // Simple in-memory rate limiter for login brute-force protection
  const LOGIN_RATE_LIMIT = 10;           // max attempts
  const LOGIN_RATE_WINDOW_MS = 60_000;   // per minute
  const LOGIN_BLOCK_DURATION_MS = 300_000; // 5 min block after limit exceeded
  const loginAttempts = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();

  function purgeExpiredRateEntries(): void {
    const now = Date.now();
    for (const [ip, entry] of loginAttempts) {
      if (entry.blockedUntil < now && now - entry.windowStart > LOGIN_RATE_WINDOW_MS) {
        loginAttempts.delete(ip);
      }
    }
    for (const [ip, entry] of adminApiCalls) {
      if (now - entry.windowStart > ADMIN_API_WINDOW_MS * 2) {
        adminApiCalls.delete(ip);
      }
    }
  }
  setInterval(purgeExpiredRateEntries, 5 * 60_000).unref();

  function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    let entry = loginAttempts.get(ip);
    if (!entry) {
      entry = { count: 0, windowStart: now, blockedUntil: 0 };
      loginAttempts.set(ip, entry);
    }
    if (entry.blockedUntil > now) {
      return { allowed: false, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    if (now - entry.windowStart > LOGIN_RATE_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    if (entry.count > LOGIN_RATE_LIMIT) {
      entry.blockedUntil = now + LOGIN_BLOCK_DURATION_MS;
      return { allowed: false, retryAfter: Math.ceil(LOGIN_BLOCK_DURATION_MS / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  // Generic in-memory rate limiter for admin API endpoints
  const ADMIN_API_RATE_LIMIT = 60;
  const ADMIN_API_WINDOW_MS = 60_000;
  const adminApiCalls = new Map<string, { count: number; windowStart: number }>();

  function checkAdminApiRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    let entry = adminApiCalls.get(ip);
    if (!entry) {
      entry = { count: 0, windowStart: now };
      adminApiCalls.set(ip, entry);
    }
    if (now - entry.windowStart > ADMIN_API_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    if (entry.count > ADMIN_API_RATE_LIMIT) {
      return { allowed: false, retryAfter: Math.ceil((ADMIN_API_WINDOW_MS - (now - entry.windowStart)) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  function createSession(): string {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + COOKIE_TTL_MS);
    return token;
  }

  // Periodic session cleanup so stale tokens don't accumulate
  setInterval(() => {
    const now = Date.now();
    for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  }, 5 * 60_000).unref();

  function isValidSession(token: string | undefined): boolean {
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp || exp < Date.now()) { sessions.delete(token ?? ""); return false; }
    return true;
  }

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  const configuredBackupLimit = Number(process.env.DATABASE_BACKUP_MAX_BYTES);
  await app.register(fastifyMultipart, {
    limits: {
      files: 1,
      fields: 4,
      fileSize: Number.isFinite(configuredBackupLimit) && configuredBackupLimit > 0
        ? Math.max(100 * 1024 * 1024, configuredBackupLimit)
        : 20 * 1024 * 1024 * 1024,
    },
  });

  // Security headers
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  });

  // Hook: protect all /admin/* routes (except login pages)
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/admin")) return;
    if (url === "/admin/login" || url === "/admin/forgot-password" || url === "/admin-themes.css") return;
    const token = (req.cookies as Record<string, string>)[COOKIE_NAME];
    if (!isValidSession(token)) {
      if (url.startsWith("/admin/api/")) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      return reply.redirect("/admin/login");
    }
    if (databaseRestoreRunning && url.startsWith("/admin/api/")) {
      return reply.status(503).send({ error: "Выполняется восстановление базы данных" });
    }
    // CSRF check: verify Origin/Referer for mutating admin API requests
    if (url.startsWith("/admin/api/") && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE")) {
      const origin = req.headers.origin ?? req.headers.referer;
      if (origin) {
        try {
          const host = new URL(origin).host.toLowerCase();
          if (host !== req.host.toLowerCase()) {
            return reply.status(403).send({ error: "CSRF validation failed" });
          }
        } catch {
          return reply.status(400).send({ error: "Invalid Origin/Referer" });
        }
      }
      // Rate limit
      const { allowed, retryAfter } = checkAdminApiRateLimit(req.ip);
      if (!allowed) {
        return reply.status(429).header("Retry-After", String(retryAfter))
          .send({ error: `Слишком много запросов. Повторите через ${retryAfter} сек.` });
      }
    }
  });

  // ── Admin login pages ─────────────────────────────────────────────────────
  const [loginHtml, forgotHtml] = await Promise.all([
    readFile(join(__dirname, "../admin/login.html"), "utf-8"),
    readFile(join(__dirname, "../admin/forgot-password.html"), "utf-8"),
  ]);

  app.get("/admin/login", async (_req, reply) =>
    reply.type("text/html").send(loginHtml));

  app.get("/admin/forgot-password", async (_req, reply) =>
    reply.type("text/html").send(forgotHtml));

  app.post("/admin/login", async (req, reply) => {
    const ip = req.ip;
    const { allowed, retryAfter } = checkLoginRateLimit(ip);
    if (!allowed) {
      return reply.status(429).header("Retry-After", String(retryAfter))
        .send({ error: `Слишком много попыток входа. Повторите через ${retryAfter} сек.` });
    }
    const body = req.body as Record<string, string> | undefined ?? {};
    const { username = "", password = "" } = body;
    if (username === adminLogin && password === adminPassword) {
      const token = createSession();
      reply.setCookie(COOKIE_NAME, token, {
        path: "/admin",
        httpOnly: true,
        sameSite: "strict",
        maxAge: COOKIE_TTL_MS / 1000,
      });
      return reply.redirect("/admin");
    }
    // Wrong credentials — redirect back with error flag
    return reply.redirect("/admin/login?error=1");
  });

  app.get("/admin/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/admin" });
    return reply.redirect("/admin/login");
  });

  // ── Admin HTML ────────────────────────────────────────────────────────────
  const adminHtml = await readFile(join(__dirname, "../admin/index.html"), "utf-8");

  app.get("/admin", async (_req, reply) =>
    reply.type("text/html").send(adminHtml));

  // ── Admin API ─────────────────────────────────────────────────────────────
  app.get("/admin/api/status", async () => {
    const recentJobs = await db
      .select()
      .from(updateJobs)
      .orderBy(desc(updateJobs.id))
      .limit(5);
    const activeJobs = await db
      .select()
      .from(updateJobs)
      .where(sql`${updateJobs.status} IN ('queued', 'running')`)
      .orderBy(desc(updateJobs.id))
      .limit(5);
    const accounts = await listAccounts();
    const enabledAccounts = accounts.filter((account) => account.enabled);
    const [metricRows, publicVersionRows] = await Promise.all([
      db.execute(sql`
        SELECT
        ((SELECT count(*) FROM configurations) +
         (SELECT count(*) FROM release_projects
          WHERE config_id IS NULL AND catalog_state = 'ready'))::int AS catalog,
        ((SELECT count(*) FROM update_edges) +
         (SELECT count(*) FROM release_version_transitions))::int AS transitions,
        (SELECT count(*) FROM release_projects)::int AS projects,
        (SELECT count(*) FROM release_projects WHERE config_id IS NOT NULL)::int AS mapped,
        (SELECT count(*) FROM release_projects WHERE config_id IS NULL)::int AS unmatched,
        (SELECT count(*) FROM release_projects WHERE catalog_state = 'discovered')::int AS pending_projects,
        (SELECT count(*) FROM release_project_versions)::int AS project_versions,
        (SELECT count(*) FROM release_version_resources)::int AS resources,
        (SELECT count(DISTINCT project_version_id) FROM release_version_resources)::int AS versions_with_resources
        ,(SELECT count(*) FROM release_project_versions
          WHERE resources_sync_status = 'error')::int AS resource_errors
        ,(SELECT count(*) FROM release_project_versions
          WHERE resources_sync_status = 'error'
            AND coalesce(resources_next_attempt_at, now()) <= now())::int AS retries_due
        ,(SELECT count(*) FROM release_projects WHERE update_priority > 0)::int AS priority_projects
        ,(SELECT count(*)
          FROM release_project_versions rpv
          JOIN release_projects rp ON rp.id = rpv.project_id
          WHERE rpv.resources_synced_at IS NULL
            AND rp.exclude_from_updates = false
            AND rp.href IS NOT NULL)::int AS resource_backlog
      `),
      db.execute(publicCatalogVersionCountQuery()),
    ]);
    const metrics = (extractRows(metricRows)[0] ?? {}) as Record<string, number>;
    const versionMetrics = extractRows(publicVersionRows)[0] ?? {};
    metrics.catalog_versions = Number(versionMetrics.c ?? 0);
    metrics.catalog_versions_lst_only = Number(versionMetrics.lst_only ?? 0);
    metrics.catalog_versions_shared = Number(versionMetrics.shared ?? 0);
    metrics.catalog_versions_releases_only = Number(versionMetrics.releases_only ?? 0);

    return {
      adminLogin,
      recentJobs,
      activeJobs,
      update: {
        running: activeJobs.length > 0,
        jobId: activeJobs[0]?.id ?? null,
        progress: activeJobs[0] ?? null,
      },
      accounts: {
        total: accounts.length,
        enabled: enabledAccounts.length,
        errors: accounts.filter((account) => account.last_status === "error").length,
      },
      metrics,
    };
  });

  app.get("/admin/api/logs", async (req) => {
    const limit = Math.min(Number((req.query as Record<string, string>).limit ?? 50), 200);
    const jobs = await db
      .select()
      .from(updateJobs)
      .orderBy(desc(updateJobs.id))
      .limit(limit);
    return { jobs };
  });

  app.get("/admin/api/jobs/active", async () => {
    const jobs = await db
      .select()
      .from(updateJobs)
      .where(sql`${updateJobs.status} IN ('queued', 'running')`)
      .orderBy(desc(updateJobs.id))
      .limit(5);
    return { jobs };
  });

  app.get("/admin/api/jobs/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: "Некорректный id" });
    const [job] = await db.select().from(updateJobs).where(eq(updateJobs.id, id)).limit(1);
    if (!job) return reply.status(404).send({ error: "Задача не найдена" });
    const events = (await db.select().from(updateJobEvents)
      .where(eq(updateJobEvents.jobId, id))
      .orderBy(desc(updateJobEvents.id))
      .limit(2000))
      .reverse();
    const runRows = await db.execute(sql`
      SELECT * FROM import_runs
      WHERE started_at >= ${job.startedAt}
        AND started_at <= coalesce(${job.finishedAt}, now()) + interval '5 seconds'
        AND source <> 'account-check'
      ORDER BY id
    `);
    return { job, events, runs: extractRows(runRows) };
  });

  app.post("/admin/api/jobs/:id/cancel", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: "Некорректный id" });
    }
    const result = await requestUpdateJobCancellation(id);
    if (!result.job) return reply.status(404).send({ error: "Задача не найдена" });
    if (result.job.status !== "running" && result.job.status !== "queued" && !result.requested) {
      return reply.status(409).send({ error: "Задача уже завершена" });
    }
    return {
      requested: result.requested,
      cancelRequestedAt: result.job.cancelRequestedAt,
    };
  });

  app.delete("/admin/api/jobs/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: "Некорректный id" });
    }
    const result = await db.execute(sql`
      DELETE FROM update_jobs
      WHERE id = ${id} AND status NOT IN ('queued', 'running')
      RETURNING id
    `);
    const deleted = extractRows(result) as unknown[];
    if (!deleted.length) {
      return reply.status(409).send({ error: "Выполняющуюся или отсутствующую задачу удалить нельзя" });
    }
    return { deleted: true };
  });

  app.delete("/admin/api/logs", async () => {
    const result = await db.execute(sql`
      DELETE FROM update_jobs
      WHERE status NOT IN ('queued', 'running')
      RETURNING id
    `);
    return { deleted: (extractRows(result) as unknown[]).length };
  });

  // ── Admin API: ITS accounts ───────────────────────────────────────────────
  app.get("/admin/api/accounts", async () => ({ accounts: await listAccounts() }));

  app.post("/admin/api/accounts", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created = await createAccount({
        label: String(body.label ?? ""),
        login: String(body.login ?? ""),
        password: String(body.password ?? ""),
        enabled: body.enabled !== false,
        priority: Number(body.priority ?? 100),
        requestConcurrency: Number(body.requestConcurrency ?? 4),
      });
      return reply.status(201).send(created);
    } catch (error) {
      const message = (error as Error).message;
      const status = /unique|duplicate/i.test(message) ? 409 : 400;
      return reply.status(status).send({ error: message });
    }
  });

  app.put("/admin/api/accounts/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: "Некорректный id" });
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return await updateAccount(id, {
        label: String(body.label ?? ""),
        login: String(body.login ?? ""),
        password: body.password ? String(body.password) : undefined,
        enabled: body.enabled !== false,
        priority: Number(body.priority ?? 100),
        requestConcurrency: Number(body.requestConcurrency ?? 4),
      });
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.delete("/admin/api/accounts/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: "Некорректный id" });
    const deleted = await deleteAccount(id);
    return deleted ? { deleted: true } : reply.status(404).send({ error: "Учётная запись не найдена" });
  });

  app.post("/admin/api/accounts/:id/test", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    const account = Number.isInteger(id) ? await accountCredentials(id) : null;
    if (!account) return reply.status(404).send({ error: "Учётная запись не найдена" });
    const startedAt = new Date();
    try {
      const session = new ReleasesSession({ concurrency: account.requestConcurrency });
      await session.login(account.login, account.password);
      const projects = parseTotalPage(await session.get(TOTAL_CATALOG_PATH));
      if (!projects.length) {
        throw new Error("Страница /total не содержит конфигураций — проверьте доступ аккаунта ИТС");
      }
      const { available, unavailable, mapped } = await syncAccountProjectAccess(id, projects);
      await db.insert(importRuns).values({
        accountId: id,
        source: "account-check",
        fileSha256: "",
        configsFound: projects.length,
        edgesUpserted: available,
        edgesUnchanged: unavailable,
        status: "ok",
        message: `projects=${projects.length} available=${available} unavailable=${unavailable} mapped=${mapped}`,
        startedAt,
        finishedAt: new Date(),
      });
      await markAccountSuccess(id);
      await touchCatalogRevision();
      return {
        ok: true,
        projects: projects.length,
        available,
        unavailable,
        mapped,
      };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      try {
        await db.insert(importRuns).values({
          accountId: id,
          source: "account-check",
          fileSha256: "",
          status: "error",
          message: message.slice(0, 2000),
          startedAt,
          finishedAt: new Date(),
        });
        await markAccountError(id, error);
      } catch (persistError) {
        req.log.error(persistError, "failed to persist ITS account check result");
      }
      return reply.status(502).send({ error: message });
    }
  });

  // ── Admin API: project ↔ LST mapping ──────────────────────────────────────
  app.get("/admin/api/config-options", async (req) => {
    const q = String((req.query as Record<string, string>).q ?? "").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    const qCompact = q.replace(/[^a-zа-я0-9]+/gi, "");
    const result = await db.execute(sql`
      SELECT id, name, coalesce(display_name_override, display_name, name) AS display_name
      FROM configurations
      WHERE ${q ? sql`
        regexp_replace(replace(lower(name), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`}
        OR regexp_replace(replace(lower(coalesce(display_name, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`}
        OR regexp_replace(replace(lower(coalesce(display_name_override, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`}
      ` : sql`true`}
      ORDER BY coalesce(display_name_override, display_name, name)
      LIMIT 100
    `);
    return { configurations: extractRows(result) };
  });

  app.patch("/admin/api/catalog/projects/:id/mapping", async (req, reply) => {
    const projectId = Number((req.params as Record<string, string>).id);
    const configIdRaw = (req.body as Record<string, unknown>)?.configId;
    const configId = configIdRaw === null || configIdRaw === "" ? null : Number(configIdRaw);
    if (!Number.isInteger(projectId) || (configId !== null && !Number.isInteger(configId))) {
      return reply.status(400).send({ error: "Некорректные параметры" });
    }
    const [project] = await db.select({
      id: releaseProjects.id,
      href: releaseProjects.href,
      configId: releaseProjects.configId,
    }).from(releaseProjects).where(eq(releaseProjects.id, projectId)).limit(1);
    if (!project) return reply.status(404).send({ error: "Проект releases не найден" });
    if (configId !== null) {
      const exists = await db.select({ id: configurations.id }).from(configurations)
        .where(eq(configurations.id, configId)).limit(1);
      if (!exists.length) return reply.status(404).send({ error: "Конфигурация LST не найдена" });
    }
    await db.update(releaseProjects).set({
      configId,
      mappingMode: configId === null ? "unmatched" : "manual",
      mappingConfidence: configId === null ? 0 : 100,
    }).where(eq(releaseProjects.id, projectId));
    if (project.configId && project.configId !== configId) {
      await db.update(configurations).set({ releasesHref: null }).where(sql`
        ${configurations.id} = ${project.configId}
        AND ${configurations.releasesHref} IS NOT DISTINCT FROM ${project.href}
      `);
    }
    if (configId !== null && project.href) {
      await db.update(configurations).set({ releasesHref: project.href })
        .where(eq(configurations.id, configId));
    }
    await touchCatalogRevision();
    return { updated: true };
  });

  // ── Admin API: catalog visibility, overrides and selective cleanup ───────
  app.get("/admin/api/catalog", async (req) => {
    const query = req.query as Record<string, string>;
    const q = String(query.q ?? "").trim().toLocaleLowerCase("ru-RU");
    const type = String(query.type ?? "all");
    const mapping = String(query.mapping ?? "all");
    const typeFilter = type === "configuration"
      ? sql`entity_type = 'configuration'`
      : type === "project"
        ? sql`entity_type = 'project'`
        : sql`true`;
    const mappingFilter = mapping === "unmatched"
      ? sql`entity_type = 'project' AND config_id IS NULL`
      : mapping === "mapped"
        ? sql`entity_type = 'project' AND config_id IS NOT NULL`
        : mapping === "manual"
          ? sql`entity_type = 'project' AND mapping_mode = 'manual'`
          : mapping === "auto"
            ? sql`entity_type = 'project' AND mapping_mode = 'auto'`
            : sql`true`;
    const searchFilter = q
      ? sql`(lower(display_name) LIKE ${`%${q}%`} OR lower(base_name) LIKE ${`%${q}%`}
          OR lower(coalesce(href, '')) LIKE ${`%${q}%`}
          OR lower(coalesce(config_name, '')) LIKE ${`%${q}%`}
          OR lower(coalesce(config_display_name, '')) LIKE ${`%${q}%`})`
      : sql`true`;
    const result = await db.execute(sql`
      WITH entities AS (
        SELECT 'configuration'::text AS entity_type, c.id, c.name AS base_name,
          coalesce(c.display_name_override, c.display_name, c.name) AS display_name,
          coalesce(c.vendor_override, c.vendor) AS vendor,
          coalesce(c.group_name_override, c.group_name) AS group_name,
          c.releases_href AS href, c.is_hidden, c.exclude_from_updates,
          'ready'::text AS catalog_state,
          (SELECT count(DISTINCT version) FROM (
            SELECT from_version AS version FROM update_edges WHERE config_id = c.id
            UNION SELECT to_version FROM update_edges WHERE config_id = c.id
          ) versions)::int AS version_count,
          NULL::int AS config_id, 'not_applicable'::text AS mapping_mode,
          0::int AS mapping_confidence, NULL::text AS config_name,
          NULL::text AS config_display_name
        FROM configurations c
        UNION ALL
        SELECT 'project'::text, rp.id, rp.identity_key,
          coalesce(rp.display_name_override, rp.display_name), '1С'::text,
          coalesce(rp.group_name_override, rp.group_name), rp.href,
          rp.is_hidden, rp.exclude_from_updates, rp.catalog_state,
          (SELECT count(*) FROM release_project_versions WHERE project_id = rp.id)::int,
          rp.config_id, rp.mapping_mode, rp.mapping_confidence,
          c.name, coalesce(c.display_name_override, c.display_name, c.name)
        FROM release_projects rp
        LEFT JOIN configurations c ON c.id = rp.config_id
      )
      SELECT * FROM entities
      WHERE ${typeFilter} AND ${mappingFilter} AND ${searchFilter}
      ORDER BY display_name, entity_type
      LIMIT 300
    `);
    return { entities: extractRows(result) };
  });

  app.get("/admin/api/catalog/configurations/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const result = await db.execute(sql`
      SELECT c.*,
        coalesce(c.display_name_override, c.display_name, c.name) AS effective_display_name,
        coalesce(c.vendor_override, c.vendor) AS effective_vendor,
        coalesce(c.group_name_override, c.group_name) AS effective_group_name,
        coalesce(c.region_override, c.region) AS effective_region,
        (SELECT count(*) FROM update_edges WHERE config_id = c.id)::int AS edge_count,
        (SELECT count(*) FROM (
          SELECT from_version AS version FROM update_edges WHERE config_id = c.id
          UNION
          SELECT to_version FROM update_edges WHERE config_id = c.id
        ) versions)::int AS version_count,
        coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', rp.id,
            'display_name', coalesce(rp.display_name_override, rp.display_name),
            'href', rp.href,
            'exclude_from_updates', rp.exclude_from_updates
          ) ORDER BY coalesce(rp.display_name_override, rp.display_name), rp.id)
          FROM release_projects rp
          WHERE rp.config_id = c.id
        ), '[]'::jsonb) AS linked_projects
      FROM configurations c WHERE c.id = ${id} LIMIT 1
    `);
    const entity = extractRows(result)[0];
    if (!entity) return reply.status(404).send({ error: "Конфигурация не найдена" });
    return { entity };
  });

  app.get("/admin/api/catalog/configurations/:id/versions", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    const q = String((req.query as Record<string, string>).q ?? "").trim().toLowerCase();
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const result = await db.execute(sql`
      WITH versions AS (
        SELECT from_version AS version FROM update_edges WHERE config_id = ${id}
        UNION
        SELECT to_version FROM update_edges WHERE config_id = ${id}
      ),
      incoming AS (
        SELECT to_version AS version,
          count(*)::int AS incoming_count,
          count(*) FILTER (WHERE cfu_path <> '')::int AS cfu_count
        FROM update_edges
        WHERE config_id = ${id}
        GROUP BY to_version
      ),
      outgoing AS (
        SELECT from_version AS version, count(*)::int AS outgoing_count
        FROM update_edges
        WHERE config_id = ${id}
        GROUP BY from_version
      )
      SELECT v.version, vm.release_date::text, vm.min_platform, vm.file_size_bytes,
        coalesce(i.incoming_count, 0)::int AS incoming_count,
        coalesce(o.outgoing_count, 0)::int AS outgoing_count,
        coalesce(i.cfu_count, 0)::int AS cfu_count
      FROM versions v
      LEFT JOIN version_meta vm ON vm.config_id = ${id} AND vm.version = v.version
      LEFT JOIN incoming i ON i.version = v.version
      LEFT JOIN outgoing o ON o.version = v.version
      WHERE ${q ? sql`lower(v.version) LIKE ${`%${q}%`}` : sql`true`}
      LIMIT 2000
    `);
    const versions = extractRows(result) as Array<Record<string, unknown>>;
    versions.sort((a, b) => compareReleaseVersions(String(b.version), String(a.version)));
    return { versions };
  });

  app.patch("/admin/api/catalog/configurations/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const updated = await db.update(configurations).set({
      displayNameOverride: optionalText(body.displayNameOverride),
      vendorOverride: optionalText(body.vendorOverride),
      groupNameOverride: optionalText(body.groupNameOverride),
      regionOverride: optionalText(body.regionOverride),
      isHidden: body.isHidden === true,
      excludeFromUpdates: body.excludeFromUpdates === true,
    }).where(eq(configurations.id, id)).returning({ id: configurations.id });
    if (!updated.length) return reply.status(404).send({ error: "Конфигурация не найдена" });
    await touchCatalogRevision(true);
    return { updated: true };
  });

  app.delete("/admin/api/catalog/configurations/:id/data", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const exists = await client.query("SELECT id FROM configurations WHERE id=$1", [id]);
      if (!exists.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Конфигурация не найдена" });
      }
      const edgeResult = await client.query("DELETE FROM update_edges WHERE config_id=$1", [id]);
      await client.query("DELETE FROM version_meta WHERE config_id=$1", [id]);
      await client.query("DELETE FROM patches WHERE config_id=$1", [id]);
      await client.query("UPDATE release_projects SET config_id=NULL, mapping_mode='unmatched', mapping_confidence=0 WHERE config_id=$1", [id]);
      await client.query("UPDATE configurations SET is_hidden=true, exclude_from_updates=true, releases_href=NULL WHERE id=$1", [id]);
      await client.query("COMMIT");
      await touchCatalogRevision(true);
      return { deletedEdges: edgeResult.rowCount ?? 0, hidden: true, excluded: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/admin/api/catalog/projects/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const result = await db.execute(sql`
      SELECT rp.*,
        coalesce(rp.display_name_override, rp.display_name) AS effective_display_name,
        coalesce(rp.group_name_override, rp.group_name) AS effective_group_name,
        c.name AS config_name,
        coalesce(c.display_name_override, c.display_name, c.name) AS config_display_name,
        (SELECT count(*) FROM release_project_versions WHERE project_id=rp.id)::int AS version_count
      FROM release_projects rp
      LEFT JOIN configurations c ON c.id = rp.config_id
      WHERE rp.id=${id} LIMIT 1
    `);
    const entity = extractRows(result)[0];
    if (!entity) return reply.status(404).send({ error: "Релиз не найден" });
    return { entity };
  });

  app.patch("/admin/api/catalog/projects/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const updated = await db.update(releaseProjects).set({
      displayNameOverride: optionalText(body.displayNameOverride),
      groupNameOverride: optionalText(body.groupNameOverride),
      isHidden: body.isHidden === true,
      excludeFromUpdates: body.excludeFromUpdates === true,
      updatePriority: body.updatePriority === true ? 100 : 0,
    }).where(eq(releaseProjects.id, id)).returning({
      id: releaseProjects.id,
      href: releaseProjects.href,
      configId: releaseProjects.configId,
    });
    if (!updated.length) return reply.status(404).send({ error: "Релиз не найден" });
    if (updated[0].configId) {
      await db.update(configurations).set({
        releasesHref: body.isHidden === true ? null : updated[0].href,
      }).where(eq(configurations.id, updated[0].configId));
    }
    await touchCatalogRevision();
    return { updated: true };
  });

  app.delete("/admin/api/catalog/projects/:id/data", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query("SELECT href, config_id FROM release_projects WHERE id=$1", [id]);
      if (!project.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Релиз не найден" });
      }
      const versionResult = await client.query("DELETE FROM release_project_versions WHERE project_id=$1", [id]);
      await client.query(`UPDATE release_projects SET latest_version=NULL, latest_date=NULL,
        transition_mode='unknown', catalog_state='discovered',
        is_hidden=true, exclude_from_updates=true WHERE id=$1`, [id]);
      if (project.rows[0].config_id) {
        await client.query("UPDATE configurations SET releases_href=NULL WHERE id=$1", [project.rows[0].config_id]);
      }
      await client.query("COMMIT");
      await touchCatalogRevision();
      return { deletedVersions: versionResult.rowCount ?? 0, hidden: true, excluded: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/admin/api/catalog/projects/:id/versions", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    const q = String((req.query as Record<string, string>).q ?? "").trim().toLowerCase();
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const result = await db.execute(sql`
      SELECT rpv.id, rpv.version, rpv.release_date::text, rpv.min_platform,
        rpv.recommended_platform, rpv.file_size_bytes, rpv.is_hidden,
        rpv.is_test,
        rpv.resources_synced_at, rpv.resources_last_attempt_at,
        rpv.resources_next_attempt_at, rpv.resources_sync_status,
        rpv.resources_sync_attempts, rpv.resources_last_error,
        rpv.release_date_override::text, rpv.min_platform_override,
        rpv.recommended_platform_override, rpv.file_size_bytes_override,
        coalesce(rpv.release_date_override, rpv.release_date)::text AS effective_release_date,
        coalesce(rpv.min_platform_override, rpv.min_platform) AS effective_min_platform,
        coalesce(rpv.recommended_platform_override, rpv.recommended_platform) AS effective_recommended_platform,
        coalesce(rpv.file_size_bytes_override, rpv.file_size_bytes) AS effective_file_size_bytes,
        (SELECT count(*) FROM release_version_resources WHERE project_version_id=rpv.id)::int AS resource_count
      FROM release_project_versions rpv
      WHERE rpv.project_id=${id} AND ${q ? sql`lower(rpv.version) LIKE ${`%${q}%`}` : sql`true`}
      ORDER BY coalesce(rpv.release_date_override, rpv.release_date) DESC NULLS LAST, rpv.version DESC
      LIMIT 300
    `);
    return { versions: extractRows(result) };
  });

  app.patch("/admin/api/catalog/versions/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    try {
      const updated = await db.update(releaseProjectVersions).set({
        isHidden: body.isHidden === true,
        releaseDateOverride: optionalDate(body.releaseDateOverride),
        minPlatformOverride: optionalText(body.minPlatformOverride),
        recommendedPlatformOverride: optionalText(body.recommendedPlatformOverride),
        fileSizeBytesOverride: optionalInteger(body.fileSizeBytesOverride),
        updatedAt: new Date(),
      }).where(eq(releaseProjectVersions.id, id)).returning({ id: releaseProjectVersions.id });
      if (!updated.length) return reply.status(404).send({ error: "Версия не найдена" });
      await touchCatalogRevision();
      return { updated: true };
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.delete("/admin/api/catalog/versions/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const deleted = await db.delete(releaseProjectVersions).where(eq(releaseProjectVersions.id, id))
      .returning({ id: releaseProjectVersions.id });
    if (!deleted.length) return reply.status(404).send({ error: "Версия не найдена" });
    await touchCatalogRevision();
    return { deleted: true };
  });

  app.get("/admin/api/catalog/versions/:id/resources", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const result = await db.execute(sql`
      SELECT rvr.*, coalesce(rvr.title_override, rvr.title) AS effective_title,
        coalesce(rvr.href_override, rvr.href) AS effective_href,
        coalesce(rvr.file_size_bytes_override, rvr.file_size_bytes) AS effective_file_size_bytes,
        coalesce(rvr.published_at_override, rvr.published_at)::text AS effective_published_at,
        coalesce(rvr.sha512_override, rvr.sha512) AS effective_sha512
      FROM release_version_resources rvr
      WHERE rvr.project_version_id=${id}
      ORDER BY rvr.sort_order, rvr.id
    `);
    return { resources: extractRows(result) };
  });

  app.patch("/admin/api/catalog/resources/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    try {
      const hrefOverride = optionalText(body.hrefOverride);
      if (hrefOverride && !/^(?:https?:\/\/|\/)/i.test(hrefOverride)) {
        throw new Error("Ссылка должна начинаться с http://, https:// или /");
      }
      const updated = await db.update(releaseVersionResources).set({
        isHidden: body.isHidden === true,
        titleOverride: optionalText(body.titleOverride),
        hrefOverride,
        fileSizeBytesOverride: optionalInteger(body.fileSizeBytesOverride),
        publishedAtOverride: optionalDate(body.publishedAtOverride),
        sha512Override: optionalText(body.sha512Override),
        updatedAt: new Date(),
      }).where(eq(releaseVersionResources.id, id)).returning({ id: releaseVersionResources.id });
      if (!updated.length) return reply.status(404).send({ error: "Ссылка не найдена" });
      await touchCatalogRevision();
      return { updated: true };
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.delete("/admin/api/catalog/resources/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: "Некорректный id" });
    const deleted = await db.delete(releaseVersionResources).where(eq(releaseVersionResources.id, id))
      .returning({ id: releaseVersionResources.id });
    if (!deleted.length) return reply.status(404).send({ error: "Ссылка не найдена" });
    await touchCatalogRevision();
    return { deleted: true };
  });

  // ── Admin API: release changes feed ─────────────────────────────────────
  const releaseChangeTypes = new Set([
    "new_version",
    "platform_changed",
    "resource_added",
    "patch_added",
  ]);
  let releaseChangeBackfillRunning = false;

  async function releaseChangeValues(body: Record<string, unknown>) {
    const projectId = Number(body.projectId);
    const eventType = String(body.eventType ?? "");
    const version = optionalText(body.version);
    const details = body.details;
    const occurredAt = new Date(String(body.occurredAt ?? ""));
    if (!Number.isSafeInteger(projectId) || projectId < 1) throw new Error("Выберите конфигурацию");
    if (!releaseChangeTypes.has(eventType)) throw new Error("Выберите тип события");
    if (!version) throw new Error("Укажите версию");
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      throw new Error("Некорректные данные события");
    }
    if (Number.isNaN(occurredAt.getTime())) throw new Error("Укажите дату события");
    const [project] = await db.select({
      id: releaseProjects.id,
      configId: releaseProjects.configId,
    }).from(releaseProjects).where(eq(releaseProjects.id, projectId)).limit(1);
    if (!project) throw new Error("Конфигурация не найдена");
    const [projectVersion] = await db.select({ id: releaseProjectVersions.id })
      .from(releaseProjectVersions)
      .where(sql`${releaseProjectVersions.projectId} = ${projectId} AND ${releaseProjectVersions.version} = ${version}`)
      .limit(1);
    return {
      eventType,
      projectId,
      projectVersionId: projectVersion?.id ?? null,
      configId: project.configId,
      version,
      isTest: body.isTest === true,
      details: details as Record<string, unknown>,
      occurredAt,
    };
  }

  app.get("/admin/api/release-changes/projects", async () => {
    const result = await db.execute(sql`
      SELECT rp.id, rp.config_id,
        coalesce(rp.display_name_override, rp.display_name) AS display_name,
        rp.href, regexp_replace(coalesce(rp.href, ''), '^/project/', '') AS nick,
        c.name AS config_name
      FROM release_projects rp
      LEFT JOIN configurations c ON c.id = rp.config_id
      ORDER BY coalesce(rp.display_name_override, rp.display_name), rp.id
      LIMIT 5000
    `);
    return { projects: extractRows(result) };
  });

  app.get("/admin/api/release-changes", async (req) => {
    const query = req.query as Record<string, string>;
    const requestedLimit = Number(query.limit ?? "50");
    const requestedOffset = Number(query.offset ?? "0");
    const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 50;
    const offset = Number.isSafeInteger(requestedOffset) ? Math.max(0, requestedOffset) : 0;
    const eventType = String(query.type ?? "").trim();
    const q = String(query.q ?? "").trim().toLocaleLowerCase("ru-RU");
    const filters = [sql`true`];
    if (releaseChangeTypes.has(eventType)) filters.push(sql`e.event_type = ${eventType}`);
    if (q) filters.push(sql`(
      lower(coalesce(rp.display_name_override, rp.display_name)) LIKE ${`%${q}%`}
      OR lower(coalesce(rp.href, '')) LIKE ${`%${q}%`}
      OR lower(coalesce(e.version, '')) LIKE ${`%${q}%`}
    )`);
    const where = sql.join(filters, sql` AND `);
    const result = await db.execute(sql`
      SELECT e.id, e.event_type, e.project_id, e.project_version_id, e.config_id,
        e.version, e.is_test, e.details, e.occurred_at, e.detected_at,
        coalesce(rp.display_name_override, rp.display_name) AS project_name,
        regexp_replace(coalesce(rp.href, ''), '^/project/', '') AS project_nick
      FROM release_change_events e
      JOIN release_projects rp ON rp.id = e.project_id
      WHERE ${where}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const countResult = await db.execute(sql`
      SELECT count(*)::int AS count
      FROM release_change_events e
      JOIN release_projects rp ON rp.id = e.project_id
      WHERE ${where}
    `);
    return {
      items: extractRows(result),
      count: Number((extractRows(countResult)[0] as Record<string, unknown> | undefined)?.count ?? 0),
      offset,
      limit,
    };
  });

  app.post("/admin/api/release-changes/backfill", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const all = body.all === true;
    const rawProjectIds = Array.isArray(body.projectIds) ? body.projectIds : [];
    const projectIds = [...new Set(rawProjectIds.map(Number))];
    if (projectIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      return reply.status(400).send({ error: "Некорректный список конфигураций" });
    }
    if (all === Boolean(projectIds.length)) {
      return reply.status(400).send({ error: "Выберите все конфигурации или хотя бы одну конкретную" });
    }
    if (releaseChangeBackfillRunning) {
      return reply.status(409).send({ error: "Заполнение ленты уже выполняется" });
    }
    releaseChangeBackfillRunning = true;
    try {
      return await backfillChangeFeed({
        all,
        projects: projectIds.map(String),
        dryRun: body.dryRun === true,
        help: false,
      });
    } catch (error) {
      req.log.error(error, "release change feed backfill failed");
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Не удалось заполнить ленту",
      });
    } finally {
      releaseChangeBackfillRunning = false;
    }
  });

  app.post("/admin/api/release-changes", async (req, reply) => {
    try {
      const values = await releaseChangeValues((req.body ?? {}) as Record<string, unknown>);
      const [created] = await db.insert(releaseChangeEvents).values({
        ...values,
        dedupeKey: `manual:${randomUUID()}`,
        detectedAt: new Date(),
      }).returning({ id: releaseChangeEvents.id });
      return reply.status(201).send({ created: true, id: created!.id });
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.patch("/admin/api/release-changes/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.status(400).send({ error: "Некорректный id" });
    try {
      const values = await releaseChangeValues((req.body ?? {}) as Record<string, unknown>);
      const updated = await db.update(releaseChangeEvents).set(values)
        .where(eq(releaseChangeEvents.id, id)).returning({ id: releaseChangeEvents.id });
      if (!updated.length) return reply.status(404).send({ error: "Событие не найдено" });
      return { updated: true };
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.delete("/admin/api/release-changes/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.status(400).send({ error: "Некорректный id" });
    const deleted = await db.delete(releaseChangeEvents).where(eq(releaseChangeEvents.id, id))
      .returning({ id: releaseChangeEvents.id });
    if (!deleted.length) return reply.status(404).send({ error: "Событие не найдено" });
    return { deleted: true };
  });

  app.delete("/admin/api/release-changes", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.confirmation !== "ОЧИСТИТЬ ЛЕНТУ") {
      return reply.status(400).send({ error: "Введите подтверждение «ОЧИСТИТЬ ЛЕНТУ»" });
    }
    const result = await db.execute(sql`
      WITH deleted AS (DELETE FROM release_change_events RETURNING 1)
      SELECT count(*)::int AS count FROM deleted
    `);
    return {
      cleared: true,
      deleted: Number((extractRows(result)[0] as Record<string, unknown> | undefined)?.count ?? 0),
    };
  });

  app.get("/admin/api/update/targets", async (req) => {
    const q = String((req.query as Record<string, string>).q ?? "").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    const qCompact = q.replace(/[^a-zа-я0-9]+/gi, "");
    const searchFilter = q
      ? sql`(
          regexp_replace(replace(lower(rp.display_name), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`} OR
          regexp_replace(replace(lower(rp.group_name), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`} OR
          regexp_replace(replace(lower(coalesce(rp.href, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`} OR
          regexp_replace(replace(lower(coalesce(c.name, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`} OR
          regexp_replace(replace(lower(coalesce(c.display_name, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') LIKE ${`%${qCompact}%`}
        )`
      : sql`true`;
    const projectRows = await db.execute(sql`
      SELECT
        rp.id, rp.display_name, rp.group_name, rp.href, rp.latest_version, rp.update_priority,
        coalesce(
          jsonb_agg(
            jsonb_build_object('id', ia.id, 'label', ia.label, 'status', apa.status)
            ORDER BY ia.priority, ia.id
          ) FILTER (WHERE ia.id IS NOT NULL),
          '[]'::jsonb
        ) AS accounts
      FROM release_projects rp
      LEFT JOIN configurations c ON c.id = rp.config_id
      LEFT JOIN account_project_access apa ON apa.project_id = rp.id
      LEFT JOIN its_accounts ia ON ia.id = apa.account_id AND ia.enabled = true
      WHERE ${searchFilter} AND rp.exclude_from_updates = false
      GROUP BY rp.id
      ORDER BY rp.display_name, rp.id
      LIMIT 200
    `);
    const accounts = (await listAccounts())
      .filter((account) => account.enabled)
      .map((account) => ({
        id: account.id,
        label: account.label,
        priority: account.priority,
      }));
    return { projects: extractRows(projectRows), accounts };
  });

  app.get("/admin/api/settings/logging", async () => ({
    level: await getUpdateLogLevel(),
    concurrency: await getUpdateConcurrency(),
    smart: await getSmartRefreshPolicy(),
  }));

  app.put("/admin/api/settings/logging", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const level = body?.level;
    const concurrency = Number(body?.concurrency);
    const currentPolicy = await getSmartRefreshPolicy();
    const smartBody = body?.smart as Record<string, unknown> ?? {};
    const smart = {
      latestIntervalHours: Number(smartBody.latestIntervalHours ?? currentPolicy.latestIntervalHours),
      recentIntervalDays: Number(smartBody.recentIntervalDays ?? currentPolicy.recentIntervalDays),
      archiveIntervalDays: Number(smartBody.archiveIntervalDays ?? currentPolicy.archiveIntervalDays),
      recentReleaseAgeDays: Number(smartBody.recentReleaseAgeDays ?? currentPolicy.recentReleaseAgeDays),
      retryBaseMinutes: Number(smartBody.retryBaseMinutes ?? currentPolicy.retryBaseMinutes),
      archivePageLimit: Number(smartBody.archivePageLimit ?? currentPolicy.archivePageLimit),
      metadataCacheDays: Number(smartBody.metadataCacheDays ?? currentPolicy.metadataCacheDays),
    };
    if (!isUpdateLogLevel(level)) {
      return reply.status(400).send({ error: "Неизвестный уровень журналирования" });
    }
    if (!isUpdateConcurrency(concurrency)) {
      return reply.status(400).send({ error: "Параллельность должна быть от 1 до 8" });
    }
    if (!isSmartRefreshPolicy(smart)) {
      return reply.status(400).send({ error: "Проверьте интервалы умного обновления" });
    }
    await db
      .insert(settings)
      .values({ key: "update_log_level", value: level, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: level, updatedAt: new Date() },
      });
    await db
      .insert(settings)
      .values({ key: "update_request_concurrency", value: String(concurrency), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: String(concurrency), updatedAt: new Date() },
      });
    const smartSettings = [
      ["update_latest_interval_hours", smart.latestIntervalHours],
      ["update_recent_interval_days", smart.recentIntervalDays],
      ["update_archive_interval_days", smart.archiveIntervalDays],
      ["update_recent_release_age_days", smart.recentReleaseAgeDays],
      ["update_retry_base_minutes", smart.retryBaseMinutes],
      ["update_archive_page_limit", smart.archivePageLimit],
      ["update_metadata_cache_days", smart.metadataCacheDays],
    ] as const;
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [key, value] of smartSettings) {
        await tx.insert(settings)
          .values({ key, value: String(value), updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { value: String(value), updatedAt: now } });
      }
    });
    return { saved: true, level, concurrency, smart };
  });

  app.put("/admin/api/update/priorities", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.projectIds) || !body.projectIds.length) {
      return reply.status(400).send({ error: "Выберите хотя бы одну конфигурацию" });
    }
    const projectIds: number[] = [...new Set<number>(
      (body.projectIds as unknown[]).map((value: unknown) => Number(value)),
    )];
    if (projectIds.length > 100 || projectIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      return reply.status(400).send({ error: "Некорректный список конфигураций" });
    }
    const updated = await db.update(releaseProjects)
      .set({ updatePriority: body.priority === false ? 0 : 100 })
      .where(inArray(releaseProjects.id, projectIds))
      .returning({ id: releaseProjects.id });
    return { updated: updated.length, priority: body.priority !== false };
  });

  app.post("/admin/api/update", async (req, reply) => {
    if (await databaseMaintenanceActive()) {
      return reply.status(503).send({ error: "Выполняется восстановление базы данных" });
    }
    const [databaseActiveJob] = await db.select({ id: updateJobs.id })
      .from(updateJobs)
      .where(sql`${updateJobs.status} IN ('queued', 'running')`)
      .orderBy(desc(updateJobs.id))
      .limit(1);
    if (databaseActiveJob) {
      return reply.status(409).send({
        error: "Уже выполняется фоновая или ручная задача обновления",
        jobId: databaseActiveJob.id,
      });
    }
    const accounts = await listAccounts();
    const enabledAccounts = accounts.filter((account) => account.enabled);
    if (!enabledAccounts.length) {
      return reply.status(400).send({ error: "Нет включённых учётных записей ИТС" });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.mode === undefined || body.mode === null || body.mode === ""
      ? "full"
      : String(body.mode);
    if (mode !== "full" && mode !== "lst" && mode !== "archive") {
      return reply.status(400).send({ error: "Неизвестный режим обновления" });
    }
    const hasProjectIds = Object.prototype.hasOwnProperty.call(body, "projectIds");
    if (body.forceAllResources !== undefined && typeof body.forceAllResources !== "boolean") {
      return reply.status(400).send({ error: "Признак принудительного обновления имеет неверный формат" });
    }
    const forceAllResources = body.forceAllResources === true;
    if (hasProjectIds && !Array.isArray(body.projectIds)) {
      return reply.status(400).send({ error: "Список конфигураций имеет неверный формат" });
    }
    const projectIdsRaw = hasProjectIds
      ? body.projectIds
      : (body.projectId === undefined || body.projectId === null || body.projectId === "" ? [] : [body.projectId]);
    const accountIdRaw = body.accountId;
    const projectIds = [...new Set((projectIdsRaw as unknown[]).map((value) => Number(value)))];
    let targets: UpdateTarget[] | undefined;
    if (hasProjectIds && !projectIds.length && !forceAllResources) {
      return reply.status(400).send({ error: "Выберите хотя бы одну конфигурацию" });
    }
    if ((mode === "lst" || mode === "archive") && projectIds.length) {
      return reply.status(400).send({
        error: mode === "lst"
          ? "Для обновления LST не выбираются отдельные конфигурации"
          : "Для заполнения архива не выбираются отдельные конфигурации",
      });
    }
    if (forceAllResources && mode !== "full") {
      return reply.status(400).send({
        error: "Принудительная проверка всех релизов несовместима с выбранным режимом обновления",
      });
    }
    if (projectIds.length) {
      if (projectIds.length > 100 || projectIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        return reply.status(400).send({ error: "Список конфигураций содержит некорректные значения" });
      }
      const projects = await db.select({
        id: releaseProjects.id,
        displayName: releaseProjects.displayName,
        excludeFromUpdates: releaseProjects.excludeFromUpdates,
      }).from(releaseProjects).where(inArray(releaseProjects.id, projectIds));
      const projectsById = new Map(projects.map((project) => [Number(project.id), project]));
      const missingIds = projectIds.filter((id) => !projectsById.has(id));
      if (missingIds.length) {
        return reply.status(404).send({ error: "Одна или несколько выбранных конфигураций не найдены" });
      }
      const excluded = projects.filter((project) => project.excludeFromUpdates);
      if (excluded.length) {
        return reply.status(400).send({
          error: `Исключены из обновления: ${excluded.map((project) => project.displayName).join(", ")}`,
        });
      }

      const accountId = accountIdRaw === undefined || accountIdRaw === null || accountIdRaw === ""
        ? undefined
        : Number(accountIdRaw);
      if (accountId !== undefined) {
        if (!Number.isInteger(accountId) || accountId <= 0) {
          return reply.status(400).send({ error: "Некорректный ИТС-аккаунт" });
        }
        if (!enabledAccounts.some((account) => account.id === accountId)) {
          return reply.status(400).send({ error: "Выбранный ИТС-аккаунт не найден или выключен" });
        }
      }
      targets = projectIds.map((projectId) => {
        const project = projectsById.get(projectId)!;
        return { projectId, projectName: project.displayName, accountId };
      });
    } else if (accountIdRaw !== undefined && accountIdRaw !== null && accountIdRaw !== "") {
      return reply.status(400).send({ error: "Сначала выберите конфигурацию" });
    }

    let job: { id: number };
    try {
      job = await createUpdateJob("manual", {
        mode: mode as UpdateMode,
        targets,
        forceAllResources,
      }, "queued");
    } catch (error) {
      if (error instanceof UpdateJobAlreadyActiveError) {
        return reply.status(409).send({ error: error.message, jobId: error.jobId });
      }
      throw error;
    }
    return {
      started: true,
      jobId: job.id,
      scope: forceAllResources && !targets
        ? "all-forced"
        : mode === "lst" || mode === "archive"
        ? mode
        : targets ? (targets.length === 1 ? "project" : "projects") : "full",
      projects: targets?.map((target) => target.projectName) ?? [],
      project: targets?.length === 1 ? targets[0].projectName : null,
      forceAllResources,
    };
  });

  app.get("/admin/api/update/status", async (req) => {
    const query = req.query as Record<string, string>;
    const from = Math.max(0, Number(query.offset ?? "0"));
    const requestedJobId = Number(query.jobId ?? "0");
    const [job] = Number.isInteger(requestedJobId) && requestedJobId > 0
      ? await db.select().from(updateJobs).where(eq(updateJobs.id, requestedJobId)).limit(1)
      : await db.select().from(updateJobs)
        .where(sql`${updateJobs.status} IN ('queued', 'running')`)
        .orderBy(desc(updateJobs.id)).limit(1);
    if (!job) {
      return { jobId: null, lines: [], total: from, running: false, progress: null };
    }
    const events = await db.select({
      id: updateJobEvents.id,
      createdAt: updateJobEvents.createdAt,
      stage: updateJobEvents.stage,
      message: updateJobEvents.message,
    }).from(updateJobEvents)
      .where(sql`${updateJobEvents.jobId} = ${job.id} AND ${updateJobEvents.id} > ${from}`)
      .orderBy(updateJobEvents.id)
      .limit(500);
    const cursor = events.length ? Number(events.at(-1)?.id) : from;
    return {
      jobId: job.id,
      lines: events.map((event) => ({
        ts: event.createdAt.toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        text: `[${event.stage}] ${event.message}`,
      })),
      total: cursor,
      running: job.status === "queued" || job.status === "running",
      progress: {
        ...job,
        current: job.progressCurrent,
        total: job.progressTotal,
      },
    };
  });

  app.post("/admin/api/update/cancel", async (_req, reply) => {
    const activeId = (await db.select({ id: updateJobs.id })
      .from(updateJobs)
      .where(sql`${updateJobs.status} IN ('queued', 'running')`)
      .orderBy(desc(updateJobs.id))
      .limit(1))[0]?.id;
    if (!activeId) return reply.status(409).send({ error: "Нет активного обновления" });
    const result = await requestUpdateJobCancellation(activeId);
    return { cancelled: true, requested: result.requested, jobId: activeId };
  });

  // ── Admin API: catalog backup and restore ────────────────────────────────
  app.get("/admin/api/database/status", async () => {
    const result = await db.execute(sql`
      SELECT pg_database_size(current_database())::bigint AS database_bytes,
             (SELECT count(*) FROM configurations)::int AS configurations,
             (SELECT count(*) FROM release_project_versions)::int AS releases,
             (SELECT count(*) FROM update_edges)::int AS transitions,
             (SELECT id FROM update_jobs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1) AS active_job_id
    `);
    const row = extractRows(result)[0] ?? {};
    return {
      databaseBytes: Number(row.database_bytes ?? 0),
      configurations: Number(row.configurations ?? 0),
      releases: Number(row.releases ?? 0),
      transitions: Number(row.transitions ?? 0),
      activeJobId: row.active_job_id == null ? null : Number(row.active_job_id),
      backupRunning: databaseBackupRunning,
      restoreRunning: databaseRestoreRunning,
      includesAccounts: false,
    };
  });

  app.get("/admin/api/database/backup", async (req, reply) => {
    if (databaseBackupRunning) {
      return reply.status(409).send({ error: "Резервная копия уже создаётся" });
    }
    if (databaseRestoreRunning || await databaseMaintenanceActive()) {
      return reply.status(409).send({ error: "Выполняется восстановление базы данных" });
    }
    const [activeJob] = await db.select({ id: updateJobs.id })
      .from(updateJobs)
      .where(sql`${updateJobs.status} IN ('queued', 'running')`)
      .limit(1);
    if (activeJob) {
      return reply.status(409).send({
        error: "Сначала дождитесь завершения задачи обновления",
        jobId: activeJob.id,
      });
    }

    databaseBackupRunning = true;
    let importLock: PoolClient | null = null;
    let tempDir = "";
    let dumpPath = "";
    let streamHandedOff = false;
    try {
      importLock = await acquireImportLocks();
      if (!importLock) {
        return reply.status(409).send({ error: "Импорт уже выполняется. Повторите создание копии после его завершения." });
      }
      tempDir = await mkdtemp(join(tmpdir(), "release1c-backup-"));
      dumpPath = join(tempDir, "catalog.dump");
      const { database } = postgresToolConnection();
      await runPostgresTool("pg_dump", [
        "--format=custom",
        "--compress=6",
        "--data-only",
        "--no-owner",
        "--no-privileges",
        `--file=${dumpPath}`,
        ...CATALOG_BACKUP_TABLES.map((table) => `--table=public.${table}`),
        database,
      ]);
      await assertPostgresCustomDump(dumpPath);
      const fileStat = await stat(dumpPath);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `release1c-catalog-${stamp}.dump`;
      const cleanup = () => { void rm(tempDir, { recursive: true, force: true }); };
      reply.raw.once("finish", cleanup);
      reply.raw.once("close", cleanup);
      streamHandedOff = true;
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .header("Content-Length", String(fileStat.size))
        .send(createReadStream(dumpPath));
    } catch (error) {
      req.log.error(error, "database backup failed");
      return reply.status(500).send({ error: (error as Error).message });
    } finally {
      databaseBackupRunning = false;
      await releaseImportLocks(importLock).catch(() => undefined);
      if (!streamHandedOff && tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  });

  app.post("/admin/api/database/restore", async (req, reply) => {
    if (databaseRestoreRunning || await databaseMaintenanceActive()) {
      return reply.status(409).send({ error: "Восстановление уже выполняется" });
    }
    if (databaseBackupRunning) {
      return reply.status(409).send({ error: "Дождитесь завершения резервного копирования" });
    }

    const tempDir = await mkdtemp(join(tmpdir(), "release1c-restore-"));
    const dumpPath = join(tempDir, "catalog.dump");
    let importLock: PoolClient | null = null;
    let uploaded = false;
    let confirmation = "";
    let originalName = "";
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (uploaded) {
            part.file.resume();
            return reply.status(400).send({ error: "Разрешён только один файл резервной копии" });
          }
          uploaded = true;
          originalName = part.filename || "catalog.dump";
          await pipeline(part.file, createWriteStream(dumpPath, { flags: "wx" }));
          if (part.file.truncated) {
            return reply.status(413).send({ error: "Файл превышает допустимый размер" });
          }
        } else if (part.fieldname === "confirmation") {
          confirmation = String(part.value ?? "").trim();
        }
      }
      if (confirmation !== "ВОССТАНОВИТЬ") {
        return reply.status(400).send({ error: "Для подтверждения введите ВОССТАНОВИТЬ" });
      }
      if (!uploaded) return reply.status(400).send({ error: "Выберите файл резервной копии" });
      await assertPostgresCustomDump(dumpPath);

      const [activeJob] = await db.select({ id: updateJobs.id })
        .from(updateJobs)
        .where(sql`${updateJobs.status} IN ('queued', 'running')`)
        .limit(1);
      if (activeJob) {
        return reply.status(409).send({
          error: "Сначала дождитесь завершения задачи обновления",
          jobId: activeJob.id,
        });
      }

      importLock = await acquireImportLocks();
      if (!importLock) {
        return reply.status(409).send({ error: "Импорт уже выполняется. Повторите восстановление после его завершения." });
      }
      databaseRestoreRunning = true;
      await setDatabaseMaintenance(true);
      const { database } = postgresToolConnection();
      const listPath = join(tempDir, "catalog.list");
      await assertCatalogDumpContents(dumpPath, listPath);
      const sqlPath = join(tempDir, "catalog.sql");
      await runPostgresTool("pg_restore", [
        "--data-only",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        `--file=${sqlPath}`,
        dumpPath,
      ]);
      const wrapperPath = join(tempDir, "restore.sql");
      const escapedSqlPath = sqlPath.replace(/'/g, "''");
      await writeFile(
        wrapperPath,
        [
          "\\set ON_ERROR_STOP on",
          "BEGIN;",
          "SET LOCAL session_replication_role = replica;",
          `TRUNCATE TABLE ${CATALOG_RESTORE_TRUNCATE.map((table) => `public.${table}`).join(", ")} RESTART IDENTITY CASCADE;`,
          `\\i '${escapedSqlPath}'`,
          "UPDATE public.release_project_versions SET source_account_id = NULL;",
          "SET LOCAL session_replication_role = origin;",
          ...CATALOG_BACKUP_TABLES.map((table) =>
            `SELECT pg_catalog.setval(pg_get_serial_sequence('public.${table}', 'id'), COALESCE((SELECT max(id) FROM public.${table}), 1), EXISTS (SELECT 1 FROM public.${table}));`,
          ),
          "COMMIT;",
          "",
        ].join("\n"),
        "utf8",
      );
      await runPostgresTool("psql", ["--set=ON_ERROR_STOP=1", `--file=${wrapperPath}`, database]);
      await touchCatalogRevision(true);
      return {
        restored: true,
        fileName: originalName,
        accountsPreserved: true,
        accountAccessReset: true,
      };
    } catch (error) {
      req.log.error(error, "database restore failed");
      return reply.status(500).send({ error: (error as Error).message });
    } finally {
      if (databaseRestoreRunning) {
        await setDatabaseMaintenance(false).catch(() => undefined);
      }
      databaseRestoreRunning = false;
      await releaseImportLocks(importLock).catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  app.post("/admin/api/data/releases/clear", async (req, reply) => {
    const confirmation = String((req.body as Record<string, unknown>)?.confirmation ?? "").trim();
    if (confirmation !== "ОЧИСТИТЬ") {
      return reply.status(400).send({ error: "Для подтверждения введите ОЧИСТИТЬ" });
    }
    const [activeUpdate] = await db.select({ id: updateJobs.id }).from(updateJobs)
      .where(sql`${updateJobs.status} IN ('queued', 'running')`)
      .orderBy(desc(updateJobs.id)).limit(1);
    if (activeUpdate) {
      return reply.status(409).send({
        error: "Сначала дождитесь завершения текущего обновления",
        jobId: activeUpdate.id,
      });
    }

    // Use the same session locks as both importers so cleanup cannot race with
    // a scheduled worker that is not represented by the web process state.
    const client = await pool.connect();
    let lstLocked = false;
    let releasesLocked = false;
    let transactionStarted = false;
    try {
      const lockResult = await client.query<{ lst_locked: boolean; releases_locked: boolean }>(`
        SELECT
          pg_try_advisory_lock(801001) AS lst_locked,
          pg_try_advisory_lock(801002) AS releases_locked
      `);
      lstLocked = Boolean(lockResult.rows[0]?.lst_locked);
      releasesLocked = Boolean(lockResult.rows[0]?.releases_locked);
      if (!lstLocked || !releasesLocked) {
        return reply.status(409).send({ error: "Импорт уже выполняется. Повторите очистку после его завершения." });
      }

      await client.query("BEGIN");
      transactionStarted = true;
      const countResult = await client.query(`
        SELECT
          (SELECT count(*) FROM release_projects)::int AS projects,
          (SELECT count(*) FROM release_project_versions)::int AS versions,
          (SELECT count(*) FROM release_version_transitions)::int AS transitions,
          (SELECT count(*) FROM release_version_resources)::int AS resources,
          (SELECT count(*) FROM patches)::int AS patches,
          (SELECT count(*) FROM version_meta WHERE source = 'releases')::int AS metadata
      `);
      const counts = countResult.rows[0] as Record<string, number>;

      await client.query("DELETE FROM patches");
      await client.query("DELETE FROM version_meta WHERE source = 'releases'");
      // Child release tables and per-account access rows use ON DELETE CASCADE.
      await client.query("DELETE FROM release_projects");
      await client.query(`
        UPDATE configurations SET
          display_name = name,
          releases_href = NULL,
          group_name = NULL,
          region = NULL,
          next_release_version = NULL,
          next_release_planned_date = NULL,
          next_release_plan_updated = NULL
      `);

      const message =
        `Очищены данные releases.1c.ru: проектов ${counts.projects ?? 0}, ` +
        `версий ${counts.versions ?? 0}, ссылок ${counts.resources ?? 0}`;
      const jobResult = await client.query<{ id: number }>(`
        INSERT INTO update_jobs (origin, status, stage, message, started_at, finished_at)
        VALUES ('manual', 'ok', 'done', $1, now(), now())
        RETURNING id
      `, [message]);
      await client.query(`
        INSERT INTO update_job_events (job_id, stage, level, message)
        VALUES ($1, 'cleanup', 'success', $2)
      `, [jobResult.rows[0].id, message]);

      await client.query("COMMIT");
      transactionStarted = false;
      return { cleared: true, counts, jobId: jobResult.rows[0].id };
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (releasesLocked) await client.query("SELECT pg_advisory_unlock(801002)").catch(() => undefined);
      if (lstLocked) await client.query("SELECT pg_advisory_unlock(801001)").catch(() => undefined);
      client.release();
    }
  });

  // ── Admin API: SSL / Caddy domain management ─────────────────────────────
  app.get("/admin/api/ssl", async () => {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "domain"));
    const domain = row?.value ?? null;
    const caddy = await getCaddyStatus();
    return { domain, caddy };
  });

  app.post("/admin/api/ssl", async (req, reply) => {
    const { domain } = (req.body as Record<string, unknown>) ?? {};
    const cleaned = typeof domain === "string" ? domain.trim().toLowerCase() : "";

    // Validate: empty (disable HTTPS) or hostname
    if (cleaned && !/^[a-z0-9][a-z0-9.\-]{0,252}$/.test(cleaned)) {
      return reply.status(400).send({ error: "Некорректный домен" });
    }

    // Push new config to Caddy
    try {
      await setCaddyDomain(cleaned || null);
    } catch (e) {
      return reply.status(502).send({ error: `Caddy не ответил: ${(e as Error).message.slice(0, 200)}` });
    }

    // Persist in DB
    await db
      .insert(settings)
      .values({ key: "domain", value: cleaned || null })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: cleaned || null, updatedAt: new Date() },
      });

    return { ok: true, domain: cleaned || null };
  });

  // ── Public static + API ───────────────────────────────────────────────────
  app.register(fastifyStatic, {
    root: join(__dirname, "..", "..", "public"),
    prefix: "/",
  });

  app.get("/api/openapi.json", async (_req, reply) =>
    reply.type("application/json; charset=utf-8").send(app.swagger()));

  app.get("/api/health", async () => {
    const accounts = await listAccounts();
    return {
      ok: true,
      has_its: accounts.some((account) => account.enabled),
      its_accounts: accounts.filter((account) => account.enabled).length,
    };
  });

  app.get("/api/revision", async () => {
    const result = await db.execute(sql`
      SELECT greatest(
        coalesce((SELECT max(finished_at) FROM update_jobs), 'epoch'::timestamptz),
        coalesce((SELECT updated_at FROM settings WHERE key = 'catalog_revision'), 'epoch'::timestamptz)
      ) AS revision
    `);
    const revision = (extractRows(result)[0]?.revision ?? null) as Date | string | null;
    return { revision: revision instanceof Date ? revision.toISOString() : revision };
  });

  let catalogResponseCache: { revision: string; body: string } | null = null;
  let statsResponseCache: { revision: string; body: string } | null = null;
  const revisionEtag = (kind: string, revision: string, suffix = "") =>
    `W/\"${kind}-${createHash("sha256").update(`${revision}:${suffix}`).digest("base64url").slice(0, 20)}\"`;

  app.get("/api/configs", async (req, reply) => {
    const q = String((req.query as Record<string, string>).q ?? "").trim();
    const version = String((req.query as Record<string, string>).version ?? "").trim();

    // By-version lookup across both the LST graph and releases histories.
    if (version) {
      const result = await db.execute(sql`
        SELECT DISTINCT
          c.id::text AS id, c.name,
          coalesce(c.display_name_override, rp.display_name_override, rp.display_name, c.display_name, c.name) AS display_name,
          coalesce(c.vendor_override, c.vendor) AS vendor, coalesce(rp.href, c.releases_href) AS releases_href
        FROM configurations c
        JOIN update_edges ue ON ue.config_id = c.id
        LEFT JOIN release_projects rp ON rp.config_id = c.id
        WHERE c.is_hidden = false AND (ue.to_version = ${version} OR ue.from_version = ${version})
        UNION
        SELECT DISTINCT
          CASE WHEN rp.config_id IS NULL THEN 'r:' || rp.id::text ELSE rp.config_id::text END AS id,
          CASE WHEN rp.config_id IS NULL THEN 'release:' || rp.id::text ELSE c.name END AS name,
          coalesce(rp.display_name_override, rp.display_name),
          coalesce(c.vendor_override, c.vendor, '1С') AS vendor, rp.href AS releases_href
        FROM release_projects rp
        JOIN release_project_versions rpv ON rpv.project_id = rp.id
        LEFT JOIN configurations c ON c.id = rp.config_id
        WHERE rpv.version = ${version} AND rpv.is_hidden = false AND rp.is_hidden = false
          AND (rp.config_id IS NOT NULL OR rp.catalog_state = 'ready')
          AND coalesce(c.is_hidden, false) = false
        LIMIT 2000
      `);
      return extractRows(result);
    }

    const revision = await getCatalogRevision();
    const etag = revisionEtag("catalog", revision, q.toLowerCase());
    reply.header("ETag", etag);
    reply.header("Cache-Control", "public, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();

    if (q) {
      const pattern = `%${q.toLowerCase()}%`;
      const result = await db.execute(sql`
        SELECT catalog_key AS id, project_id, name, display_name, vendor, releases_href,
          group_name, region, next_release_version, next_release_planned_date,
          next_release_plan_updated, latest_version, latest_date,
          latest_platform, latest_recommended_platform, version_count, avg_days,
          has_graph, mapping_status, transition_mode, available_accounts,
          available_account_labels
        FROM catalog_summary
        WHERE lower(coalesce(display_name, '') || ' ' || coalesce(name, '') || ' ' || coalesce(vendor, ''))
          LIKE ${pattern}
        ORDER BY coalesce(display_name, name)
        LIMIT 2000
      `);
      return reply.type("application/json; charset=utf-8")
        .send(JSON.stringify(extractRows(result)));
    }

    if (!catalogResponseCache || catalogResponseCache.revision !== revision) {
      const result = await db.execute(sql`
        SELECT catalog_key AS id, project_id, name, display_name, vendor, releases_href,
          group_name, region, next_release_version, next_release_planned_date,
          next_release_plan_updated, latest_version, latest_date,
          latest_platform, latest_recommended_platform, version_count, avg_days,
          has_graph, mapping_status, transition_mode, available_accounts,
          available_account_labels
        FROM catalog_summary
        ORDER BY coalesce(display_name, name)
      `);
      const rows = extractRows(result) as Record<string, unknown>[];
      catalogResponseCache = { revision, body: JSON.stringify(rows) };
    }
    return reply.type("application/json; charset=utf-8").send(catalogResponseCache.body);
  });

  app.get("/api/versions", async (req) => {
    const name = String((req.query as Record<string, string>).config ?? "").trim();
    const projectParam = String((req.query as Record<string, string>).project ?? "").trim();
    const requestedProjectId = projectParam ? Number(projectParam) : null;
    const includeResources = String((req.query as Record<string, string>).includeResources ?? "").toLowerCase() === "true";
    if (!name) return { versions: [] };
    if (requestedProjectId !== null && !Number.isInteger(requestedProjectId)) {
      return { versions: [] };
    }

    if (name.startsWith("release:")) {
      const projectId = Number(name.slice("release:".length));
      if (!Number.isInteger(projectId)) return { versions: [] };
      const projectRows = await db.execute(sql`
        SELECT id, config_id, latest_version, latest_date::text, href, transition_mode,
               (SELECT count(*) FROM release_project_versions WHERE project_id=release_projects.id)::int AS stored_version_count
        FROM release_projects
        WHERE id = ${projectId} AND is_hidden = false
          AND (config_id IS NOT NULL OR catalog_state = 'ready')
        LIMIT 1
      `);
      const project = (extractRows(projectRows))[0] as Record<string, unknown>;
      if (!project) return { versions: [] };
      if (project.config_id) {
        const mapped = await db.select({ name: configurations.name })
          .from(configurations).where(eq(configurations.id, Number(project.config_id))).limit(1);
        if (mapped.length) {
          // Keep the exact releases project while enriching it with its LST graph.
          (req.query as Record<string, string>).config = mapped[0].name;
          return replyVersionsForConfiguration(mapped[0].name, includeResources, projectId);
        }
      }

      const versionRows = await db.execute(sql`
        SELECT version, is_test,
               coalesce(release_date_override, release_date)::text AS release_date,
               coalesce(min_platform_override, min_platform) AS min_platform,
               coalesce(recommended_platform_override, recommended_platform) AS recommended_platform,
               coalesce(file_size_bytes_override, file_size_bytes) AS file_size_bytes,
               (SELECT coalesce(link.href_override, link.href)
                FROM release_version_resources link
                WHERE link.project_version_id=release_project_versions.id
                  AND link.is_hidden=false AND link.href=release_project_versions.download_href
                LIMIT 1) AS download_href
        FROM release_project_versions
        WHERE project_id = ${projectId} AND is_hidden = false
      `);
      const entries = extractRows(versionRows) as Array<Record<string, unknown>>;
      if (!entries.length && project.latest_version && Number(project.stored_version_count ?? 0) === 0) {
        entries.push({
          version: project.latest_version,
          release_date: project.latest_date,
          min_platform: null,
          recommended_platform: null,
          file_size_bytes: null,
          download_href: project.href
            ? `${project.href}?allUpdates=true`
            : null,
          is_test: false,
        });
      }
      const resourceRows = includeResources ? await db.execute(sql`
        SELECT rpv.version, rvr.kind, rvr.category,
               coalesce(rvr.title_override, rvr.title) AS title,
               coalesce(rvr.href_override, rvr.href) AS href,
               rvr.properties_id, rvr.file_name, rvr.file_extension,
               coalesce(rvr.file_size_bytes_override, rvr.file_size_bytes) AS file_size_bytes,
               coalesce(rvr.published_at_override, rvr.published_at)::text AS published_at,
               coalesce(rvr.sha512_override, rvr.sha512) AS sha512,
               rvr.is_file, rvr.sort_order
        FROM release_version_resources rvr
        JOIN release_project_versions rpv ON rpv.id = rvr.project_version_id
        WHERE rpv.project_id = ${projectId} AND rpv.is_hidden = false AND rvr.is_hidden = false
        ORDER BY rpv.version, rvr.sort_order
      `) : { rows: [] };
      const resources = resourcesByVersion(extractRows(resourceRows));
      const transitionRows = await db.execute(sql`
        SELECT rpv.version, rvt.from_version
        FROM release_version_transitions rvt
        JOIN release_project_versions rpv ON rpv.id = rvt.project_version_id
        WHERE rpv.project_id = ${projectId}
        ORDER BY rpv.version, rvt.from_version
      `);
      const intendedVersions = transitionsByVersion(
        extractRows(transitionRows),
      );
      const graphRows = await db.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM release_version_transitions rvt
          JOIN release_project_versions rpv ON rpv.id = rvt.project_version_id
          WHERE rpv.project_id = ${projectId}
        ) AS ready
      `);
      const graphReady = project.transition_mode === "unrestricted"
        || Boolean(extractRows(graphRows)[0]?.ready);
      const versions = entries.map((entry) => String(entry.version)).sort(compareVersionStrings);
      const meta: Record<string, VersionMetadataPayload> = {};
      for (const entry of entries) {
        const ver = String(entry.version);
        meta[ver] = {
          source: "releases",
          release_date: entry.release_date == null ? null : String(entry.release_date),
          min_platform: entry.min_platform == null ? null : String(entry.min_platform),
          recommended_platform: entry.recommended_platform == null ? null : String(entry.recommended_platform),
          file_size_bytes: entry.file_size_bytes == null ? null : Number(entry.file_size_bytes),
          download_href: entry.download_href == null ? null : String(entry.download_href),
          is_test: Boolean(entry.is_test),
          previous_versions: intendedVersions[ver] ?? [],
          resources: resources[ver] ?? [],
        };
      }
      return {
        versions,
        editions: groupVersionsByEdition(versions),
        meta,
        cfu: {},
        releases_href: project.href ?? null,
        graph_ready: graphReady,
        transition_mode: project.transition_mode ?? "unknown",
        resources_included: includeResources,
      };
    }

    return replyVersionsForConfiguration(name, includeResources, requestedProjectId);
  });

  async function replyVersionsForConfiguration(
    name: string,
    includeResources = false,
    requestedProjectId: number | null = null,
  ) {
    const cfg = await db
      .select({ id: configurations.id, releasesHref: configurations.releasesHref })
      .from(configurations)
      .where(sql`${configurations.name} = ${name} AND ${configurations.isHidden} = false`)
      .limit(1);
    if (cfg.length === 0) return { versions: [] };

    const selectedProjectRows = requestedProjectId === null ? [] : await db.execute(sql`
      SELECT id, href, transition_mode, latest_version,
             EXISTS (
               SELECT 1
               FROM release_project_versions scoped_version
               WHERE scoped_version.project_id = release_projects.id
                 AND scoped_version.is_hidden = false
             ) AS has_release_versions,
             ARRAY(
               SELECT DISTINCT split_part(scoped_branch.version, '.', 1)
               FROM release_project_versions scoped_branch
               WHERE scoped_branch.project_id = release_projects.id
                 AND scoped_branch.is_hidden = false
               ORDER BY split_part(scoped_branch.version, '.', 1)
             ) AS release_branches
      FROM release_projects
      WHERE id = ${requestedProjectId} AND config_id = ${cfg[0].id} AND is_hidden = false
      LIMIT 1
    `);
    const selectedProject = (extractRows(selectedProjectRows)[0] ?? null) as {
      id: number;
      href: string | null;
      transition_mode: string | null;
      latest_version: string | null;
      has_release_versions: boolean;
      release_branches: string[];
    } | null;
    if (requestedProjectId !== null && !selectedProject) return { versions: [] };
    const exactProjectId = selectedProject ? Number(selectedProject.id) : null;
    const projectBranches = [...new Set([
      ...(selectedProject?.release_branches ?? []),
      ...(!selectedProject?.has_release_versions && selectedProject?.latest_version
        ? [selectedProject.latest_version.split(".", 1)[0]]
        : []),
    ].filter(Boolean))];
    // Persisted releases remain authoritative even if every account later
    // loses access. LST may supplement that history, but only within editions
    // observed for this exact releases project.
    const scopeLstToProject = exactProjectId !== null && projectBranches.length > 0;
    const projectBranchLiterals = projectBranches.length
      ? sql.join(projectBranches.map((branch) => sql`${branch}`), sql`, `)
      : sql`NULL`;
    const projectScope = exactProjectId === null
      ? sql`rp.config_id = ${cfg[0].id}`
      : sql`rp.id = ${exactProjectId}`;
    const hiddenProjectScope = exactProjectId === null
      ? sql`hidden_project.config_id = ${cfg[0].id}`
      : sql`hidden_project.id = ${exactProjectId}`;
    const edgeTargetScope = !scopeLstToProject ? sql`` : sql`
      AND split_part(ue.to_version, '.', 1) IN (${projectBranchLiterals})
    `;
    // Transition sources may belong to an older edition (for example,
    // Accounting 2.0 can be upgraded to an Accounting30 release). Keep those
    // sources in previous_versions. Only LST versions from the selected
    // project's editions are added to the visible history.
    const edgeSourceHistoryScope = !scopeLstToProject ? sql`` : sql`
      AND split_part(ue.from_version, '.', 1) IN (${projectBranchLiterals})
    `;
    const releaseSourceHistoryScope = !scopeLstToProject ? sql`` : sql`
      AND EXISTS (
        SELECT 1
        FROM release_project_versions scoped_source
        WHERE scoped_source.project_id = ${exactProjectId}
          AND scoped_source.is_hidden = false
          AND scoped_source.version = rvt.from_version
      )
    `;
    const metaVersionScope = !scopeLstToProject ? sql`` : sql`
      AND EXISTS (
        SELECT 1
        FROM release_project_versions scoped_version
        WHERE scoped_version.project_id = ${exactProjectId}
          AND scoped_version.is_hidden = false
          AND scoped_version.version = vm.version
      )
    `;

    const allVersionRows = await db.execute(sql`
      SELECT DISTINCT v FROM (
        SELECT ue.from_version v FROM update_edges ue
          WHERE ue.config_id = ${cfg[0].id} ${edgeTargetScope} ${edgeSourceHistoryScope}
        UNION
        SELECT ue.to_version v FROM update_edges ue
          WHERE ue.config_id = ${cfg[0].id} ${edgeTargetScope}
        UNION
        SELECT rpv.version v
          FROM release_project_versions rpv
          JOIN release_projects rp ON rp.id = rpv.project_id
          WHERE ${projectScope} AND rp.is_hidden = false AND rpv.is_hidden = false
        UNION
        SELECT rp.latest_version v
          FROM release_projects rp
          WHERE ${projectScope} AND rp.is_hidden = false
            AND rp.latest_version IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM release_project_versions known_version
              WHERE known_version.project_id = rp.id AND known_version.is_hidden = false
            )
        UNION
        SELECT rvt.from_version v
          FROM release_version_transitions rvt
          JOIN release_project_versions rpv ON rpv.id = rvt.project_version_id
          JOIN release_projects rp ON rp.id = rpv.project_id
          WHERE ${projectScope} AND rp.is_hidden = false AND rpv.is_hidden = false
            ${releaseSourceHistoryScope}
      ) t
      WHERE NOT EXISTS (
        SELECT 1
        FROM release_project_versions hidden_version
        JOIN release_projects hidden_project ON hidden_project.id = hidden_version.project_id
        WHERE ${hiddenProjectScope}
          AND hidden_version.version = t.v
          AND hidden_version.is_hidden = true
      )
    `);
    const list = extractRows(allVersionRows).map((row) => String(row.v));

    list.sort(compareVersionStrings);

    // Group by edition (first segment) for the UI.
    // Fetch release_date + min_platform + file_size_bytes from version_meta.
    const metaRows = await db.execute(sql`
      WITH candidates AS (
        SELECT version, release_date, min_platform,
               NULL::text AS recommended_platform, file_size_bytes,
               NULL::text AS download_href, false AS is_test,
               false AS from_project_releases, 1 AS priority
        FROM version_meta vm
        WHERE vm.config_id = ${cfg[0].id} ${metaVersionScope}
        UNION ALL
        SELECT rpv.version,
               coalesce(rpv.release_date_override, rpv.release_date),
               coalesce(rpv.min_platform_override, rpv.min_platform),
               coalesce(rpv.recommended_platform_override, rpv.recommended_platform),
               coalesce(rpv.file_size_bytes_override, rpv.file_size_bytes),
               (SELECT coalesce(link.href_override, link.href)
                FROM release_version_resources link
                 WHERE link.project_version_id=rpv.id
                   AND link.is_hidden=false AND link.href=rpv.download_href
                  LIMIT 1), rpv.is_test, true AS from_project_releases, 0 AS priority
        FROM release_project_versions rpv
        JOIN release_projects rp ON rp.id = rpv.project_id
        WHERE ${projectScope} AND rp.is_hidden = false AND rpv.is_hidden = false
        UNION ALL
        SELECT rp.latest_version, rp.latest_date,
               NULL::text, NULL::text, NULL::bigint, NULL::text,
               false, true AS from_project_releases, 0 AS priority
        FROM release_projects rp
        WHERE ${projectScope} AND rp.is_hidden = false
          AND rp.latest_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM release_project_versions known_version
            WHERE known_version.project_id = rp.id AND known_version.is_hidden = false
          )
      )
      SELECT DISTINCT ON (version)
        version, release_date::text, min_platform, recommended_platform,
        file_size_bytes, download_href, is_test, from_project_releases
      FROM candidates
      ORDER BY version, priority
    `);
    const meta: Record<string, VersionMetadataPayload> = {};
    const resourceRows = includeResources ? await db.execute(sql`
      SELECT rpv.version, rvr.kind, rvr.category,
             coalesce(rvr.title_override, rvr.title) AS title,
             coalesce(rvr.href_override, rvr.href) AS href,
             rvr.properties_id, rvr.file_name, rvr.file_extension,
             coalesce(rvr.file_size_bytes_override, rvr.file_size_bytes) AS file_size_bytes,
             coalesce(rvr.published_at_override, rvr.published_at)::text AS published_at,
             coalesce(rvr.sha512_override, rvr.sha512) AS sha512,
             rvr.is_file, rvr.sort_order
      FROM release_version_resources rvr
      JOIN release_project_versions rpv ON rpv.id = rvr.project_version_id
      JOIN release_projects rp ON rp.id = rpv.project_id
      WHERE ${projectScope}
        AND rp.is_hidden = false AND rpv.is_hidden = false AND rvr.is_hidden = false
      ORDER BY rpv.version, rvr.sort_order
    `) : { rows: [] };
    const resources = resourcesByVersion(extractRows(resourceRows));
    const transitionRows = await db.execute(sql`
      SELECT version, from_version FROM (
        SELECT ue.to_version AS version, ue.from_version
        FROM update_edges ue
        WHERE ue.config_id = ${cfg[0].id} ${edgeTargetScope}
        UNION
        SELECT rpv.version, rvt.from_version
        FROM release_version_transitions rvt
        JOIN release_project_versions rpv ON rpv.id = rvt.project_version_id
        JOIN release_projects rp ON rp.id = rpv.project_id
        WHERE ${projectScope}
      ) intended
      ORDER BY version, from_version
    `);
    const intendedVersions = transitionsByVersion(
      extractRows(transitionRows),
    );
    for (const r of extractRows(metaRows)) {
      const row = r as Record<string, unknown>;
      meta[String(row.version)] = {
        source: Boolean(row.from_project_releases) ? "releases" : "lst",
        release_date: (row.release_date as string | null) ?? null,
        min_platform: (row.min_platform as string | null) ?? null,
        recommended_platform: (row.recommended_platform as string | null) ?? null,
        file_size_bytes: (row.file_size_bytes as number | null) ?? null,
        download_href: (row.download_href as string | null) ?? null,
        is_test: Boolean(row.is_test),
        previous_versions: intendedVersions[String(row.version)] ?? [],
        resources: resources[String(row.version)] ?? [],
      };
    }
    for (const version of list) {
      meta[version] ??= {
        source: "lst",
        release_date: null,
        min_platform: null,
        recommended_platform: null,
        file_size_bytes: null,
        download_href: null,
        is_test: false,
        previous_versions: intendedVersions[version] ?? [],
        resources: resources[version] ?? [],
      };
    }

    const modeRows = await db.execute(sql`
      SELECT transition_mode
      FROM release_projects
      WHERE ${exactProjectId === null
        ? sql`config_id = ${cfg[0].id}`
        : sql`id = ${exactProjectId}`}
        AND is_hidden = false
      ORDER BY CASE WHEN mapping_mode = 'manual' THEN 0 ELSE 1 END,
               mapping_confidence DESC, last_seen_at DESC
      LIMIT 1
    `);
    const transitionMode = String(
      (extractRows(modeRows)[0]?.transition_mode) ?? "explicit",
    );

    // Fetch cfu_path per to_version: pick the edge from the most recent from_version.
    const cfuRows = await db.execute(sql`
      SELECT DISTINCT ON (to_version) to_version, cfu_path
      FROM update_edges ue
      WHERE ue.config_id = ${cfg[0].id} ${edgeTargetScope}
      ORDER BY to_version ASC, from_version DESC
    `);
    const cfu: Record<string, string> = {};
    for (const r of extractRows(cfuRows)) {
      const row = r as { cfu_path?: string; to_version?: string };
      if (row.cfu_path && row.to_version) cfu[row.to_version] = row.cfu_path;
    }

    return {
      versions: list,
      editions: groupVersionsByEdition(list),
      meta,
      cfu,
      releases_href: selectedProject?.href ?? cfg[0].releasesHref ?? null,
      graph_ready: list.length > 1,
      transition_mode: transitionMode,
      resources_included: includeResources,
    };
  }

  app.get("/api/version-resources", async (req, reply) => {
    const name = String((req.query as Record<string, string>).config ?? "").trim();
    const version = String((req.query as Record<string, string>).version ?? "").trim();
    const projectParam = String((req.query as Record<string, string>).project ?? "").trim();
    const requestedProjectId = projectParam ? Number(projectParam) : null;
    if (!name || !version) return reply.code(400).send({ error: "Укажите config и version" });
    const releaseOnlyProject = name.startsWith("release:");
    const directProjectId = releaseOnlyProject ? Number(name.slice(8)) : requestedProjectId;
    if (directProjectId !== null && !Number.isInteger(directProjectId)) {
      return reply.code(400).send({ error: "Некорректный идентификатор конфигурации" });
    }
    const revision = await getCatalogRevision();
    const etag = revisionEtag("resources", revision, `${name}:${directProjectId ?? ""}:${version}`);
    reply.header("ETag", etag);
    reply.header("Cache-Control", "public, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    const namedConfigFilter = sql`
      rp.config_id = (SELECT id FROM configurations WHERE name = ${name} AND is_hidden = false LIMIT 1)
    `;
    const projectFilter = directProjectId === null
      ? namedConfigFilter
      : releaseOnlyProject
        ? sql`rp.id = ${directProjectId}`
        : sql`rp.id = ${directProjectId} AND ${namedConfigFilter}`;
    const result = await db.execute(sql`
      SELECT rpv.resources_sync_status, rpv.resources_synced_at,
        rvr.kind, rvr.category, coalesce(rvr.title_override, rvr.title) AS title,
        coalesce(rvr.href_override, rvr.href) AS href,
        rvr.properties_id, rvr.file_name, rvr.file_extension,
        coalesce(rvr.file_size_bytes_override, rvr.file_size_bytes) AS file_size_bytes,
        coalesce(rvr.published_at_override, rvr.published_at)::text AS published_at,
        coalesce(rvr.sha512_override, rvr.sha512) AS sha512,
        rvr.is_file, rvr.sort_order
      FROM release_project_versions rpv
      JOIN release_projects rp ON rp.id = rpv.project_id
      LEFT JOIN release_version_resources rvr
        ON rvr.project_version_id = rpv.id AND rvr.is_hidden = false
      WHERE ${projectFilter} AND rp.is_hidden = false
        AND rpv.is_hidden = false AND rpv.version = ${version}
      ORDER BY CASE WHEN rp.mapping_mode = 'manual' THEN 0 ELSE 1 END,
        rp.mapping_confidence DESC, rvr.sort_order
    `);
    const rows = (extractRows(result)) as Record<string, unknown>[];
    const resources = [...new Map(rows
      .filter((row) => row.href)
      .map((row) => [String(row.href), versionResourcePayload(row)] as const)).values()];
    return {
      resources,
      sync_status: rows[0]?.resources_sync_status ?? "pending",
      synced_at: rows[0]?.resources_synced_at ?? null,
    };
  });

  app.get("/api/release-changes", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const requestedLimit = Number(query.limit ?? "40");
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(100, requestedLimit))
      : 40;
    const before = query.before ? decodeReleaseChangeCursor(query.before) : null;
    const projectId = query.project ? Number(query.project) : null;
    const allowedTypes = new Set([
      "new_version",
      "platform_changed",
      "resource_added",
      "patch_added",
    ]);
    const eventType = String(query.type ?? "").trim();
    if (eventType && !allowedTypes.has(eventType)) {
      return reply.code(400).send({ error: "Неизвестный тип изменения" });
    }
    if (query.before && before === null) {
      return reply.code(400).send({ error: "Некорректный курсор before" });
    }
    if (projectId !== null && (!Number.isSafeInteger(projectId) || projectId < 1)) {
      return reply.code(400).send({ error: "Некорректный идентификатор проекта" });
    }
    const filters = [
      sql`rp.is_hidden = false`,
      sql`(rp.config_id IS NOT NULL OR rp.catalog_state = 'ready')`,
      sql`coalesce(c.is_hidden, false) = false`,
      sql`coalesce(rpv.is_hidden, false) = false`,
    ];
    if (eventType) filters.push(sql`e.event_type = ${eventType}`);
    if (before !== null) {
      filters.push(sql`(e.occurred_at < ${before.occurredAt} OR (e.occurred_at = ${before.occurredAt} AND e.id < ${before.id}))`);
    }
    if (projectId !== null) filters.push(sql`e.project_id = ${projectId}`);
    const result = await db.execute(sql`
      SELECT e.id, e.event_type, e.version, e.is_test, e.details, e.occurred_at, e.detected_at,
        e.project_id, e.config_id,
        coalesce(rp.display_name_override, rp.display_name) AS project_name,
        coalesce(rp.group_name_override, rp.group_name) AS group_name,
        regexp_replace(rp.href, '^/project/', '') AS project_nick
      FROM release_change_events e
      JOIN release_projects rp ON rp.id = e.project_id
      LEFT JOIN release_project_versions rpv ON rpv.id = e.project_version_id
      LEFT JOIN configurations c ON c.id = e.config_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ${limit + 1}
    `);
    const rows = (extractRows(result) as Record<string, unknown>[]).map((row) => ({
      ...row,
      id: Number(row.id),
      project_id: Number(row.project_id),
      config_id: row.config_id === null ? null : Number(row.config_id),
    }));
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return {
      items,
      next_cursor: hasMore && last
        ? encodeReleaseChangeCursor((last as Record<string, unknown>).occurred_at, Number(last.id))
        : null,
    };
  });

  function transitionsByVersion(rows: Array<Record<string, unknown>>): Record<string, string[]> {
    const grouped: Record<string, string[]> = {};
    for (const row of rows) {
      const version = String(row.version);
      const fromVersion = String(row.from_version);
      const values = grouped[version] ??= [];
      if (!values.includes(fromVersion)) values.push(fromVersion);
    }
    for (const values of Object.values(grouped)) values.sort(compareVersionStrings);
    return grouped;
  }

  function resourcesByVersion(rows: Array<Record<string, unknown>>): Record<string, VersionResourcePayload[]> {
    const grouped: Record<string, VersionResourcePayload[]> = {};
    for (const row of rows) {
      const version = String(row.version);
      (grouped[version] ??= []).push(versionResourcePayload(row));
    }
    return grouped;
  }

  function compareVersionStrings(a: string, b: string): number {
    return compareReleaseVersions(a, b);
  }

  const editionCache = new Map<string, Array<{ edition: number; versions: string[] }>>();

  function groupVersionsByEdition(versions: string[]) {
    const key = versions.join("\0");
    const cached = editionCache.get(key);
    if (cached) return cached;
    const byEdition = new Map<number, string[]>();
    for (const version of versions) {
      const edition = Number(version.split(".")[0] ?? 0);
      const values = byEdition.get(edition) ?? [];
      values.push(version);
      byEdition.set(edition, values);
    }
    const result = [...byEdition.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([edition, values]) => ({ edition, versions: values }));
    editionCache.set(key, result);
    return result;
  }

  app.get("/api/patches", async (req) => {
    const { config, version, project } = req.query as Record<string, string>;
    if (!config || !version) return { patches: [] };
    const requestedProjectId = project ? Number(project) : null;
    const releaseProjectId = config.startsWith("release:")
      ? Number(config.slice("release:".length))
      : requestedProjectId;
    if (releaseProjectId !== null && !Number.isSafeInteger(releaseProjectId)) {
      return { patches: [] };
    }
    const projectFilter = releaseProjectId === null
      ? sql`p.config_id = (SELECT id FROM configurations WHERE name = ${String(config)} LIMIT 1)`
      : sql`rpv.project_id = ${releaseProjectId}`;
    const dbRows = await db.execute(sql`
      SELECT p.uuid, p.title, p.patch_date::text, p.download_key
      FROM patches p
      LEFT JOIN release_project_versions rpv ON rpv.id = p.project_version_id
      WHERE ${projectFilter} AND p.version = ${version}
      ORDER BY p.patch_date DESC NULLS LAST
    `);
    const existing = extractRows(dbRows);
    if (existing.length > 0) return { patches: existing };

    return { patches: [] };
  });

  app.get("/api/chain", async (req) => {
    const { config, from, to } = req.query as Record<string, string>;
    if (!config || !from || !to) {
      return { error: "config, from, to are required" };
    }
    const configName = String(config);
    const fromVersion = String(from).trim();
    const toVersion = String(to).trim();
    if (configName.startsWith("release:")) {
      const projectId = Number(configName.slice("release:".length));
      const modeRows = Number.isInteger(projectId)
        ? await db.execute(sql`
            SELECT transition_mode
            FROM release_projects
            WHERE id = ${projectId} AND is_hidden = false
              AND (config_id IS NOT NULL OR catalog_state = 'ready')
            LIMIT 1
          `)
        : null;
      const transitionMode = modeRows
        ? String((extractRows(modeRows)[0]?.transition_mode) ?? "unknown")
        : "unknown";
      if (transitionMode === "unrestricted") {
        if (!isReleaseVersion(fromVersion) || !isReleaseVersion(toVersion)) {
          return {
            found: false,
            steps: [],
            length: 0,
            note: "Введите номер версии в формате, опубликованном на releases.1c.ru.",
          };
        }
        const order = compareReleaseVersions(fromVersion, toVersion);
        if (order > 0) {
          return {
            found: false,
            steps: [],
            length: 0,
            note: "Исходная версия новее целевой.",
          };
        }
        const testRows = await db.execute(sql`
          SELECT version
          FROM release_project_versions
          WHERE project_id = ${projectId} AND is_test = true
            AND version IN (${fromVersion}, ${toVersion})
          ORDER BY CASE WHEN version = ${toVersion} THEN 0 ELSE 1 END
          LIMIT 1
        `);
        const testVersion = String((extractRows(testRows)[0]?.version) ?? "");
        if (testVersion) {
          return {
            found: false,
            steps: [],
            length: 0,
            note: testVersion === toVersion
              ? `Версия ${toVersion} предназначена для тестирования и исключена из расчёта обновлений.`
              : `Исходная версия ${fromVersion} предназначена для тестирования и исключена из расчёта обновлений.`,
          };
        }
        if (order === 0) return { found: true, steps: [], length: 0 };
        return {
          found: true,
          steps: [{ fromVersion, toVersion, cfuPath: "" }],
          length: 1,
          note: "На странице 1С ограничения по исходной версии не указаны.",
        };
      }
    }
    if (!parseVersion(fromVersion) || !parseVersion(toVersion)) {
      return { found: false, steps: [], length: 0, note: "Введите версии в формате 1.2.3.4." };
    }
    const res = await findChain(
      configName,
      fromVersion,
      toVersion,
    );
    return res;
  });

  app.get("/api/stats", async (req, reply) => {
    const revision = await getCatalogRevision();
    const etag = revisionEtag("stats", revision);
    reply.header("ETag", etag);
    reply.header("Cache-Control", "public, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    if (statsResponseCache?.revision === revision) {
      return reply.type("application/json; charset=utf-8").send(statsResponseCache.body);
    }
    const [cfgCount, edgeCount, verCount, lastRun] = await Promise.all([
      db.execute(sql`
        SELECT (
          (SELECT count(*) FROM configurations WHERE is_hidden = false) +
          (SELECT count(*) FROM release_projects
           WHERE config_id IS NULL AND is_hidden = false AND catalog_state = 'ready')
        )::int c
      `),
      db.execute(sql`
        SELECT count(*)::int c FROM update_edges ue
        JOIN configurations c ON c.id=ue.config_id
        WHERE c.is_hidden=false
      `),
      db.execute(publicCatalogVersionCountQuery()),
      db.select().from(importRuns)
        .where(sql`${importRuns.status} = 'ok' AND ${importRuns.source} IN ('lst', 'releases', 'releases-target')`)
        .orderBy(desc(importRuns.id))
        .limit(1),
    ]);
    const cfgC = (extractRows(cfgCount))[0]?.c ?? 0;
    const edgeC = (extractRows(edgeCount))[0]?.c ?? 0;
    const verC = (extractRows(verCount))[0]?.c ?? 0;
    const run = lastRun[0] ?? null;
    const payload = {
      configurations: cfgC,
      edges: edgeC,
      versions: verC,
      last_updated: run?.finishedAt?.toISOString().slice(0, 10) ?? null,
      lastRun: run,
    };
    statsResponseCache = { revision, body: JSON.stringify(payload) };
    return reply.type("application/json; charset=utf-8").send(statsResponseCache.body);
  });

  // ── SPA fallback: unmatched page GETs → index.html ────────────────────────
  // Handles hard refresh on client-side routes like /#/config/96 or
  // /%23/config/96 (when a proxy encodes the hash fragment).
  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split("?", 1)[0];
    if (pathname.startsWith("/api/") || pathname.startsWith("/admin/api/")) {
      return reply.status(404).send({ error: "Маршрут API не найден" });
    }
    return reply.sendFile("index.html");
  });

  return app;
}

/** On startup: if a domain is stored in DB, re-apply it to Caddy. */
async function syncCaddyOnStart() {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, "domain"));
    const domain = row?.value ?? null;
    if (domain) {
      await setCaddyDomain(domain);
      console.log(`[caddy] domain restored: ${domain}`);
    }
  } catch (e) {
    // Non-fatal: Caddy might not be up yet on very first start
    console.warn("[caddy] sync on start skipped:", (e as Error).message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  buildServer()
    .then(async (app) => {
      await app.listen({ port, host: "0.0.0.0" });
      app.log.info(`listening on :${port}`);
      // Give Caddy a moment to start before pushing config
      setTimeout(() => { void syncCaddyOnStart(); }, 3000);
    })
    .catch(async (e) => {
      console.error(e);
      await pool.end();
      process.exit(1);
    });
}
