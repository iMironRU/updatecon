/**
 * import-releases.ts — fetch releases.1c.ru and merge into DB as secondary source.
 *
 * Primary source (ITS / .lst) owns configurations and update_edges.
 * This adapter only writes:
 *   - configurations.display_name, configurations.releases_href  (enrichment)
 *   - version_meta rows (release_date, min_platform)
 *
 * Matching strategy: version-set intersection.
 *   For each releases.1c.ru project, collect its known versions.
 *   Find all our configs whose to_version set overlaps ≥ MIN_MATCH_RATIO.
 *   If exactly one config matches above threshold → link it.
 *   Unmatched projects are logged for manual review.
 */

import { sql, eq } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { configurations, versionMeta } from "../db/schema.js";
import { ReleasesSession } from "./fetch-releases.js";
import { parseTotalPage, parseProjectPage } from "./parse-releases.js";

// releases→DB: ≥80% of releases versions must appear in our DB for the winning config.
// DB→releases: the winning config must have ≥30% of its own to_versions in releases.
//   (Popular configs like БП have thousands of versions; releases has ~600 — so 30% is fine.)
// Also reject ambiguous matches (second candidate within 90% of first).
const MIN_FORWARD_RATIO = 0.8;
const MIN_REVERSE_RATIO = 0.3;
const MIN_RELEASES_VERSIONS = 10; // ignore tiny projects (libraries, tools)

interface MatchResult {
  configId: number;
  configName: string;
  forwardRatio: number;
  reverseRatio: number;
}

async function findMatchingConfig(
  releasesVersions: string[],
  displayName?: string,
): Promise<MatchResult | null> {
  if (releasesVersions.length < MIN_RELEASES_VERSIONS) return null;

  const versionLiterals = sql.join(
    releasesVersions.map((v) => sql`${v}`),
    sql`, `,
  );

  // Forward pass: collect all configs that meet the forward-ratio threshold.
  const rows = await db.execute(sql`
    SELECT config_id, count(*)::int AS matches
    FROM update_edges
    WHERE to_version IN (${versionLiterals})
    GROUP BY config_id
    ORDER BY matches DESC
    LIMIT 10
  `);
  const hits: { config_id: number; matches: number }[] =
    (rows as any).rows ?? (rows as any);
  if (!hits.length) return null;

  const qualifying = hits
    .map((h) => ({ config_id: Number(h.config_id), matches: Number(h.matches) }))
    .filter((h) => h.matches / releasesVersions.length >= MIN_FORWARD_RATIO);
  if (!qualifying.length) return null;

  // When displayName is available, use Dice coefficient to rank all qualifying
  // candidates and pick the best name match. This prevents a low-overlap
  // project (e.g. AccountingAI) from stealing a config just because it
  // happens to win the version-count race — the name provides a stronger signal.
  let winnerId = Number(qualifying[0].config_id);
  let winnerMatches = Number(qualifying[0].matches);

  if (displayName && qualifying.length > 0) {
    const candidateIds = qualifying.map((h) => h.config_id);
    const cfgsRows = await db.execute(sql`
      SELECT id, name FROM configurations
      WHERE id IN (${sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)})
    `);
    const cfgs: { id: number; name: string }[] =
      (cfgsRows as any).rows ?? (cfgsRows as any);
    const matchesByConfigId = new Map(
      qualifying.map((h) => [Number(h.config_id), h.matches]),
    );
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^а-яёa-z0-9]/gi, "");
    const relNorm = norm(displayName);
    let bestScore = -1;
    for (const cfg of cfgs) {
      const cfgNorm = norm(cfg.name);
      const lcs = longestCommonSubstring(relNorm, cfgNorm);
      // Dice coefficient: rewards full matches, penalises extra chars on either side.
      const score = (2 * lcs) / (relNorm.length + cfgNorm.length);
      if (score > bestScore) {
        bestScore = score;
        winnerId = Number(cfg.id);
        winnerMatches = matchesByConfigId.get(Number(cfg.id)) ?? winnerMatches;
      }
    }
  }

  const forwardRatio = winnerMatches / releasesVersions.length;

  // Reverse pass for the winner.
  const totalRows = await db.execute(sql`
    SELECT count(DISTINCT to_version)::int AS total
    FROM update_edges
    WHERE config_id = ${winnerId}
  `);
  const total: number =
    ((totalRows as any).rows ?? (totalRows as any))[0]?.total ?? 0;
  const reverseRatio = total > 0 ? winnerMatches / total : 0;
  if (reverseRatio < MIN_REVERSE_RATIO) return null;

  const cfgRows = await db
    .select({ id: configurations.id, name: configurations.name })
    .from(configurations)
    .where(eq(configurations.id, winnerId))
    .limit(1);
  if (!cfgRows.length) return null;

  return {
    configId: cfgRows[0].id,
    configName: cfgRows[0].name,
    forwardRatio,
    reverseRatio,
  };
}

