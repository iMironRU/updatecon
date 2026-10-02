/**
 * platform.ts — builds of the 1С:Предприятие platform from releases.1c.ru.
 *
 *   /project/Platform83?allUpdates=true   every 8.3 build with its date
 *   /version_files?nick=…&ver=…           one build: distributions grouped by
 *                                          OS (<h5>Windows (64-bit)</h5> …),
 *                                          release notes, bugboard link
 *
 * The lists are two or three pages per run; a build page is fetched once
 * (errors are retried after a week), so only new builds cost requests.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { platformBuilds } from "../db/schema.js";
import { ReleasesSession } from "./fetch-releases.js";

const BASE = "https://releases.1c.ru";
const LIST_NICKS = ["Platform85", "Platform83", "Platform82"];
const DETAIL_NICKS = ["Platform85", "Platform83"];   // 8.2 is history: dates are enough
const DELAY_MS = 300;

export interface BuildListItem { version: string; date: string | null }

/** "27.08.26" → "2026-08-27" */
function isoDate(d: string): string | null {
  const m = d.match(/^(\d\d)\.(\d\d)\.(\d\d)$/);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

export function parseBuildList(html: string): BuildListItem[] {
  const out: BuildListItem[] = [];
  const re = /<a href="\/version_files\?nick=\w+&(?:amp;)?ver=([\d.]+)">\s*[\d.]+\s*<\/a>\s*<\/td>\s*<td class="dateColumn">\s*([\d.]*)\s*<\/td>/g;
  for (const m of html.matchAll(re)) out.push({ version: m[1], date: isoDate(m[2]) });
  return out;
}

/** OS tags from a distribution group title ("Linux (arm64, Эльбрус-8С)" → arm64, e2k). */
export function osTags(title: string): string[] {
  const t = title.toLowerCase();
  const tags: string[] = [];
  if (t.startsWith("windows")) tags.push(/32-bit/.test(t) ? "win32" : "win64");
  else if (t.startsWith("linux")) {
    if (/arm|эльбрус/.test(t)) {
      if (/arm/.test(t)) tags.push("arm64");
      if (/эльбрус/.test(t)) tags.push("e2k");
    } else tags.push(/32-bit/.test(t) ? "linux32" : "linux64");
  } else if (t.startsWith("macos")) tags.push("mac");
  return tags;
}

/**
 * OS tags from a distribution's file name — older build pages have no groups,
 * just a flat list: "Тонкий клиент 1С:Предприятия (64-bit) для DEB-based
 * Linux-систем", "Клиент 1С:Предприятия для OS X". Only the part before
 * " + " counts ("…для Windows + Тонкий клиент для Windows, Linux и MacOS…").
 */
export function osFromFileName(name: string): string[] {
  const n = name.split(" + ")[0];
  if (!/\sдля\s/i.test(n)) return [];
  if (/ARM/i.test(n)) return ["arm64"];
  if (/Эльбрус/i.test(n)) return ["e2k"];
  const x64 = /64-bit/i.test(n);
  if (/для\s+Windows/i.test(n)) return [x64 ? "win64" : "win32"];
  if (/для\s+(?:(?:DEB|RPM)-based\s+)?Linux/i.test(n)) return [x64 ? "linux64" : "linux32"];
  if (/для\s+(?:macOS|Mac\s*OS|OS\s*X)/i.test(n)) return ["mac"];
  return [];
}

export function parseBuildPage(html: string): { os: string[]; notesUrl: string | null; bugsUrl: string | null } {
  const os = new Set<string>();
  for (const m of html.matchAll(/<h5>\s*([^<]+?)\s*<\/h5>/g)) osTags(m[1]).forEach((t) => os.add(t));
  for (const m of html.matchAll(/<a href="\/version_file\?[^"]*">\s*([^<]+?)\s*<\/a>/g)) osFromFileName(m[1]).forEach((t) => os.add(t));
  const notes = html.match(/<a href="(\/version_file\?[^"]*1cv8upd[^"]*\.htm)"/i);
  const bugs = html.match(/href="(https:\/\/bugboard\.1c\.ru\?state=ver-\d+)"/);
  const order = ["win64", "win32", "linux64", "linux32", "arm64", "e2k", "mac"];
  return {
    os: [...os].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    notesUrl: notes ? BASE + notes[1].replace(/&amp;/g, "&") : null,
    bugsUrl: bugs ? bugs[1] : null,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function syncPlatform(opts: {
  login?: string; password?: string;
  onLog?: (m: string) => void; onProgress?: (cur: number, tot: number) => void; signal?: AbortSignal;
} = {}): Promise<{ builds: number; added: number; details: number; errors: number }> {
  const log = (m: string) => (opts.onLog ? opts.onLog(m) : console.log(m));
  const login = opts.login ?? process.env.ITS_LOGIN, password = opts.password ?? process.env.ITS_PASSWORD;
  if (!login || !password) { log("⚠ ITS_LOGIN / ITS_PASSWORD не заданы — пропуск"); return { builds: 0, added: 0, details: 0, errors: 0 }; }

  const session = new ReleasesSession();
  await session.login(login, password);

  let builds = 0, added = 0;
  for (const nick of LIST_NICKS) {
    if (opts.signal?.aborted) break;
    let list: BuildListItem[];
    try {
      list = parseBuildList(await session.get(`/project/${nick}?allUpdates=true`));
    } catch (e) {
      log(`  ✗ ${nick}: ${(e as Error).message}`);
      continue;
    }
    if (!list.length) { log(`  ✗ ${nick}: список сборок не разобран`); continue; }
    const before = Number((((await db.execute(sql`SELECT count(*)::int AS n FROM platform_builds WHERE nick = ${nick}`)) as any).rows ?? [])[0]?.n ?? 0);
    for (let i = 0; i < list.length; i += 200) {
      await db.insert(platformBuilds)
        .values(list.slice(i, i + 200).map((b) => ({
          version: b.version, nick, line: b.version.split(".").slice(0, 3).join("."), releaseDate: b.date,
        })))
        .onConflictDoUpdate({ target: platformBuilds.version, set: { releaseDate: sql`excluded.release_date`, nick: sql`excluded.nick` } });
    }
    const after = Number((((await db.execute(sql`SELECT count(*)::int AS n FROM platform_builds WHERE nick = ${nick}`)) as any).rows ?? [])[0]?.n ?? 0);
    builds += list.length; added += after - before;
    log(`  ✓ ${nick}: ${list.length} сборок${after > before ? `, новых ${after - before}` : ""}, последняя ${list[0].version}`);
  }

  // Build pages: once per build; a failed one is retried after a week.
  const todo = (((await db.execute(sql`
    SELECT version, nick FROM platform_builds
    WHERE nick IN (${sql.join(DETAIL_NICKS.map((n) => sql`${n}`), sql`, `)})
      AND (details_status IS NULL OR (details_status = 'error' AND fetched_at < now() - interval '7 days'))
    ORDER BY string_to_array(version, '.')::int[] DESC
  `)) as any).rows ?? []) as { version: string; nick: string }[];
  let details = 0, errors = 0;
  if (todo.length) log(`Страницы сборок: ${todo.length} (ОС, список изменений, ошибки)…`);
  for (let i = 0; i < todo.length; i++) {
    if (opts.signal?.aborted) break;
    const { version, nick } = todo[i];
    try {
      const p = parseBuildPage(await session.get(`/version_files?nick=${nick}&ver=${version}`));
      await db.update(platformBuilds)
        .set({ os: p.os, notesUrl: p.notesUrl, bugsUrl: p.bugsUrl, detailsStatus: "ok", fetchedAt: new Date() })
        .where(sql`version = ${version}`);
      details++;
    } catch (e) {
      errors++;
      log(`  ✗ ${version}: ${(e as Error).message}`);
      await db.update(platformBuilds).set({ detailsStatus: "error", fetchedAt: new Date() }).where(sql`version = ${version}`);
    }
    opts.onProgress?.(i + 1, todo.length);
    if ((i + 1) % 50 === 0) log(`Страницы сборок: ${i + 1} / ${todo.length}`);
    await delay(DELAY_MS);
  }
  if (todo.length) log(`Страницы сборок: загружено ${details}${errors ? `, ошибок ${errors}` : ""}`);
  return { builds, added, details, errors };
}
