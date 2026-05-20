/**
 * parse-releases.ts — HTML → structured data for releases.1c.ru pages.
 */

export interface ReleasesConfig {
  href: string;        // "/project/Accounting30"
  displayName: string; // "Бухгалтерия предприятия, редакция 3.0"
  latestVersion: string;
  latestDate: string;
  groupName: string;              // "Типовые конфигурации фирмы «1С» для России"
  nextReleaseVersion?: string;    // "3.0.209"
  nextReleasePlannedDate?: string; // "Ноябрь 2026"
  nextReleasePlanUpdated?: string; // "2026-04-01"
}

export interface VersionRow {
  version: string;
  releaseDate: string | null; // "DD.MM.YY" or null
  minPlatform: string | null; // "8.3.27.1688" or null
}

export interface VersionFileInfo {
  title: string;          // "Дистрибутив обновления"
  href: string;           // "/version_file?nick=...&path=..."
  propertiesId?: string;  // "572665"
}

export interface PatchInfo {
  uuid: string;
  patchDate: string | null;  // ISO "YYYY-MM-DD"
  title?: string;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** "DD.MM.YY" or "DD.MM.YYYY" → "YYYY-MM-DD" (ISO), null if unparseable. */
export function parseDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\.(\d{2})\.(\d{2,4})$/);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  const year = yy.length === 2 ? (Number(yy) >= 90 ? `19${yy}` : `20${yy}`) : yy;
  return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** Parse /total — returns all configs with groups and planned dates. */
export function parseTotalPage(html: string): ReleasesConfig[] {
  const configs: ReleasesConfig[] = [];

  // Build group id → name map
  const groupMap = new Map<string, string>();
  for (const m of html.matchAll(/<tr[^>]*\bgroup="(\d+)"[^>]*>[\s\S]*?<span class="group-name">([^<]+)</g)) {
    groupMap.set(m[1], m[2].trim());
  }

  // Parse each config row
  for (const rowMatch of html.matchAll(/<tr[^>]*\bparent-group="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const groupId = rowMatch[1];
    const row = rowMatch[2];

    const hrefMatch = row.match(/href="(\/project\/[^"?]+)">([^<]+)</);
    if (!hrefMatch) continue;

    const href = hrefMatch[1];
    const displayName = hrefMatch[2].trim();
    const groupName = groupMap.get(groupId) ?? "";

    // Latest version (link to version_files)
    const latestVerMatch = row.match(/version_files\?nick=[^&]+&ver=([^"]+)/);
    const latestVersion = latestVerMatch?.[1] ?? "";

    // Latest release date (first releaseDate cell)
    const relDateMatch = row.match(/class="releaseDate[^"]*"[^>]*>\s*([0-9]{1,2}\.[0-9]{2}\.[0-9]{2,4})/);
    const latestDate = relDateMatch?.[1] ?? "";

    // Planned version: second versionColumn cell (first is latest)
    const versionCells = [...row.matchAll(/class="versionColumn[^"]*"[^>]*>\s*([0-9][0-9.]+)\s*</g)];
    const nextReleaseVersion = versionCells[1]?.[1];

    // Planned release date
    const planDateMatch = row.match(/class="planReleaseDate[^"]*"[^>]*>\s*([^<\s][^<]+?)\s*</);
    const nextReleasePlannedDate = planDateMatch?.[1]?.trim();

    // Plan updated date
    const planUpdMatch = row.match(/class="updateDate[^"]*"[^>]*>\s*([0-9]{1,2}\.[0-9]{2}\.[0-9]{2,4})/);
    const nextReleasePlanUpdated = planUpdMatch
      ? (parseDate(planUpdMatch[1]) ?? undefined)
      : undefined;

    configs.push({
      href,
      displayName,
      groupName,
      latestVersion,
      latestDate,
      nextReleaseVersion,
      nextReleasePlannedDate,
      nextReleasePlanUpdated,
    });
  }

  return configs;
}

/** Parse /project/XXX?allUpdates=true — returns per-version metadata. */
export function parseProjectPage(html: string): VersionRow[] {
  const rows: VersionRow[] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) =>
      stripTags(t[1]),
    );
    if (!tds[0] || !/^\d+\.\d+\.\d+/.test(tds[0])) continue;
    // tds[0]=version, tds[1]=date DD.MM.YY, tds[2]=compatible_from (ignored),
    // tds[3]=min_platform (may be absent for old entries)
    const [version, rawDate, , minPlatform] = tds;
    const releaseDate = parseDate(rawDate ?? "") ?? null;
    rows.push({
      version,
      releaseDate,
      minPlatform: minPlatform?.match(/^\d+\.\d+/) ? minPlatform : null,
    });
  }
  return rows;
}

/** Parse /version_files?nick=X&ver=Y — returns file list with property IDs. */
export function parseVersionFiles(html: string): VersionFileInfo[] {
  const files: VersionFileInfo[] = [];
  // Pattern: href="/version_file?..." then anchor text, then later properties id
  const linkRe = /href="(\/version_file\?[^"]+)"[^>]*>\s*([^<]+)<[\s\S]*?\/files\/properties\/version-files\/(\d+)/g;
  for (const m of html.matchAll(linkRe)) {
    files.push({ href: m[1], title: m[2].trim(), propertiesId: m[3] });
  }
  return files;
}

/** Parse /files/properties/version-files/{id} JSON response → size in bytes. */
export function parseFileProperties(json: string): number | null {
  try {
    const data = JSON.parse(json) as { size?: string };
    const m = data.size?.match(/\(([0-9 ]+)\s*байт/);
    return m ? parseInt(m[1].replace(/\s/g, ""), 10) : null;
  } catch {
    return null;
  }
}

/** Parse /patches/total?nick=X&ver=Y — returns patch list. */
export function parsePatchesPage(html: string): PatchInfo[] {
  const patches: PatchInfo[] = [];
  // Each row: onclick with uuid + dateColumn cell
  const rowRe = /onclick="[^"]*\/patches\/([a-f0-9-]{36})"[\s\S]*?<td class="dateColumn">([^<]+)<\/td>/g;
  for (const m of html.matchAll(rowRe)) {
    patches.push({
      uuid: m[1],
      patchDate: parseDate(m[2].trim()),
    });
  }
  return patches;
}
