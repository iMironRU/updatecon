/**
 * server.ts — Fastify app: API + static web UI in one service.
 *
 * Public endpoints:
 *   GET  /api/health
 *   GET  /api/configs?q=<substr>           -> application editions (enriched)
 *   GET  /api/configs?version=<v>          -> editions that contain this version
 *   GET  /api/versions?config_id=<id>      -> known versions + version_meta
 *   GET  /api/patches?config_id=&ver=      -> patches list for a version
 *   GET  /api/chain?config_id=&from=&to=   -> computed update chain
 *   (config=<metadata name> is still accepted on the calls above, but names
 *    are not unique — prefer config_id.)
 *   GET  /api/stats                        -> import/run summary
 *   GET  /api/tags                         -> product-line tag dictionary
 *   GET  /*                                -> static UI (public/)
 *
 * Admin endpoints (cookie session auth via ADMIN_LOGIN / ADMIN_PASSWORD):
 *   GET  /admin                            -> admin UI
 *   GET  /admin/api/status                 -> cron, its_login, recent runs
 *   GET  /admin/api/logs                   -> last 50 import runs
 *   GET  /admin/api/import/status          -> is import running + last run
 *   POST /admin/api/import/lst             -> trigger LST import
 *   POST /admin/api/import/releases        -> trigger releases import
 *   GET  /admin/api/projects               -> releases.1c.ru projects + links
 *   GET  /admin/api/apps?q=                -> application editions (link picker)
 *   POST /admin/api/projects/link          -> manual link / unlink / back to auto
 *   GET  /admin/api/tags?q=                -> templates with their tags
 *   POST /admin/api/tags                   -> manual tags / back to auto
 *   POST /admin/api/tags/refresh           -> recompute automatic tags
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
import { configurations, updateEdges, importRuns, patches, settings, releaseProjects } from "./schema.js";
import { findChain } from "./chain.js";
import { setCaddyDomain, getCaddyStatus } from "./caddy.js";
import { TAGS, refreshTags, setManualTags } from "./tags.js";
import { parseVersion } from "../parser/version.js";
import { runImport } from "./import-lst.js";
import { runReleasesImport, refreshPrimaryProjects } from "../releases/import-releases.js";
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

interface ResolvedConfig { id: number; edition: number | null; releasesHref: string | null; }

/**
 * Which application edition an API call is about. Preferred: config_id.
 * Legacy: config=<metadata name> — names are not unique any more (one name
 * can span several templates/editions), so prefer the edition matching the
 * version hint's first segment, then the newest edition.
 */
