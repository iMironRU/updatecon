/**
 * chain.ts — update-chain calculator.
 *
 * BFS in TypeScript, fetching the frontier level-by-level from Postgres.
 * Each version is visited at most once → O(V + E), never exponential.
 *
 * Guards:
 *  - only explicit transitions from LST/releases are traversed.
 *  - cycle-safe: visited set grows monotonically.
 *  - depth-limited (maxDepth).
 *  - "shortest" = fewest steps (BFS guarantees this).
 *  - equal-length paths prefer newer intermediate releases at the first
 *    differing step.
 */

import { sql } from "drizzle-orm";
import { db, rows } from "./client.js";
import { compareVersions, parseVersion } from "../parser/version.js";

interface ChainStep {
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

  // A release-only project can still use transitions parsed from its project page.
  const directProjectId = configName.startsWith("release:")
    ? Number(configName.slice("release:".length))
    : null;
  let configId: number | null = null;
  if (directProjectId === null) {
    const cfgRows = await db.execute(
      sql`SELECT id FROM configurations WHERE name = ${configName} AND is_hidden = false LIMIT 1`,
    );
    const cfgList = rows(cfgRows);
    if (!cfgList?.length) return { found: false, steps: [], length: 0 };
    configId = Number(cfgList[0].id);
  } else if (!Number.isInteger(directProjectId)) {
    return { found: false, steps: [], length: 0 };
  }
  const lstFilter = configId === null ? sql`false` : sql`ue.config_id = ${configId}`;
  const projectFilter = directProjectId === null
    ? sql`rp.config_id = ${configId} AND rp.is_hidden = false`
    : sql`rp.id = ${directProjectId} AND rp.is_hidden = false AND rp.catalog_state = 'ready'`;

  const testEndpointRows = await db.execute(sql`
    SELECT rpv.version
    FROM release_project_versions rpv
    JOIN release_projects rp ON rp.id = rpv.project_id
    WHERE ${projectFilter}
      AND rpv.is_test = true
      AND rpv.version IN (${from}, ${to})
    ORDER BY CASE WHEN rpv.version = ${to} THEN 0 ELSE 1 END
    LIMIT 1
  `);
  const testEndpoint = String(
    (rows(testEndpointRows)[0]?.version) ?? "",
  );
  if (testEndpoint) {
    return {
      found: false,
      steps: [],
      length: 0,
      note: testEndpoint === to
        ? `Версия ${toVersion} предназначена для тестирования и исключена из расчёта обновлений.`
        : `Исходная версия ${fromVersion} предназначена для тестирования и исключена из расчёта обновлений.`,
    };
  }

  const compare = compareSegments(fromPv.segments, toPv.segments);
  if (compare > 0) {
    return {
      found: false,
      steps: [],
      length: 0,
      note: "Целевая версия должна быть новее исходной.",
    };
  }

  // Some 1C project pages intentionally leave every transition cell empty.
  // This is an explicit "from any older version" policy, not missing data.
  const unrestrictedTarget = await db.execute(sql`
    SELECT 1
    FROM release_projects rp
    JOIN release_project_versions rpv ON rpv.project_id = rp.id
    WHERE ${projectFilter}
      AND rp.transition_mode = 'unrestricted'
      AND rpv.version = ${to}
      AND rpv.is_test = false
    LIMIT 1
  `);
  if (rows(unrestrictedTarget).length > 0) {
    let cfuPath = "";
    if (configId !== null) {
      const cfuRows = await db.execute(sql`
        SELECT cfu_path FROM update_edges
        WHERE config_id = ${configId} AND to_version = ${to}
        ORDER BY from_version DESC LIMIT 1
      `);
      cfuPath = String((rows(cfuRows)[0]?.cfu_path) ?? "");
    }
    return {
      found: true,
      steps: [{ fromVersion: from, toVersion: to, cfuPath }],
      length: 1,
      note: "1С не ограничивает исходную версию для этого релиза.",
    };
  }

