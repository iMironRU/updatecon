/**
 * parse-releases.ts — HTML → structured data for releases.1c.ru pages.
 */

export interface ReleasesConfig {
  href: string;        // "/project/Accounting30"
  displayName: string; // "Бухгалтерия предприятия, редакция 3.0"
  latestVersion: string;
  latestDate: string;
}

export interface VersionRow {
  version: string;
  releaseDate: string | null; // "DD.MM.YY" or null
  minPlatform: string | null; // "8.3.27.1688" or null
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Parse /total — returns all configs listed in the table. */
export function parseTotalPage(html: string): ReleasesConfig[] {
  const configs: ReleasesConfig[] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = m[1];
    const href = row.match(/href="(\/project\/[^"?]+)"/)?.[1];
    if (!href) continue;
    const tds = [
      ...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g),
    ].map((t) => stripTags(t[1]));
    if (!tds[0]) continue;
    configs.push({
      href,
      displayName: tds[0] ?? "",
      latestVersion: tds[1] ?? "",
      latestDate: tds[2] ?? "",
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
      minPlatform: minPlatform?.match(/^\d+\.\d+/)
        ? minPlatform
        : null,
    });
  }
  return rows;
}

/** "DD.MM.YY" or "DD.MM.YYYY" → "YYYY-MM-DD" (ISO), null if unparseable. */
function parseDate(raw: string): string | null {
  const m = raw.match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  const year = yy.length === 2 ? (Number(yy) >= 90 ? `19${yy}` : `20${yy}`) : yy;
  return `${year}-${mm}-${dd}`;
}