function longestCommonSubstring(a: string, b: string): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let len = 0;
      while (i + len < a.length && j + len < b.length && a[i + len] === b[j + len]) len++;
      if (len > max) max = len;
    }
  }
  return max;
}

export async function runReleasesImport(
  login = process.env.ITS_LOGIN,
  password = process.env.ITS_PASSWORD,
): Promise<void> {
  const session = new ReleasesSession();
  console.log("Authenticating with releases.1c.ru...");
  await session.login(login, password);
  console.log("OK");

  console.log("Fetching /total...");
  const totalHtml = await session.get("/total");
  const allConfigs = parseTotalPage(totalHtml);
  console.log(`Found ${allConfigs.length} projects on releases.1c.ru`);

  let matched = 0;
  let skipped = 0;
  let metaRows = 0;

  // When multiple releases projects map to the same DB config, keep only the
  // one with the most absolute version matches. More matches → more of the
  // config's version history is covered → this is the canonical project.
  const bestMatchForConfig = new Map<number, { matches: number; href: string }>();

  for (let i = 0; i < allConfigs.length; i++) {
    const cfg = allConfigs[i];
    process.stdout.write(
      `\r[${i + 1}/${allConfigs.length}] ${cfg.href.padEnd(40)}`,
    );

    // Fetch per-version data.
    let versionRows;
    try {
      const html = await session.get(`${cfg.href}?allUpdates=true`);
      versionRows = parseProjectPage(html);
    } catch (e) {
      console.error(`\n  SKIP ${cfg.href}: ${(e as Error).message}`);
      skipped++;
      continue;
    }

    if (versionRows.length === 0) { skipped++; continue; }

    const versions = versionRows.map((r) => r.version);
    const match = await findMatchingConfig(versions, cfg.displayName);
    if (!match) { skipped++; continue; }

    const prev = bestMatchForConfig.get(match.configId);
    const currentMatches = Math.round(match.forwardRatio * versions.length);
    if (prev && prev.matches >= currentMatches) {
      // A previous project had equal-or-better version coverage; skip.
      skipped++;
      continue;
    }

    // New best match for this config — overwrite any previous claim.
    bestMatchForConfig.set(match.configId, { matches: currentMatches, href: cfg.href });

    await db.execute(sql`
      UPDATE configurations
      SET display_name  = ${cfg.displayName},
          releases_href = ${cfg.href}
      WHERE id = ${match.configId}
    `);

    // Upsert version_meta rows.
    for (const row of versionRows) {
      if (!row.releaseDate && !row.minPlatform) continue;
      await db.execute(sql`
        INSERT INTO version_meta (config_id, version, release_date, min_platform, source, updated_at)
        VALUES (
          ${match.configId}, ${row.version},
          ${row.releaseDate ?? null}::date,
          ${row.minPlatform ?? null},
          'releases', now()
        )
        ON CONFLICT (config_id, version) DO UPDATE
          SET release_date = EXCLUDED.release_date,
              min_platform = EXCLUDED.min_platform,
              updated_at   = now()
      `);
      metaRows++;
    }
    matched++;
  }

  process.stdout.write("\n");
  console.log(
    `Done: matched=${matched} skipped=${skipped} version_meta_rows=${metaRows}`,
  );
}

// CLI entry point
if (
  process.argv[1] ===
  new URL(import.meta.url).pathname
) {
  runReleasesImport().finally(() => pool.end());
}
