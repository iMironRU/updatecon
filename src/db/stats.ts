/**
 * stats.ts — aggregates for the statistics page that need more than the
 * catalog rows: release activity (by year, weekday), adoption of platform
 * 8.5, update-chain lengths, transitions between products, and the
 * "will my platform take the latest release?" check.
 *
 * The inputs only change on an import, so everything is computed once and
 * cached until the next import run (or CACHE_MS, whichever comes first).
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { journal, eventsCount } from "./events.js";

const CACHE_MS = 30 * 60 * 1000;
const rowsOf = <T>(r: unknown): T[] => ((r as any).rows ?? r) as T[];

/** Dotted versions of any length, numerically ("3.3.432" < "3.3.432.1"). */
function cmpLoose(a: string, b: string): number {
  const x = a.split("."), y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (parseInt(x[i] ?? "0", 10) || 0) - (parseInt(y[i] ?? "0", 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Current edition of every application (the catalog's default set).
const CURRENT = sql`(c.template_key IS NULL OR c.edition =
  (SELECT max(c2.edition) FROM configurations c2 WHERE c2.template_key = c.template_key))`;

interface MetaRow { config_id: number; version: string; release_date: string | null; min_platform: string | null }

let cacheKey = "";
let cacheAt = 0;
let metaCache: Map<number, MetaRow[]> | null = null;
let moreCache: MoreStats | null = null;
let platformCache: PlatformInfo | null = null;

async function freshKey(): Promise<boolean> {
  const r = rowsOf<{ k: string }>(await db.execute(sql`SELECT coalesce(max(id), 0)::text AS k FROM import_runs`));
  const key = r[0]?.k ?? "0";
  if (key !== cacheKey || Date.now() - cacheAt > CACHE_MS) {
    cacheKey = key;
    cacheAt = Date.now();
    metaCache = null;
    moreCache = null;
    platformCache = null;
    return false;
  }
  return true;
}

/** version_meta grouped by config, newest version first. */
async function loadMeta(): Promise<Map<number, MetaRow[]>> {
  if (metaCache) return metaCache;
  const rows = rowsOf<MetaRow>(await db.execute(sql`
    SELECT config_id, version, release_date::text AS release_date, min_platform FROM version_meta
  `));
  const m = new Map<number, MetaRow[]>();
  for (const r of rows) {
    const id = Number(r.config_id);
    const list = m.get(id) ?? [];
    list.push(r);
    m.set(id, list);
  }
  for (const list of m.values()) list.sort((a, b) => cmpLoose(b.version, a.version));
  metaCache = m;
  return m;
}

// ── Platform compatibility ─────────────────────────────────────────────────

type Plat = [number, number, number, number];
const NO_BUILD = 1e9;   // "8.3.24" = any build of that line

export function parsePlatform(s: string): Plat | null {
  const m = String(s).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/);
  return m ? [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : NO_BUILD] : null;
}
const cmpPlat = (a: Plat, b: Plat) => {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};
const fmtPlat = (p: Plat) => p.join(".");
const sameGen = (a: Plat, b: Plat) => a[0] === b[0] && a[1] === b[1];

/**
 * releases.1c.ru lists the minimum build of every supported platform line:
 * "8.3.24.1548, 8.3.25.1374" = 8.3.24 from build 1548, or 8.3.25 from 1374
 * (newer lines are fine). "8.3.27.1688, 8.5.1.1150" adds generation 8.5.
 *   ok      — the user's platform takes this version;
 *   no      — needs `need` (the minimum in the user's generation, or the
 *             lowest listed one when only newer generations are listed);
 *   unknown — only older generations are listed (an 8.3-only release on 8.5):
 *             the release notes do not say, and we do not guess.
 */
function check(req: string | null, u: Plat): { st: "ok" | "no" | "unknown"; need?: string } {
  const entries = (req?.match(/\d+\.\d+\.\d+\.\d+/g) ?? []).map((s) => parsePlatform(s)!).sort(cmpPlat);
  if (!entries.length) return { st: "unknown" };
  const gen = entries.filter((e) => sameGen(e, u));
  if (!gen.length) {
    const newer = entries.filter((e) => cmpPlat(e, u) > 0);
    return newer.length ? { st: "no", need: fmtPlat(newer[0]) } : { st: "unknown" };
  }
  const line = gen.find((e) => e[2] === u[2]);
  if (line) return cmpPlat(u, line) >= 0 ? { st: "ok" } : { st: "no", need: fmtPlat(line) };
  return cmpPlat(u, gen[0]) >= 0 ? { st: "ok" } : { st: "no", need: fmtPlat(gen[0]) };
}

export interface PlatformCheckRow {
  id: number;
  st: "ok" | "no" | "unknown";
  latest: string;          // newest version with a known requirement
  req?: string;            // its requirement, as releases.1c.ru lists it
  need?: string;           // what the user needs for it
  best?: string;           // newest version the user's platform takes
  best_date?: string | null;
}

export async function platformCheck(p: string): Promise<PlatformCheckRow[] | null> {
  const u = parsePlatform(p);
  if (!u) return null;
  await freshKey();
  const meta = await loadMeta();
  const out: PlatformCheckRow[] = [];
  for (const [id, list] of meta) {
    const known = list.filter((r) => r.min_platform);
    if (!known.length) continue;
    const top = known[0];
    const r = check(top.min_platform, u);
    if (r.st === "ok") { out.push({ id, st: "ok", latest: top.version }); continue; }
    const row: PlatformCheckRow = { id, st: r.st, latest: top.version, req: top.min_platform ?? undefined, need: r.need };
    if (r.st === "no") {
      const best = known.find((x) => check(x.min_platform, u).st === "ok");
      if (best) { row.best = best.version; row.best_date = best.release_date; }
    }
    out.push(row);
  }
  return out;
}

// ── Everything else ────────────────────────────────────────────────────────

export interface MoreStats {
  years: { y: number; n: number }[];
  weekdays: number[];                          // Mon..Sun, releases over the last 3 years
  plat85: { id: number; first: string }[];     // first release that lists platform 8.5
  chains: { id: number; from: string; from_date: string | null; to: string; steps: number }[];
  chainMedian: number | null;
  jumps: { median: number; max: number; id: number | null; version: string | null };
  transitions: { from: number; to: number; packages: number; from_min: string; from_max: string; to_min: string; to_max: string }[];
}

export async function moreStats(): Promise<MoreStats> {
  if ((await freshKey()) && moreCache) return moreCache;

  const [years, weekdays, plat85, transitions, edges] = await Promise.all([
    db.execute(sql`
      SELECT extract(year FROM release_date)::int AS y, count(*)::int AS n
      FROM version_meta WHERE release_date IS NOT NULL GROUP BY 1 ORDER BY 1`),
    db.execute(sql`
      SELECT extract(isodow FROM release_date)::int AS d, count(*)::int AS n
      FROM version_meta WHERE release_date >= current_date - interval '3 years' GROUP BY 1`),
    // (\\. here = \. in SQL — see CLAUDE.md)
    db.execute(sql`
      SELECT config_id AS id, min(release_date)::text AS first
      FROM version_meta
      WHERE release_date IS NOT NULL AND min_platform ~ '(^|[^0-9.])8\\.5\\.'
      GROUP BY 1`),
    db.execute(sql`
      SELECT from_config_id AS "from", to_config_id AS "to", packages, from_min, from_max, to_min, to_max
      FROM transitions WHERE kind = 'product' AND from_config_id IS NOT NULL
      ORDER BY packages DESC LIMIT 80`),
    db.execute(sql`
      SELECT e.config_id AS id, e.from_version AS f, e.to_version AS t
      FROM update_edges e JOIN configurations c ON c.id = e.config_id
      WHERE ${CURRENT} AND split_part(e.from_version, '.', 1) = c.edition::text`),
  ]);

  const wd = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rowsOf<{ d: number; n: number }>(weekdays)) wd[r.d - 1] = r.n;

  // Chains: fewest packages from the oldest version of the current edition to
  // its newest one (the same BFS as chain.ts, done in memory for all at once).
  const byCfg = new Map<number, { f: string; t: string }[]>();
  for (const e of rowsOf<{ id: number; f: string; t: string }>(edges)) {
    const list = byCfg.get(Number(e.id)) ?? [];
    list.push(e);
    byCfg.set(Number(e.id), list);
  }
  const meta = await loadMeta();
  const chains: MoreStats["chains"] = [];
  const fanIn: number[] = [];
  let maxJump = { n: 0, id: null as number | null, version: null as string | null };
  for (const [id, list] of byCfg) {
    const adj = new Map<string, string[]>();
    const into = new Map<string, number>();
    let oldest = list[0].f, newest = list[0].t;
    for (const e of list) {
      (adj.get(e.f) ?? adj.set(e.f, []).get(e.f)!).push(e.t);
      into.set(e.t, (into.get(e.t) ?? 0) + 1);
      if (cmpLoose(e.f, oldest) < 0) oldest = e.f;
      if (cmpLoose(e.t, newest) > 0) newest = e.t;
    }
    for (const [v, n] of into) {
      fanIn.push(n);
      if (n > maxJump.n) maxJump = { n, id, version: v };
    }
    const dist = new Map<string, number>([[oldest, 0]]);
    let frontier = [oldest];
    while (frontier.length && !dist.has(newest)) {
      const next: string[] = [];
      for (const v of frontier) for (const w of adj.get(v) ?? []) {
        if (!dist.has(w)) { dist.set(w, dist.get(v)! + 1); next.push(w); }
      }
      frontier = next;
    }
    const steps = dist.get(newest);
    if (steps === undefined || steps === 0) continue;
    const fromDate = meta.get(id)?.find((r) => r.version === oldest)?.release_date ?? null;
    chains.push({ id, from: oldest, from_date: fromDate, to: newest, steps });
  }
  const median = (a: number[]) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  chains.sort((a, b) => b.steps - a.steps);

  moreCache = {
    years: rowsOf<{ y: number; n: number }>(years),
    weekdays: wd,
    plat85: rowsOf<{ id: number; first: string }>(plat85).map((r) => ({ id: Number(r.id), first: r.first })),
    chainMedian: median(chains.map((c) => c.steps)),
    chains: chains.slice(0, 60),
    jumps: { median: median(fanIn) ?? 0, max: maxJump.n, id: maxJump.id, version: maxJump.version },
    transitions: rowsOf<MoreStats["transitions"][number]>(transitions)
      .map((r) => ({ ...r, from: Number(r.from), to: Number(r.to), packages: Number(r.packages) })),
  };
  return moreCache;
}

/**
 * Drill-down for the release-activity charts: who released the most in a
 * given year, or on a given weekday (ISO 1 = Monday) over the last 3 years.
 */
export async function releasesBy(q: { year?: number; dow?: number }): Promise<{ total: number; top: { id: number; n: number }[] } | null> {
  const where = q.year !== undefined
    ? sql`extract(year FROM release_date) = ${q.year}`
    : q.dow !== undefined
      ? sql`release_date >= current_date - interval '3 years' AND extract(isodow FROM release_date) = ${q.dow}`
      : null;
  if (!where) return null;
  const rows = rowsOf<{ id: number; n: number }>(await db.execute(sql`
    SELECT config_id AS id, count(*)::int AS n
    FROM version_meta WHERE release_date IS NOT NULL AND ${where}
    GROUP BY 1 ORDER BY 2 DESC, 1
  `));
  return {
    total: rows.reduce((s, r) => s + Number(r.n), 0),
    top: rows.slice(0, 12).map((r) => ({ id: Number(r.id), n: Number(r.n) })),
  };
}

// ── Platform page ──────────────────────────────────────────────────────────

export interface PlatformInfo {
  builds: { v: string; nick: string; line: string; date: string | null; os: string[] | null; notes: string | null; bugs: string | null }[];
  current: Record<string, string | null>;          // releases.1c.ru nick → its newest version
  required: Record<string, string>;                // config id → lowest platform its newest release runs on
  coverage: { line: string; build: string; ok: number[]; unknown: number[] }[];
}

const COVERAGE_FROM: Plat = [8, 3, 20, 0];

export async function platformInfo(): Promise<PlatformInfo> {
  if ((await freshKey()) && platformCache) return platformCache;
  const [builds, current] = await Promise.all([
    db.execute(sql`
      SELECT version AS v, nick, line, release_date::text AS date, os, notes_url AS notes, bugs_url AS bugs
      FROM platform_builds ORDER BY string_to_array(version, '.')::int[] DESC`),
    db.execute(sql`
      SELECT nick, latest_version FROM release_projects
      WHERE nick IN ('Platform83', 'Platform85', 'mobile', 'mobile85', 'PlTr83', 'PlTr85')`),
  ]);
  const list = rowsOf<PlatformInfo["builds"][number]>(builds);
  const meta = await loadMeta();

  // What each configuration's newest release asks for, and the lowest of it.
  const reqOf = new Map<number, string>();
  const required: Record<string, string> = {};
  for (const [id, rows] of meta) {
    const top = rows.find((r) => r.min_platform);
    if (!top?.min_platform) continue;
    const entries = (top.min_platform.match(/\d+\.\d+\.\d+\.\d+/g) ?? []).map((x) => parsePlatform(x)!).sort(cmpPlat);
    if (!entries.length) continue;
    reqOf.set(id, top.min_platform);
    required[id] = fmtPlat(entries[0]);
  }

  // Coverage: on the newest build of each recent line, whose newest release installs.
  const newestOfLine = new Map<string, string>();
  for (const b of list) {
    if (b.nick === "Platform82") continue;
    if (!newestOfLine.has(b.line)) newestOfLine.set(b.line, b.v);   // list is newest first
  }
  const coverage: PlatformInfo["coverage"] = [];
  for (const [line, build] of newestOfLine) {
    const u = parsePlatform(build)!;
    if (cmpPlat(u, COVERAGE_FROM) < 0) continue;
    const ok: number[] = [], unknown: number[] = [];
    for (const [id, req] of reqOf) {
      const st = check(req, u).st;
      if (st === "ok") ok.push(id); else if (st === "unknown") unknown.push(id);
    }
    coverage.push({ line, build, ok, unknown });
  }

  platformCache = {
    builds: list,
    current: Object.fromEntries(rowsOf<{ nick: string; latest_version: string | null }>(current).map((r) => [r.nick, r.latest_version])),
    required,
    coverage,
  };
  return platformCache;
}

// ── News feed ──────────────────────────────────────────────────────────────
// Computed from what the database already has (no event log yet): releases
// (flagged when they are a product's first one or raise the minimum platform),
// new platform builds, products moving to 8.5, ended long-term support.

export interface NewsEvent {
  type: "release" | "patch" | "platform_build" | "to85" | "lts_end";
  id?: number;
  branch?: boolean;                   // an update to an older branch (the ДП line) while a newer one exists
  count?: number; titles?: string[];  // patch: how many that day, what they fix
  date: string;                       // YYYY-MM-DD
  config_id?: number;
  version?: string;
  platform?: string | null;           // the release's requirement as listed
  raised_from?: string;               // the previous release's minimum, when this one is higher
  first?: boolean;                    // the product's first release we know of
  build?: string; line?: string; os?: string[] | null;
  lts_line?: string;
}

const lowest = (req: string | null | undefined): Plat | null => {
  const e = (req?.match(/\d+\.\d+\.\d+\.\d+/g) ?? []).map((x) => parsePlatform(x)!).sort(cmpPlat);
  return e[0] ?? null;
};

export async function newsEvents(days: number): Promise<{ days: number; events: NewsEvent[] }> {
  const d = Math.max(1, Math.min(180, Math.round(days)));
  // The journal (release_events) is the source once it exists; an install that has not
  // imported or applied a snapshot with it yet gets the computed feed below.
  if (await eventsCount() > 0) return { days: d, events: await journal(d) as NewsEvent[] };
  const [rel, builds, to85, lts] = await Promise.all([
    db.execute(sql`
      WITH v AS (
        SELECT config_id, version, release_date, min_platform,
               lag(min_platform) OVER w AS prev_platform,
               row_number() OVER w AS n
        FROM version_meta
        WHERE release_date IS NOT NULL AND version ~ '^[0-9]+(\\.[0-9]+)*$'
        WINDOW w AS (PARTITION BY config_id ORDER BY release_date, string_to_array(version, '.')::bigint[])
      )
      SELECT config_id, version, release_date::text AS date, min_platform, prev_platform, n = 1 AS first
      FROM v WHERE release_date >= current_date - ${d}::int
      ORDER BY release_date DESC, config_id`),
    db.execute(sql`
      SELECT version, line, release_date::text AS date, os FROM platform_builds
      WHERE release_date >= current_date - ${d}::int AND nick IN ('Platform83', 'Platform85')`),
    db.execute(sql`
      SELECT DISTINCT ON (config_id) config_id, version, release_date::text AS date, min_platform
      FROM version_meta WHERE min_platform ~ '(^|[^0-9.])8\\.5\\.' AND release_date IS NOT NULL
      ORDER BY config_id, release_date, version`),
    db.execute(sql`
      SELECT config_id, lts_version, lts_until::text AS date FROM release_projects
      WHERE config_id IS NOT NULL AND lts_until BETWEEN current_date - ${d}::int AND current_date`),
  ]);
  const events: NewsEvent[] = [];
  for (const r of rowsOf<{ config_id: number; version: string; date: string; min_platform: string | null; prev_platform: string | null; first: boolean }>(rel)) {
    const e: NewsEvent = { type: "release", date: r.date, config_id: Number(r.config_id), version: r.version, platform: r.min_platform };
    if (r.first) e.first = true;
    const cur = lowest(r.min_platform), prev = lowest(r.prev_platform);
    if (cur && prev && cmpPlat(cur, prev) > 0) e.raised_from = fmtPlat(prev);
    events.push(e);
  }
  for (const b of rowsOf<{ version: string; line: string; date: string; os: string[] | null }>(builds)) {
    events.push({ type: "platform_build", date: b.date, build: b.version, line: b.line, os: b.os });
  }
  const since = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  for (const r of rowsOf<{ config_id: number; version: string; date: string; min_platform: string }>(to85)) {
    if (r.date >= since) events.push({ type: "to85", date: r.date, config_id: Number(r.config_id), version: r.version, platform: r.min_platform });
  }
  for (const r of rowsOf<{ config_id: number; lts_version: string; date: string }>(lts)) {
    events.push({ type: "lts_end", date: r.date, config_id: Number(r.config_id), lts_line: r.lts_version.split(".").slice(0, 3).join(".") });
  }
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { days: d, events };
}
