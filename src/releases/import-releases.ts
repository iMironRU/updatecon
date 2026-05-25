/**
 * import-releases.ts — fetch releases.1c.ru and merge into DB as secondary source.
 *
 * Primary source (ITS / .lst) owns configurations and update_edges.
 * This adapter writes:
 *   - configurations: display_name, releases_href, group_name,
 *                     next_release_version, next_release_planned_date, next_release_plan_updated
 *   - version_meta: release_date, min_platform, file_size_bytes
 *   - patches: uuid, patch_date, title, download_key
 *
 * Matching strategy: version-set intersection.
 *   For each releases.1c.ru project, collect its known versions.
 *   Find all our configs whose to_version set overlaps ≥ MIN_MATCH_RATIO.
 *   If exactly one config matches above threshold → link it.
 */

import { sql, eq } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { configurations, versionMeta, patches, importRuns } from "../db/schema.js";
import { ReleasesSession } from "./fetch-releases.js";
import {
  parseTotalPage, parseProjectPage, parseVersionFiles,
  parseFileProperties, parsePatchesPage,
} from "./parse-releases.js";

// releases→DB: ≥80% of releases versions must appear in our DB for the winning config.
const MIN_FORWARD_RATIO = 0.8;
// DB→releases: the winning config must have ≥30% of its own to_versions in releases.
const MIN_REVERSE_RATIO = 0.3;
const MIN_RELEASES_VERSIONS = 10;

/** Map a releases.1c.ru group_name to a short region code. */
function groupToRegion(groupName: string | null | undefined): string | null {
  if (!groupName) return null;
  if (/Стандартные библиотеки/i.test(groupName))   return "stdlib";
  if (/Международные/i.test(groupName))             return "intl";
  if (/для России|для Российской/i.test(groupName)) return "ru";
  if (/для Азербайджана/i.test(groupName))          return "az";
  if (/для Армении/i.test(groupName))               return "am";
  if (/для стран Балтии/i.test(groupName))          return "baltics";
  if (/для Беларуси/i.test(groupName))              return "by";
  if (/для Болгарии/i.test(groupName))              return "bg";
  if (/для Грузии/i.test(groupName))                return "ge";
  if (/для Казахстана/i.test(groupName))            return "kz";
  if (/для Кыргызстана/i.test(groupName))           return "kg";
  if (/для Латвии/i.test(groupName))                return "lv";
  if (/для Литвы/i.test(groupName))                 return "lt";
  if (/для Молдовы/i.test(groupName))               return "md";
  if (/для Таджикистана/i.test(groupName))          return "tj";
  if (/для Узбекистана/i.test(groupName))           return "uz";
  if (/для Эстонии/i.test(groupName))               return "ee";
  if (/Отраслевые решения/i.test(groupName))        return "ru"; // industry — Russian ecosystem
  if (/Конфигурации проекта/i.test(groupName))      return "ru"; // partner — Russian ecosystem
  return "ru"; // default
}

/** Region stems to search in config names/display names (handles Russian declension). */
const REGION_STEMS: Record<string, string[]> = {
  az: ["азербайджан", "azerbaij"],
  am: ["армени", "armeni"],
  baltics: ["балти", "baltic"],
  by: ["беларус", "белорус", "belarus"],
  bg: ["болгари", "bulgari"],
  ge: ["грузи", "georgi"],
  kz: ["казахстан", "kazakhst"],
  kg: ["кыргыз", "kyrgyz"],
  lv: ["латви", "latvia"],
  lt: ["литв", "lithu"],
  md: ["молдов", "moldova"],
  tj: ["таджик", "tajik"],
  uz: ["узбек", "uzbek"],
  ee: ["эстони", "estoni"],
  stdlib: ["библиотек", "library"],
  intl: ["международн", "internation"],
};

/** Returns true if the DB config's name/displayName indicates it belongs to the given region. */
function configMatchesRegion(configName: string, configDisplayName: string | null | undefined, region: string): boolean {
  if (region === "ru") return true; // no restriction for Russian
  const stems = REGION_STEMS[region];
  if (!stems) return true; // unknown region — allow
  const haystack = ((configName || "") + " " + (configDisplayName || "")).toLowerCase();
  return stems.some((s) => haystack.includes(s));
}

interface MatchResult {
  configId: number;
  configName: string;
  configDisplayName: string | null;
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

  let winnerId = Number(qualifying[0].config_id);
  let winnerMatches = Number(qualifying[0].matches);

