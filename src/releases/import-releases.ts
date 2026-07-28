/**
 * Multi-account releases.1c.ru importer.
 *
 * /total is parsed completely for every account: linked rows are available to
 * that account, grey rows are still valuable catalog records. Linked projects
 * are enriched with full version history and matched to the union LST graph.
 */

import { and, eq, notInArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TaskLimiter, batches } from "../utils/index.js";
import { isMetadataCacheFresh } from "./cache-policy.js";
import { db, pool, rows as extractRows } from "../db/client.js";
import {
  accountProjectAccess,
  configurations,
  importRuns,
  patches,
  releaseChangeEvents,
  releaseProjects,
  releaseVersionResources,
  releaseVersionTransitions,
  releaseProjectVersions,
  versionMeta,
} from "../db/schema.js";
import {
  patchChangeDraft,
  platformChangeDraft,
  resourceChangeDrafts,
  versionChangeDrafts,
  type ChangeDraft,
} from "./change-feed.js";
import {
  enabledAccountCredentials,
  ensureLegacyAccount,
  markAccountError,
  markAccountSuccess,
} from "../accounts/service.js";
import { ReleasesSession, type ReleasesSessionStats } from "./fetch-releases.js";
import {
  compareReleaseVersions,
  parseDate,
  parsePatchesPage,
  parseProjectPage,
  parseTotalPage,
  parseVersionFilePage,
  parseVersionFilesPage,
  TOTAL_CATALOG_PATH,
  type ReleasesConfig,
  type VersionRow,
} from "./parse-releases.js";

const MIN_RELEASES_VERSIONS = 2;

function feedEventDate(value: string | null, fallback = new Date()): Date {
  if (!value) return fallback;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function errorMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (message) messages.push(String(message));
    current = (current as { cause?: unknown }).cause;
  }
  if (!messages.length) messages.push(String(error));
  const selected = [...messages].reverse().find((message) => !message.startsWith("Failed query:"))
    ?? messages.at(-1)
    ?? "Неизвестная ошибка";
  return selected.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function newestReleaseRow(rows: VersionRow[]): VersionRow | null {
  return rows.reduce<VersionRow | null>((best, row) => {
    if (!best) return row;
    const dateOrder = (row.releaseDate ?? "").localeCompare(best.releaseDate ?? "");
    const cmp = dateOrder || compareReleaseVersions(row.version, best.version);
    return cmp >= 0 ? row : best;
  }, null);
}

function includeCatalogPreview(rows: VersionRow[], cfg: ReleasesConfig): VersionRow[] {
  if (!cfg.previewVersion) return rows;
  const existing = rows.find((row) => row.version === cfg.previewVersion);
  if (existing) {
    existing.isTest = true;
    existing.releaseDate ??= cfg.previewDate ?? null;
    return rows;
  }
  return [...rows, {
    version: cfg.previewVersion,
    releaseDate: cfg.previewDate ?? null,
    minPlatform: null,
    previousVersions: [],
    isTest: true,
  }];
}

function projectCatalogSignature(cfg: ReleasesConfig): string {
  return createHash("sha256").update(JSON.stringify([
    cfg.latestVersion ?? null,
    cfg.latestDate ?? null,
    cfg.previewVersion ?? null,
    cfg.previewDate ?? null,
    cfg.nextReleaseVersion ?? null,
    cfg.nextReleasePlannedDate ?? null,
    cfg.nextReleasePlanUpdated ?? null,
  ])).digest("hex");
}

function projectPageHash(rows: VersionRow[]): string {
  const normalized = [...rows]
    .sort((left, right) => left.version.localeCompare(right.version, "ru", { numeric: true }))
    .map((row) => ({
      version: row.version,
      releaseDate: row.releaseDate ?? null,
      minPlatform: row.minPlatform ?? null,
      isTest: row.isTest,
      previousVersions: [...new Set(row.previousVersions)].sort((a, b) =>
        a.localeCompare(b, "ru", { numeric: true })),
    }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function groupToRegion(groupName: string | null | undefined): string | null {
  if (!groupName) return null;
  if (/Стандартные библиотеки/i.test(groupName)) return "stdlib";
  if (/Международные/i.test(groupName)) return "intl";
  if (/для России|для Российской/i.test(groupName)) return "ru";
  if (/для Азербайджана/i.test(groupName)) return "az";
  if (/для Армении/i.test(groupName)) return "am";
  if (/для стран Балтии/i.test(groupName)) return "baltics";
  if (/для Беларуси/i.test(groupName)) return "by";
  if (/для Болгарии/i.test(groupName)) return "bg";
  if (/для Грузии/i.test(groupName)) return "ge";
  if (/для Казахстана/i.test(groupName)) return "kz";
  if (/для Кыргызстана/i.test(groupName)) return "kg";
  if (/для Латвии/i.test(groupName)) return "lv";
  if (/для Литвы/i.test(groupName)) return "lt";
  if (/для Молдовы/i.test(groupName)) return "md";
  if (/для Таджикистана/i.test(groupName)) return "tj";
  if (/для Узбекистана/i.test(groupName)) return "uz";
  if (/для Эстонии/i.test(groupName)) return "ee";
  return "ru";
}

const REGION_STEMS: Record<string, string[]> = {
  az: ["азербайджан", "azerbaij"], am: ["армени", "armeni"],
  baltics: ["балти", "baltic"], by: ["беларус", "белорус", "belarus"],
  bg: ["болгари", "bulgari"], ge: ["грузи", "georgi"],
  kz: ["казахстан", "kazakhst"], kg: ["кыргыз", "kyrgyz"],
  lv: ["латви", "latvia"], lt: ["литв", "lithu"],
  md: ["молдов", "moldova"], tj: ["таджик", "tajik"],
  uz: ["узбек", "uzbek"], ee: ["эстони", "estoni"],
  stdlib: ["библиотек", "library"], intl: ["международн", "internation"],
};

function configMatchesRegion(
  configName: string,
  configDisplayName: string | null | undefined,
  region: string,
): boolean {
  if (region === "ru") return true;
  const stems = REGION_STEMS[region];
  if (!stems) return true;
  const haystack = `${configName} ${configDisplayName ?? ""}`.toLowerCase();
  return stems.some((stem) => haystack.includes(stem));
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9]/gi, "");
}

function longestCommonSubstring(a: string, b: string): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let len = 0;
      while (a[i + len] && a[i + len] === b[j + len]) len++;
      if (len > max) max = len;
    }
  }
  return max;
}

function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb || na.includes(nb) || nb.includes(na)) return 1;
  return (2 * longestCommonSubstring(na, nb)) / (na.length + nb.length);
}

interface MatchResult {
  configId: number;
  configName: string;
  configDisplayName: string | null;
  confidence: number;
}

interface ConfigNameCandidate {
  id: number;
  name: string;
  displayName: string | null;
  region: string | null;
}

interface ProjectMappingSource {
  href: string | null;
  displayName: string;
  groupName: string;
  region: string | null;
  nextReleaseVersion: string | null;
  nextReleasePlannedDate: string | null;
  nextReleasePlanUpdated: string | Date | null;
}

function normalizeExactName(value: string): string {
  return normalizeName(
    value
      .normalize("NFKC")
      .replace(/^\s*1[сc]\s*[:—–-]?\s*/iu, ""),
  );
}

async function loadConfigNameCandidates(): Promise<ConfigNameCandidate[]> {
  return db
    .select({
      id: configurations.id,
      name: configurations.name,
      displayName: configurations.displayName,
      region: configurations.region,
    })
    .from(configurations)
    .where(eq(configurations.excludeFromUpdates, false));
}

function findUniqueExactNameMatch(
  displayName: string,
  region: string | null,
  candidates: ConfigNameCandidate[],
  reservedConfigIds: Set<number>,
): { match: MatchResult | null; ambiguous: boolean } {
  const target = normalizeExactName(displayName);
  if (target.length < 3) return { match: null, ambiguous: false };

  const matches = candidates.filter((candidate) => {
    if (reservedConfigIds.has(candidate.id)) return false;
    const names = new Set([
      normalizeExactName(candidate.name),
      normalizeExactName(candidate.displayName ?? ""),
    ]);
    if (!names.has(target)) return false;
    if (region && !["ru", "stdlib", "intl"].includes(region)) {
      return configMatchesRegion(candidate.name, candidate.displayName, region);
    }
    return true;
  });

  if (matches.length !== 1) {
    return { match: null, ambiguous: matches.length > 1 };
  }
  const candidate = matches[0];
  return {
    ambiguous: false,
    match: {
      configId: candidate.id,
      configName: candidate.name,
      configDisplayName: candidate.displayName,
      confidence: 98,
    },
  };
}

