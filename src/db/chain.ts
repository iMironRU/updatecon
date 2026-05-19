/**
 * chain.ts — update-chain calculator.
 *
 * Given a configuration and a (fromVersion, toVersion), find the shortest
 * sequence of update packages that walks from one to the other along
 * update_edges. Pure SQL recursive CTE so the graph never leaves Postgres.
 *
 * Guards:
 *  - same edition only (edges already store `edition`; we pin it to the
 *    target's edition, mirroring СовпадаютРедакции).
 *  - cycle-safe: a path never revisits a version (array membership check).
 *  - depth-limited (maxDepth) so a pathological graph can't run away.
 *  - "shortest" = fewest steps; ties broken by lexicographically smaller
 *    version path for determinism.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { parseVersion } from "../parser/version.js";

export interface ChainStep {
  fromVersion: string;
  toVersion: string;
  cfuPath: string;
}

export interface ChainResult {
  found: boolean;
  steps: ChainStep[];
  /** number of update packages to apply */
  length: number;
}

export async function findChain(
  configName: string,
  fromVersion: string,
  toVersion: string,
  maxDepth = 64,
): Promise<ChainResult> {
  const fromPv = parseVersion(fromVersion);
  const toPv = parseVersion(toVersion);
  if (!fromPv || !toPv) return { found: false, steps: [], length: 0 };

  const from = fromPv.core;
  const to = toPv.core;
  if (from === to) return { found: true, steps: [], length: 0 };

  const edition = toPv.segments[0] ?? 0;

  // Recursive walk over edges. `path` accumulates visited versions to block
  // cycles; we stop as soon as we reach `to`, then pick the shortest.
  const rows = await db.execute(sql`
    WITH RECURSIVE cfg AS (
      SELECT id FROM configurations WHERE name = ${configName} LIMIT 1
    ),
    walk AS (
      SELECT
        e.from_version,
        e.to_version,
        e.cfu_path,
        1 AS depth,
        ARRAY[e.from_version, e.to_version] AS path,
        ARRAY[e.cfu_path] AS cfus
      FROM update_edges e, cfg
      WHERE e.config_id = cfg.id
        AND e.edition = ${edition}
        AND e.from_version = ${from}

      UNION ALL

      SELECT
        e.from_version,
        e.to_version,
        e.cfu_path,
        w.depth + 1,
        w.path || e.to_version,
        w.cfus || e.cfu_path
      FROM update_edges e
      JOIN cfg ON e.config_id = cfg.id
      JOIN walk w ON e.from_version = w.to_version
      WHERE e.edition = ${edition}
        AND w.depth < ${maxDepth}
        AND NOT (e.to_version = ANY(w.path))   -- cycle guard
        AND w.to_version <> ${to}              -- stop once target reached
    )
    SELECT path, cfus, depth
    FROM walk
    WHERE to_version = ${to}
    ORDER BY depth ASC, path ASC
    LIMIT 1
  `);

  const r = (rows as unknown as { rows: any[] }).rows ?? (rows as any);
  if (!r || r.length === 0) return { found: false, steps: [], length: 0 };

  const path: string[] = r[0].path;
  const cfus: string[] = r[0].cfus;
  const steps: ChainStep[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    steps.push({
      fromVersion: path[i],
      toVersion: path[i + 1],
      cfuPath: cfus[i] ?? "",
    });
  }
  return { found: true, steps, length: steps.length };
}