  if (displayName && qualifying.length > 0) {
    const candidateIds = qualifying.map((h) => h.config_id);
    const cfgsRows = await db.execute(sql`
      SELECT id, name, display_name FROM configurations
      WHERE id IN (${sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)})
    `);
    const cfgs: { id: number; name: string; display_name: string | null }[] =
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
      const score = (2 * lcs) / (relNorm.length + cfgNorm.length);
      if (score > bestScore) {
        bestScore = score;
        winnerId = Number(cfg.id);
        winnerMatches = matchesByConfigId.get(Number(cfg.id)) ?? winnerMatches;
      }
    }
  }

  const forwardRatio = winnerMatches / releasesVersions.length;

  const totalRows = await db.execute(sql`
    SELECT count(DISTINCT to_version)::int AS total
    FROM update_edges WHERE config_id = ${winnerId}
  `);
  const total: number =
    ((totalRows as any).rows ?? (totalRows as any))[0]?.total ?? 0;
  const reverseRatio = total > 0 ? winnerMatches / total : 0;
  if (reverseRatio < MIN_REVERSE_RATIO) return null;

  const cfgRows = await db
    .select({ id: configurations.id, name: configurations.name, displayName: configurations.displayName })
    .from(configurations)
    .where(eq(configurations.id, winnerId))
    .limit(1);
  if (!cfgRows.length) return null;

  return {
    configId: cfgRows[0].id,
    configName: cfgRows[0].name,
    configDisplayName: cfgRows[0].displayName ?? null,
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

// ── File size fetching ────────────────────────────────────────────────────────

async function syncFileSizesForConfig(
  session: ReleasesSession,
  configId: number,
  nick: string,
  limit = 50,
): Promise<number> {
  // Find version_meta rows for this config that have no file_size_bytes yet
  const rows = await db.execute(sql`
    SELECT id, version FROM version_meta
    WHERE config_id = ${configId} AND file_size_bytes IS NULL
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `) as { rows: Array<{ id: number; version: string }> };
  const items = (rows as any).rows ?? rows;
  let sized = 0;

  for (const item of items) {
    try {
      const html = await session.get(
        `/version_files?nick=${encodeURIComponent(nick)}&ver=${encodeURIComponent(item.version)}`
      );
      const files = parseVersionFiles(html);
      // Prefer "Дистрибутив обновления" (main update zip, not base install)
      const updateFile = files.find(f =>
        f.title.includes("Дистрибутив обновления") && !f.title.includes("базовой")
      ) ?? files.find(f => f.title.includes("Дистрибутив"));

      if (!updateFile?.propertiesId) continue;

      const propJson = await session.get(`/files/properties/version-files/${updateFile.propertiesId}`);
      const bytes = parseFileProperties(propJson);
      if (!bytes) continue;

      await db
        .update(versionMeta)
        .set({ fileSizeBytes: bytes })
        .where(eq(versionMeta.id, item.id));
      sized++;
      await delay(150);
    } catch {
      // version may not exist on releases.1c.ru — skip silently
    }
  }
  return sized;
}

// ── Patches fetching ──────────────────────────────────────────────────────────

async function syncPatchesForConfig(
  session: ReleasesSession,
  configId: number,
  nick: string,
  versions: string[],
): Promise<number> {
  let total = 0;
  for (const ver of versions) {
    try {
      const html = await session.get(
        `/patches/total?nick=${encodeURIComponent(nick)}&ver=${encodeURIComponent(ver)}`
      );
      const patchList = parsePatchesPage(html);
      for (const p of patchList) {
        await db
          .insert(patches)
          .values({
            configId,
            version: ver,
            uuid: p.uuid,
            title: p.title ?? null,
            patchDate: p.patchDate ?? null,
          })
          .onConflictDoNothing();
        total++;
      }
      await delay(150);
    } catch {
      // version may not have patches page — skip
    }
  }
  return total;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Main export ───────────────────────────────────────────────────────────────

export interface ReleasesImportOptions {
  /** Sync group names and planned release dates from /total (fast, one page) */
  syncTotalPage?: boolean;
  /** Fetch file sizes for version_meta rows (slow, many pages) */
  syncSizes?: boolean;
  /** Fetch patches for known versions (slow, many pages) */
  syncPatchesData?: boolean;
  /** Max versions to size per run */
  sizesLimit?: number;
  /** Progress callback: called once per config with (current, total, nick) */
  onProgress?: (current: number, total: number, nick: string) => void;
  /** Log callback for admin UI; if absent, output goes to stdout */
  onLog?: (msg: string) => void;
  /** AbortSignal to cancel the import between configs */
  signal?: AbortSignal;
}

export async function runReleasesImport(
  login = process.env.ITS_LOGIN,
  password = process.env.ITS_PASSWORD,
  opts: ReleasesImportOptions = {},
): Promise<void> {
  const {
    syncTotalPage = true,
    syncSizes = true,
    syncPatchesData = false,
    sizesLimit = 200,
    onProgress,
    onLog,
    signal,
  } = opts;

  const log = (msg: string) => {
    if (onLog) onLog(msg); else console.log(msg);
  };

  if (!login || !password) {
    log("⚠ ITS_LOGIN / ITS_PASSWORD не заданы — пропуск");
    return;
  }

  const startedAt = new Date();

  const session = new ReleasesSession();
  log("Авторизация на releases.1c.ru...");
  await session.login(login, password);
  log("Авторизация успешна");

  log("Загрузка списка проектов (/total)...");
  const totalHtml = await session.get("/total");
  const allConfigs = parseTotalPage(totalHtml);
  log(`Найдено проектов: ${allConfigs.length}`);

  let matched = 0, skipped = 0, metaRows = 0, totalSized = 0, totalPatches = 0;

  const bestMatchForConfig = new Map<number, { matches: number; href: string }>();

  for (let i = 0; i < allConfigs.length; i++) {
    // Check abort signal between iterations
    if (signal?.aborted) {
      const e = new Error("Cancelled by user");
      e.name = "AbortError";
      throw e;
    }

    const cfg = allConfigs[i];
    const nick = cfg.href.replace(/^\/project\//, "");

    onProgress?.(i + 1, allConfigs.length, nick);
    if (!onLog) {
      process.stdout.write(`\r[releases] [${i + 1}/${allConfigs.length}] ${cfg.href.padEnd(40)}`);
    }

    let versionRows;
    try {
      const html = await session.get(`${cfg.href}?allUpdates=true`);
      versionRows = parseProjectPage(html);
    } catch (e) {
      log(`  ✗ ${nick}: ${(e as Error).message}`);
      skipped++;
      continue;
    }

    if (versionRows.length === 0) { skipped++; continue; }

    const versions = versionRows.map((r) => r.version);
    const match = await findMatchingConfig(versions, cfg.displayName);
    if (!match) { skipped++; continue; }

    const releasesRegion = groupToRegion(cfg.groupName);

    // For non-Russian regional projects: the matched DB config must have a name/display_name
    // that hints at the same region. This prevents Russian configs from being matched to
    // Azerbaijani/Kazakh/etc. projects that share version ranges (localised ports).
    if (releasesRegion && releasesRegion !== "ru" && releasesRegion !== "stdlib" && releasesRegion !== "intl") {
      if (!configMatchesRegion(match.configName, match.configDisplayName, releasesRegion)) {
        log(`  ✗ ${nick}: регион ${releasesRegion} не совпадает с конфигом ${match.configName}`);
        skipped++;
        continue;
      }
    }

    const prev = bestMatchForConfig.get(match.configId);
    const currentMatches = Math.round(match.forwardRatio * versions.length);
    if (prev && prev.matches >= currentMatches) { skipped++; continue; }
    bestMatchForConfig.set(match.configId, { matches: currentMatches, href: cfg.href });

    log(`  ✓ ${nick} → ${match.configName}`);

    // If releases_href was previously assigned to a different config (matching
    // heuristic can change between runs), clear it there first — the unique
    // constraint does not allow two rows to share the same href.
    await db.execute(sql`
      UPDATE configurations SET releases_href = NULL
      WHERE releases_href = ${cfg.href} AND id <> ${match.configId}
    `);

    // Write config enrichment (display_name, releases_href, group, region, planned dates)
    await db.execute(sql`
      UPDATE configurations SET
        display_name                = ${cfg.displayName},
        releases_href               = ${cfg.href},
        group_name                  = ${cfg.groupName || null},
        region                      = ${releasesRegion},
        next_release_version        = ${cfg.nextReleaseVersion ?? null},
        next_release_planned_date   = ${cfg.nextReleasePlannedDate ?? null},
        next_release_plan_updated   = ${cfg.nextReleasePlanUpdated ?? null}::date
      WHERE id = ${match.configId}
    `);

    // Upsert version_meta rows
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

    // File sizes (incremental, limited per run)
    if (syncSizes) {
      const sized = await syncFileSizesForConfig(session, match.configId, nick, Math.ceil(sizesLimit / allConfigs.length) + 1);
      if (sized > 0) log(`    размеры: ${sized} версий`);
      totalSized += sized;
    }

    // Patches (only if explicitly requested)
    if (syncPatchesData) {
      // Only fetch patches for the latest 3 versions to keep it manageable
      const recentVersions = versions.slice(-3);
      const p = await syncPatchesForConfig(session, match.configId, nick, recentVersions);
      totalPatches += p;
    }

    matched++;
  }

  if (!onLog) process.stdout.write("\n");
  log(`Готово: совпало=${matched}, пропущено=${skipped}, метаданных=${metaRows}, размеров=${totalSized}`);

  await db.insert(importRuns).values({
    source: "releases",
    fileSha256: "",
    fileBytes: 0,
    configsFound: matched,
    edgesUpserted: metaRows,
    edgesUnchanged: skipped,
    status: "ok",
    message: `matched=${matched} skipped=${skipped} meta=${metaRows} sizes=${totalSized}`,
    startedAt,
    finishedAt: new Date(),
  });
}

// CLI entry point
if (process.argv[1] === new URL(import.meta.url).pathname) {
  runReleasesImport(undefined, undefined, { syncSizes: true, syncPatchesData: true })
    .finally(() => pool.end());
}
