/**
 * server.ts — Fastify app: API + static web UI in one service.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/configs?q=<substr>          -> matching configurations
 *   GET  /api/versions?config=<name>      -> known versions (sorted), grouped by edition
 *   GET  /api/chain?config=&from=&to=     -> computed update chain
 *   GET  /api/stats                       -> import/run summary
 *   GET  /*                               -> static UI (public/)
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
    const rows = await db
      .select({
        name: configurations.name,
        vendor: configurations.vendor,
      })
      .from(configurations)
      .where(
        q
          ? sql`lower(${configurations.name}) like ${"%" + q.toLowerCase() + "%"}`
          : sql`true`,
      )
      .orderBy(configurations.name)
      .limit(50);
    return rows;
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
    return {
      versions: list,
      editions: [...byEdition.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([edition, versions]) => ({ edition, versions })),
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
    const cfgCount = await db.execute(
      sql`SELECT count(*)::int c FROM configurations`,
    );
    const edgeCount = await db.execute(
      sql`SELECT count(*)::int c FROM update_edges`,
    );
    const lastRun = await db
      .select()
      .from(importRuns)
      .orderBy(desc(importRuns.id))
      .limit(1);
    const cfgC = ((cfgCount as any).rows ?? cfgCount)[0]?.c ?? 0;
    const edgeC = ((edgeCount as any).rows ?? edgeCount)[0]?.c ?? 0;
    return {
      configurations: cfgC,
      edges: edgeC,
      lastRun: lastRun[0] ?? null,
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
