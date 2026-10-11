/**
 * chain-checks.ts — our chains against 1C's update service (update-api.1c.ru).
 *
 * For typical configurations (programNameFor) the service is asked about recent
 * versions that have a newer one: it names the next version and the number of
 * files in its chain. We build our chain to that version and compare the length.
 * One row per (configuration, version) in chain_checks, refreshed weekly (a month
 * for versions the service does not know). Step 6 of «Обновить всё»; the chain
 * page shows the official answer next to ours, /stats the mismatches.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { findChain } from "./chain.js";
import { programInfo, programNameFor } from "../releases/update-api.js";

export type CheckStatus = "match" | "ours_longer" | "ours_shorter" | "no_path" | "behind" | "unknown";

/** The verdict from the service's answer and our chain to its target. */
export function compareCheck(svc: { known: boolean; next: string | null; files: number | null }, ours: { found: boolean; steps: number; targetKnown: boolean }, ourNext: string | null, version: string):
  { status: CheckStatus; note: string | null } {
  if (!svc.known) return { status: "unknown", note: "сервис не знает эту программу или версию" };
  if (!svc.next) {
    // the service says «актуальна»; do we agree?
    return ourNext && ourNext !== version ? { status: "ours_longer", note: `сервис: версия актуальна, у нас есть ${ourNext}` } : { status: "match", note: "актуальна" };
  }
  // the LST lags the service by a day or two: the target is not in our data yet
  if (!ours.targetKnown) return { status: "behind", note: `версии ${svc.next} у нас ещё нет` };
  if (!ours.found) return { status: "no_path", note: `у нас нет пути до ${svc.next}` };
  const tail = ourNext && ourNext !== svc.next ? `; у нас новее: ${ourNext}` : "";
  if (svc.files == null || ours.steps === svc.files) return { status: "match", note: `${ours.steps} ${ours.steps === 1 ? "шаг" : ours.steps < 5 ? "шага" : "шагов"} до ${svc.next}${tail}` };
  if (ours.steps > svc.files) return { status: "ours_longer", note: `у нас ${ours.steps}, у сервиса ${svc.files} до ${svc.next}${tail}` };
  return { status: "ours_shorter", note: `у нас ${ours.steps}, у сервиса ${svc.files} до ${svc.next}${tail}` };
}

export interface CheckResult { asked: number; match: number; mismatch: number; behind: number; unknown: number }

export async function checkChains(opts: { limit?: number; perConfig?: number; onLog?: (m: string) => void } = {}): Promise<CheckResult> {
  const log = opts.onLog ?? ((m: string) => console.log(`[chains] ${m}`));
  const limit = opts.limit ?? 150, per = opts.perConfig ?? 3;
  // Typical 1C configurations with versions, newest first; skip rows checked recently.
  const rows = ((await db.execute(sql`
    SELECT c.id, c.name, c.template_code,
      (SELECT version FROM version_meta v WHERE v.config_id = c.id AND v.release_date IS NOT NULL AND v.version ~ '^[0-9]+(\\.[0-9]+)*$'
         ORDER BY string_to_array(v.version, '.')::bigint[] DESC LIMIT 1) AS newest,
      (SELECT array_agg(version ORDER BY release_date DESC) FROM (
         SELECT v.version, v.release_date FROM version_meta v
         WHERE v.config_id = c.id AND v.release_date IS NOT NULL AND v.version ~ '^[0-9]+(\\.[0-9]+)*$'
           AND EXISTS (SELECT 1 FROM update_edges e WHERE e.config_id = c.id AND e.from_version = v.version)
           AND NOT EXISTS (SELECT 1 FROM chain_checks k WHERE k.config_id = c.id AND k.version = v.version
                           AND k.checked_at > now() - (CASE WHEN k.status = 'unknown' THEN interval '30 days' ELSE interval '7 days' END))
         ORDER BY v.release_date DESC LIMIT ${per}) x) AS versions
    FROM configurations c
    WHERE c.template_code LIKE '1c/%' AND c.group_name IS NOT NULL
    ORDER BY c.id`)) as any).rows as { id: number; name: string; template_code: string; newest: string | null; versions: string[] | null }[];
  const res: CheckResult = { asked: 0, match: 0, mismatch: 0, behind: 0, unknown: 0 };
  for (const c of rows) {
    const program = programNameFor(c.template_code);
    if (!program || !c.versions?.length) continue;
    for (const version of c.versions) {
      if (res.asked >= limit) break;
      let info;
      try { info = await programInfo(program, version, c.name); }
      catch (e) { log(`✗ ${program} ${version}: ${(e as Error).message}`); continue; }
      res.asked++;
      if (info.error) { log(`✗ ${program} ${version}: ${info.error}`); continue; }
      const ours = info.next ? await findChain(c.id, version, info.next) : { found: false, steps: [] as unknown[] };
      const targetKnown = !info.next || Number(((await db.execute(sql`SELECT count(*)::int AS n FROM update_edges WHERE config_id = ${c.id} AND to_version = ${info.next}`)) as any).rows[0].n) > 0;
      const verdict = compareCheck(info, { found: ours.found, steps: ours.steps.length, targetKnown }, c.newest, version);
      await db.execute(sql`
        INSERT INTO chain_checks (config_id, version, program_name, checked_at, svc_next, svc_files, svc_size, svc_platform, our_next, our_steps, status, note)
        VALUES (${c.id}, ${version}, ${program}, now(), ${info.next}, ${info.files}, ${info.size}, ${info.platformMin}, ${c.newest}, ${ours.found ? ours.steps.length : null}, ${verdict.status}, ${verdict.note})
        ON CONFLICT (config_id, version) DO UPDATE SET program_name = EXCLUDED.program_name, checked_at = now(), svc_next = EXCLUDED.svc_next,
          svc_files = EXCLUDED.svc_files, svc_size = EXCLUDED.svc_size, svc_platform = EXCLUDED.svc_platform, our_next = EXCLUDED.our_next,
          our_steps = EXCLUDED.our_steps, status = EXCLUDED.status, note = EXCLUDED.note`);
      if (verdict.status === "match") res.match++;
      else if (verdict.status === "unknown") res.unknown++;
      else if (verdict.status === "behind") res.behind++;
      else { res.mismatch++; log(`≠ ${c.name} ${version}: ${verdict.note}`); }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  log(`запросов ${res.asked}: совпало ${res.match}, расхождений ${res.mismatch}, отстаём от сервиса ${res.behind}, сервис не знает ${res.unknown}`);
  return res;
}

/** For /stats and the admin: totals and the current mismatches. */
export async function chainCheckSummary() {
  const totals = ((await db.execute(sql`SELECT status, count(*)::int AS n FROM chain_checks GROUP BY status`)) as any).rows as { status: string; n: number }[];
  const mismatches = ((await db.execute(sql`
    SELECT k.config_id, coalesce(c.display_name, c.name) AS name, k.version, k.svc_next, k.svc_files, k.our_steps, k.our_next, k.status, k.note, k.checked_at::date::text AS checked
    FROM chain_checks k JOIN configurations c ON c.id = k.config_id
    WHERE k.status NOT IN ('match', 'unknown', 'behind') ORDER BY c.name, string_to_array(k.version, '.')::bigint[] DESC`)) as any).rows;
  const last = ((await db.execute(sql`SELECT max(checked_at)::date::text AS d FROM chain_checks`)) as any).rows[0]?.d ?? null;
  return { checked: last, totals: Object.fromEntries(totals.map((t) => [t.status, Number(t.n)])), mismatches };
}