  // BFS: frontier = versions to expand next; pred = how we got there.
  const visited = new Set<string>([from]);
  const pred = new Map<string, Predecessor>();
  let frontier: string[] = [from];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const frontierLiteral = sql.join(
      frontier.map((v) => sql`${v}`),
      sql`, `,
    );
    const result = await db.execute(sql`
      SELECT DISTINCT ON (from_version, to_version)
        from_version, to_version, cfu_path
      FROM (
        SELECT ue.from_version, ue.to_version, ue.cfu_path, 0 AS priority
        FROM update_edges ue
        WHERE ${lstFilter}
          AND NOT EXISTS (
            SELECT 1
            FROM release_project_versions test_version
            JOIN release_projects test_project ON test_project.id = test_version.project_id
            WHERE test_project.config_id = ue.config_id
              AND test_project.is_hidden = false
              AND test_version.is_test = true
              AND test_version.version IN (ue.from_version, ue.to_version)
          )

        UNION ALL

        SELECT rvt.from_version, rpv.version AS to_version, '' AS cfu_path, 1 AS priority
        FROM release_version_transitions rvt
        JOIN release_project_versions rpv ON rpv.id = rvt.project_version_id
        JOIN release_projects rp ON rp.id = rpv.project_id
        WHERE ${projectFilter}
          AND rpv.is_test = false
          AND NOT EXISTS (
            SELECT 1 FROM release_project_versions test_source
            WHERE test_source.project_id = rpv.project_id
              AND test_source.version = rvt.from_version
              AND test_source.is_test = true
          )
      ) graph
      WHERE from_version IN (${frontierLiteral})
      ORDER BY from_version, to_version, priority
    `);
    const edges = rows(result) as { from_version: string; to_version: string; cfu_path: string }[];

    // `frontier` is already ordered by preferred paths from the previous BFS
    // level. Keep that parent order and visit each parent's newest targets
    // first. Thus BFS still returns the fewest steps, while the first path
    // found among equal-length alternatives contains newer intermediate
    // releases at the first differing position.
    const frontierRank = new Map(frontier.map((version, index) => [version, index]));
    edges.sort((left, right) => {
      const parentOrder =
        (frontierRank.get(left.from_version) ?? Number.MAX_SAFE_INTEGER)
        - (frontierRank.get(right.from_version) ?? Number.MAX_SAFE_INTEGER);
      if (parentOrder !== 0) return parentOrder;
      return compareVersions(right.to_version, left.to_version)
        || right.to_version.localeCompare(left.to_version, "ru", { numeric: true });
    });

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
    SELECT 1
    FROM (
      SELECT ue.from_version
      FROM update_edges ue
      WHERE ${lstFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM release_project_versions test_version
          JOIN release_projects test_project ON test_project.id = test_version.project_id
          WHERE test_project.config_id = ue.config_id
            AND test_project.is_hidden = false
            AND test_version.is_test = true
            AND test_version.version IN (ue.from_version, ue.to_version)
        )

      UNION ALL

      SELECT rvt.from_version
      FROM release_version_transitions rvt
      JOIN release_project_versions rpv ON rpv.id = rvt.project_version_id
      JOIN release_projects rp ON rp.id = rpv.project_id
      WHERE ${projectFilter}
        AND rpv.is_test = false
        AND NOT EXISTS (
          SELECT 1 FROM release_project_versions test_source
          WHERE test_source.project_id = rpv.project_id
            AND test_source.version = rvt.from_version
            AND test_source.is_test = true
        )
    ) graph
    WHERE from_version = ${from}
    LIMIT 1
  `);
  const hasFromEdges = rows(fromEdgeCheck).length > 0;
  if (!hasFromEdges) {
    const projectStateRows = await db.execute(sql`
      SELECT
        count(rpv.id)::int AS versions,
        bool_or(rp.transition_mode = 'unknown') AS has_unknown_policy,
        bool_or(rp.transition_mode = 'unrestricted') AS has_unrestricted_policy
      FROM release_projects rp
      LEFT JOIN release_project_versions rpv ON rpv.project_id = rp.id
      WHERE ${projectFilter}
    `);
    const projectState = (rows(projectStateRows)[0] ?? {}) as {
      versions?: number;
      has_unknown_policy?: boolean;
      has_unrestricted_policy?: boolean;
    };
    if (Number(projectState.versions ?? 0) > 0 && projectState.has_unrestricted_policy) {
      return {
        found: false,
        steps: [],
        length: 0,
        note: `Целевая версия ${toVersion} отсутствует в опубликованной истории 1С. Для известных релизов исходная версия не ограничивается.`,
      };
    }
    if (Number(projectState.versions ?? 0) > 0 && projectState.has_unknown_policy) {
      return {
        found: false,
        steps: [],
        length: 0,
        note: "Для этой конфигурации допустимые переходы не указаны. Обновите данные, чтобы приложение уточнило правило перехода на странице 1С.",
      };
    }
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

function compareSegments(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length, 4);
  for (let index = 0; index < length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
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