async function findMatchingConfig(
  releasesVersions: string[],
  displayName: string,
  region: string | null,
): Promise<MatchResult | null> {
  const uniqueVersions = [...new Set(releasesVersions)];
  if (uniqueVersions.length < MIN_RELEASES_VERSIONS) return null;

  const literals = sql.join(uniqueVersions.map((version) => sql`${version}`), sql`, `);
  const result = await db.execute(sql`
    SELECT
      c.id, c.name, c.display_name,
      count(DISTINCT ue.to_version)::int AS matches,
      totals.total::int AS total
    FROM update_edges ue
    JOIN configurations c ON c.id = ue.config_id
    JOIN LATERAL (
      SELECT count(DISTINCT to_version)::int AS total
      FROM update_edges WHERE config_id = c.id
    ) totals ON true
    WHERE ue.to_version IN (${literals})
    GROUP BY c.id, totals.total
    ORDER BY matches DESC
    LIMIT 20
  `);

  const candidates = extractRows(result) as Array<{
    id: number; name: string; display_name: string | null; matches: number; total: number;
  }>;
  const minForward = uniqueVersions.length >= 10 ? 0.75 : uniqueVersions.length >= 4 ? 0.8 : 1;

  const scored = candidates
    .map((candidate) => {
      const matches = Number(candidate.matches);
      const total = Number(candidate.total);
      const forward = matches / uniqueVersions.length;
      const reverse = total > 0 ? matches / total : 0;
      const name = nameSimilarity(displayName, candidate.display_name ?? candidate.name);
      return {
        candidate,
        forward,
        reverse,
        confidence: Math.round((forward * 0.7 + Math.min(reverse, 1) * 0.15 + name * 0.15) * 100),
      };
    })
    .filter(({ candidate, forward }) => {
      if (forward < minForward) return false;
      if (region && !["ru", "stdlib", "intl"].includes(region)) {
        return configMatchesRegion(candidate.name, candidate.display_name, region);
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence);

  if (!scored.length || scored[0].confidence < 70) return null;
  if (scored[1] && scored[0].confidence - scored[1].confidence < 4) return null;
  const best = scored[0];
  return {
    configId: Number(best.candidate.id),
    configName: best.candidate.name,
    configDisplayName: best.candidate.display_name,
    confidence: best.confidence,
  };
}

interface ProjectRow {
  id: number;
  configId: number | null;
  mappingMode: string;
  catalogState: string;
  excludeFromUpdates: boolean;
  updatePriority: number;
  projectCatalogSignature: string | null;
  projectPageHash: string | null;
  projectPageCheckedAt: Date | null;
}

function chunks<T>(values: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function upsertProject(
  cfg: ReleasesConfig,
  accountId: number | null,
): Promise<ProjectRow> {
  const region = groupToRegion(cfg.groupName);
  const hrefFilter = cfg.href ? sql` OR href = ${cfg.href}` : sql``;
  const existingRows = await db.execute(sql`
    SELECT id, config_id AS "configId", mapping_mode AS "mappingMode",
           catalog_state AS "catalogState",
           exclude_from_updates AS "excludeFromUpdates",
           update_priority AS "updatePriority",
           project_catalog_signature AS "projectCatalogSignature",
           project_page_hash AS "projectPageHash",
           project_page_checked_at AS "projectPageCheckedAt"
    FROM release_projects
    WHERE identity_key = ${cfg.identityKey}${hrefFilter}
    ORDER BY CASE WHEN href = ${cfg.href} THEN 0 ELSE 1 END
    LIMIT 1
  `);
  const existing = (extractRows(existingRows)[0] ?? null) as unknown as ProjectRow | null;
  const values = {
    href: cfg.href,
    displayName: cfg.displayName,
    groupName: cfg.groupName,
    region,
    latestVersion: cfg.latestVersion || null,
    latestDate: cfg.latestDate ? parseDate(cfg.latestDate) : null,
    nextReleaseVersion: cfg.nextReleaseVersion ?? null,
    nextReleasePlannedDate: cfg.nextReleasePlannedDate ?? null,
    nextReleasePlanUpdated: cfg.nextReleasePlanUpdated ?? null,
    previewVersion: cfg.previewVersion ?? null,
    previewDate: cfg.previewDate ?? null,
    lastSeenAt: new Date(),
  };

  let project: ProjectRow;
  if (existing?.excludeFromUpdates) {
    project = existing;
  } else if (existing) {
    const [updated] = await db
      .update(releaseProjects)
      .set({
        ...values,
        href: cfg.href ?? sql`${releaseProjects.href}`,
      })
      .where(eq(releaseProjects.id, existing.id))
      .returning({
        id: releaseProjects.id,
        configId: releaseProjects.configId,
        mappingMode: releaseProjects.mappingMode,
        catalogState: releaseProjects.catalogState,
        excludeFromUpdates: releaseProjects.excludeFromUpdates,
        updatePriority: releaseProjects.updatePriority,
        projectCatalogSignature: releaseProjects.projectCatalogSignature,
        projectPageHash: releaseProjects.projectPageHash,
        projectPageCheckedAt: releaseProjects.projectPageCheckedAt,
      });
    project = updated;
  } else {
    const [created] = await db
      .insert(releaseProjects)
      .values({ identityKey: cfg.identityKey, ...values })
      .returning({
        id: releaseProjects.id,
        configId: releaseProjects.configId,
        mappingMode: releaseProjects.mappingMode,
        catalogState: releaseProjects.catalogState,
        excludeFromUpdates: releaseProjects.excludeFromUpdates,
        updatePriority: releaseProjects.updatePriority,
        projectCatalogSignature: releaseProjects.projectCatalogSignature,
        projectPageHash: releaseProjects.projectPageHash,
        projectPageCheckedAt: releaseProjects.projectPageCheckedAt,
      });
    project = created;
  }

  if (accountId !== null) {
    await db
      .insert(accountProjectAccess)
      .values({
        accountId,
        projectId: project.id,
        status: cfg.accessible ? "available" : "unavailable",
        href: cfg.href,
        lastError: "",
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accountProjectAccess.accountId, accountProjectAccess.projectId],
        set: {
          status: cfg.accessible ? "available" : "unavailable",
          href: cfg.href,
          lastError: "",
          lastSeenAt: new Date(),
        },
      });
  }
  return project;
}

/**
 * Store a complete /total page with a bounded number of PostgreSQL round trips.
 * The previous implementation selected, updated and wrote account access for
 * every row separately (roughly three thousand queries for one account).
 */
async function syncCatalogProjects(
  accountId: number,
  projects: ReleasesConfig[],
): Promise<Array<{ cfg: ReleasesConfig; project: ProjectRow }>> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const existing = await tx.select({
      id: releaseProjects.id,
      identityKey: releaseProjects.identityKey,
      href: releaseProjects.href,
      configId: releaseProjects.configId,
      mappingMode: releaseProjects.mappingMode,
      catalogState: releaseProjects.catalogState,
      excludeFromUpdates: releaseProjects.excludeFromUpdates,
      updatePriority: releaseProjects.updatePriority,
      projectCatalogSignature: releaseProjects.projectCatalogSignature,
      projectPageHash: releaseProjects.projectPageHash,
      projectPageCheckedAt: releaseProjects.projectPageCheckedAt,
    }).from(releaseProjects);
    const byIdentity = new Map(existing.map((row) => [row.identityKey, row]));
    const byHref = new Map(existing.filter((row) => row.href).map((row) => [row.href!, row]));

    const updates = new Map<number, {
      id: number;
      href: string | null;
      displayName: string;
      groupName: string;
      region: string | null;
      latestVersion: string | null;
      latestDate: string | null;
      nextReleaseVersion: string | null;
      nextReleasePlannedDate: string | null;
      nextReleasePlanUpdated: string | null;
      previewVersion: string | null;
      previewDate: string | null;
    }>();
    const inserts = new Map<string, typeof releaseProjects.$inferInsert>();
    for (const cfg of projects) {
      const stored = byIdentity.get(cfg.identityKey) ?? (cfg.href ? byHref.get(cfg.href) : undefined);
      const values = {
        href: cfg.href,
        displayName: cfg.displayName,
        groupName: cfg.groupName,
        region: groupToRegion(cfg.groupName),
        latestVersion: cfg.latestVersion || null,
        latestDate: cfg.latestDate ? parseDate(cfg.latestDate) : null,
        nextReleaseVersion: cfg.nextReleaseVersion ?? null,
        nextReleasePlannedDate: cfg.nextReleasePlannedDate ?? null,
        nextReleasePlanUpdated: cfg.nextReleasePlanUpdated ?? null,
        previewVersion: cfg.previewVersion ?? null,
        previewDate: cfg.previewDate ?? null,
      };
      if (stored) {
        if (!stored.excludeFromUpdates) updates.set(stored.id, { id: stored.id, ...values });
      } else {
        inserts.set(cfg.identityKey, {
          identityKey: cfg.identityKey,
          ...values,
          lastSeenAt: now,
        });
      }
    }

    for (const batch of chunks([...updates.values()])) {
      await tx.execute(sql`
        UPDATE release_projects rp SET
          href = coalesce(incoming.href, rp.href),
          display_name = incoming."displayName",
          group_name = incoming."groupName",
          region = incoming.region,
          latest_version = incoming."latestVersion",
          latest_date = incoming."latestDate",
          next_release_version = incoming."nextReleaseVersion",
          next_release_planned_date = incoming."nextReleasePlannedDate",
          next_release_plan_updated = incoming."nextReleasePlanUpdated",
          preview_version = incoming."previewVersion",
          preview_date = incoming."previewDate",
          last_seen_at = ${now}
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS incoming(
          id bigint, href text, "displayName" text, "groupName" text, region text,
          "latestVersion" text, "latestDate" date, "nextReleaseVersion" text,
          "nextReleasePlannedDate" text, "nextReleasePlanUpdated" date,
          "previewVersion" text, "previewDate" date
        )
        WHERE rp.id = incoming.id
      `);
    }
    for (const batch of chunks([...inserts.values()])) {
      await tx.insert(releaseProjects).values(batch).onConflictDoUpdate({
        target: releaseProjects.identityKey,
        set: {
          href: sql`coalesce(excluded.href, ${releaseProjects.href})`,
          displayName: sql`excluded.display_name`,
          groupName: sql`excluded.group_name`,
          region: sql`excluded.region`,
          latestVersion: sql`excluded.latest_version`,
          latestDate: sql`excluded.latest_date`,
          nextReleaseVersion: sql`excluded.next_release_version`,
          nextReleasePlannedDate: sql`excluded.next_release_planned_date`,
          nextReleasePlanUpdated: sql`excluded.next_release_plan_updated`,
          previewVersion: sql`excluded.preview_version`,
          previewDate: sql`excluded.preview_date`,
          lastSeenAt: now,
        },
      });
    }

    const storedRows = await tx.select({
      id: releaseProjects.id,
      identityKey: releaseProjects.identityKey,
      href: releaseProjects.href,
      configId: releaseProjects.configId,
      mappingMode: releaseProjects.mappingMode,
      catalogState: releaseProjects.catalogState,
      excludeFromUpdates: releaseProjects.excludeFromUpdates,
      updatePriority: releaseProjects.updatePriority,
      projectCatalogSignature: releaseProjects.projectCatalogSignature,
      projectPageHash: releaseProjects.projectPageHash,
      projectPageCheckedAt: releaseProjects.projectPageCheckedAt,
    }).from(releaseProjects);
    const storedByIdentity = new Map(storedRows.map((row) => [row.identityKey, row]));
    const storedByHref = new Map(storedRows.filter((row) => row.href).map((row) => [row.href!, row]));
    const resolved = projects.flatMap((cfg) => {
      const project = storedByIdentity.get(cfg.identityKey) ?? (cfg.href ? storedByHref.get(cfg.href) : undefined);
      return project ? [{ cfg, project }] : [];
    });

    const accessByProject = new Map<number, typeof accountProjectAccess.$inferInsert>();
    for (const item of resolved) {
      accessByProject.set(item.project.id, {
        accountId,
        projectId: item.project.id,
        status: item.cfg.accessible ? "available" : "unavailable",
        href: item.cfg.href,
        lastError: "",
        lastSeenAt: now,
      });
    }
    for (const batch of chunks([...accessByProject.values()])) {
      await tx.insert(accountProjectAccess).values(batch).onConflictDoUpdate({
        target: [accountProjectAccess.accountId, accountProjectAccess.projectId],
        set: {
          status: sql`excluded.status`,
          href: sql`excluded.href`,
          lastError: "",
          lastSeenAt: now,
        },
      });
    }
    const seenProjectIds = [...accessByProject.keys()];
    if (seenProjectIds.length) {
      await tx.delete(accountProjectAccess).where(and(
        eq(accountProjectAccess.accountId, accountId),
        notInArray(accountProjectAccess.projectId, seenProjectIds),
      ));
    }
    return resolved;
  });
}

