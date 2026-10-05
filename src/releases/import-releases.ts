/**
 * import-releases.ts — fetch releases.1c.ru and merge into DB as secondary source.
 *
 * Primary source (ITS / .lst) owns configurations (application editions) and
 * update_edges. This adapter writes:
 *   - release_projects: every project from /total + its link to an application
 *   - configurations: display fields copied from the primary linked project
 *   - version_meta: release_date, min_platform, file_size_bytes
 *   - patches: uuid, patch_date, title, download_key
 *
 * Matching (project → application edition), in order:
 *   1. manual  — set in the admin UI, never overwritten here.
 *   2. rule    — nick = template name + edition suffix ("Accounting30" →
 *                "1c/Accounting"); edition picked by version overlap within
 *                that template only.
 *   3. versions — strict fallback for what the rule cannot see: ≥90% of the
 *                project's versions in one application, a clear single winner,
 *                and that application has no project yet.
 */

import { sql, eq, and, inArray, isNotNull, or } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import {
  configurations, versionMeta, patches, importRuns, releaseProjects,
  type ReleaseProject,
} from "../db/schema.js";
import { nickMatchesTemplate, templateName } from "../db/template.js";
import { compareVersions } from "../parser/version.js";
import { ReleasesSession } from "./fetch-releases.js";
import { syncSolutions } from "./solutions.js";
import { refreshTags } from "../db/tags.js";
import {
  parseTotalPage, parseProjectPage, parseVersionFiles, parseVersionFileList,
  parseFileProperties, parsePatchesPage, parseProjectLinks,
  type ReleasesConfig, type VersionRow,
} from "./parse-releases.js";

// Fallback (versions) thresholds — deliberately strict: a wrong link is worse
// than no link, and the admin can always link by hand.
const FALLBACK_MIN_VERSIONS = 10;
const FALLBACK_MIN_FORWARD = 0.9;   // share of the project's versions found in the app
const FALLBACK_MIN_REVERSE = 0.5;   // share of the app's versions found in the project
const FALLBACK_MAX_RUNNER_UP = 0.5; // runner-up must be below this share of the winner

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


// ── Applications & matching ──────────────────────────────────────────────────

export interface App {
  id: number;
  name: string;
  templateCode: string;
  templateKey: string;
  edition: number;
}

export async function loadApps(): Promise<App[]> {
  const rows = await db
    .select({
      id: configurations.id, name: configurations.name,
      templateCode: configurations.templateCode, templateKey: configurations.templateKey,
      edition: configurations.edition,
    })
    .from(configurations);
  const apps: App[] = [];
  for (const r of rows) {
    if (r.templateCode && r.templateKey && r.edition !== null) {
      apps.push({ id: r.id, name: r.name, templateCode: r.templateCode, templateKey: r.templateKey, edition: r.edition });
    }
  }
  return apps;
}