async function resolveConfig(q: Record<string, unknown>, versionHint?: string): Promise<ResolvedConfig | null> {
  const cols = { id: configurations.id, edition: configurations.edition, releasesHref: configurations.releasesHref };
  const idRaw = String(q.config_id ?? "").trim();
  if (/^\d+$/.test(idRaw)) {
    const [row] = await db.select(cols).from(configurations).where(eq(configurations.id, Number(idRaw))).limit(1);
    return row ?? null;
  }
  const name = String(q.config ?? "").trim();
  if (!name) return null;
  const rows = await db.select(cols).from(configurations).where(eq(configurations.name, name));
  if (rows.length === 0) return null;
  const hintEd = versionHint ? parseVersion(versionHint)?.segments[0] : undefined;
  rows.sort((a, b) =>
    Number(b.edition === hintEd) - Number(a.edition === hintEd) ||
    (b.edition ?? -1) - (a.edition ?? -1));
  return rows[0];
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

  // ── Admin API: releases.1c.ru project ↔ application matching ─────────────
  app.get("/admin/api/projects", async () => {
    const rows = await db.execute(sql`
      SELECT p.nick, p.href, p.display_name, p.group_name, p.region, p.latest_version,
             p.match_method, p.config_id, p.last_seen_at,
             c.name AS config_name, c.template_code, c.edition
      FROM release_projects p
      LEFT JOIN configurations c ON c.id = p.config_id
      ORDER BY (p.config_id IS NULL) DESC, p.display_name
    `);
    const orphans = await db.execute(sql`
      SELECT count(*)::int AS n FROM configurations c
      WHERE NOT EXISTS (SELECT 1 FROM release_projects p WHERE p.config_id = c.id)
    `);
    return {
      projects: (rows as any).rows ?? rows,
      appsWithoutProject: ((orphans as any).rows ?? orphans)[0]?.n ?? 0,
    };
  });

  app.get("/admin/api/apps", async (req) => {
    const q = String((req.query as any).q ?? "").trim().toLowerCase();
    const like = "%" + q + "%";
    const rows = await db.execute(sql`
      SELECT c.id, c.name, c.display_name, c.template_code, c.edition,
             (SELECT count(*)::int FROM update_edges e WHERE e.config_id = c.id) AS edges
      FROM configurations c
      WHERE ${q ? sql`lower(c.name) LIKE ${like}
                    OR lower(coalesce(c.display_name, '')) LIKE ${like}
                    OR coalesce(c.template_key, '') LIKE ${like}` : sql`true`}
      ORDER BY c.template_key, c.edition DESC
      LIMIT 30
    `);
    return { apps: (rows as any).rows ?? rows };
  });

  // body: { nick, config_id: number | null } → manual link (null = "never link")
  //       { nick, auto: true }                → forget the manual decision
  app.post("/admin/api/projects/link", async (req, reply) => {
    const body = (req.body as any) ?? {};
    const nick = String(body.nick ?? "").trim();
    if (!nick) return reply.status(400).send({ error: "nick обязателен" });
    const [proj] = await db.select({ nick: releaseProjects.nick }).from(releaseProjects)
      .where(eq(releaseProjects.nick, nick)).limit(1);
    if (!proj) return reply.status(404).send({ error: "Проект не найден" });

    if (body.auto === true) {
      await db.update(releaseProjects).set({ configId: null, matchMethod: null })
        .where(eq(releaseProjects.nick, nick));
    } else {
      const raw = body.config_id;
      const configId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
      if (configId !== null) {
        if (!Number.isInteger(configId)) return reply.status(400).send({ error: "Некорректный config_id" });
        const [cfg] = await db.select({ id: configurations.id }).from(configurations)
          .where(eq(configurations.id, configId)).limit(1);
        if (!cfg) return reply.status(404).send({ error: "Приложение не найдено" });
      }
      await db.update(releaseProjects).set({ configId, matchMethod: "manual" })
        .where(eq(releaseProjects.nick, nick));
    }
    await refreshPrimaryProjects();
    return { ok: true };
  });

  // ── Admin API: product-line tags ─────────────────────────────────────────
  app.get("/admin/api/tags", async (req) => {
    const q = String((req.query as any).q ?? "").trim().toLowerCase();
    const like = "%" + q + "%";
    const rows = await db.execute(sql`
      SELECT l.template_key, l.template_code, l.name, l.display_name, l.editions,
             coalesce(json_agg(json_build_object('tag', t.tag, 'kind', t.kind, 'source', t.source)
                               ORDER BY t.kind DESC, t.tag) FILTER (WHERE t.tag IS NOT NULL), '[]'::json) AS tags
      FROM (
        SELECT DISTINCT ON (template_key) template_key, template_code, name, display_name,
               (SELECT count(*)::int FROM configurations c2 WHERE c2.template_key = c.template_key) AS editions
        FROM configurations c
        WHERE template_key IS NOT NULL
        ORDER BY template_key, edition DESC
      ) l
      LEFT JOIN template_tags t ON t.template_key = l.template_key
      WHERE ${q ? sql`l.template_key LIKE ${like} OR lower(l.name) LIKE ${like}
                    OR lower(coalesce(l.display_name, '')) LIKE ${like}
                    OR EXISTS (SELECT 1 FROM template_tags tt
                               WHERE tt.template_key = l.template_key AND lower(tt.tag) = ${q})` : sql`true`}
      GROUP BY l.template_key, l.template_code, l.name, l.display_name, l.editions
      ORDER BY l.template_key
    `);
    return { dictionary: TAGS.map((t) => ({ tag: t.tag, title: t.title })), templates: (rows as any).rows ?? rows };
  });

  // body: { template_key, tags: [{tag, kind: "own"|"based"}] } → manual (empty = no tags)
  //       { template_key, auto: true }                        → back to automatic
  app.post("/admin/api/tags", async (req, reply) => {
    const body = (req.body as any) ?? {};
    const key = String(body.template_key ?? "").trim().toLowerCase();
    if (!key) return reply.status(400).send({ error: "template_key обязателен" });
    if (body.auto === true) {
      await setManualTags(key, null);
      return { ok: true };
    }
    if (!Array.isArray(body.tags)) return reply.status(400).send({ error: "tags должен быть массивом" });
    const known = new Set(TAGS.map((t) => t.tag));
    const tags: { tag: string; kind: "own" | "based" }[] = [];
    for (const t of body.tags) {
      const tag = String(t?.tag ?? "");
      const kind = t?.kind === "based" ? "based" : "own";
      if (!known.has(tag)) return reply.status(400).send({ error: `Неизвестный тег: ${tag}` });
      if (!tags.some((x) => x.tag === tag)) tags.push({ tag, kind });
    }
    await setManualTags(key, tags);
    return { ok: true };
  });

  app.post("/admin/api/tags/refresh", async () => ({ ok: true, ...(await refreshTags()) }));

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
    const { from, to } = req.query as Record<string, string>;
    const cfg = await resolveConfig(req.query as Record<string, unknown>, to);
    if (!cfg || !from || !to) {
      return reply.status(400).send({ error: "config_id, from, to are required" });
    }
    if (!process.env.ITS_LOGIN || !process.env.ITS_PASSWORD) {
      return reply.status(503).send({ error: "ITS credentials not configured" });
    }

    // Resolve cfu_path from the edge
    const rows = await db.execute(sql`
      SELECT ue.cfu_path
      FROM update_edges ue
      WHERE ue.config_id = ${cfg.id} AND ue.from_version = ${from} AND ue.to_version = ${to}
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
        SELECT DISTINCT c.id, c.name, c.display_name, c.vendor, c.releases_href, c.template_code, c.edition
        FROM configurations c
        JOIN update_edges ue ON ue.config_id = c.id
        WHERE (ue.to_version = ${version} OR ue.from_version = ${version})
          -- the from-side of a cross-edition edge belongs to the previous edition
          AND (c.edition IS NULL OR c.edition::text = split_part(${version}, '.', 1))
        ORDER BY c.name
        LIMIT 20
      `);
      return (rows as any).rows ?? rows;
    }

    // Full catalog with enrichment from version_meta and edge counts.
    const filter = q
      ? sql`lower(c.name) like ${"%" + q.toLowerCase() + "%"}
            OR lower(coalesce(c.display_name, '')) like ${"%" + q.toLowerCase() + "%"}
            OR coalesce(c.template_key, '') like ${"%" + q.toLowerCase() + "%"}`
      : sql`true`;

    const rows = await db.execute(sql`
      SELECT
        c.id, c.name, c.display_name, c.vendor, c.releases_href,
        c.template_code, c.edition,
        (c.edition = (SELECT max(c2.edition) FROM configurations c2
                      WHERE c2.template_key = c.template_key)) AS is_latest_edition,
        (SELECT coalesce(json_agg(json_build_object('tag', t.tag, 'kind', t.kind)
                                  ORDER BY t.kind DESC, t.tag), '[]'::json)
         FROM template_tags t
         WHERE t.template_key = c.template_key AND t.tag <> '') AS tags,
        c.group_name, c.region, c.next_release_version, c.next_release_planned_date, c.next_release_plan_updated,
        -- releases.1c.ru data when present, else the newest version the LST knows
        COALESCE(vm.version, mv.v) AS latest_version,
        -- Platform generation (8.2 / 8.3 / 8.5 …): the official minimum from
        -- releases.1c.ru for its newest version, unless the LST has a newer
        -- package — then that package's manifest (tmplts/…/1cv8.mft AppVersion).
        -- (Клиент ЭДО 2.10: manifest says 8.3, the release notes require 8.5.1.)
        CASE
          WHEN vp.gen IS NOT NULL
               AND (pm.app_version IS NULL OR vp.ver_arr >= string_to_array(mv.v, '.')::bigint[])
            THEN vp.gen
          ELSE pm.app_version
        END AS platform,
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
        SELECT to_version AS v, cfu_path
        FROM update_edges
        WHERE config_id = c.id
        ORDER BY string_to_array(to_version, '.')::bigint[] DESC
        LIMIT 1
      ) mv ON true
      LEFT JOIN package_manifests pm
        ON pm.status = 'ok'
       AND pm.dir = regexp_replace(replace(mv.cfu_path, '\\', '/'), '/[^/]*$', '')
      LEFT JOIN LATERAL (
        -- newest releases version with a known minimum platform; several listed
        -- ("8.3.27.1688, 8.5.1.1150") → the lowest generation is the requirement
        SELECT CASE WHEN version ~ '^[0-9]+(\\.[0-9]+)*$'
                    THEN string_to_array(version, '.')::bigint[] END AS ver_arr,
               -- "8.3.27.1688" → "8.3": a generation starts a version, not a build number.
               -- (\\. in this template literal = \. in SQL; a bare \. would be "any char".)
               (SELECT min(m[2]) FROM regexp_matches(min_platform, '(^|[^0-9.])(8\\.[0-9]+)\\.[0-9]', 'g') AS m) AS gen
        FROM version_meta
        WHERE config_id = c.id AND min_platform IS NOT NULL
        ORDER BY release_date DESC NULLS LAST
        LIMIT 1
      ) vp ON true
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
    const found = await resolveConfig(req.query as Record<string, unknown>);
    if (!found) return { versions: [] };
    const cfg = [found];

    const rows = await db.execute(sql`
      SELECT DISTINCT v FROM (
        SELECT from_version v FROM update_edges WHERE config_id = ${cfg[0].id}
        UNION
        SELECT to_version   v FROM update_edges WHERE config_id = ${cfg[0].id}
      ) t
    `);
    // An application edition only lists its own edition's versions: the
    // from-side of cross-edition migration edges (10.x→11.x stored under
    // UT 11) belongs to the previous edition.
    const list: string[] = (
      (rows as any).rows ?? (rows as any)
    ).map((r: any) => r.v)
      .filter((v: string) => found.edition === null || parseVersion(v)?.segments[0] === found.edition);

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
    const { ver } = req.query as any;
    if (!ver) return { patches: [] };

    // 1. Resolve the application edition (id + releases_href).
    const cfgRow = await resolveConfig(req.query as Record<string, unknown>, String(ver));
    if (!cfgRow) return { patches: [] };
    const configId = cfgRow.id;
    const releasesHref = cfgRow.releasesHref ?? null;

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
    const { from, to } = req.query as any;
    const cfg = await resolveConfig(req.query as Record<string, unknown>, to ? String(to) : undefined);
    if (!cfg || !from || !to) {
      return { error: "config_id, from, to are required" };
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
      cfg.id,
      String(from),
      String(to),
    );
    return res;
  });

  app.get("/api/tags", async () =>
    TAGS.map((t) => ({ tag: t.tag, title: t.title })));

  app.get("/api/stats", async () => {
    const [cfgCount, appCount, edgeCount, verCount, lastRun] = await Promise.all([
      db.execute(sql`SELECT count(*)::int c FROM configurations`),
      // Applications = templates (one current edition each); configurations = all editions.
      db.execute(sql`SELECT count(DISTINCT coalesce(template_key, id::text))::int c FROM configurations`),
      db.execute(sql`SELECT count(*)::int c FROM update_edges`),
      db.execute(sql`SELECT count(DISTINCT to_version)::int c FROM update_edges`),
      db.select().from(importRuns)
        .where(eq(importRuns.status, "ok"))
        .orderBy(desc(importRuns.id))
        .limit(1),
    ]);
    const cfgC = ((cfgCount as any).rows ?? cfgCount)[0]?.c ?? 0;
    const appC = ((appCount as any).rows ?? appCount)[0]?.c ?? 0;
    const edgeC = ((edgeCount as any).rows ?? edgeCount)[0]?.c ?? 0;
    const verC = ((verCount as any).rows ?? verCount)[0]?.c ?? 0;
    const run = lastRun[0] ?? null;
    return {
      configurations: cfgC,
      applications: appC,
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