async function applyProjectMapping(
  projectId: number,
  source: ProjectMappingSource,
  match: MatchResult,
  log?: (message: string) => void,
): Promise<void> {
  await db
    .update(releaseProjects)
    .set({
      configId: match.configId,
      mappingMode: "auto",
      mappingConfidence: match.confidence,
    })
    .where(eq(releaseProjects.id, projectId));

  if (source.href) {
    await db.execute(sql`
      UPDATE configurations SET releases_href = NULL
      WHERE releases_href = ${source.href} AND id <> ${match.configId}
    `);
  }
  await db.execute(sql`
    UPDATE configurations SET
      display_name = ${source.displayName}, releases_href = ${source.href},
      group_name = ${source.groupName || null}, region = ${source.region},
      next_release_version = ${source.nextReleaseVersion},
      next_release_planned_date = ${source.nextReleasePlannedDate},
      next_release_plan_updated = ${source.nextReleasePlanUpdated}::date
    WHERE id = ${match.configId}
  `);
  log?.(`  ✓ ${source.displayName} → ${match.configName} (${match.confidence}%)`);
}

/**
 * Join rows discovered on /total to LST configurations only when the complete
 * normalized name has exactly one unused match. Ambiguous and administrator-
 * excluded rows deliberately stay unmatched.
 */
export async function reconcileReleaseProjectMappings(): Promise<{
  scanned: number;
  mapped: number;
  ambiguous: number;
}> {
  const candidates = await loadConfigNameCandidates();
  const occupiedRows = await db
    .select({ configId: releaseProjects.configId })
    .from(releaseProjects)
    .where(sql`${releaseProjects.configId} IS NOT NULL`);
  const reservedConfigIds = new Set(
    occupiedRows
      .map((row) => row.configId)
      .filter((id): id is number => id !== null),
  );
  const result = await db.execute(sql`
    SELECT id, href,
      display_name AS "displayName", group_name AS "groupName", region,
      next_release_version AS "nextReleaseVersion",
      next_release_planned_date AS "nextReleasePlannedDate",
      next_release_plan_updated AS "nextReleasePlanUpdated"
    FROM release_projects
    WHERE config_id IS NULL
      AND mapping_mode <> 'manual'
      AND exclude_from_updates = false
    ORDER BY id
  `);
  const projects = extractRows(result) as unknown as Array<ProjectMappingSource & { id: number }>;
  let mapped = 0;
  let ambiguous = 0;

  for (const project of projects) {
    const exact = findUniqueExactNameMatch(
      project.displayName,
      project.region,
      candidates,
      reservedConfigIds,
    );
    if (exact.ambiguous) ambiguous++;
    if (!exact.match) continue;
    await applyProjectMapping(project.id, project, exact.match);
    reservedConfigIds.add(exact.match.configId);
    mapped++;
  }
  return { scanned: projects.length, mapped, ambiguous };
}

/** Refresh only the per-account availability table from /total. */
export async function syncAccountProjectAccess(
  accountId: number,
  projects: ReleasesConfig[],
): Promise<{ available: number; unavailable: number; mapped: number }> {
  await syncCatalogProjects(accountId, projects);
  const available = projects.filter((project) => project.accessible).length;
  const unavailable = projects.length - available;
  const reconciliation = await reconcileReleaseProjectMappings();
  return { available, unavailable, mapped: reconciliation.mapped };
}

async function linkProjectToConfig(
  projectId: number,
  cfg: ReleasesConfig,
  versions: string[],
  current: ProjectRow,
  log: (message: string, detail?: "brief" | "normal" | "detailed") => void,
): Promise<number | null> {
  if (current.configId) return current.configId;
  const region = groupToRegion(cfg.groupName);
  const occupiedRows = await db
    .select({ configId: releaseProjects.configId })
    .from(releaseProjects)
    .where(sql`${releaseProjects.configId} IS NOT NULL AND ${releaseProjects.id} <> ${projectId}`);
  const reservedConfigIds = new Set(
    occupiedRows.map((row) => row.configId).filter((id): id is number => id !== null),
  );
  const exact = findUniqueExactNameMatch(
    cfg.displayName,
    region,
    await loadConfigNameCandidates(),
    reservedConfigIds,
  );
  let match = exact.match ?? await findMatchingConfig(versions, cfg.displayName, region);
  if (match && reservedConfigIds.has(match.configId)) match = null;
  if (!match) return current.configId;
  await applyProjectMapping(projectId, {
    href: cfg.href,
    displayName: cfg.displayName,
    groupName: cfg.groupName,
    region,
    nextReleaseVersion: cfg.nextReleaseVersion ?? null,
    nextReleasePlannedDate: cfg.nextReleasePlannedDate ?? null,
    nextReleasePlanUpdated: cfg.nextReleasePlanUpdated ?? null,
  }, match, log);
  return match.configId;
}