const appLabel = (a: App) => `${a.name} [${a.templateCode}, ред. ${a.edition}]`;
const nickOf = (href: string) => href.replace(/^\/project\//, "");
const firstSegment = (v: string) => Number(v.split(".")[0]);

/** Distinct to_versions each config shares with the given version list. */
async function overlapCounts(ids: number[] | null, versions: string[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (versions.length === 0 || (ids && ids.length === 0)) return out;
  const idFilter = ids
    ? sql`AND config_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`
    : sql``;
  const rows = await db.execute(sql`
    SELECT config_id, count(DISTINCT to_version)::int AS n
    FROM update_edges
    WHERE to_version IN (${sql.join(versions.map((v) => sql`${v}`), sql`, `)}) ${idFilter}
    GROUP BY config_id
  `);
  for (const r of ((rows as any).rows ?? rows) as { config_id: number; n: number }[]) {
    out.set(Number(r.config_id), Number(r.n));
  }
  return out;
}

/** Rule: nick = template name + edition suffix. Returns the app id or null. */
export async function matchByRule(nick: string, versions: string[], apps: App[]): Promise<App | null> {
  let cands = apps.filter((a) => nickMatchesTemplate(nick, a.templateCode));
  if (cands.length === 0) return null;
  // Most specific template wins ("AccountingCorp" over "Accounting").
  const maxLen = Math.max(...cands.map((a) => templateName(a.templateCode).length));
  cands = cands.filter((a) => templateName(a.templateCode).length === maxLen);

  if (versions.length === 0) {
    // Some partner projects publish no version list at all (the partner
    // distributes the release). Without versions the edition can't be
    // checked, so link only the unambiguous case: nick is exactly the
    // template name and that template has a single edition.
    const exact = cands.filter((a) => templateName(a.templateCode).toLowerCase() === nick.toLowerCase());
    return exact.length === 1 && cands.length === 1 ? exact[0] : null;
  }

  // The project's dominant edition (first version segment).
  const edCount = new Map<number, number>();
  for (const v of versions) edCount.set(firstSegment(v), (edCount.get(firstSegment(v)) ?? 0) + 1);
  let domEd = -1, domN = -1;
  for (const [ed, n] of edCount) if (n > domN) { domEd = ed; domN = n; }

  const overlap = await overlapCounts(cands.map((a) => a.id), versions);
  let best: App | null = null, bestScore = -1;
  for (const a of cands) {
    const score = (overlap.get(a.id) ?? 0) * 2 + (a.edition === domEd ? 1 : 0);
    if (score > bestScore) { best = a; bestScore = score; }
  }
  if (!best) return null;
  // Right template but neither the versions nor the edition fit: the edition
  // is probably not in the LST yet — do not force it onto another edition.
  if ((overlap.get(best.id) ?? 0) === 0 && best.edition !== domEd) return null;
  return best;
}

/** Strict version-overlap fallback. `taken` = apps that already have a project. */
export async function matchByVersions(versions: string[], apps: Map<number, App>, taken: Set<number>): Promise<App | null> {
  const distinct = [...new Set(versions)];
  if (distinct.length < FALLBACK_MIN_VERSIONS) return null;
  const hits = [...(await overlapCounts(null, distinct)).entries()].sort((a, b) => b[1] - a[1]);
  if (hits.length === 0) return null;
  const [winId, winN] = hits[0];
  // The best fit already has its own project → this one is a sibling product
  // (mobile client, library, …) rather than a new link.
  if (taken.has(winId)) return null;
  if (winN / distinct.length < FALLBACK_MIN_FORWARD) return null;
  if (hits[1] && hits[1][1] >= winN * FALLBACK_MAX_RUNNER_UP) return null;
  const totalRows = await db.execute(sql`
    SELECT count(DISTINCT to_version)::int AS total FROM update_edges WHERE config_id = ${winId}
  `);
  const total = Number(((totalRows as any).rows ?? totalRows)[0]?.total ?? 0);
  if (total === 0 || winN / total < FALLBACK_MIN_REVERSE) return null;
  return apps.get(winId) ?? null;
}

/**
 * Copy display fields of each application's primary project into
 * configurations (manual links first, then the project with the newest
 * version). Also used by the admin UI after a manual link.
 */
export async function refreshPrimaryProjects(): Promise<void> {
  const linked = await db.select().from(releaseProjects).where(isNotNull(releaseProjects.configId));
  const primary = new Map<number, ReleaseProject>();
  for (const p of linked) {
    const cur = primary.get(p.configId!);
    if (!cur) { primary.set(p.configId!, p); continue; }
    const pm = p.matchMethod === "manual", cm = cur.matchMethod === "manual";
    if (pm !== cm) { if (pm) primary.set(p.configId!, p); continue; }
    const cmp = compareVersions(p.latestVersion ?? "", cur.latestVersion ?? "");
    if (cmp > 0 || (cmp === 0 && p.nick < cur.nick)) primary.set(p.configId!, p);
  }
  await db.transaction(async (tx) => {
    // Clear first: releases_href is unique and may move between applications.
    await tx.update(configurations).set({
      releasesHref: null, displayName: null, groupName: null, region: null,
      nextReleaseVersion: null, nextReleasePlannedDate: null, nextReleasePlanUpdated: null,
    }).where(or(isNotNull(configurations.releasesHref), isNotNull(configurations.displayName)));
    for (const [configId, p] of primary) {
      await tx.update(configurations).set({
        releasesHref: p.href,
        displayName: p.displayName || null,
        groupName: p.groupName,
        region: p.region,
        nextReleaseVersion: p.nextReleaseVersion,
        nextReleasePlannedDate: p.nextReleasePlannedDate,
        nextReleasePlanUpdated: p.nextReleasePlanUpdated,
      }).where(eq(configurations.id, configId));
    }
  });
}

// ── Version files: the list of a version's files + the update file's size ─────
// One /version_files page per version, newest first, `limit` per project per
// run: new releases are read the night they appear, older ones fill in over
// the following runs. A version read with no files (the portal hides it from
// this account, or it is gone) is tried again after 30 days.

export async function syncVersionFilesForConfig(
  session: ReleasesSession,
  configId: number,
  nick: string,
  versions: string[],
  limit = 3,
): Promise<number> {
  if (versions.length === 0) return 0;
  const items = await db
    .select({ id: versionMeta.id, version: versionMeta.version, size: versionMeta.fileSizeBytes })
    .from(versionMeta)
    .where(and(
      eq(versionMeta.configId, configId),
      inArray(versionMeta.version, versions),        // this project's versions only: they are read under its nick
      sql`(${versionMeta.filesFetchedAt} IS NULL OR (coalesce(jsonb_array_length(${versionMeta.files}), 0) = 0
           AND ${versionMeta.filesFetchedAt} < now() - interval '30 days'))`,
    ))
    .orderBy(sql`${versionMeta.releaseDate} DESC NULLS LAST`, sql`${versionMeta.id} DESC`)
    .limit(limit);
  let read = 0;

  for (const item of items) {
    try {
      const html = await session.get(
        `/version_files?nick=${encodeURIComponent(nick)}&ver=${encodeURIComponent(item.version)}`
      );
      const list = parseVersionFileList(html);
      let size = item.size;
      if (size == null) {
        // Prefer "Дистрибутив обновления" (main update zip, not base install)
        const files = parseVersionFiles(html);
        const updateFile = files.find(f =>
          f.title.includes("Дистрибутив обновления") && !f.title.includes("базовой")
        ) ?? files.find(f => f.title.includes("Дистрибутив"));
        if (updateFile?.propertiesId) {
          size = parseFileProperties(await session.get(`/files/properties/version-files/${updateFile.propertiesId}`));
        }
      }
      await db
        .update(versionMeta)
        .set({ files: list, filesNick: nick, filesFetchedAt: new Date(), fileSizeBytes: size ?? null })
        .where(eq(versionMeta.id, item.id));
      read++;
      await delay(150);
    } catch {
      // network trouble: not marked as read, so the next run tries again
    }
  }
  return read;
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
  /** Ignored: /total is always synced (release_projects needs it). Kept for callers. */
  syncTotalPage?: boolean;
  /** Read the versions' file lists and update-file sizes (slow, many pages) */
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
  const projects = parseTotalPage(await session.get("/total"));
  log(`Найдено проектов: ${projects.length}`);

  const apps = await loadApps();
  const appsById = new Map(apps.map((a) => [a.id, a]));
  const siblings = new Map(apps.map((a) => [`${a.templateKey}#${a.edition}`, a]));

  // Manual links from the admin UI are authoritative (config_id NULL = "never link").
  const manual = new Map<string, number | null>();
  for (const p of await db
    .select({ nick: releaseProjects.nick, configId: releaseProjects.configId, matchMethod: releaseProjects.matchMethod })
    .from(releaseProjects)) {
    if (p.matchMethod === "manual") manual.set(p.nick, p.configId);
  }

  // Every project from /total is stored, matched or not — the admin UI lists them.
  const seenAt = new Date();
  for (const p of projects) {
    const meta = {
      href: p.href,
      displayName: p.displayName,
      groupName: p.groupName || null,
      region: groupToRegion(p.groupName),
      latestVersion: p.latestVersion || null,
      nextReleaseVersion: p.nextReleaseVersion ?? null,
      nextReleasePlannedDate: p.nextReleasePlannedDate ?? null,
      nextReleasePlanUpdated: p.nextReleasePlanUpdated ?? null,
      ltsVersion: p.ltsVersion ?? null,
      ltsUntil: p.ltsUntil ?? null,
      lastSeenAt: seenAt,
    };
    await db.insert(releaseProjects)
      .values({ nick: nickOf(p.href), ...meta })
      .onConflictDoUpdate({ target: releaseProjects.nick, set: meta });
  }

  let byRule = 0, byVersions = 0, byManual = 0, metaRows = 0, totalSized = 0;
  const linkedNicks = new Set<string>();
  const taken = new Set<number>();          // apps that got a project this run
  const fetchedNicks: string[] = [];
  const pending: { p: ReleasesConfig; rows: VersionRow[] }[] = [];

  const applyLink = async (p: ReleasesConfig, rows: VersionRow[], app: App, method: string) => {
    const nick = nickOf(p.href);
    await db.update(releaseProjects)
      .set({ configId: app.id, matchMethod: method })
      .where(eq(releaseProjects.nick, nick));
    linkedNicks.add(nick);
    taken.add(app.id);

    // Each version goes to its own edition of the same template (a project
    // occasionally lists versions of a neighbouring edition).
    for (const row of rows) {
      if (!row.releaseDate && !row.minPlatform) continue;
      const ed = firstSegment(row.version);
      const target = ed === app.edition ? app : siblings.get(`${app.templateKey}#${ed}`);
      if (!target) continue;
      await db.execute(sql`
        INSERT INTO version_meta (config_id, version, release_date, min_platform, source, updated_at)
        VALUES (${target.id}, ${row.version}, ${row.releaseDate ?? null}::date, ${row.minPlatform ?? null}, 'releases', now())
        ON CONFLICT (config_id, version) DO UPDATE
          SET release_date = EXCLUDED.release_date,
              min_platform = EXCLUDED.min_platform,
              updated_at   = now()
      `);
      metaRows++;
    }

    if (syncSizes) {
      const read = await syncVersionFilesForConfig(session, app.id, nick, rows.map((r) => r.version),
        Math.max(3, Math.ceil(sizesLimit / projects.length) + 1));
      if (read > 0) log(`    файлы версий: ${read}`);
      totalSized += read;
    }
    if (syncPatchesData) {
      await syncPatchesForConfig(session, app.id, nick, rows.map((r) => r.version).slice(-3));
    }
  };

  // ── Pass 1: fetch every project; manual and rule links are applied at once ──
  for (let i = 0; i < projects.length; i++) {
    if (signal?.aborted) {
      const e = new Error("Cancelled by user");
      e.name = "AbortError";
      throw e;
    }
    const p = projects[i];
    const nick = nickOf(p.href);
    onProgress?.(i + 1, projects.length, nick);
    if (!onLog) process.stdout.write(`\r[releases] [${i + 1}/${projects.length}] ${nick.padEnd(40)}`);

    let rows: VersionRow[];
    try {
      const html = await session.get(`${p.href}?allUpdates=true`);
      rows = parseProjectPage(html);
      // Product page (solutions.1c.ru / v8.1c.ru) and bug catalog links —
      // stored for every project, matched or not.
      const links = parseProjectLinks(html);
      await db.update(releaseProjects)
        .set({ infoUrl: links.infoUrl, bugsUrl: links.bugsUrl })
        .where(eq(releaseProjects.nick, nick));
    } catch (e) {
      log(`  ✗ ${nick}: ${(e as Error).message}`);
      continue;
    }
    fetchedNicks.push(nick);

    if (manual.has(nick)) {
      const app = appsById.get(manual.get(nick) ?? -1);
      if (app) {
        log(`  ✓ ${nick} → ${appLabel(app)} [вручную]`);
        await applyLink(p, rows, app, "manual");
        byManual++;
      } else {
        linkedNicks.add(nick); // manual "no link": keep it that way
      }
      continue;
    }

    const app = await matchByRule(nick, rows.map((r) => r.version), apps);
    if (app) {
      log(`  ✓ ${nick} → ${appLabel(app)}`);
      await applyLink(p, rows, app, "rule");
      byRule++;
    } else {
      pending.push({ p, rows });
    }
  }

  // ── Pass 2: strict version fallback for what the rule could not place ──
  for (const { p, rows } of pending) {
    if (signal?.aborted) {
      const e = new Error("Cancelled by user");
      e.name = "AbortError";
      throw e;
    }
    const app = await matchByVersions(rows.map((r) => r.version), appsById, taken);
    if (!app) continue;
    log(`  ≈ ${nickOf(p.href)} → ${appLabel(app)} [по версиям]`);
    await applyLink(p, rows, app, "versions");
    byVersions++;
  }

  // Auto links that no longer hold are dropped (only for projects we could
  // actually fetch this run — a network error must not unlink anything).
  const stale = fetchedNicks.filter((n) => !linkedNicks.has(n));
  for (let i = 0; i < stale.length; i += 500) {
    await db.update(releaseProjects)
      .set({ configId: null, matchMethod: null })
      .where(and(
        inArray(releaseProjects.nick, stale.slice(i, i + 500)),
        sql`${releaseProjects.matchMethod} IS DISTINCT FROM 'manual'`,
      ));
  }

  await refreshPrimaryProjects();

  // Product cards from solutions.1c.ru (industries, tasks, base configuration,
  // support contacts), then retag: the official base outranks the heuristics.
  try {
    await syncSolutions({ onLog: log, signal });
    const t = await refreshTags();
    log(`Теги линеек: своих=${t.own}, «на базе»=${t.based} (по 1С:Решения ${t.bySolutions}, по версиям ${t.byVersions})`);
  } catch (e) {
    log(`1С:Решения: ошибка — ${(e as Error).message}`);
  }

  if (!onLog) process.stdout.write("\n");
  const matched = byRule + byVersions + byManual;
  const unmatched = projects.length - matched;
  log(
    `Готово: сопоставлено=${matched} (правило=${byRule}, по версиям=${byVersions}, вручную=${byManual}), ` +
    `не сопоставлено=${unmatched}, метаданных=${metaRows}, файлов версий=${totalSized}`,
  );
  if (unmatched > 0) log(`Несопоставленные проекты — в админке, вкладка «Сопоставление».`);

  await db.insert(importRuns).values({
    source: "releases",
    fileSha256: "",
    fileBytes: 0,
    configsFound: matched,
    edgesUpserted: metaRows,
    edgesUnchanged: unmatched,
    status: "ok",
    message: `rule=${byRule} versions=${byVersions} manual=${byManual} unmatched=${unmatched} meta=${metaRows} files=${totalSized}`,
    startedAt,
    finishedAt: new Date(),
  });
}

// CLI entry point
if (process.argv[1] === new URL(import.meta.url).pathname) {
  runReleasesImport(undefined, undefined, { syncSizes: true, syncPatchesData: true })
    .finally(() => pool.end());
}
