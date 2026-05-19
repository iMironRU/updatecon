/**
 * server.ts — Fastify app: API + static web UI in one service.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/configs?q=<substr>           -> matching configurations (enriched)
 *   GET  /api/configs?version=<v>          -> configs that contain this version
 *   GET  /api/versions?config=<name>       -> known versions + version_meta
 *   GET  /api/chain?config=&from=&to=      -> computed update chain
 *   GET  /api/stats                        -> import/run summary
 *   GET  /*                                -> static UI (public/)
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql, eq, desc } from "drizzle-orm";
import { db, pool } from "./client.js";
import { configurations, updateEdges, importRuns } from "./schema.js";
import { findChain } from "./chain.js";
import { parseVersion } from "../parser/version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildServer() {
  const app = Fastify({ logger: true });

  app.register(fastifyStatic, {
    root: join(__dirname, "..", "..", "public"),
    prefix: "/",
  });

  app.get("/api/health", async () => ({ ok: true }));

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

    const rows = await db.execute(sql`
      SELECT DISTINCT v FROM (
        SELECT from_version v FROM update_edges WHERE config_id = ${cfg[0].id}
        UNION
        SELECT to_version   v FROM update_edges WHERE config_id = ${cfg[0].id}
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

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  app
    .listen({ port, host: "0.0.0.0" })
    .then(() => app.log.info(`listening on :${port}`))
    .catch(async (e) => {
      app.log.error(e);
      await pool.end();
      process.exit(1);
    });
}