async function upsertVersions(
  projectId: number,
  configId: number | null,
  accountId: number | null,
  rows: VersionRow[],
): Promise<{ stored: number; removed: number }> {
  const uniqueRows = [...new Map(rows.map((row) => [row.version, row])).values()];
  if (!uniqueRows.length) return { stored: 0, removed: 0 };

  return db.transaction(async (tx) => {
    const updatedAt = new Date();
    const versionIds = new Map<string, number>();
    const existingRows = await tx
      .select({
        version: releaseProjectVersions.version,
        minPlatform: releaseProjectVersions.minPlatform,
        isTest: releaseProjectVersions.isTest,
      })
      .from(releaseProjectVersions)
      .where(eq(releaseProjectVersions.projectId, projectId));
    const changeDrafts = versionChangeDrafts(
      projectId,
      existingRows,
      uniqueRows.map((row) => ({
        version: row.version,
        releaseDate: row.releaseDate,
        minPlatform: row.minPlatform,
        isTest: row.isTest,
      })),
    );

    for (const batch of batches(uniqueRows)) {
      const storedRows = await tx
        .insert(releaseProjectVersions)
        .values(batch.map((row) => ({
          projectId,
          version: row.version,
          releaseDate: row.releaseDate,
          minPlatform: row.minPlatform,
          isTest: row.isTest,
          sourceAccountId: accountId,
          updatedAt,
        })))
        .onConflictDoUpdate({
          target: [releaseProjectVersions.projectId, releaseProjectVersions.version],
          set: {
            releaseDate: sql`excluded.release_date`,
            minPlatform: sql`coalesce(excluded.min_platform, ${releaseProjectVersions.minPlatform})`,
            isTest: sql`excluded.is_test`,
            sourceAccountId: sql`excluded.source_account_id`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ id: releaseProjectVersions.id, version: releaseProjectVersions.version });
      for (const stored of storedRows) versionIds.set(stored.version, stored.id);
    }

    if (changeDrafts.length) {
      await tx.insert(releaseChangeEvents).values(changeDrafts.map((change) => ({
        dedupeKey: change.dedupeKey,
        eventType: change.eventType,
        projectId,
        projectVersionId: versionIds.get(change.version) ?? null,
        configId,
        version: change.version,
        isTest: change.isTest,
        details: change.details,
        occurredAt: feedEventDate(change.occurredAt, updatedAt),
        detectedAt: updatedAt,
      }))).onConflictDoNothing();
    }

    const versionLiterals = sql.join(uniqueRows.map((row) => sql`${row.version}`), sql`, `);
    const removedResult = await tx.execute(sql`
      DELETE FROM release_project_versions
      WHERE project_id = ${projectId}
        AND version NOT IN (${versionLiterals})
      RETURNING id
    `);
    const removed = (extractRows(removedResult) as unknown[]).length;

    // The project page is authoritative, so rebuilding its transition set is
    // both simpler and much faster than deleting transitions version by version.
    await tx.execute(sql`
      DELETE FROM release_version_transitions rvt
      USING release_project_versions rpv
      WHERE rvt.project_version_id = rpv.id
        AND rpv.project_id = ${projectId}
    `);
    const transitionValues = uniqueRows.flatMap((row) => {
      const projectVersionId = versionIds.get(row.version);
      if (!projectVersionId) return [];
      return [...new Set(row.previousVersions)]
        .filter((fromVersion) => fromVersion !== row.version)
        .map((fromVersion) => ({ projectVersionId, fromVersion, updatedAt }));
    });
    for (const batch of batches(transitionValues)) {
      await tx.insert(releaseVersionTransitions).values(batch).onConflictDoNothing();
    }

    if (configId) {
      const metadataValues = uniqueRows
        .filter((row) => !row.isTest && (row.releaseDate || row.minPlatform))
        .map((row) => ({
          configId,
          version: row.version,
          releaseDate: row.releaseDate,
          minPlatform: row.minPlatform,
          source: "releases",
          updatedAt,
        }));
      for (const batch of batches(metadataValues)) {
        await tx
          .insert(versionMeta)
          .values(batch)
          .onConflictDoUpdate({
            target: [versionMeta.configId, versionMeta.version],
            set: {
              releaseDate: sql`excluded.release_date`,
              minPlatform: sql`excluded.min_platform`,
              source: sql`excluded.source`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
    }

    return { stored: uniqueRows.length, removed };
  });
}

interface PageProgressState {
  current: number;
  total: number;
  source: string;
  onProgress?: (current: number, total: number, project: string, source: string) => void;
  onQueueStats?: (pending: number, retry: number, source: string) => void;
}

export interface SmartRefreshPolicy {
  latestIntervalHours: number;
  recentIntervalDays: number;
  archiveIntervalDays: number;
  recentReleaseAgeDays: number;
  retryBaseMinutes: number;
  archivePageLimit: number;
  metadataCacheDays: number;
}

export const DEFAULT_SMART_REFRESH_POLICY: SmartRefreshPolicy = {
  latestIntervalHours: 24,
  recentIntervalDays: 7,
  archiveIntervalDays: 90,
  recentReleaseAgeDays: 365,
  retryBaseMinutes: 15,
  archivePageLimit: 1000,
  metadataCacheDays: 30,
};

interface ScheduledVersionRow {
  id: number;
  projectId: number;
  version: string;
  nick: string;
  projectName: string;
  configId: number | null;
  minPlatform: string | null;
  recommendedPlatform: string | null;
  resourcesSyncedAt: Date | null;
  patchesSyncedAt: Date | null;
  isTest: boolean;
  resourcesSyncStatus: string;
  resourcesSyncAttempts: number;
  isLatest: boolean;
}

async function storeReleaseChanges(
  projectId: number,
  configId: number | null,
  projectVersionId: number,
  changes: ChangeDraft[],
): Promise<void> {
  if (!changes.length) return;
  await db.insert(releaseChangeEvents).values(changes.map((change) => ({
    dedupeKey: change.dedupeKey,
    eventType: change.eventType,
    projectId,
    projectVersionId,
    configId,
    version: change.version,
    isTest: change.isTest,
    details: change.details,
    occurredAt: feedEventDate(change.occurredAt),
  }))).onConflictDoNothing();
}

interface PatchSyncTarget {
  id: number;
  projectId: number;
  configId: number | null;
  version: string;
  isTest: boolean;
  patchesSyncedAt: Date | null;
}

async function syncPatchResource(
  session: ReleasesSession,
  target: PatchSyncTarget,
  href: string,
): Promise<number> {
  const parsed = parsePatchesPage(await session.get(href));
  const existing = parsed.length
    ? await db.select({ uuid: patches.uuid }).from(patches)
      .where(sql`${patches.uuid} IN (${sql.join(parsed.map((patch) => sql`${patch.uuid}`), sql`, `)})`)
    : [];
  const existingUuids = new Set(existing.map((patch) => patch.uuid));
  if (parsed.length) {
    await db.insert(patches).values(parsed.map((patch) => ({
      configId: target.configId,
      projectVersionId: target.id,
      version: target.version,
      uuid: patch.uuid,
      title: patch.title ?? null,
      patchDate: patch.patchDate,
    }))).onConflictDoUpdate({
      target: patches.uuid,
      set: {
        configId: sql`coalesce(excluded.config_id, ${patches.configId})`,
        projectVersionId: sql`coalesce(excluded.project_version_id, ${patches.projectVersionId})`,
        version: sql`excluded.version`,
        title: sql`coalesce(excluded.title, ${patches.title})`,
        patchDate: sql`coalesce(excluded.patch_date, ${patches.patchDate})`,
      },
    });
  }
  const changes = parsed
    .filter((patch) => !existingUuids.has(patch.uuid))
    .map((patch) => patchChangeDraft(
      target.version,
      target.isTest,
      patch,
      target.patchesSyncedAt !== null,
    ))
    .filter((change): change is ChangeDraft => change !== null);
  await storeReleaseChanges(target.projectId, target.configId, target.id, changes);
  await db.update(releaseProjectVersions)
    .set({ patchesSyncedAt: new Date() })
    .where(eq(releaseProjectVersions.id, target.id));
  return parsed.filter((patch) => !existingUuids.has(patch.uuid)).length;
}

async function syncVersionResources(
  session: ReleasesSession,
  projectIds: number[],
  limit: number,
  log: (message: string, detail?: "brief" | "normal" | "detailed") => void,
  accountLabel: string,
  signal?: AbortSignal,
  taskLimiter = new TaskLimiter(1),
  pageProgress?: PageProgressState,
  policy: SmartRefreshPolicy = DEFAULT_SMART_REFRESH_POLICY,
  options: {
    retryOnly?: boolean;
    backfillOnly?: boolean;
    forceLatest?: boolean;
    forceAll?: boolean;
    resumeAfter?: Date;
  } = {},
): Promise<{ pages: number; resources: number; failed: number }> {
  if (!projectIds.length) return { pages: 0, resources: 0, failed: 0 };
  const ids = sql.join([...new Set(projectIds)].map((id) => sql`${id}`), sql`, `);
  const limitClause = limit > 0 ? sql`LIMIT ${limit}` : sql``;
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT
        rpv.id,
        rpv.project_id,
        rpv.version,
        rpv.release_date,
        rpv.resources_synced_at,
        rpv.patches_synced_at,
        rpv.min_platform,
        rpv.recommended_platform,
        rpv.is_test,
        rpv.resources_next_attempt_at,
        rpv.resources_sync_status,
        rpv.resources_sync_attempts,
        rp.update_priority,
        rp.config_id,
        coalesce(rp.display_name_override, rp.display_name) AS project_name,
        regexp_replace(rp.href, '^/project/', '') AS nick,
        row_number() OVER (
          PARTITION BY rpv.project_id
          ORDER BY rpv.release_date DESC NULLS LAST, rpv.version DESC
        ) = 1 AS is_latest
      FROM release_project_versions rpv
      JOIN release_projects rp ON rp.id = rpv.project_id
      WHERE rpv.project_id IN (${ids})
        AND rp.exclude_from_updates = false
        AND rp.href IS NOT NULL
    )
    SELECT
      id,
      project_id AS "projectId",
      version,
      nick,
      project_name AS "projectName",
      config_id AS "configId",
      min_platform AS "minPlatform",
      recommended_platform AS "recommendedPlatform",
      resources_synced_at AS "resourcesSyncedAt",
      patches_synced_at AS "patchesSyncedAt",
      is_test AS "isTest",
      resources_sync_status AS "resourcesSyncStatus",
      resources_sync_attempts AS "resourcesSyncAttempts",
      is_latest AS "isLatest"
    FROM ranked
    WHERE (
      ${options.forceAll === true}
      OR (${options.backfillOnly === true} AND resources_synced_at IS NULL)
      OR (
        ${options.backfillOnly !== true}
        AND (
          (
            ${options.retryOnly === true}
            AND resources_sync_status = 'error'
            AND coalesce(resources_next_attempt_at, now()) <= now()
          )
          OR (
            ${options.retryOnly !== true}
            AND (
              resources_synced_at IS NULL
              OR (
                resources_sync_status = 'error'
                AND coalesce(resources_next_attempt_at, now()) <= now()
              )
              OR (is_latest AND (
                ${options.forceLatest === true}
                OR resources_synced_at < now() - (${policy.latestIntervalHours}::double precision * interval '1 hour')
              ))
              OR (
                NOT is_latest
                AND release_date >= current_date - (${policy.recentReleaseAgeDays}::int)
                AND resources_synced_at < now() - (${policy.recentIntervalDays}::double precision * interval '1 day')
              )
              OR (
                NOT is_latest
                AND (release_date IS NULL OR release_date < current_date - (${policy.recentReleaseAgeDays}::int))
                AND resources_synced_at < now() - (${policy.archiveIntervalDays}::double precision * interval '1 day')
              )
            )
          )
          OR (
            ${options.retryOnly !== true}
            AND EXISTS (
              SELECT 1 FROM release_version_resources stale
              WHERE stale.project_version_id = ranked.id
                AND (
                  (stale.kind = 'readme' AND stale.href NOT LIKE '/version_file?%')
                  OR stale.href IN ('/classifiers/total', '/external-components/total')
                )
            )
          )
        )
      )
    )
      AND (
        ${options.resumeAfter === undefined}
        OR resources_synced_at IS NULL
        OR resources_synced_at < ${options.resumeAfter ?? new Date(0)}
      )
    ORDER BY update_priority DESC,
             is_latest DESC,
             CASE resources_sync_status WHEN 'error' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
             resources_next_attempt_at ASC NULLS FIRST,
             release_date DESC NULLS LAST,
             version DESC
    ${limitClause}
  `);
  const records = extractRows(result) as unknown as ScheduledVersionRow[];
  let pages = 0;
  let resourcesStored = 0;
  let failed = 0;
  let metadataLoaded = 0;
  let metadataCacheHits = 0;
  if (records.length) {
    const retryCount = records.filter((row) => row.resourcesSyncStatus === "error").length;
    log(
      `[${accountLabel}] ${options.forceAll ? "Принудительная" : "Умная"} очередь страниц: ${records.length}, ` +
      `актуальных версий ${records.filter((row) => row.isLatest).length}, повторных попыток ${retryCount}`,
      "normal",
    );
    pageProgress?.onQueueStats?.(records.length, retryCount, pageProgress.source);
  }
  if (pageProgress) {
    pageProgress.total = records.length;
    pageProgress.onProgress?.(
      pageProgress.current,
      pageProgress.total,
      options.forceAll ? "Принудительная проверка всех релизов" : "Умная очередь релизов",
      pageProgress.source,
    );
  }
  let completedPages = 0;
  for (const recordBatch of batches(records, 250)) {
    const pageResults = await Promise.allSettled(recordBatch.map((row) => taskLimiter.run(async () => {
    try {
      if (signal?.aborted) {
        const error = new Error("Обновление прервано пользователем");
        error.name = "AbortError";
        throw error;
      }
      await db
        .update(releaseProjectVersions)
        .set({ resourcesLastAttemptAt: new Date() })
        .where(eq(releaseProjectVersions.id, row.id));
      const html = await session.get(
        `/version_files?nick=${encodeURIComponent(row.nick)}&ver=${encodeURIComponent(row.version)}`,
      );
      const page = parseVersionFilesPage(html);
      const existingResourceRows = await db.select({
            href: releaseVersionResources.href,
            fileName: releaseVersionResources.fileName,
            fileSizeBytes: releaseVersionResources.fileSizeBytes,
            publishedAt: releaseVersionResources.publishedAt,
            sha512: releaseVersionResources.sha512,
            metadataCheckedAt: releaseVersionResources.metadataCheckedAt,
          })
          .from(releaseVersionResources)
          .where(eq(releaseVersionResources.projectVersionId, row.id));
      const cachedRows = options.forceAll ? [] : existingResourceRows;
      const cachedByHref = new Map(cachedRows.map((resource) => [resource.href, resource]));
      const resourceCandidates: Array<(typeof page.resources)[number] & {
        metadataCheckedAt: Date | null;
      }> = [];
      let metadataRead = 0;
      let metadataCached = 0;
      let metadataFailed = 0;
      for (const resource of page.resources) {
        if (signal?.aborted) {
          const error = new Error("Обновление прервано пользователем");
          error.name = "AbortError";
          throw error;
        }
        let metadata = null;
        const cached = cachedByHref.get(resource.href);
        let metadataCheckedAt = cached?.metadataCheckedAt ?? null;
        if (
          resource.href.startsWith("/version_file?")
          && ["distribution", "transition"].includes(resource.category)
        ) {
          const cacheFresh = isMetadataCacheFresh(
            metadataCheckedAt,
            policy.metadataCacheDays,
            options.forceAll === true,
          );
          if (cacheFresh && cached) {
            metadata = cached;
            metadataCached++;
          } else {
            try {
              const landingHtml = await session.getLandingPage(resource.href);
              if (landingHtml) metadata = parseVersionFilePage(landingHtml);
              metadataCheckedAt = new Date();
              if (metadata) metadataRead++;
            } catch {
              // Metadata is optional; always keep the authenticated landing page.
              metadataFailed++;
            }
          }
        }
        const effectiveMetadata = metadata ?? cached;
        resourceCandidates.push({
          ...resource,
          fileName: effectiveMetadata?.fileName ?? resource.fileName,
          fileSizeBytes: effectiveMetadata?.fileSizeBytes ?? resource.fileSizeBytes,
          publishedAt: effectiveMetadata?.publishedAt ?? resource.publishedAt,
          sha512: effectiveMetadata?.sha512 ?? resource.sha512,
          metadataCheckedAt,
        });
      }
      // Some legacy 1C pages repeat the same href in several visual blocks.
      // PostgreSQL cannot update one conflict target twice in a single INSERT.
      const resources = [...new Map(
        resourceCandidates.map((resource) => [resource.href, resource]),
      ).values()].map((resource, index) => ({ ...resource, sortOrder: index }));
      const resourceChanges = resourceChangeDrafts(
        row.projectId,
        row.version,
        row.isTest,
        existingResourceRows.map((resource) => resource.href),
        resources,
        row.resourcesSyncedAt !== null,
      );
      const primaryFile = resources.find((file) => file.kind === "update_distribution")
        ?? resources.find((file) => file.kind === "full_distribution")
        ?? resources.find((file) => file.kind === "new_base_distribution")
        ?? resources.find((file) => file.category === "distribution");

      if (resources.length) {
        const currentHrefs = sql.join(resources.map((resource) => sql`${resource.href}`), sql`, `);
        await db.execute(sql`
          DELETE FROM release_version_resources
          WHERE project_version_id = ${row.id} AND href NOT IN (${currentHrefs})
        `);
      } else {
        await db.delete(releaseVersionResources)
          .where(eq(releaseVersionResources.projectVersionId, row.id));
      }
      if (resources.length) {
        await db
          .insert(releaseVersionResources)
          .values(resources.map((resource) => ({
            projectVersionId: row.id,
            kind: resource.kind,
            category: resource.category,
            title: resource.title,
            href: resource.href,
            propertiesId: resource.propertiesId ?? null,
            fileName: resource.fileName ?? null,
            fileExtension: resource.fileExtension ?? null,
            fileSizeBytes: resource.fileSizeBytes ?? null,
            publishedAt: resource.publishedAt ?? null,
            sha512: resource.sha512 ?? null,
            metadataCheckedAt: resource.metadataCheckedAt,
            isFile: resource.isFile,
            sortOrder: resource.sortOrder,
            updatedAt: new Date(),
          })))
          .onConflictDoUpdate({
            target: [releaseVersionResources.projectVersionId, releaseVersionResources.href],
            set: {
              kind: sql`excluded.kind`,
              category: sql`excluded.category`,
              title: sql`excluded.title`,
              propertiesId: sql`excluded.properties_id`,
              fileName: sql`excluded.file_name`,
              fileExtension: sql`excluded.file_extension`,
              fileSizeBytes: sql`excluded.file_size_bytes`,
              publishedAt: sql`excluded.published_at`,
              sha512: sql`excluded.sha512`,
              metadataCheckedAt: sql`excluded.metadata_checked_at`,
              isFile: sql`excluded.is_file`,
              sortOrder: sql`excluded.sort_order`,
              updatedAt: new Date(),
            },
          });
      }
      await storeReleaseChanges(row.projectId, row.configId, row.id, resourceChanges);
      const platformChange = platformChangeDraft(
        row.projectId,
        row.version,
        row.isTest,
        {
          minPlatform: row.minPlatform,
          recommendedPlatform: row.recommendedPlatform,
        },
        {
          minPlatform: page.minPlatform ?? row.minPlatform,
          recommendedPlatform: page.recommendedPlatform,
        },
        row.resourcesSyncedAt !== null,
      );
      if (platformChange) {
        await storeReleaseChanges(row.projectId, row.configId, row.id, [platformChange]);
      }
      const patchesResource = resources.find((resource) => resource.kind === "patches");
      if (patchesResource) {
        await syncPatchResource(session, row, patchesResource.href);
      } else if (!row.patchesSyncedAt) {
        await db.update(releaseProjectVersions)
          .set({ patchesSyncedAt: new Date() })
          .where(eq(releaseProjectVersions.id, row.id));
      }
      await db
        .update(releaseProjectVersions)
        .set({
          downloadHref: primaryFile?.href ?? null,
          fileSizeBytes: primaryFile?.fileSizeBytes ?? null,
          minPlatform: page.minPlatform ?? sql`${releaseProjectVersions.minPlatform}`,
          recommendedPlatform: page.recommendedPlatform,
          isTest: page.isTest,
          resourcesSyncedAt: new Date(),
          resourcesLastAttemptAt: new Date(),
          resourcesNextAttemptAt: null,
          resourcesSyncStatus: "ok",
          resourcesSyncAttempts: 0,
          resourcesLastError: "",
          updatedAt: new Date(),
        })
        .where(eq(releaseProjectVersions.id, row.id));
      pages++;
      resourcesStored += resources.length;
      metadataLoaded += metadataRead;
      metadataCacheHits += metadataCached;
      if (metadataFailed > 0) {
        log(
          `[${accountLabel}] ${row.nick} ${row.version}: метаданные недоступны для ${metadataFailed} файлов`,
          "detailed",
        );
      }
    } catch (error) {
      if (signal?.aborted || (error as Error).name === "AbortError") throw error;
      failed++;
      const attempts = Math.max(0, Number(row.resourcesSyncAttempts || 0)) + 1;
      const retryMinutes = Math.min(
        7 * 24 * 60,
        policy.retryBaseMinutes * (4 ** Math.min(attempts - 1, 5)),
      );
      const nextAttempt = new Date(Date.now() + retryMinutes * 60_000);
      const message = errorMessage(error);
      await db
        .update(releaseProjectVersions)
        .set({
          resourcesLastAttemptAt: new Date(),
          resourcesNextAttemptAt: nextAttempt,
          resourcesSyncStatus: "error",
          resourcesSyncAttempts: attempts,
          resourcesLastError: message.slice(0, 2000),
        })
        .where(eq(releaseProjectVersions.id, row.id));
      log(
        `[${accountLabel}] releases.1c.ru: ${row.nick} ${row.version} — ` +
        `ошибка страницы релиза: ${message}; повтор через ${retryMinutes} мин`,
      );
    } finally {
      completedPages++;
      if (pageProgress) {
        pageProgress.current++;
        pageProgress.onProgress?.(
          pageProgress.current,
          pageProgress.total,
          `${row.projectName}: ${row.version}`,
          pageProgress.source,
        );
      }
      if (completedPages % 25 === 0 || completedPages === records.length) {
        log(
          `[${accountLabel}] Умная очередь: ${completedPages}/${records.length}, ` +
          `ссылок ${resourcesStored}, метаданных загружено ${metadataLoaded}, ` +
          `из кэша ${metadataCacheHits}, ошибок ${failed}`,
          "normal",
        );
      }
    }
    })));
    const rejectedPage = pageResults.find((result: PromiseSettledResult<void>) => result.status === "rejected");
    if (rejectedPage?.status === "rejected") throw rejectedPage.reason;
  }
  return { pages, resources: resourcesStored, failed };
}

async function syncPatches(
  session: ReleasesSession,
  configId: number,
  nick: string,
  versions: string[],
): Promise<number> {
  const results = await Promise.allSettled(versions.map(async (version) => {
    const targetRows = await db.execute(sql`
      SELECT rpv.id, rpv.project_id AS "projectId", rp.config_id AS "configId",
             rpv.version, rpv.is_test AS "isTest", rpv.patches_synced_at AS "patchesSyncedAt"
      FROM release_project_versions rpv
      JOIN release_projects rp ON rp.id = rpv.project_id
      WHERE rp.config_id = ${configId} AND rpv.version = ${version}
        AND regexp_replace(rp.href, '^/project/', '') = ${nick}
      LIMIT 1
    `);
    const target = extractRows(targetRows)[0] as unknown as PatchSyncTarget | undefined;
    if (!target) return 0;
    return syncPatchResource(
      session,
      target,
      `/patches/total?nick=${encodeURIComponent(nick)}&ver=${encodeURIComponent(version)}`,
    );
  }));
  let count = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      count += result.value;
    }
  }
  return count;
}

export interface ReleasesImportOptions {
  /** Kept for compatibility; /total is always the authoritative first step. */
  syncTotalPage?: boolean;
  syncLinks?: boolean;
  syncPatchesData?: boolean;
  /** Positive override for the per-run release-page budget. */
  linksPerProject?: number;
  /** Maximum of simultaneous releases.1c.ru requests for the active account (1..8). */
  concurrency?: number;
  refreshPolicy?: SmartRefreshPolicy;
  /** Only process persisted failed version pages whose retry time has arrived. */
  retryOnly?: boolean;
  /** Process a bounded batch of historical pages that have never been enriched. */
  backfillOnly?: boolean;
  /** Targeted updates always recheck the latest release page. */
  forceLatest?: boolean;
  /** Ignore refresh intervals and recheck every release page in the active scope. */
  forceAllResources?: boolean;
  /** Only process the selected releases.1c.ru projects. */
  targetProjectIds?: number[];
  /** Restrict a targeted import to one enabled account. */
  targetAccountId?: number;
  /** Successful resource pages at or after this point form the resume checkpoint. */
  resumeAfter?: Date;
  onProgress?: (current: number, total: number, project: string, source: string) => void;
  onPageProgress?: (current: number, total: number, project: string, source: string) => void;
  onRuntimeStats?: (stats: ReleasesSessionStats & { source: string }) => void;
  onQueueStats?: (pending: number, retry: number, source: string) => void;
  onLog?: (message: string, detail?: "brief" | "normal" | "detailed") => void;
  signal?: AbortSignal;
  /** Internal per-run set preventing the same project being fetched by several accounts. */
  processedProjectIds?: Set<number>;
  /** Internal per-run set recording projects whose project page was processed successfully. */
  successfulProjectIds?: Set<number>;
}

export interface TargetedReleasesImportOptions extends ReleasesImportOptions {
  projectId: number;
  /** Omit to try enabled accounts in priority order, preferring known access. */
  accountId?: number;
}

export interface TargetedReleasesImportResult {
  projectId: number;
  projectName: string;
  accountId: number;
  accountLabel: string;
  versionsStored: number;
}

interface ImportAccount {
  id: number | null;
  label: string;
  login: string;
  password: string;
  requestConcurrency?: number;
}

async function runAccountImport(
  account: ImportAccount,
  opts: ReleasesImportOptions,
): Promise<void> {
  const {
    syncLinks = false,
    syncPatchesData = false,
    linksPerProject = 0,
    concurrency = 4,
    refreshPolicy = DEFAULT_SMART_REFRESH_POLICY,
    retryOnly = false,
    backfillOnly = false,
    forceLatest = false,
    forceAllResources = false,
    targetProjectIds,
    resumeAfter,
    onProgress,
    onPageProgress,
    onRuntimeStats,
    onQueueStats,
    onLog,
    signal,
    processedProjectIds,
    successfulProjectIds,
  } = opts;
  const globalConcurrency = Math.max(1, Math.min(8, Math.floor(concurrency)));
  const accountConcurrency = Math.max(
    1,
    Math.min(8, Math.floor(account.requestConcurrency ?? globalConcurrency)),
  );
  const requestConcurrency = Math.min(globalConcurrency, accountConcurrency);
  // Project pages are independent and share the session HTTP limiter. Honour
  // the configured limit instead of silently capping this stage at three.
  const projectConcurrency = requestConcurrency;
  const log = (
    message: string,
    detail: "brief" | "normal" | "detailed" = "normal",
  ) => onLog ? onLog(message, detail) : console.log(message);
  const startedAt = new Date();
  let projectsSeen = 0;
  let versionsStored = 0;
  let unavailable = 0;

  try {
    const pageLimiter = new TaskLimiter(requestConcurrency);
    const pageProgress: PageProgressState = {
      current: 0,
      total: 0,
      source: `account:${account.id ?? "legacy"}`,
      onProgress: onPageProgress,
      onQueueStats,
    };
    const session = new ReleasesSession({
      concurrency: requestConcurrency,
      onStats: (stats) => onRuntimeStats?.({ ...stats, source: String(account.id ?? account.label) }),
      onRetry: (message) => log(`[${account.label}] releases.1c.ru: ${message}`),
    });
    log(`[${account.label}] Авторизация на releases.1c.ru...`);
    await session.login(account.login, account.password);
    log(
      `[${account.label}] Лимит аккаунта: HTTP-запросов до ${requestConcurrency}, ` +
      `конфигураций одновременно до ${projectConcurrency}`,
    );

    if (retryOnly || backfillOnly) {
      const queuedProjectsResult = await db.execute(sql`
        SELECT DISTINCT rp.id
        FROM release_projects rp
        JOIN release_project_versions rpv ON rpv.project_id = rp.id
        JOIN account_project_access apa
          ON apa.project_id = rp.id AND apa.account_id = ${account.id}
        WHERE rp.exclude_from_updates = false
          AND rp.href IS NOT NULL
          AND apa.status = 'available'
          AND apa.account_id = (
            SELECT preferred.account_id
            FROM account_project_access preferred
            JOIN its_accounts preferred_account
              ON preferred_account.id = preferred.account_id
            WHERE preferred.project_id = rp.id
              AND preferred.status = 'available'
              AND preferred_account.enabled = true
            ORDER BY hashtextextended(concat(rp.id, ':', preferred.account_id), 0)
            LIMIT 1
          )
          AND (
            (${retryOnly} AND rpv.resources_sync_status = 'error'
              AND coalesce(rpv.resources_next_attempt_at, now()) <= now())
            OR (${backfillOnly} AND rpv.resources_synced_at IS NULL)
          )
        ORDER BY rp.id
      `);
      const queuedProjectIds = (extractRows(queuedProjectsResult) as Array<{ id: number }>)
        .map((row) => Number(row.id))
        .filter((projectId) => {
          if (processedProjectIds?.has(projectId)) return false;
          processedProjectIds?.add(projectId);
          return true;
        });
      if (!queuedProjectIds.length) {
        log(
          `[${account.label}] ${retryOnly ? "Очередь повторных попыток" : "Очередь архивных страниц"} пуста`,
          "brief",
        );
      } else {
        const resourceStats = await syncVersionResources(
          session,
          queuedProjectIds,
          refreshPolicy.archivePageLimit,
          log,
          account.label,
          signal,
          pageLimiter,
          pageProgress,
          refreshPolicy,
          { retryOnly, backfillOnly, resumeAfter },
        );
        versionsStored = resourceStats.pages;
      }
      await db.insert(importRuns).values({
        accountId: account.id,
        source: retryOnly ? "releases-retry" : "releases-archive",
        fileSha256: "",
        configsFound: queuedProjectIds.length,
        edgesUpserted: versionsStored,
        status: queuedProjectIds.length ? "ok" : "skipped",
        message: `projects=${queuedProjectIds.length} pages=${versionsStored}`,
        startedAt,
        finishedAt: new Date(),
      });
      return;
    }

    const totalHtml = await session.get(TOTAL_CATALOG_PATH);
    const projects = parseTotalPage(totalHtml);
    if (!projects.length) {
      throw new Error("Страница /total не содержит конфигураций — проверьте доступ аккаунта ИТС");
    }
    projectsSeen = projects.length;
    unavailable = projects.filter((project) => !project.accessible).length;
    log(`[${account.label}] /total: ${projects.length}, доступно: ${projects.length - unavailable}, без ссылки: ${unavailable}`);

    log(`[${account.label}] Этап 1/3: сохранение полного каталога /total`, "brief");
    const catalogResults = account.id === null
      ? await Promise.all(projects.map(async (cfg) => ({ cfg, project: await upsertProject(cfg, null) })))
      : await syncCatalogProjects(account.id, projects);
    const scheduledProjects = catalogResults
      .filter((item) => {
        if (item.project.excludeFromUpdates) {
          log(`[${account.label}] ${item.cfg.displayName}: пропущена — исключена из обновления администратором`);
          return false;
        }
        return Boolean(item.cfg.href);
      })
      .filter((item) => !targetProjectIds?.length || targetProjectIds.includes(item.project.id))
      .filter((item) => !processedProjectIds?.has(item.project.id))
      .sort((left, right) =>
        right.project.updatePriority - left.project.updatePriority
        || left.cfg.displayName.localeCompare(right.cfg.displayName, "ru"),
      );

    log(
      `[${account.label}] Этап 2/3: проверка страниц ${scheduledProjects.length} проектов ` +
      `(сначала выбранные как приоритетные)`,
      "brief",
    );
    let completedProjects = 0;
    const projectLimiter = new TaskLimiter(projectConcurrency);
    const resourceProjectIds: number[] = [];
    for (const projectBatch of batches(scheduledProjects, 250)) {
      const projectResults = await Promise.allSettled(projectBatch.map(({ cfg, project }) => projectLimiter.run(async () => {
      // Multiple ITS accounts run in parallel. Claim synchronously before the
      // first await so one project is assigned to exactly one account queue.
      if (processedProjectIds?.has(project.id)) {
        completedProjects++;
        onProgress?.(completedProjects, scheduledProjects.length, `${account.label}: ${cfg.displayName}`, pageProgress.source);
        return;
      }
      processedProjectIds?.add(project.id);
      let projectSucceeded = false;
      try {
        if (signal?.aborted) {
          const error = new Error("Обновление прервано пользователем");
          error.name = "AbortError";
          throw error;
        }
        onProgress?.(completedProjects, scheduledProjects.length, `${account.label}: ${cfg.displayName}`, pageProgress.source);

        const signature = projectCatalogSignature(cfg);
        const checkedAt = project.projectPageCheckedAt
          ? new Date(project.projectPageCheckedAt).getTime()
          : 0;
        const verificationIntervalMs = refreshPolicy.recentIntervalDays * 86_400_000;
        if (
          !forceLatest
          && !forceAllResources
          && project.projectPageHash
          && project.projectCatalogSignature === signature
          && checkedAt > Date.now() - verificationIntervalMs
        ) {
          log(
            `[${account.label}] releases.1c.ru: ${cfg.displayName} — ` +
            `последняя версия не изменилась, страница проекта пропущена`,
            "detailed",
          );
          resourceProjectIds.push(project.id);
          projectSucceeded = true;
          return;
        }

        const nick = cfg.href!.replace(/^\/project\//, "");
        const projectHtml = await session.get(`${cfg.href!}?allUpdates=true#updates`);
        const versionRows = includeCatalogPreview(parseProjectPage(projectHtml), cfg);
        if (!versionRows.length) throw new Error("Страница проекта не содержит распознанных версий");
        const contentHash = projectPageHash(versionRows);
        const transitionMode = versionRows.some((row) => row.previousVersions.length > 0)
          ? "explicit"
          : "unrestricted";
        const stableRows = versionRows.filter((row) => !row.isTest);
        const latestRow = newestReleaseRow(stableRows.length ? stableRows : versionRows);
        await db
          .update(releaseProjects)
          .set({
            transitionMode,
            latestVersion: latestRow?.version ?? cfg.latestVersion ?? null,
            latestDate: latestRow?.releaseDate ?? (cfg.latestDate ? parseDate(cfg.latestDate) : null),
            projectCatalogSignature: signature,
            projectPageHash: contentHash,
            projectPageCheckedAt: new Date(),
            catalogState: "ready",
            lastSeenAt: new Date(),
          })
          .where(eq(releaseProjects.id, project.id));
        if (project.projectPageHash === contentHash) {
          resourceProjectIds.push(project.id);
          projectSucceeded = true;
          log(
            `[${account.label}] releases.1c.ru: ${cfg.displayName} — содержимое страницы не изменилось`,
            "detailed",
          );
          return;
        }
        const configId = await linkProjectToConfig(
          project.id,
          cfg,
          versionRows.map((row) => row.version),
          project,
          log,
        );
        const versionResult = await upsertVersions(project.id, configId, account.id, versionRows);
        if (versionResult.removed > 0) {
          log(`[${account.label}] releases.1c.ru: ${cfg.displayName} — удалено устаревших версий: ${versionResult.removed}`);
        }
        versionsStored += versionResult.stored;
        log(
          `[${account.label}] releases.1c.ru: ${cfg.displayName} — ` +
          `${versionRows.length} версий${stableRows.length < versionRows.length ? `, для тестирования: ${versionRows.length - stableRows.length}` : ""}, ` +
          `переходы: ${transitionMode === "explicit" ? "указаны явно" : "с любой старой версии"}`,
        );
        resourceProjectIds.push(project.id);
        projectSucceeded = true;
        if (syncPatchesData && configId) {
          await syncPatches(session, configId, nick, versionRows.slice(-3).map((row) => row.version));
        }
      } catch (error) {
        if (signal?.aborted || (error as Error).name === "AbortError") throw error;
        if (account.id !== null && project) {
          await db
            .update(accountProjectAccess)
            .set({
              status: "error",
              lastError: errorMessage(error),
              lastSeenAt: new Date(),
            })
            .where(sql`${accountProjectAccess.accountId} = ${account.id} AND ${accountProjectAccess.projectId} = ${project.id}`);
        }
        log(`[${account.label}] Ошибка ${cfg.displayName}: ${errorMessage(error)}`);
        if (targetProjectIds?.length) processedProjectIds?.delete(project.id);
      } finally {
        if (projectSucceeded) successfulProjectIds?.add(project.id);
        completedProjects++;
        onProgress?.(completedProjects, scheduledProjects.length, `${account.label}: ${cfg.displayName}`, pageProgress.source);
      }
      })));
      const rejectedProject = projectResults.find((result) => result.status === "rejected");
      if (rejectedProject?.status === "rejected") throw rejectedProject.reason;
    }

    if (syncLinks && resourceProjectIds.length) {
      log(
        `[${account.label}] Этап 3/3: ${forceAllResources
          ? "принудительная проверка страниц всех релизов"
          : "актуальные версии, просроченные страницы и очередь ошибок"}`,
        "brief",
      );
      const resourceStats = await syncVersionResources(
        session,
        resourceProjectIds,
        forceAllResources ? 0 : (linksPerProject > 0 ? linksPerProject : refreshPolicy.archivePageLimit),
        log,
        account.label,
        signal,
        pageLimiter,
        pageProgress,
        refreshPolicy,
        { forceLatest, forceAll: forceAllResources, resumeAfter },
      );
      if (resourceStats.pages > 0 || resourceStats.failed > 0) {
        log(
          `[${account.label}] Страницы релизов: обработано ${resourceStats.pages}, ` +
          `ссылок ${resourceStats.resources}, ошибок ${resourceStats.failed}`,
        );
      }
    }

    const reconciliation = await reconcileReleaseProjectMappings();
    if (reconciliation.mapped > 0 || reconciliation.ambiguous > 0) {
      log(
        `[${account.label}] Сопоставление с LST: добавлено ${reconciliation.mapped}, ` +
        `неоднозначных названий ${reconciliation.ambiguous}`,
      );
    }

    await db.insert(importRuns).values({
      accountId: account.id,
      source: targetProjectIds?.length ? "releases-target" : "releases",
      fileSha256: "",
      configsFound: targetProjectIds?.length ? resourceProjectIds.length : projectsSeen,
      edgesUpserted: versionsStored,
      edgesUnchanged: unavailable,
      status: "ok",
      message: `projects=${projectsSeen} unavailable=${unavailable} versions=${versionsStored}`,
      startedAt,
      finishedAt: new Date(),
    });
    if (account.id !== null) await markAccountSuccess(account.id);
    log(
      `[${account.label}] releases.1c.ru завершён: проектов ${projectsSeen}, ` +
      `версий ${versionsStored}, недоступно ${unavailable}`,
    );
  } catch (error) {
    const aborted = signal?.aborted || (error as Error).name === "AbortError";
    await db.insert(importRuns).values({
      accountId: account.id,
      source: targetProjectIds?.length ? "releases-target" : "releases",
      fileSha256: "",
      configsFound: projectsSeen,
      edgesUpserted: versionsStored,
      edgesUnchanged: unavailable,
      status: aborted ? "cancelled" : "error",
      message: (aborted
        ? "Обновление прервано пользователем"
        : errorMessage(error)).slice(0, 2000),
      startedAt,
      finishedAt: new Date(),
    });
    if (!aborted && account.id !== null) await markAccountError(account.id, error);
    throw error;
  }
}

