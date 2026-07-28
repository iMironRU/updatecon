/**
 * parse-releases.ts — HTML → structured data for releases.1c.ru pages.
 */

/** Always request the complete account catalog, including grey unavailable rows. */
export const TOTAL_CATALOG_PATH = "/total?hideUnavailablePrograms=false";

export interface ReleasesConfig {
  href: string | null; // "/project/Accounting30"; null when account has no access
  accessible: boolean;
  identityKey: string;
  displayName: string; // "Бухгалтерия предприятия, редакция 3.0"
  latestVersion: string;
  latestDate: string;
  groupName: string;              // "Типовые конфигурации фирмы «1С» для России"
  nextReleaseVersion?: string;    // "3.0.209"
  nextReleasePlannedDate?: string; // "Ноябрь 2026"
  nextReleasePlanUpdated?: string; // "2026-04-01"
  previewVersion?: string;
  previewDate?: string;
}

export interface VersionRow {
  version: string;
  releaseDate: string | null; // ISO "YYYY-MM-DD" or null
  minPlatform: string | null; // "8.3.27.1688" or null
  previousVersions: string[];
  isTest: boolean;
}

type VersionResourceCategory =
  | "documentation"
  | "distribution"
  | "transition"
  | "additional"
  | "service";

interface VersionFileInfo {
  title: string;
  href: string;
  propertiesId?: string;
  fileName?: string;
  kind: string;
  category: VersionResourceCategory;
  fileExtension?: string;
  fileSizeBytes?: number;
  publishedAt?: string;
  sha512?: string;
  isFile: boolean;
  sortOrder: number;
}

export interface VersionFileMetadata {
  fileName: string | null;
  fileSizeBytes: number | null;
  publishedAt: string | null;
  sha512: string | null;
}

export interface VersionFilesPage {
  resources: VersionFileInfo[];
  minPlatform: string | null;
  recommendedPlatform: string | null;
  isTest: boolean;
}

export interface PatchInfo {
  uuid: string;
  patchDate: string | null;  // ISO "YYYY-MM-DD"
  title?: string;
}

const DECODE_MAP: Record<string, string> = {
  "&nbsp;": " ", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">",
};
const DECODE_PATTERN = /&(?:nbsp|quot|amp|lt|gt);/gi;

function decodeEntities(value: string): string {
  return value.replace(DECODE_PATTERN, (match) => DECODE_MAP[match.toLowerCase()] ?? match);
}

const TAG_PATTERN = /<[^>]+>/g;
const WHITESPACE_PATTERN = /\s+/g;

function stripTags(html: string): string {
  return decodeEntities(html.replace(TAG_PATTERN, " "))
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

const CLASS_CELL_CACHE = new Map<string, RegExp>();
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function classCell(row: string, className: string): string {
  let pattern = CLASS_CELL_CACHE.get(className);
  if (!pattern) {
    const escaped = className.replace(RE_ESCAPE, "\\$&");
    pattern = new RegExp(`<td[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`);
    CLASS_CELL_CACHE.set(className, pattern);
  }
  const match = row.match(pattern);
  return match ? stripTags(match[1]) : "";
}

// Most 1C configurations use 3–4 dot-separated segments. Technology
// distributions such as PostgreSQL use a second numeric group after a dash:
// 18.3-5.1C, 9.6.7-1.1C (the final C may also be Cyrillic С). Java builds
// published by 1C retain their build metadata after `+`: 11.0.30+9.
const RELEASE_VERSION_PATTERN =
  String.raw`(?:\d+(?:\.\d+){1,3}-\d+(?:\.\d+){0,2}[a-zа-яё]*|\d+(?:\.\d+){2,3}(?:\+[0-9a-z]+(?:[._-][0-9a-z]+)*)?)`;

const RELEASE_VERSION_ALL = new RegExp(RELEASE_VERSION_PATTERN, "gi");
const RELEASE_VERSION_START = new RegExp(`^\\s*(${RELEASE_VERSION_PATTERN})`, "i");

function versionsFrom(value: string): string[] {
  RELEASE_VERSION_ALL.lastIndex = 0;
  return [...value.matchAll(RELEASE_VERSION_ALL)]
    .map((match) => match[0]);
}

function versionFrom(value: string): string {
  return value.match(RELEASE_VERSION_START)?.[1] ?? "";
}

export function isReleaseVersion(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed) && versionFrom(trimmed) === trimmed;
}

