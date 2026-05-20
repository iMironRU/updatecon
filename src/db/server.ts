/**
 * server.ts — Fastify app: API + static web UI in one service.
 *
 * Public endpoints:
 *   GET  /api/health
 *   GET  /api/configs?q=<substr>           -> matching configurations (enriched)
 *   GET  /api/configs?version=<v>          -> configs that contain this version
 *   GET  /api/versions?config=<name>       -> known versions + version_meta
 *   GET  /api/chain?config=&from=&to=      -> computed update chain
 *   GET  /api/stats                        -> import/run summary
 *   GET  /*                                -> static UI (public/)
 *
 * Admin endpoints (Basic Auth via ADMIN_LOGIN / ADMIN_PASSWORD):
 *   GET  /admin                            -> admin UI
 *   GET  /admin/api/status                 -> cron, its_login, recent runs
 *   GET  /admin/api/logs                   -> last 50 import runs
 *   GET  /admin/api/import/status          -> is import running + last run
 *   POST /admin/api/import/lst             -> trigger LST import
 *   POST /admin/api/import/releases        -> trigger releases import
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyBasicAuth from "@fastify/basic-auth";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { request as httpsRequest } from "node:https";
import { sql, eq, desc } from "drizzle-orm";
import { db, pool } from "./client.js";
import { configurations, updateEdges, importRuns } from "./schema.js";
import { findChain } from "./chain.js";
import { parseVersion } from "../parser/version.js";
import { runImport } from "./import-lst.js";
import { runReleasesImport } from "../releases/import-releases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// In-memory lock: only one import per source at a time.
const importRunning: Record<string, boolean> = {};

async function safeAdminImport(source: "lst" | "releases") {
  if (importRunning[source]) return;
  importRunning[source] = true;
  try {
    if (source === "lst") {
      await runImport();
    } else {
      await runReleasesImport();
    }
  } catch (e) {
    console.error(`[admin] import (${source}) error:`, (e as Error).message);
  } finally {
    importRunning[source] = false;
  }
}

export async function buildServer() {
  const app = Fastify({ logger: true });

  // ── Admin Basic Auth ──────────────────────────────────────────────────────
  const adminLogin = process.env.ADMIN_LOGIN ?? "admin";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "admin";

  await app.register(fastifyBasicAuth, {
    validate(username, password, _req, _reply, done) {
      if (username === adminLogin && password === adminPassword) {
        done();
      } else {
        done(new Error("Wrong credentials"));
      }
    },
    authenticate: { realm: "Updatcon Admin" },
  });

  // ── Admin HTML ────────────────────────────────────────────────────────────
  const adminHtml = readFileSync(
    join(__dirname, "../admin/index.html"),
    "utf-8",
  );

  app.get(
    "/admin",
    { onRequest: app.basicAuth },
    async (_req, reply) => {
      return reply.type("text/html").send(adminHtml);
    },
  );

  // ── Admin API ─────────────────────────────────────────────────────────────
  app.get("/admin/api/status", { onRequest: app.basicAuth }, async () => {
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

  app.get("/admin/api/logs", { onRequest: app.basicAuth }, async (req) => {
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
    { onRequest: app.basicAuth },
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
    { onRequest: app.basicAuth },
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
    { onRequest: app.basicAuth },
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

    // Fetch release_date + min_platform from version_meta.
    const metaRows = await db.execute(sql`
      SELECT version, release_date::text, min_platform
      FROM version_meta
      WHERE config_id = ${cfg[0].id}
    `);
    const meta: Record<string, { release_date: string | null; min_platform: string | null }> = {};
    for (const r of (metaRows as any).rows ?? metaRows) {
      meta[(r as any).version] = {
        release_date: (r as any).release_date ?? null,
        min_platform: (r as any).min_platform ?? null,
      };
    }

    return {
      versions: list,
      editions: [...byEdition.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([edition, versions]) => ({ edition, versions })),
      meta,
    };
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  buildServer()
    .then((app) =>
      app
        .listen({ port, host: "0.0.0.0" })
        .then(() => app.log.info(`listening on :${port}`)),
    )
    .catch(async (e) => {
      console.error(e);
      await pool.end();
      process.exit(1);
    });
}