/** Compatibility entry point for one explicit/legacy account. */
export async function runReleasesImport(
  login = process.env.ITS_LOGIN,
  password = process.env.ITS_PASSWORD,
  opts: ReleasesImportOptions = {},
): Promise<void> {
  if (!login || !password) throw new Error("Логин и пароль ИТС не заданы");
  await runAccountImport({ id: null, label: "ИТС", login, password }, opts);
}

/** Import all enabled accounts, preserving progress when one account fails. */
export interface ReleasesImportResult {
  succeeded: number;
  failed: number;
  projectsSucceeded: number;
  projectIdsFailed: number[];
}

async function runAllReleasesImportsUnlocked(
  opts: ReleasesImportOptions = {},
): Promise<ReleasesImportResult> {
  await ensureLegacyAccount();
  let accounts = await enabledAccountCredentials();
  if (opts.targetAccountId !== undefined) {
    accounts = accounts.filter((account) => account.id === opts.targetAccountId);
  }
  if (!accounts.length) throw new Error("Нет включённых учётных записей ИТС");
  let succeeded = 0;
  let failed = 0;
  const processedProjectIds = new Set<number>();
  const successfulProjectIds = new Set<number>();
  const runAccount = async (account: ImportAccount) => {
    await runAccountImport(account, { ...opts, processedProjectIds, successfulProjectIds });
    return account;
  };
  const results: PromiseSettledResult<ImportAccount>[] = [];
  if (opts.targetProjectIds?.length) {
    // A grouped targeted update reuses one login and one /total response per
    // account. Accounts are tried in priority order so a project can fall
    // through to the next account when the preferred one cannot read it.
    for (const account of accounts) {
      try {
        results.push({ status: "fulfilled", value: await runAccount(account) });
      } catch (reason) {
        results.push({ status: "rejected", reason });
      }
      if (opts.targetProjectIds.every((id) => successfulProjectIds.has(id))) break;
    }
  } else {
    results.push(...await Promise.allSettled(accounts.map(runAccount)));
  }
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const account = accounts[index];
    if (result.status === "fulfilled") {
      succeeded++;
    } else {
      failed++;
      opts.onLog?.(`[${account.label}] очередь аккаунта завершилась с ошибкой: ${errorMessage(result.reason)}`);
    }
  }
  if (!succeeded) throw new Error("Импорт releases не выполнен ни для одной учётной записи");
  const projectIdsFailed = (opts.targetProjectIds ?? [])
    .filter((projectId) => !successfulProjectIds.has(projectId));
  if (opts.targetProjectIds?.length && successfulProjectIds.size === 0) {
    throw new Error("Ни одна из выбранных конфигураций не обновлена доступными ИТС-аккаунтами");
  }
  return {
    succeeded,
    failed,
    projectsSucceeded: successfulProjectIds.size,
    projectIdsFailed,
  };
}

