/**
 * events.ts — the release journal (release_events): what the news feed shows and
 * push notifications send.
 *
 * recordEvents() materialises new facts from the data tables after an import:
 * releases of the last `horizonDays` (with the attributes decided then: the
 * product's first release, a raised minimum platform, an update to an older
 * branch — the ДП line), patches, platform builds, the move to 8.5, ended
 * long-term support. A fact is written once (unique type+key) and never
 * recomputed, so the feed does not change under the reader and a subscriber is
 * told exactly once. The first run fills the last half-year.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";

export interface RecordResult { release: number; patch: number; platform_build: number; to85: number; lts_end: number; total: number }

const n = (r: unknown) => Number(((r as any).rows ?? r)[0]?.n ?? 0);

export async function recordEvents(opts: { horizonDays?: number; onLog?: (m: string) => void } = {}): Promise<RecordResult> {
  const h = opts.horizonDays ?? 180;
  const log = opts.onLog ?? ((m: string) => console.log(`[events] ${m}`));
  const res: RecordResult = { release: 0, patch: 0, platform_build: 0, to85: 0, lts_end: 0, total: 0 };

  // Releases: attributes from the version's place among its configuration's versions.
  res.release = n(await db.execute(sql`
    WITH ins AS (
      INSERT INTO release_events (type, key, config_id, version, date, data)
      SELECT 'release', v.config_id || ':' || v.version, v.config_id, v.version, v.release_date,
        jsonb_strip_nulls(jsonb_build_object(
          'platform', v.min_platform,
          'first', CASE WHEN v.n = 1 THEN true END,
          'raised_from', CASE WHEN plat_min(v.min_platform) > plat_min(v.prev_platform) THEN v.prev_platform END,
          'branch', CASE WHEN EXISTS (
              SELECT 1 FROM version_meta v2 WHERE v2.config_id = v.config_id AND v2.release_date IS NOT NULL
                AND v2.version ~ '^[0-9]+(\\.[0-9]+)*$'
                AND string_to_array(v2.version, '.')::bigint[] > string_to_array(v.version, '.')::bigint[]
                AND v2.release_date <= v.release_date) THEN true END))
      FROM (
        SELECT config_id, version, release_date, min_platform,
               lag(min_platform) OVER w AS prev_platform, row_number() OVER w AS n
        FROM version_meta
        WHERE release_date IS NOT NULL AND version ~ '^[0-9]+(\\.[0-9]+)*$'
        WINDOW w AS (PARTITION BY config_id ORDER BY release_date, string_to_array(version, '.')::bigint[])
      ) v
      WHERE v.release_date >= current_date - ${h}::int
      ON CONFLICT (type, key) DO NOTHING
      RETURNING 1)
    SELECT count(*)::int AS n FROM ins`));

  res.patch = n(await db.execute(sql`
    WITH ins AS (
      INSERT INTO release_events (type, key, config_id, version, date, data)
      SELECT 'patch', p.config_id || ':' || p.version || ':' || p.uuid, p.config_id, p.version, p.patch_date,
        jsonb_strip_nulls(jsonb_build_object('uuid', p.uuid, 'title', p.title, 'description', left(p.description, 300)))
      FROM patches p WHERE p.patch_date IS NOT NULL AND p.patch_date >= current_date - ${h}::int
      ON CONFLICT (type, key) DO NOTHING
      RETURNING 1)
    SELECT count(*)::int AS n FROM ins`));

  res.platform_build = n(await db.execute(sql`
    WITH ins AS (
      INSERT INTO release_events (type, key, config_id, version, date, data)
      SELECT 'platform_build', version, NULL, version, release_date, jsonb_strip_nulls(jsonb_build_object('line', line, 'os', to_jsonb(os)))
      FROM platform_builds WHERE release_date IS NOT NULL AND release_date >= current_date - ${h}::int AND nick IN ('Platform83', 'Platform85')
      ON CONFLICT (type, key) DO NOTHING
      RETURNING 1)
    SELECT count(*)::int AS n FROM ins`));

  res.to85 = n(await db.execute(sql`
    WITH ins AS (
      INSERT INTO release_events (type, key, config_id, version, date, data)
      SELECT 'to85', config_id::text, config_id, version, release_date, jsonb_build_object('platform', min_platform)
      FROM (SELECT DISTINCT ON (config_id) config_id, version, release_date, min_platform
            FROM version_meta WHERE min_platform ~ '(^|[^0-9.])8\\.5\\.' AND release_date IS NOT NULL
            ORDER BY config_id, release_date, version) f
      WHERE release_date >= current_date - ${h}::int
      ON CONFLICT (type, key) DO NOTHING
      RETURNING 1)
    SELECT count(*)::int AS n FROM ins`));

  res.lts_end = n(await db.execute(sql`
    WITH ins AS (
      INSERT INTO release_events (type, key, config_id, version, date, data)
      SELECT 'lts_end', config_id || ':' || array_to_string((string_to_array(lts_version, '.'))[1:3], '.'), config_id, lts_version, lts_until,
        jsonb_build_object('lts_line', array_to_string((string_to_array(lts_version, '.'))[1:3], '.'))
      FROM release_projects
      WHERE config_id IS NOT NULL AND lts_version IS NOT NULL AND lts_until BETWEEN current_date - ${h}::int AND current_date
      ON CONFLICT (type, key) DO NOTHING
      RETURNING 1)
    SELECT count(*)::int AS n FROM ins`));

  res.total = res.release + res.patch + res.platform_build + res.to85 + res.lts_end;
  log(`новых событий ${res.total}: релизов ${res.release}, патчей ${res.patch}, сборок платформы ${res.platform_build}, переходов на 8.5 ${res.to85}, окончаний ДП ${res.lts_end}`);
  return res;
}

/** Events of the last `days` days, newest first (patches grouped per configuration version and day). */
export interface JournalEvent {
  id: number; type: string; date: string; config_id?: number; version?: string;
  platform?: string | null; raised_from?: string; first?: boolean; branch?: boolean;
  build?: string; line?: string; os?: string[] | null; lts_line?: string;
  count?: number; titles?: string[];
}
export async function journal(days: number): Promise<JournalEvent[]> {
  const rows = ((await db.execute(sql`
    SELECT id, type, config_id, version, date::text AS date, data FROM release_events
    WHERE date >= current_date - ${days}::int ORDER BY date DESC, id DESC`)) as any).rows as
    { id: number; type: string; config_id: number | null; version: string | null; date: string; data: Record<string, any> }[];
  const out: JournalEvent[] = [];
  const patchGroups = new Map<string, JournalEvent>();
  for (const r of rows) {
    const d = r.data ?? {};
    if (r.type === "patch") {
      const k = `${r.config_id}:${r.version}:${r.date}`;
      let g = patchGroups.get(k);
      if (!g) { g = { id: Number(r.id), type: "patch", date: r.date, config_id: Number(r.config_id), version: r.version!, count: 0, titles: [] }; patchGroups.set(k, g); out.push(g); }
      g.count!++;
      if (g.titles!.length < 5 && d.description) g.titles!.push(String(d.description).split("\n")[0].slice(0, 120));
      continue;
    }
    const e: JournalEvent = { id: Number(r.id), type: r.type, date: r.date };
    if (r.config_id != null) e.config_id = Number(r.config_id);
    if (r.version) e.version = r.version;
    if (r.type === "release") { e.platform = d.platform ?? null; if (d.raised_from) e.raised_from = d.raised_from; if (d.first) e.first = true; if (d.branch) e.branch = true; }
    if (r.type === "platform_build") { e.build = r.version!; e.line = d.line; e.os = d.os ?? null; }
    if (r.type === "to85") e.platform = d.platform;
    if (r.type === "lts_end") e.lts_line = d.lts_line;
    out.push(e);
  }
  return out;
}

export async function eventsCount(): Promise<number> {
  return n(await db.execute(sql`SELECT count(*)::int AS n FROM release_events`));
}
