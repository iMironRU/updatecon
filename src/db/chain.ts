/**
 * chain.ts — update-chain calculator.
 *
 * BFS in TypeScript, fetching the frontier level-by-level from Postgres.
 * Each version is visited at most once → O(V + E), never exponential.
 *
 * Guards:
 *  - same edition only (mirrors СовпадаютРедакции).
 *  - cycle-safe: visited set grows monotonically.
 *  - depth-limited (maxDepth).
 *  - "shortest" = fewest steps (BFS guarantees this).
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
  note?: string;
}

interface Predecessor {
  prev: string;
  cfu: string;
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

  // Resolve config id once.
  const cfgRows = await db.execute(
    sql`SELECT id FROM configurations WHERE name = ${configName} LIMIT 1`,
  );
  const cfgList = (cfgRows as any).rows ?? (cfgRows as any);
  if (!cfgList?.length) return { found: false, steps: [], length: 0 };
  const configId: number = cfgList[0].id;

  // BFS: frontier = versions to expand next; pred = how we got there.
  const visited = new Set<string>([from]);
  const pred = new Map<string, Predecessor>();
  let frontier: string[] = [from];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const frontierLiteral = sql.join(
      frontier.map((v) => sql`${v}`),
      sql`, `,
    );
    const rows = await db.execute(sql`
      SELECT from_version, to_version, cfu_path
      FROM update_edges
      WHERE config_id  = ${configId}
        AND edition    = ${edition}
        AND from_version IN (${frontierLiteral})
    `);
    const edges: { from_version: string; to_version: string; cfu_path: string }[] =
      (rows as any).rows ?? (rows as any);

    const nextFrontier: string[] = [];
    for (const e of edges) {
      if (visited.has(e.to_version)) continue;
      visited.add(e.to_version);
      pred.set(e.to_version, { prev: e.from_version, cfu: e.cfu_path });
      if (e.to_version === to) {
        return { found: true, steps: reconstructPath(pred, from, to), length: depth + 1 };
      }
      nextFrontier.push(e.to_version);
    }
    frontier = nextFrontier;
  }

  // BFS exhausted without reaching `to`. Diagnose why for a helpful message.
  // Case 1: from_version has no outgoing edges at all → data gap (version too old).
  const fromEdgeCheck = await db.execute(sql`
    SELECT 1 FROM update_edges
    WHERE config_id = ${configId} AND edition = ${edition} AND from_version = ${from}
    LIMIT 1
  `);
  const hasFromEdges = ((fromEdgeCheck as any).rows ?? fromEdgeCheck).length > 0;
  if (!hasFromEdges) {
    return {
      found: false,
      steps: [],
      length: 0,
      note:
        `Версия ${fromVersion} слишком старая — данных об обновлениях из неё нет в базе ` +
        `(1С не публикует переходы из давних версий). ` +
        `Сначала обновитесь вручную до любой версии из списка, затем постройте цепочку отсюда.`,
    };
  }
  return { found: false, steps: [], length: 0, note: "Цепочка не найдена — нет пути в базе данных." };
}

function reconstructPath(
  pred: Map<string, Predecessor>,
  from: string,
  to: string,
): ChainStep[] {
  const steps: ChainStep[] = [];
  let cur = to;
  while (cur !== from) {
    const p = pred.get(cur)!;
    steps.unshift({ fromVersion: p.prev, toVersion: cur, cfuPath: p.cfu });
    cur = p.prev;
  }
  return steps;
}