async function recordTargetedRun(
  accountId: number,
  startedAt: Date,
  status: "ok" | "skipped" | "error",
  versionsStored: number,
  message: string,
): Promise<void> {
  await db.insert(importRuns).values({
    accountId,
    source: "releases-target",
    fileSha256: "",
    configsFound: 1,
    edgesUpserted: versionsStored,
    edgesUnchanged: status === "skipped" ? 1 : 0,
    status,
    message: message.slice(0, 2000),
    startedAt,
    finishedAt: new Date(),
  });
}

async function runTargetedReleasesImportUnlocked(
  opts: TargetedReleasesImportOptions,
): Promise<TargetedReleasesImportResult> {
  const {
    projectId,
    accountId,
    syncLinks = true,
    syncPatchesData = false,
    linksPerProject = 0,
    concurrency = 4,
    refreshPolicy = DEFAULT_SMART_REFRESH_POLICY,
    forceLatest = true,
    forceAllResources = false,
    resumeAfter,
    onProgress,
    onPageProgress,
    onRuntimeStats,
    onQueueStats,
    onLog,
    signal,
  } = opts;
  const requestConcurrency = Math.max(1, Math.min(8, Math.floor(concurrency)));
  const pageLimiter = new TaskLimiter(requestConcurrency);
  const pageProgress: PageProgressState = {
    current: 0,
    total: 0,
    source: "targeted",
    onProgress: onPageProgress,
    onQueueStats,
  };
  const log = (
    message: string,
    detail: "brief" | "normal" | "detailed" = "normal",
  ) => onLog ? onLog(message, detail) : console.log(message);

  const targetResult = await db.execute(sql`
    SELECT id, identity_key, href, display_name, exclude_from_updates
    FROM release_projects
    WHERE id = ${projectId}
    LIMIT 1
  `);
  const target = (extractRows(targetResult)[0] ?? null) as {
    id: number;
    identity_key: string;
    href: string | null;
    display_name: string;
    exclude_from_updates: boolean;
  } | null;
  if (!target) throw new Error("Выбранная конфигурация releases.1c.ru не найдена");
  if (target.exclude_from_updates) {
    throw new Error("Конфигурация исключена из обновления администратором");
  }

  await ensureLegacyAccount();
  let accounts = await enabledAccountCredentials();
  if (accountId !== undefined) {
    accounts = accounts.filter((account) => account.id === accountId);
    if (!accounts.length) {
      throw new Error("Выбранный ИТС-аккаунт не найден или выключен");
    }
  } else {
    const accessResult = await db.execute(sql`
      SELECT account_id, status
      FROM account_project_access
      WHERE project_id = ${projectId}
    `);
    const accessRows = extractRows(accessResult) as Array<{
      account_id: number;
      status: string;
    }>;
    const access = new Map(accessRows.map((row) => [Number(row.account_id), row.status]));
    accounts.sort((a, b) => {
      const aRank = access.get(a.id) === "available" ? 0 : 1;
      const bRank = access.get(b.id) === "available" ? 0 : 1;
      return aRank - bRank || a.priority - b.priority || a.id - b.id;
    });
  }
  if (!accounts.length) throw new Error("Нет включённых учётных записей ИТС");

  const errors: string[] = [];
  for (let index = 0; index < accounts.length; index++) {
    if (signal?.aborted) {
      const error = new Error("Обновление прервано пользователем");
      error.name = "AbortError";
      throw error;
    }
    const account = accounts[index];
    const startedAt = new Date();
    onProgress?.(index + 1, accounts.length, `${account.label}: ${target.display_name}`, pageProgress.source);

    let session: ReleasesSession;
    let cfg: ReleasesConfig | undefined;
    try {
      const effectiveConcurrency = Math.min(
        requestConcurrency,
        Math.max(1, Math.min(8, Math.floor(account.requestConcurrency ?? requestConcurrency))),
      );
      session = new ReleasesSession({
        concurrency: effectiveConcurrency,
        onStats: (stats) => onRuntimeStats?.({
          ...stats,
          source: `${account.id}:${projectId}:${startedAt.getTime()}`,
        }),
        onRetry: (message) => log(`[${account.label}] releases.1c.ru: ${message}`),
      });
      log(`[${account.label}] Авторизация на releases.1c.ru...`);
      await session.login(account.login, account.password);
      const projects = parseTotalPage(await session.get(TOTAL_CATALOG_PATH));
      if (!projects.length) {
        throw new Error("Страница /total не содержит конфигураций — проверьте доступ аккаунта ИТС");
      }
      cfg = projects.find((project) => project.identityKey === target.identity_key)
        ?? (target.href ? projects.find((project) => project.href === target.href) : undefined);
      if (!cfg) {
        throw new Error("Конфигурация отсутствует на странице /total этого аккаунта");
      }
      await markAccountSuccess(account.id);
    } catch (error) {
      if (signal?.aborted || (error as Error).name === "AbortError") throw error;
      const message = errorMessage(error);
      errors.push(`[${account.label}] ${message}`);
      log(`[${account.label}] ${target.display_name}: ${message}`);
      await recordTargetedRun(account.id, startedAt, "error", 0, message);
      await markAccountError(account.id, error);
      if (accountId !== undefined) throw error;
      continue;
    }

    const project = await upsertProject(cfg, account.id);
    if (!cfg.href) {
      const message = `Конфигурация ${target.display_name} недоступна аккаунту ${account.label}`;
      errors.push(message);
      log(`[${account.label}] ${message}`);
      await recordTargetedRun(account.id, startedAt, "skipped", 0, message);
      if (accountId !== undefined) throw new Error(message);
      continue;
    }

    try {
      const nick = cfg.href.replace(/^\/project\//, "");
      const projectHtml = await session.get(`${cfg.href}?allUpdates=true#updates`);
      const versionRows = includeCatalogPreview(parseProjectPage(projectHtml), cfg);
      if (!versionRows.length) {
        throw new Error("Страница проекта не содержит распознанных версий");
      }
      const signature = projectCatalogSignature(cfg);
      const contentHash = projectPageHash(versionRows);
      const transitionMode = versionRows.some((row) => row.previousVersions.length > 0)
        ? "explicit"
        : "unrestricted";
      const stableRows = versionRows.filter((row) => !row.isTest);
      const latestRow = newestReleaseRow(stableRows.length ? stableRows : versionRows);
      await db
        .update(releaseProjects)
        .set({
          transitionMode,
          latestVersion: latestRow?.version ?? cfg.latestVersion ?? null,
          latestDate: latestRow?.releaseDate ?? (cfg.latestDate ? parseDate(cfg.latestDate) : null),
          projectCatalogSignature: signature,
          projectPageHash: contentHash,
          projectPageCheckedAt: new Date(),
          catalogState: "ready",
          lastSeenAt: new Date(),
        })
        .where(eq(releaseProjects.id, project.id));
      const configId = project.projectPageHash === contentHash
        ? project.configId
        : await linkProjectToConfig(
          project.id,
          cfg,
          versionRows.map((row) => row.version),
          project,
          log,
        );
      const versionResult = project.projectPageHash === contentHash
        ? { stored: 0, removed: 0 }
        : await upsertVersions(
          project.id,
          configId,
          account.id,
          versionRows,
        );
      if (versionResult.removed > 0) {
        log(`[${account.label}] releases.1c.ru: ${cfg.displayName} — удалено устаревших версий: ${versionResult.removed}`);
      }
      const versionsStored = versionResult.stored;
      if (project.projectPageHash === contentHash) {
        log(`[${account.label}] releases.1c.ru: ${cfg.displayName} — содержимое страницы не изменилось`, "detailed");
      }
      log(
        `[${account.label}] releases.1c.ru: ${cfg.displayName} — ` +
        `${versionRows.length} версий${stableRows.length < versionRows.length ? `, для тестирования: ${versionRows.length - stableRows.length}` : ""}, ` +
        `переходы: ${transitionMode === "explicit" ? "указаны явно" : "с любой старой версии"}`,
      );

      if (syncLinks) {
        if (forceAllResources) {
          log(
            `[${account.label}] releases.1c.ru: ${cfg.displayName} — ` +
            "принудительная повторная проверка всех страниц релизов",
            "brief",
          );
        }
        const resourceStats = await syncVersionResources(
          session,
          [project.id],
          forceAllResources ? 0 : (linksPerProject > 0 ? linksPerProject : refreshPolicy.archivePageLimit),
          log,
          account.label,
          signal,
          pageLimiter,
          pageProgress,
          refreshPolicy,
          { forceLatest, forceAll: forceAllResources, resumeAfter },
        );
        log(
          `[${account.label}] releases.1c.ru: ${cfg.displayName} — страницы релизов: ` +
          `${resourceStats.pages}, ссылок: ${resourceStats.resources}, ошибок: ${resourceStats.failed}`,
        );
      }
      if (syncPatchesData && configId) {
        await syncPatches(session, configId, nick, versionRows.slice(-3).map((row) => row.version));
      }

      const message = `${cfg.displayName}: версий ${versionsStored}`;
      await recordTargetedRun(account.id, startedAt, "ok", versionsStored, message);
      await markAccountSuccess(account.id);
      log(`[${account.label}] Точечное обновление ${cfg.displayName} завершено`);
      return {
        projectId: project.id,
        projectName: cfg.displayName,
        accountId: account.id,
        accountLabel: account.label,
        versionsStored,
      };
    } catch (error) {
      if (signal?.aborted || (error as Error).name === "AbortError") throw error;
      const message = errorMessage(error);
      errors.push(`[${account.label}] ${message}`);
      await db
        .update(accountProjectAccess)
        .set({ status: "error", lastError: message.slice(0, 2000), lastSeenAt: new Date() })
        .where(sql`${accountProjectAccess.accountId} = ${account.id} AND ${accountProjectAccess.projectId} = ${project.id}`);
      await recordTargetedRun(account.id, startedAt, "error", 0, message);
      log(`[${account.label}] ${target.display_name}: ${message}`);
      if (accountId !== undefined) throw error;
    }
  }

  throw new Error(
    `Не удалось обновить ${target.display_name}: ${errors.join("; ") || "нет аккаунта с доступом"}`,
  );
}

/** Update one releases.1c.ru project without downloading the global LST. */
export async function runTargetedReleasesImport(
  opts: TargetedReleasesImportOptions,
): Promise<TargetedReleasesImportResult> {
  const client = await pool.connect();
  const lockKey = 801002;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [lockKey],
    );
    if (!result.rows[0]?.locked) {
      throw new Error("Импорт releases.1c.ru уже выполняется другим процессом");
    }
    return await runTargetedReleasesImportUnlocked(opts);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [lockKey]); } catch { /* connection lost */ }
    client.release();
  }
}

/** Serialize scheduled and manually triggered imports across processes. */
export async function runAllReleasesImports(
  opts: ReleasesImportOptions = {},
): Promise<ReleasesImportResult> {
  const client = await pool.connect();
  const lockKey = 801002;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [lockKey],
    );
    if (!result.rows[0]?.locked) {
      throw new Error("Импорт releases.1c.ru уже выполняется другим процессом");
    }
    return await runAllReleasesImportsUnlocked(opts);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [lockKey]); } catch { /* connection lost */ }
    client.release();
  }
}

/** Number of failed version pages whose persisted backoff has elapsed. */
export async function countDueReleaseRetries(): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS count
    FROM release_project_versions rpv
    JOIN release_projects rp ON rp.id = rpv.project_id
    WHERE rpv.resources_sync_status = 'error'
      AND coalesce(rpv.resources_next_attempt_at, now()) <= now()
      AND rp.exclude_from_updates = false
      AND rp.href IS NOT NULL
  `);
  return Number((extractRows(result)[0] as { count?: number } | undefined)?.count ?? 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAllReleasesImports({ syncLinks: true, syncPatchesData: false })
    .finally(() => pool.end());
}
