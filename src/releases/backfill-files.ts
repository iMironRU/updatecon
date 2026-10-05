/**
 * backfill-files.ts — read the file list of every version at once.
 *
 * The nightly import reads 3 versions per project (newest first); this reads
 * all the rest, project by project, one page at a time with a pause. Update
 * file sizes are skipped (half the requests); the nightly import keeps
 * reading them for new versions. Run by the snapshot workflow («files_all»):
 *
 *   node dist/releases/backfill-files.js [--minutes 300] [--pause 250]
 *
 * --minutes is a time budget: what is left is read by the next run.
 */

import { isNotNull, sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { releaseProjects } from "../db/schema.js";
import { ReleasesSession } from "./fetch-releases.js";
import { parseProjectPage } from "./parse-releases.js";
import { syncVersionFilesForConfig } from "./import-releases.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function main() {
  const minutes = arg("--minutes", 300);
  const pauseMs = arg("--pause", 250);
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  const remaining = async () => Number(((await db.execute(sql`
    SELECT count(*)::int AS n FROM version_meta vm
    WHERE vm.files_fetched_at IS NULL
      AND EXISTS (SELECT 1 FROM release_projects rp WHERE rp.config_id = vm.config_id)`)) as any).rows[0].n);

  const before = await remaining();
  console.log(`[files] не прочитано версий: ${before}; бюджет ${minutes} мин, пауза ${pauseMs} мс`);
  if (before === 0) return;

  const session = new ReleasesSession();
  await session.login();
  const projects = await db.select({ nick: releaseProjects.nick, href: releaseProjects.href, configId: releaseProjects.configId })
    .from(releaseProjects).where(isNotNull(releaseProjects.configId)).orderBy(releaseProjects.nick);

  let read = 0;
  const stats = { failed: 0 };
  for (let i = 0; i < projects.length; i++) {
    if (Date.now() > deadline) { console.log("[files] бюджет времени вышел — остальное дочитает следующий запуск"); break; }
    const p = projects[i];
    let versions: string[];
    try {
      versions = parseProjectPage(await session.get(`${p.href}?allUpdates=true`)).map((r) => r.version);
    } catch (e) {
      console.log(`[files] [${i + 1}/${projects.length}] ${p.nick}: страница проекта не открылась (${(e as Error).message})`);
      continue;
    }
    const failedBefore = stats.failed;
    const n = await syncVersionFilesForConfig(session, p.configId!, p.nick, versions, 100_000, { withSize: false, deadline, pauseMs, stats });
    read += n;
    const failed = stats.failed - failedBefore;
    if (n > 0 || failed > 0) {
      const perVersion = read ? Math.round((Date.now() - started) / read) : 0;
      console.log(`[files] [${i + 1}/${projects.length}] ${p.nick}: ${n}${failed ? `, не открылось ${failed}` : ""} (всего ${read}, ~${perVersion} мс на версию)`);
    }
  }
  const after = await remaining();
  console.log(`[files] прочитано ${read} за ${Math.round((Date.now() - started) / 60_000)} мин, не открылось ${stats.failed}; не прочитано осталось ${after}`);
}

main()
  .catch((e) => { console.error("[files] ошибка:", e); process.exitCode = 1; })
  .finally(() => pool.end());