const DIGIT_PATTERN = /\d+/g;
const versionDigitsCache = new Map<string, number[]>();

function digitsOf(version: string): number[] {
  let cached = versionDigitsCache.get(version);
  if (!cached) {
    cached = [...version.matchAll(DIGIT_PATTERN)].map((match) => Number(match[0]));
    versionDigitsCache.set(version, cached);
  }
  return cached;
}

/** Numeric ordering for both regular 1C and technology-distribution versions. */
export function compareReleaseVersions(a: string, b: string): number {
  const left = digitsOf(a);
  const right = digitsOf(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const normalizeSuffix = (value: string) => value
    .normalize("NFKC")
    .replace(/[Сс]/g, "C")
    .toLocaleUpperCase("ru-RU");
  return normalizeSuffix(a).localeCompare(normalizeSuffix(b), "ru");
}

function normalizedIdentityPart(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function projectIdentityKey(groupName: string, displayName: string): string {
  return `${normalizedIdentityPart(groupName)}::${normalizedIdentityPart(displayName)}`;
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
  // `group` must not match `parent-group`; the old \bgroup expression did.
  for (const m of html.matchAll(/<tr\s+group="(\d+)"[^>]*>[\s\S]*?<span class="group-name">([^<]+)</g)) {
    groupMap.set(m[1], stripTags(m[2]));
  }

  // Parse each config row
  for (const rowMatch of html.matchAll(/<tr[^>]*\bparent-group="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const groupId = rowMatch[1];
    const row = rowMatch[2];

    const nameCellMatch = row.match(
      /<td[^>]*class="[^"]*\bnameColumn\b[^"]*"[^>]*>([\s\S]*?)<\/td>/,
    );
    const nameCell = nameCellMatch?.[1] ?? "";
    const hrefMatch = nameCell.match(
      /href="(\/project\/[^"?]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    const href = hrefMatch?.[1] ?? null;
    const displayName = stripTags(hrefMatch?.[2] ?? nameCell);
    if (!displayName) continue;
    const groupName = groupMap.get(groupId) ?? "";

    const versionCells = [...row.matchAll(
      /<td[^>]*class="[^"]*\bversionColumn\b[^"]*"[^>]*>([\s\S]*?)<\/td>/g,
    )].map((m) => versionFrom(stripTags(m[1])));
    const latestVersion = versionCells[0] ?? "";
    const nextReleaseVersion = versionCells[1] || undefined;
    const previewVersion = versionCells[2] || undefined;

    const latestDate = classCell(row, "releaseDate").match(
      /\d{1,2}\.\d{2}\.\d{2,4}/,
    )?.[0] ?? "";

    // Planned release date
    const rawPlanDate = classCell(row, "planReleaseDate");
    const nextReleasePlannedDate = rawPlanDate && rawPlanDate !== "Не определена"
      ? rawPlanDate
      : undefined;

    // Plan updated date
    const rawPlanUpdated = classCell(row, "updateDate").match(
      /\d{1,2}\.\d{2}\.\d{2,4}/,
    )?.[0];
    const nextReleasePlanUpdated = rawPlanUpdated
      ? (parseDate(rawPlanUpdated) ?? undefined)
      : undefined;
    const rawPreviewDate = classCell(row, "publicationDate").match(
      /\d{1,2}\.\d{2}\.\d{2,4}/,
    )?.[0];
    const previewDate = rawPreviewDate
      ? (parseDate(rawPreviewDate) ?? undefined)
      : undefined;

    configs.push({
      href,
      accessible: href !== null,
      identityKey: projectIdentityKey(groupName, displayName),
      displayName,
      groupName,
      latestVersion,
      latestDate,
      nextReleaseVersion,
      nextReleasePlannedDate,
      nextReleasePlanUpdated,
      previewVersion,
      previewDate,
    });
  }

  return configs;
}

/** Parse /project/XXX?allUpdates=true — returns per-version metadata. */
export function parseProjectPage(html: string): VersionRow[] {
  const rows: VersionRow[] = [];
  const byVersion = new Map<string, VersionRow>();
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) =>
      stripTags(t[1]),
    );
    const version = versionFrom(tds[0] ?? "");
    if (!version) continue;
    // tds[0]=version, tds[1]=date DD.MM.YY, tds[2]=compatible_from,
    // tds[3]=min_platform (may be absent for old entries)
    const [, rawDate, , minPlatform] = tds;
    const releaseDate = parseDate(rawDate ?? "") ?? null;
    const row = {
      version,
      releaseDate,
      minPlatform: minPlatform?.match(/^\d+\.\d+/) ? minPlatform : null,
      previousVersions: [...new Set(versionsFrom(tds[2] ?? ""))],
      isTest: false,
    };
    rows.push(row);
    byVersion.set(version, row);
  }

  // Test releases are listed outside the history table in a separate
  // "Версии для тестирования" block. They are real releases, but must not be
  // mistaken for the latest production version.
  for (const paragraph of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripTags(paragraph[1]);
    if (!/предназначен(?:а|о|ы)?(?:\s+только)?\s+для\s+тестирования/i.test(text)) continue;
    const link = paragraph[1].match(
      /<a\b[^>]*href=["'][^"']*\bver=([^&"']+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    const version = versionFrom(stripTags(link?.[2] ?? ""))
      || versionFrom(decodeURIComponent(decodeEntities(link?.[1] ?? "")));
    if (!version) continue;
    const rawDate = text.match(/\b\d{1,2}\.\d{2}\.\d{2,4}\b/)?.[0] ?? "";
    const existing = byVersion.get(version);
    if (existing) {
      existing.isTest = true;
      existing.releaseDate ??= parseDate(rawDate);
      continue;
    }
    const row: VersionRow = {
      version,
      releaseDate: parseDate(rawDate),
      minPlatform: null,
      previousVersions: [],
      isTest: true,
    };
    rows.push(row);
    byVersion.set(version, row);
  }
  return rows;
}

function classifyVersionResource(
  title: string,
  href: string,
): Pick<VersionFileInfo, "kind" | "category" | "isFile"> {
  const normalized = title.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (href.startsWith("/patches/")) return { kind: "patches", category: "service", isFile: false };
  if (href.startsWith("/classifiers")) return { kind: "classifiers", category: "service", isFile: false };
  if (href.startsWith("/external-components")) return { kind: "external_components", category: "service", isFile: false };
  if (/^https?:\/\/bugboard\.1c\.ru/i.test(href)) return { kind: "bugboard", category: "service", isFile: false };
  if (normalized.includes("новое в версии")) return { kind: "whats_new", category: "documentation", isFile: true };
  if (normalized.includes("изменения в версии")) return { kind: "version_changes", category: "documentation", isFile: true };
  if (normalized.includes("порядок обновления") || normalized.includes("список изменений")) {
    return { kind: "update_instructions", category: "documentation", isFile: true };
  }
  if (normalized === "дистрибутив обновления") {
    return { kind: "update_distribution", category: "distribution", isFile: true };
  }
  if (normalized.includes("дистрибутив обновления") && normalized.includes("базов")) {
    return { kind: "base_update_distribution", category: "distribution", isFile: true };
  }
  if (normalized.includes("полный дистрибутив")) {
    return { kind: "full_distribution", category: "distribution", isFile: true };
  }
  if (normalized.includes("дистрибутив создания новой базы")) {
    return { kind: "new_base_distribution", category: "distribution", isFile: true };
  }
  if (normalized.includes("технологический дистрибутив")) {
    return { kind: "technology_distribution", category: "distribution", isFile: true };
  }
  if (normalized === "readme") return { kind: "readme", category: "documentation", isFile: true };
  if (normalized.includes("версии библиотек")) {
    return { kind: "library_versions", category: "documentation", isFile: true };
  }
  if (normalized.startsWith("для перехода")) {
    return { kind: "migration_distribution", category: "transition", isFile: true };
  }
  if (/\.(?:epf|erf)(?:$|[?&#])/i.test(decodeEntities(href))) {
    return { kind: "additional_processing", category: "additional", isFile: true };
  }
  return { kind: "other", category: "additional", isFile: true };
}

function resourceExtension(href: string): string | undefined {
  try {
    const decoded = decodeURIComponent(decodeEntities(href));
    const path = new URL(decoded, "https://releases.1c.ru").searchParams.get("path") ?? decoded;
    return path.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function resourceFileName(href: string): string | undefined {
  try {
    const decoded = decodeURIComponent(decodeEntities(href));
    const path = new URL(decoded, "https://releases.1c.ru").searchParams.get("path") ?? decoded;
    return path.split(/[\\/]/).filter(Boolean).at(-1) || undefined;
  } catch {
    return undefined;
  }
}

const PLATFORM = "(8\\.3\\.\\d+\\.\\d+)";
const MIN_PLATFORM_PATTERNS = [
  new RegExp(`не ниже\\s+${PLATFORM}`, "i"),
  new RegExp(`Минимальная версия[^:]{0,240}:\\s*${PLATFORM}`, "i"),
  new RegExp(`для использования текущей версии[^:]{0,240}:\\s*${PLATFORM}`, "i"),
];
const RECOMMENDED_PLATFORM_PATTERNS = [
  new RegExp(`рекомендованная\\s+${PLATFORM}`, "i"),
  new RegExp(`Рекомендуемая версия[^:]{0,240}:\\s*${PLATFORM}`, "i"),
  new RegExp(`рекоменду[^0-9]{0,240}${PLATFORM}`, "i"),
];

function minPlatformOf(text: string): string | null {
  for (const pattern of MIN_PLATFORM_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function recommendedPlatformOf(text: string): string | null {
  for (const pattern of RECOMMENDED_PLATFORM_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Parse /version_files?nick=X&ver=Y including arbitrary files and service links. */
export function parseVersionFilesPage(html: string): VersionFilesPage {
  const resources: VersionFileInfo[] = [];
  const matches = [...html.matchAll(
    /<a\s+[^>]*href="(\/version_file\?[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  )];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const href = decodeEntities(match[1]);
    const title = stripTags(match[2]);
    const tailEnd = matches[index + 1]?.index ?? Math.min(html.length, (match.index ?? 0) + 1600);
    const tail = html.slice((match.index ?? 0) + match[0].length, tailEnd);
    const propertiesId = tail.match(/\/files\/properties\/version-files\/(\d+)/)?.[1];
    resources.push({
      title,
      href,
      propertiesId,
      fileName: resourceFileName(href),
      fileExtension: resourceExtension(href),
      sortOrder: resources.length,
      ...classifyVersionResource(title, href),
    });
  }

  const servicePatterns = [
    /<a\s+[^>]*href="(\/patches\/total\?[^\"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a\s+[^>]*href="(\/classifiers[^\"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a\s+[^>]*href="(\/external-components[^\"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a\s+[^>]*href="(https?:\/\/bugboard\.1c\.ru[^\"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const pattern of servicePatterns) {
    for (const match of html.matchAll(pattern)) {
      const href = decodeEntities(match[1]);
      // The page header contains generic catalog navigation. Keep only links
      // related to this project/version so a release card is not polluted by
      // global classifiers and external-component indexes.
      if (href === "/classifiers/total" || href === "/external-components/total") continue;
      if (resources.some((resource) => resource.href === href)) continue;
      const title = stripTags(match[2]);
      resources.push({
        title,
        href,
        sortOrder: resources.length,
        ...classifyVersionResource(title, href),
      });
    }
  }

  const text = stripTags(html);
  const minPlatform = minPlatformOf(text);
  const recommendedPlatform = recommendedPlatformOf(text);
  const isTest = /предназначен(?:а|о|ы)?(?:\s+только)?\s+для\s+тестирования/i.test(text);

  return { resources, minPlatform, recommendedPlatform, isTest };
}

/** Parse the authenticated /version_file landing page without downloading it. */
export function parseVersionFilePage(html: string): VersionFileMetadata {
  const text = stripTags(html);
  const fileName = text.match(
    /(?:Имя файла|Файл)\s*:\s*([^\s]+?)(?=\s+(?:Размер(?: файла)?|Дата публикации|Контрольная сумма|SHA-512|Скачать)\s*:|$)/i,
  )?.[1] ?? null;
  const byteText = text.match(
    /Размер(?: файла)?\s*:[\s\S]{0,120}?\(([0-9\s\u00a0]+)\s*байт\)/i,
  )?.[1];
  const fileSizeBytes = byteText
    ? Number(byteText.replace(/[\s\u00a0]/g, ""))
    : null;
  const rawPublishedAt = text.match(
    /Дата публикации\s*:\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
  )?.[1];
  const publishedAt = rawPublishedAt ? parseDate(rawPublishedAt) : null;
  const sha512 = text.match(
    /(?:Контрольная сумма\s*)?SHA[\s-]*512\s*:\s*([a-f0-9]{128})/i,
  )?.[1]?.toLowerCase() ?? null;
  return {
    fileName,
    fileSizeBytes: Number.isSafeInteger(fileSizeBytes) ? fileSizeBytes : null,
    publishedAt,
    sha512,
  };
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
