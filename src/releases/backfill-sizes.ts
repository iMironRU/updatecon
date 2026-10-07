/**
 * backfill-sizes.ts — read the update file size of versions that have none.
 *
 * The nightly import reads sizes only for the 3 newest versions per project and
 * the all-versions file backfill skips them (two requests per version: the file
 * list page for the properties id, then the properties JSON). This fills the
 * rest, newest versions first — chains are built over recent versions — within
 * a time budget. Run by the snapshot workflow («sizes_all»):
 *
 *   node dist/releases/backfill-sizes.js [--minutes 300] [--pause 250]
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { ReleasesSession } from "./fetch-releases.js";
import { parseFileProperties, parseVersionFiles } from "./parse-releases.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const minutes = arg("--minutes", 300);
  const pauseMs = arg("--pause", 250);
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  // Versions whose file list holds an update distribution but no size yet.
  const items = ((await db.execute(sql`
    SELECT vm.id, vm.version, vm.files_nick AS nick
    FROM version_meta vm
    WHERE vm.file_size_bytes IS NULL AND vm.files_nick IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(vm.files) f WHERE f->>'t' ILIKE '%Дистрибутив%')
      AND (vm.size_checked_at IS NULL OR vm.size_checked_at < now() - interval '90 days')
    ORDER BY vm.release_date DESC NULLS LAST, vm.id DESC`)) as any).rows as { id: number; version: string; nick: string }[];
  console.log(`[sizes] версий без размера: ${items.length}; бюджет ${minutes} мин, пауза ${pauseMs} мс`);
  if (!items.length) return;

  const session = new ReleasesSession();
  await session.login();
  let read = 0, empty = 0, failed = 0;
  for (const it of items) {
    if (Date.now() > deadline) { console.log("[sizes] бюджет времени вышел — остальное дочитает следующий запуск"); break; }
    try {
      const html = await session.get(`/version_files?nick=${encodeURIComponent(it.nick)}&ver=${encodeURIComponent(it.version)}`);
      const files = parseVersionFiles(html);
      const upd = files.find((f) => f.title.includes("Дистрибутив обновления") && !f.title.includes("базовой")) ?? files.find((f) => f.title.includes("Дистрибутив"));
      let size: number | null = null;
      if (upd?.propertiesId) {
        await delay(pauseMs);
        size = parseFileProperties(await session.get(`/files/properties/version-files/${upd.propertiesId}`));
      }
      await db.execute(sql`UPDATE version_meta SET file_size_bytes = ${size}, size_checked_at = now() WHERE id = ${it.id}`);
      if (size != null) read++; else empty++;
      if ((read + empty) % 200 === 0) console.log(`[sizes] ${read + empty}/${items.length}: размеров ${read}, без размера ${empty}, ошибок ${failed}, ~${Math.round((Date.now() - started) / (read + empty))} мс на версию`);
      await delay(pauseMs);
    } catch {
      failed++;
    }
  }
  console.log(`[sizes] прочитано ${read} за ${Math.round((Date.now() - started) / 60_000)} мин, без размера на портале ${empty}, не открылось ${failed}; осталось ${items.length - read - empty}`);
}

main()
  .catch((e) => { console.error("[sizes] ошибка:", e); process.exitCode = 1; })
  .finally(() => pool.end());
