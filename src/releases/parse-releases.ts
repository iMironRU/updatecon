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
  ltsVersion?: string;            // "11.5.27.93" — current build of the long-term support branch
  ltsUntil?: string;              // "2027-04-30" — end of long-term support
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

// Planned versions are 3-segment ("3.0.207"): parser/version.ts only knows
// 4-segment cores, so compare numerically here.
function cmpLoose(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
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

  // Build group id → name map from the group header rows: <tr group="481">…
  // <span class="group-name">…</span>…</tr>. The attribute must be exactly
  // `group=` — config rows carry `parent-group=`, and matching those (a bare
  // \bgroup= does, "-" is a word boundary) shifted every group's name onto
  // the previous group ("для России" projects came out as "для Азербайджана").
  const groupMap = new Map<string, string>();
  for (const m of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const id = m[1].match(/(?:^|\s)group="(\d+)"/);
    if (!id) continue;
    const name = m[2].match(/<span class="group-name">([^<]+)</);
    if (name) groupMap.set(id[1], name[1].trim());
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

    // Current versions: the "actual" cell may list several — a long-term
    // support build marked <abbr title="Длительная поддержка до 30.04.27">ДП</abbr>
    // next to the main one (УТ: 11.5.27.93 ДП + 11.6.1.64). Latest = the highest.
    const actualCell = row.match(/class="versionColumn actualVersionColumn"[^>]*>([\s\S]*?)<\/td>/);
    const actual: string[] = [];
    let ltsVersion: string | undefined, ltsUntil: string | undefined;
    for (const m of (actualCell?.[1] ?? "").matchAll(
      /ver=([0-9.]+)"[^>]*>[^<]*<\/a>\s*(?:<sup>[\s\S]*?title="Длительная поддержка до ([0-9.]+)")?/g)) {
      actual.push(m[1]);
      if (m[2]) { ltsVersion = m[1]; ltsUntil = parseDate(m[2]) ?? undefined; }
    }
    const fallback = row.match(/version_files\?nick=[^&]+&ver=([^"]+)/)?.[1];
    const latestVersion = actual.length
      ? actual.reduce((a, b) => (cmpLoose(b, a) > 0 ? b : a))
      : fallback ?? "";

    // Latest release date (first releaseDate cell)
    const relDateMatch = row.match(/class="releaseDate[^"]*"[^>]*>\s*([0-9]{1,2}\.[0-9]{2}\.[0-9]{2,4})/);
    const latestDate = relDateMatch?.[1] ?? "";

    // Planned releases: one row may list several ("3.0.220 — Май 2027",
    // "3.0.207 — Сентябрь 2026"), each as a plan-release-link anchor, with the
    // dates and "plan updated" dates as parallel <span> lists in the next two
    // cells. The next release is the lowest planned version beyond the current
    // release line ("3.1.38." next to 3.1.38.92 is a long-term-support build
    // of the same line, "3.1.39" is the next release); else the lowest one.
    const cellText = (cls: string): string[] => {
      const cell = row.match(new RegExp(`<td class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</td>`));
      return cell ? [...cell[1].matchAll(/<span[^>]*>\s*([^<]*?)\s*<\/span>/g)].map((m) => m[1].trim()) : [];
    };
    const planVersions = [...row.matchAll(/plan-release-link-([0-9][0-9.]*)/g)].map((m) => m[1].replace(/\.+$/, ""));
    const planDates = cellText("planReleaseDate");
    const planUpdated = cellText("updateDate");
    const currentLine = latestVersion.split(".").slice(0, 3).join(".");
    const lowest = (pred: (v: string) => boolean) => {
      let best = -1;
      planVersions.forEach((v, i) => {
        if (pred(v) && (best < 0 || cmpLoose(v, planVersions[best]) < 0)) best = i;
      });
      return best;
    };
    let next = currentLine ? lowest((v) => cmpLoose(v, currentLine) > 0) : -1;
    if (next < 0) next = lowest(() => true);
    const nextReleaseVersion = next >= 0 ? planVersions[next] : undefined;
    const nextReleasePlannedDate = next >= 0 ? planDates[next] || undefined : undefined;
    const nextReleasePlanUpdated = next >= 0 && planUpdated[next]
      ? (parseDate(planUpdated[next]) ?? undefined)
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
      ltsVersion,
      ltsUntil,
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

export interface ProjectLinks {
  /** "Общая информация о конфигурации": solutions.1c.ru/catalog/…/features or v8.1c.ru/… */
  infoUrl: string | null;
  /** "Каталог ошибок продукта": bugboard.v8.1c.ru/project/….html */
  bugsUrl: string | null;
}

// The site still links over plain http; all 1c.ru hosts serve https.
const httpsFor = (url: string) =>
  url.replace(/^http:\/\/((?:[a-z0-9-]+\.)*1c\.ru\/)/i, "https://$1");

/** Product links from a /project/XXX page (same markup with ?allUpdates=true). */
export function parseProjectLinks(html: string): ProjectLinks {
  let infoUrl: string | null = null;
  for (const m of html.matchAll(/<a\b([^>]*)>/g)) {
    if (!/class="[^"]*\bprogram-info-url\b/.test(m[1])) continue;
    const href = m[1].match(/href="(https?:\/\/[^"]+)"/);
    if (href) { infoUrl = httpsFor(href[1].replace(/&amp;/g, "&")); break; }
  }
  const bugs = html.match(/href="(https?:\/\/bugboard\.v8\.1c\.ru\/[^"]+)"/);
  return { infoUrl, bugsUrl: bugs ? httpsFor(bugs[1].replace(/&amp;/g, "&")) : null };
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
