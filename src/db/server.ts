/**
 * server.ts — Fastify app: API + static web UI in one service.
 *
 * Public endpoints:
 *   GET  /api/health
 *   GET  /api/configs?q=<substr>           -> matching configurations (enriched)
 *   GET  /api/configs?version=<v>          -> configs that contain this version
 *   GET  /api/versions?config=<name>       -> known versions + version_meta
 *   GET  /api/patches?config=&ver=          -> patches list for a version
 *   GET  /api/chain?config=&from=&to=      -> computed update chain
 *   GET  /api/stats                        -> import/run summary
 *   GET  /*                                -> static UI (public/)
 *
 * Admin endpoints (cookie session auth via ADMIN_LOGIN / ADMIN_PASSWORD):
 *   GET  /admin                            -> admin UI
 *   GET  /admin/api/status                 -> cron, its_login, recent runs
 *   GET  /admin/api/logs                   -> last 50 import runs
 *   GET  /admin/api/import/status          -> is import running + last run
 *   POST /admin/api/import/lst             -> trigger LST import
 *   POST /admin/api/import/releases        -> trigger releases import
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { sql, eq, desc } from "drizzle-orm";
import { db, pool } from "./client.js";
import { configurations, updateEdges, importRuns, patches, settings } from "./schema.js";
import { findChain } from "./chain.js";
import { setCaddyDomain, getCaddyStatus } from "./caddy.js";
import { parseVersion } from "../parser/version.js";
import { runImport } from "./import-lst.js";
import { runReleasesImport } from "../releases/import-releases.js";
import { ReleasesSession } from "../releases/fetch-releases.js";
import { parsePatchesPage } from "../releases/parse-releases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// In-memory lock: only one import per source at a time.
const importRunning: Record<string, boolean> = {};

// Per-source log buffer (cleared on each new run)
interface LogEntry { ts: string; text: string; }
const importLogs: Record<string, LogEntry[]> = { lst: [], releases: [] };
const importProgress: Record<string, { current: number; total: number }> =
  { lst: { current: 0, total: 0 }, releases: { current: 0, total: 0 } };
const importAbort: Record<string, AbortController | null> = { lst: null, releases: null };

function addImportLog(source: string, text: string) {
  const ts = new Date().toLocaleTimeString("ru-RU",
    { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  importLogs[source].push({ ts, text });
  if (importLogs[source].length > 1000) importLogs[source].shift();
  console.log(`[admin/${source}] ${text}`);
}

async function safeAdminImport(source: "lst" | "releases") {
  if (importRunning[source]) return;
  importRunning[source] = true;
  importLogs[source] = [];
  importProgress[source] = { current: 0, total: 0 };
  const ac = new AbortController();
  importAbort[source] = ac;

  addImportLog(source, "Импорт запущен");
  try {
    if (source === "lst") {
      await runImport(undefined, { onLog: (msg) => addImportLog(source, msg) });
    } else {
      await runReleasesImport(undefined, undefined, {
        syncTotalPage: true,
        syncSizes: true,
        syncPatchesData: false,
        onProgress: (cur, tot, nick) => {
          importProgress[source] = { current: cur, total: tot };
          addImportLog(source, `[${cur}/${tot}] ${nick}`);
        },
        onLog: (msg) => addImportLog(source, msg),
        signal: ac.signal,
      });
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      addImportLog(source, "⛔ Импорт прерван пользователем");
    } else {
      addImportLog(source, `✗ Ошибка: ${(e as Error).message}`);
      console.error(`[admin] import (${source}) error:`, (e as Error).message);
    }
  } finally {
    importRunning[source] = false;
    importAbort[source] = null;
  }
}

export async function buildServer() {
  const app = Fastify({ logger: true });

  // ── Admin session auth (cookie-based) ─────────────────────────────────────
  const adminLogin    = process.env.ADMIN_LOGIN    ?? "admin";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "admin";
  const COOKIE_NAME   = "uc_admin_session";
  const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

  // In-memory session store: token → expiry timestamp
  const sessions = new Map<string, number>();

  function createSession(): string {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + COOKIE_TTL_MS);
    // Purge expired sessions
    for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
    return token;
  }

  function isValidSession(token: string | undefined): boolean {
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp || exp < Date.now()) { sessions.delete(token ?? ""); return false; }
    return true;
  }

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);

  // Hook: protect all /admin/* routes (except login pages)
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/admin")) return;
    if (url === "/admin/login" || url === "/admin/forgot-password") return;
    const token = (req.cookies as Record<string, string>)[COOKIE_NAME];
    if (!isValidSession(token)) {
      if (url.startsWith("/admin/api/")) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      return reply.redirect("/admin/login");
    }
  });

  // ── Admin login pages ─────────────────────────────────────────────────────
  const loginHtml       = readFileSync(join(__dirname, "../admin/login.html"), "utf-8");
  const forgotHtml      = readFileSync(join(__dirname, "../admin/forgot-password.html"), "utf-8");

  app.get("/admin/login", async (_req, reply) =>
    reply.type("text/html").send(loginHtml));

  app.get("/admin/forgot-password", async (_req, reply) =>
    reply.type("text/html").send(forgotHtml));

  app.post("/admin/login", async (req, reply) => {
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
  const adminHtml = readFileSync(join(__dirname, "../admin/index.html"), "utf-8");

  app.get("/admin", async (_req, reply) =>
    reply.type("text/html").send(adminHtml));

  // ── Admin API ─────────────────────────────────────────────────────────────
  app.get("/admin/api/status", async () => {
    const recentRuns = await db
      .select()
      .from(importRuns)
      .orderBy(desc(importRuns.id))
      .limit(5);

    const itsLogin = process.env.ITS_LOGIN
      ? process.env.ITS_LOGIN.slice(0, 3) + "•".repeat(Math.max(0, process.env.ITS_LOGIN.length - 3))
      : "(не задан)";

    const dbUrl = process.env.DATABASE_URL
      ? process.env.DATABASE_URL.replace(/:([^:@]+)@/, ":••••@")
      : "(не задан)";

    return {
      cron: process.env.IMPORT_CRON ?? "0 4 * * *",
      itsLogin,
      adminLogin,
      dbUrl,
      port: process.env.PORT ?? "3000",
      recentRuns,
      importRunning,
    };
  });

  app.get("/admin/api/logs", async (req) => {
    const limit = Math.min(Number((req.query as any).limit ?? 50), 200);
    const runs = await db
      .select()
      .from(importRuns)
      .orderBy(desc(importRuns.id))
      .limit(limit);
    return { runs };
  });

  app.get(
    "/admin/api/import/status",
    async () => {
      const lastRun =
        (await db
          .select()
          .from(importRuns)
          .orderBy(desc(importRuns.id))
          .limit(1))[0] ?? null;
      return { running: importRunning, lastRun };
    },
  );

  app.post(
    "/admin/api/import/lst",
    async (_req, reply) => {
      if (importRunning["lst"]) {
        return reply.status(409).send({ error: "LST import already running" });
      }
      const lastRun =
        (await db
          .select()
          .from(importRuns)
          .orderBy(desc(importRuns.id))
          .limit(1))[0] ?? null;
      // Fire and forget — client polls /admin/api/import/status
      void safeAdminImport("lst");
      return { started: true, lastRunId: lastRun?.id ?? 0 };
    },
  );

  app.post(
    "/admin/api/import/releases",
    async (_req, reply) => {
      if (importRunning["releases"]) {
        return reply
          .status(409)
          .send({ error: "Releases import already running" });
      }
      if (!process.env.ITS_LOGIN || !process.env.ITS_PASSWORD) {
        return reply
          .status(400)
          .send({ error: "ITS_LOGIN / ITS_PASSWORD не заданы в .env" });
      }
      const lastRun =
        (await db
          .select()
          .from(importRuns)
          .orderBy(desc(importRuns.id))
          .limit(1))[0] ?? null;
      void safeAdminImport("releases");
      return { started: true, lastRunId: lastRun?.id ?? 0 };
    },
  );

  // Live log stream: GET /admin/api/import/log?source=releases&offset=0
  app.get("/admin/api/import/log", async (req) => {
    const { source = "releases", offset = "0" } = req.query as Record<string, string>;
    const logs = importLogs[source] ?? [];
    const from = Math.max(0, Number(offset));
    return {
      lines: logs.slice(from),
      total: logs.length,
      running: !!importRunning[source],
      progress: importProgress[source] ?? { current: 0, total: 0 },
    };
  });

  // Cancel a running import
  app.post("/admin/api/import/cancel", async (req, reply) => {
    const { source = "releases" } = req.query as Record<string, string>;
    const ac = importAbort[source];
    if (!ac) return reply.status(409).send({ error: "Нет активного импорта" });
    ac.abort();
    return { cancelled: true };
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
    const { domain } = (req.body as any) ?? {};
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

  app.get("/api/health", async () => ({
    ok: true,
    has_its: !!(process.env.ITS_LOGIN && process.env.ITS_PASSWORD),
  }));

  // ── Proxy download via ITS (credentials stay server-side) ─────────────────
  app.get("/api/download", async (req, reply) => {
    const { config, from, to } = req.query as Record<string, string>;
    if (!config || !from || !to) {
      return reply.status(400).send({ error: "config, from, to are required" });
    }
    if (!process.env.ITS_LOGIN || !process.env.ITS_PASSWORD) {
      return reply.status(503).send({ error: "ITS credentials not configured" });
    }

    // Resolve cfu_path from the edge
    const rows = await db.execute(sql`
      SELECT ue.cfu_path
      FROM update_edges ue
      JOIN configurations c ON c.id = ue.config_id
      WHERE c.name = ${config} AND ue.from_version = ${from} AND ue.to_version = ${to}
      LIMIT 1
    `);
    const edge = ((rows as any).rows ?? rows)[0] as { cfu_path: string } | undefined;
    if (!edge?.cfu_path) {
      return reply.status(404).send({ error: "Update edge not found" });
    }

    const urlPath = "/tmplts/" + edge.cfu_path.replace(/\\/g, "/");
    const auth =
      "Basic " +
      Buffer.from(`${process.env.ITS_LOGIN}:${process.env.ITS_PASSWORD}`).toString("base64");
    const filename = edge.cfu_path.split(/[\\/]/).pop() ?? "1cv8.cfu";

    return new Promise<void>((resolve, reject) => {
      const upstream = httpsRequest(
        {
          host: "downloads.v8.1c.ru",
          path: urlPath,
          headers: { Authorization: auth, "User-Agent": "1C+Enterprise/8.3" },
        },
        (res) => {
          if (res.statusCode === 401) {
            res.resume();
            reply.status(502).send({ error: "ITS auth failed" });
            return resolve();
          }
          if (res.statusCode !== 200) {
            res.resume();
            reply.status(502).send({ error: `ITS returned ${res.statusCode}` });
            return resolve();
          }
          void reply.header("Content-Disposition", `attachment; filename="${filename}"`);
          void reply.header("Content-Type", "application/octet-stream");
          if (res.headers["content-length"]) {
            void reply.header("Content-Length", res.headers["content-length"]);
          }
          reply.send(res);
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      upstream.on("error", reject);
      upstream.end();
    });
  });

  app.get("/api/configs", async (req) => {
    const q = String((req.query as any).q ?? "").trim();
    const version = String((req.query as any).version ?? "").trim();

    // By-version lookup: find configs that contain this version in their edges.
    if (version) {
      const rows = await db.execute(sql`
        SELECT DISTINCT c.id, c.name, c.display_name, c.vendor, c.releases_href
        FROM configurations c
        JOIN update_edges ue ON ue.config_id = c.id
        WHERE ue.to_version = ${version} OR ue.from_version = ${version}
        ORDER BY c.name
        LIMIT 20
      `);
      return (rows as any).rows ?? rows;
    }

    // Full catalog with enrichment from version_meta and edge counts.
    const filter = q
      ? sql`lower(c.name) like ${"%" + q.toLowerCase() + "%"}
            OR lower(coalesce(c.display_name, '')) like ${"%" + q.toLowerCase() + "%"}`
      : sql`true`;

    const rows = await db.execute(sql`
      SELECT
        c.id, c.name, c.display_name, c.vendor, c.releases_href,
        c.group_name, c.region, c.next_release_version, c.next_release_planned_date, c.next_release_plan_updated,
        vm.version       AS latest_version,
        vm.release_date  AS latest_date,
        vm.min_platform  AS latest_platform,
        COALESCE(vc.cnt, 0) AS version_count,
        avgd.avg_days
      FROM configurations c
      LEFT JOIN LATERAL (
        SELECT version, release_date, min_platform
        FROM version_meta
        WHERE config_id = c.id AND release_date IS NOT NULL
        ORDER BY release_date DESC
        LIMIT 1
      ) vm ON true
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT to_version)::int AS cnt
        FROM update_edges WHERE config_id = c.id
      ) vc ON true
      LEFT JOIN LATERAL (
        SELECT round(avg(diff))::int AS avg_days
        FROM (
          SELECT (release_date - lag(release_date) OVER (ORDER BY release_date)) AS diff
          FROM version_meta
          WHERE config_id = c.id AND release_date IS NOT NULL
        ) t
        WHERE diff > 0 AND diff < 365
      ) avgd ON true
      WHERE ${filter}
      ORDER BY coalesce(c.display_name, c.name)
      LIMIT 1000
    `);
    return (rows as any).rows ?? rows;
  });

  app.get("/api/versions", async (req) => {
    const name = String((req.query as any).config ?? "").trim();
    if (!name) return { versions: [] };
    const cfg = await db
      .select({ id: configurations.id })
      .from(configurations)
      .where(eq(configurations.name, name))
      .limit(1);
    if (cfg.length === 0) return { versions: [] };

    // Only include versions from the dominant edition (most edges) so that
    // cross-edition migration edges (e.g. 10.x→11.x stored under UT 11) don't
    // pollute the version list with entries from a different product generation.
    const rows = await db.execute(sql`
      WITH dom AS (
        SELECT edition FROM update_edges WHERE config_id = ${cfg[0].id}
        GROUP BY edition ORDER BY count(*) DESC LIMIT 1
      )
      SELECT DISTINCT v FROM (
        SELECT from_version v FROM update_edges
          WHERE config_id = ${cfg[0].id} AND edition = (SELECT edition FROM dom)
        UNION
        SELECT to_version   v FROM update_edges
          WHERE config_id = ${cfg[0].id} AND edition = (SELECT edition FROM dom)
      ) t
    `);
    const list: string[] = (
      (rows as any).rows ?? (rows as any)
    ).map((r: any) => r.v);

    list.sort((a, b) => {
      const pa = parseVersion(a)?.segments ?? [];
      const pb = parseVersion(b)?.segments ?? [];
      for (let i = 0; i < 4; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
      }
      return 0;
    });

    // Group by edition (first segment) for the UI.
    const byEdition = new Map<number, string[]>();
    for (const v of list) {
      const ed = parseVersion(v)?.segments[0] ?? 0;
      const arr = byEdition.get(ed) ?? [];
      arr.push(v);
      byEdition.set(ed, arr);
    }

    // Fetch release_date + min_platform + file_size_bytes from version_meta.
    const metaRows = await db.execute(sql`
      SELECT version, release_date::text, min_platform, file_size_bytes
      FROM version_meta
      WHERE config_id = ${cfg[0].id}
    `);
    const meta: Record<string, { release_date: string | null; min_platform: string | null; file_size_bytes: number | null }> = {};
    for (const r of (metaRows as any).rows ?? metaRows) {
      meta[(r as any).version] = {
        release_date: (r as any).release_date ?? null,
        min_platform: (r as any).min_platform ?? null,
        file_size_bytes: (r as any).file_size_bytes ?? null,
      };
    }

    // Fetch cfu_path per to_version: pick the edge from the most recent from_version.
    const cfuRows = await db.execute(sql`
      SELECT DISTINCT ON (to_version) to_version, cfu_path
      FROM update_edges
      WHERE config_id = ${cfg[0].id}
      ORDER BY to_version ASC, from_version DESC
    `);
    const cfu: Record<string, string> = {};
    for (const r of (cfuRows as any).rows ?? cfuRows) {
      if ((r as any).cfu_path) cfu[(r as any).to_version] = (r as any).cfu_path;
    }

    return {
      versions: list,
      editions: [...byEdition.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([edition, versions]) => ({ edition, versions })),
      meta,
      cfu,
    };
  });

  app.get("/api/patches", async (req) => {
    const { config, ver } = req.query as any;
    if (!config || !ver) return { patches: [] };

    // 1. Look up config by name to get id and releases_href.
    const cfgRows = await db
      .select({ id: configurations.id, releasesHref: configurations.releasesHref })
      .from(configurations)
      .where(eq(configurations.name, String(config)))
      .limit(1);
    if (cfgRows.length === 0) return { patches: [] };
    const configId = cfgRows[0].id;
    const releasesHref = cfgRows[0].releasesHref ?? null;

    // 2. Query DB first.
    const dbRows = await db.execute(sql`
      SELECT uuid, title, patch_date::text, download_key
      FROM patches
      WHERE config_id = ${configId} AND version = ${String(ver)}
      ORDER BY patch_date DESC NULLS LAST
    `);
    const existing = (dbRows as any).rows ?? dbRows;
    if (existing.length > 0) return { patches: existing };

    // 3. If empty and credentials + releases_href are available, lazy-fetch.
    if (
      process.env.ITS_LOGIN &&
      process.env.ITS_PASSWORD &&
      releasesHref
    ) {
      try {
        const nick = releasesHref.replace("/project/", "");
        const session = new ReleasesSession();
        await session.login();
        const html = await session.get(
          "/patches/total?nick=" + nick + "&ver=" + String(ver),
        );
        const parsed = parsePatchesPage(html);
        if (parsed.length > 0) {
          const valuesToInsert = parsed.map((p) => ({
            configId,
            version: String(ver),
            uuid: p.uuid,
            title: p.title ?? null,
            patchDate: p.patchDate ?? null,
            downloadKey: null as string | null,
          }));
          await db.insert(patches).values(valuesToInsert).onConflictDoNothing();
          return {
            patches: parsed.map((p) => ({
              uuid: p.uuid,
              title: p.title ?? null,
              patch_date: p.patchDate,
              download_key: null,
            })),
          };
        }
      } catch (e) {
        // Lazy fetch failure is non-fatal — return empty list.
        console.error("[patches] lazy fetch failed:", e);
      }
    }

    return { patches: [] };
  });

  app.get("/api/chain", async (req) => {
    const { config, from, to } = req.query as any;
    if (!config || !from || !to) {
      return { error: "config, from, to are required" };
    }
    const fp = parseVersion(String(from));
    const tp = parseVersion(String(to));
    if (fp && tp && fp.segments[0] !== tp.segments[0]) {
      return {
        found: false,
        steps: [],
        length: 0,
        note: "Версии в разных редакциях. Переход между редакциями — отдельная процедура, цепочкой обновлений не строится.",
      };
    }
    const res = await findChain(
      String(config),
      String(from),
      String(to),
    );
    return res;
  });

  app.get("/api/stats", async () => {
    const [cfgCount, edgeCount, verCount, lastRun] = await Promise.all([
      db.execute(sql`SELECT count(*)::int c FROM configurations`),
      db.execute(sql`SELECT count(*)::int c FROM update_edges`),
      db.execute(sql`SELECT count(DISTINCT to_version)::int c FROM update_edges`),
      db.select().from(importRuns).orderBy(desc(importRuns.id)).limit(1),
    ]);
    const cfgC = ((cfgCount as any).rows ?? cfgCount)[0]?.c ?? 0;
    const edgeC = ((edgeCount as any).rows ?? edgeCount)[0]?.c ?? 0;
    const verC = ((verCount as any).rows ?? verCount)[0]?.c ?? 0;
    const run = lastRun[0] ?? null;
    return {
      configurations: cfgC,
      edges: edgeC,
      versions: verC,
      last_updated: run?.finishedAt?.toISOString().slice(0, 10) ?? null,
      lastRun: run,
    };
  });

  // ── SPA fallback: any unmatched GET → index.html ─────────────────────────
  // Handles hard refresh on client-side routes like /#/config/96 or
  // /%23/config/96 (when a proxy encodes the hash fragment).
  app.setNotFoundHandler((_req, reply) => {
    void reply.sendFile("index.html");
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
