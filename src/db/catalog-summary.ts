import { sql } from "drizzle-orm";
import { db, rows } from "./client.js";
import { catalogSummary, settings } from "./schema.js";

let refreshPromise: Promise<void> | null = null;

/** Rebuild the compact public catalog atomically for all readers. */
function refreshCatalogSummary(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = db.transaction(async (tx) => {
    // Serialize rebuilds initiated by the web and worker processes.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(71824017)`);
    await tx.delete(catalogSummary);
    await tx.execute(sql`
      INSERT INTO catalog_summary (
        catalog_key, config_id, project_id, name, display_name, vendor,
        releases_href, group_name, region, next_release_version,
        next_release_planned_date, next_release_plan_updated, latest_version,
        latest_date, latest_platform, latest_recommended_platform,
        version_count, lst_only_version_count, shared_version_count,
        releases_only_version_count, avg_days, has_graph, mapping_status, transition_mode,
        available_accounts, available_account_labels, updated_at
      )
      WITH graph_versions AS (
        SELECT config_id, from_version AS version FROM update_edges
        UNION
        SELECT config_id, to_version AS version FROM update_edges
      ),
      graph_stats AS (
        SELECT config_id, count(*)::int AS version_count
        FROM graph_versions
        GROUP BY config_id
      ),
      graph_latest AS (
        SELECT DISTINCT ON (config_id) config_id, version
        FROM graph_versions
        ORDER BY config_id,
          coalesce(nullif(substring(split_part(version, '.', 1) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(version, '.', 2) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(version, '.', 3) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(version, '.', 4) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(version from '[+]([0-9]+)'), '')::int, 0) DESC,
          version DESC
      ),
      mapped_projects AS (
        SELECT DISTINCT ON (config_id)
          id, config_id, coalesce(display_name_override, display_name) AS display_name,
          href, coalesce(group_name_override, group_name) AS group_name, region,
          latest_version, latest_date, next_release_version,
          next_release_planned_date, next_release_plan_updated,
          mapping_mode, mapping_confidence, transition_mode
        FROM release_projects
        WHERE config_id IS NOT NULL AND is_hidden = false
        ORDER BY config_id,
          CASE WHEN mapping_mode = 'manual' THEN 0 ELSE 1 END,
          mapping_confidence DESC, last_seen_at DESC
      ),
      release_counts AS (
        SELECT project_id,
          count(*) FILTER (WHERE is_hidden = false)::int AS visible_count,
          count(*)::int AS all_count
        FROM release_project_versions
        GROUP BY project_id
      ),
      project_branches AS (
        SELECT DISTINCT rp.id AS project_id, rp.config_id,
          split_part(rpv.version, '.', 1) AS branch
        FROM release_projects rp
        JOIN release_project_versions rpv ON rpv.project_id = rp.id
        WHERE rp.config_id IS NOT NULL AND rp.is_hidden = false
          AND rpv.is_hidden = false
        UNION
        SELECT rp.id, rp.config_id, split_part(rp.latest_version, '.', 1)
        FROM release_projects rp
        WHERE rp.config_id IS NOT NULL AND rp.is_hidden = false
          AND rp.latest_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM release_project_versions rpv
            WHERE rpv.project_id = rp.id AND rpv.is_hidden = false
          )
      ),
      project_version_origins AS (
        SELECT rpv.project_id, rpv.version, false AS from_lst, true AS from_releases
        FROM release_project_versions rpv
        JOIN release_projects rp ON rp.id = rpv.project_id
        WHERE rp.config_id IS NOT NULL AND rp.is_hidden = false
          AND rpv.is_hidden = false
        UNION ALL
        SELECT rp.id, rp.latest_version, false, true
        FROM release_projects rp
        WHERE rp.config_id IS NOT NULL AND rp.is_hidden = false
          AND rp.latest_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM release_project_versions rpv
            WHERE rpv.project_id = rp.id AND rpv.is_hidden = false
          )
        UNION ALL
        SELECT pb.project_id, gv.version, true, false
        FROM project_branches pb
        JOIN graph_versions gv ON gv.config_id = pb.config_id
          AND split_part(gv.version, '.', 1) = pb.branch
        WHERE NOT EXISTS (
          SELECT 1 FROM release_project_versions hidden_version
          WHERE hidden_version.project_id = pb.project_id
            AND hidden_version.version = gv.version
            AND hidden_version.is_hidden = true
        )
      ),
      project_versions AS (
        SELECT project_id, version,
          bool_or(from_lst) AS from_lst,
          bool_or(from_releases) AS from_releases
        FROM project_version_origins
        GROUP BY project_id, version
      ),
      project_version_counts AS (
        SELECT project_id,
          count(*)::int AS version_count,
          count(*) FILTER (WHERE from_lst AND NOT from_releases)::int AS lst_only_version_count,
          count(*) FILTER (WHERE from_lst AND from_releases)::int AS shared_version_count,
          count(*) FILTER (WHERE NOT from_lst AND from_releases)::int AS releases_only_version_count
        FROM project_versions
        GROUP BY project_id
      ),
      transition_counts AS (
        SELECT rpv.project_id, count(*)::int AS transition_count
        FROM release_version_transitions rvt
        JOIN release_project_versions rpv ON rpv.id = rvt.project_version_id
        GROUP BY rpv.project_id
      ),
      access_stats AS (
        SELECT apa.project_id,
          count(*) FILTER (WHERE apa.status = 'available')::int AS available_accounts,
          jsonb_agg(jsonb_build_object('id', ia.id, 'label', ia.label) ORDER BY ia.label)
            FILTER (WHERE apa.status = 'available') AS available_account_labels
        FROM account_project_access apa
        JOIN its_accounts ia ON ia.id = apa.account_id
        GROUP BY apa.project_id
      ),
      release_latest AS (
        SELECT DISTINCT ON (rpv.project_id)
          rpv.project_id, rpv.version,
          coalesce(rpv.release_date_override, rpv.release_date) AS release_date,
          coalesce(rpv.min_platform_override, rpv.min_platform) AS min_platform,
          coalesce(rpv.recommended_platform_override, rpv.recommended_platform) AS recommended_platform
        FROM release_project_versions rpv
        WHERE rpv.is_hidden = false
        ORDER BY rpv.project_id, rpv.is_test,
          coalesce(rpv.release_date_override, rpv.release_date) DESC NULLS LAST,
          coalesce(nullif(substring(split_part(rpv.version, '.', 1) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(rpv.version, '.', 2) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(rpv.version, '.', 3) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(rpv.version, '.', 4) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(rpv.version from '[+]([0-9]+)'), '')::int, 0) DESC,
          rpv.version DESC
      ),
      release_avg AS (
        SELECT project_id, round(avg(diff))::int AS avg_days
        FROM (
          SELECT project_id, effective_date
            - lag(effective_date) OVER (PARTITION BY project_id ORDER BY effective_date) AS diff
          FROM (
            SELECT project_id, coalesce(release_date_override, release_date) AS effective_date
            FROM release_project_versions
            WHERE is_hidden = false AND is_test = false
              AND coalesce(release_date_override, release_date) IS NOT NULL
          ) dated
        ) differences
        WHERE diff > 0 AND diff < 365
        GROUP BY project_id
      ),
      version_meta_latest AS (
        SELECT DISTINCT ON (config_id) config_id, version, release_date, min_platform
        FROM version_meta
        ORDER BY config_id, release_date DESC NULLS LAST,
          coalesce(nullif(substring(split_part(version, '.', 1) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(version, '.', 2) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(version, '.', 3) from '^[0-9]+'), '')::int, 0) DESC,
          coalesce(nullif(substring(split_part(version, '.', 4) from '^[0-9]+'), '')::int, 0) DESC,
          version DESC
      ),
      version_meta_avg AS (
        SELECT config_id, round(avg(diff))::int AS avg_days
        FROM (
          SELECT config_id, release_date
            - lag(release_date) OVER (PARTITION BY config_id ORDER BY release_date) AS diff
          FROM version_meta
          WHERE release_date IS NOT NULL
        ) differences
        WHERE diff > 0 AND diff < 365
        GROUP BY config_id
      ),
      graph_catalog AS (
        SELECT
          c.id::text AS catalog_key, c.id::int AS config_id, mp.id::int AS project_id,
          c.name,
          coalesce(c.display_name_override, mp.display_name, c.display_name, c.name) AS display_name,
          coalesce(c.vendor_override, c.vendor) AS vendor,
          coalesce(mp.href, c.releases_href) AS releases_href,
          coalesce(c.group_name_override, mp.group_name, c.group_name, '') AS group_name,
          coalesce(c.region_override, mp.region, c.region) AS region,
          coalesce(mp.next_release_version, c.next_release_version) AS next_release_version,
          coalesce(mp.next_release_planned_date, c.next_release_planned_date) AS next_release_planned_date,
          coalesce(mp.next_release_plan_updated, c.next_release_plan_updated) AS next_release_plan_updated,
          coalesce(mp.latest_version, vml.version, gl.version) AS latest_version,
          coalesce(mp.latest_date, vml.release_date) AS latest_date,
          coalesce(rl.min_platform, vml.min_platform) AS latest_platform,
          rl.recommended_platform AS latest_recommended_platform,
          CASE WHEN mp.id IS NOT NULL AND coalesce(pvc.version_count, 0) > 0
            THEN pvc.version_count ELSE coalesce(gs.version_count, 0)
          END::int AS version_count,
          CASE WHEN mp.id IS NOT NULL AND coalesce(pvc.version_count, 0) > 0
            THEN pvc.lst_only_version_count ELSE coalesce(gs.version_count, 0)
          END::int AS lst_only_version_count,
          CASE WHEN mp.id IS NOT NULL AND coalesce(pvc.version_count, 0) > 0
            THEN pvc.shared_version_count ELSE 0
          END::int AS shared_version_count,
          CASE WHEN mp.id IS NOT NULL AND coalesce(pvc.version_count, 0) > 0
            THEN pvc.releases_only_version_count ELSE 0
          END::int AS releases_only_version_count,
          coalesce(ra.avg_days, vma.avg_days) AS avg_days,
          (coalesce(gs.version_count, 0) > 0 OR coalesce(tc.transition_count, 0) > 0
            OR mp.transition_mode = 'unrestricted') AS has_graph,
          CASE WHEN mp.id IS NULL THEN 'lst-only' ELSE mp.mapping_mode END AS mapping_status,
          coalesce(mp.transition_mode, 'explicit') AS transition_mode,
          coalesce(ast.available_accounts, 0)::int AS available_accounts,
          coalesce(ast.available_account_labels, '[]'::jsonb) AS available_account_labels
        FROM configurations c
        LEFT JOIN mapped_projects mp ON mp.config_id = c.id
        LEFT JOIN graph_stats gs ON gs.config_id = c.id
        LEFT JOIN graph_latest gl ON gl.config_id = c.id
        LEFT JOIN version_meta_latest vml ON vml.config_id = c.id
        LEFT JOIN version_meta_avg vma ON vma.config_id = c.id
        LEFT JOIN release_counts rc ON rc.project_id = mp.id
        LEFT JOIN project_version_counts pvc ON pvc.project_id = mp.id
        LEFT JOIN transition_counts tc ON tc.project_id = mp.id
        LEFT JOIN release_latest rl ON rl.project_id = mp.id
        LEFT JOIN release_avg ra ON ra.project_id = mp.id
        LEFT JOIN access_stats ast ON ast.project_id = mp.id
        WHERE c.is_hidden = false
      ),
      release_only AS (
        SELECT
          'r:' || rp.id::text AS catalog_key, NULL::int AS config_id, rp.id::int AS project_id,
          'release:' || rp.id::text AS name,
          coalesce(rp.display_name_override, rp.display_name) AS display_name,
          '1С'::text AS vendor, rp.href AS releases_href,
          coalesce(rp.group_name_override, rp.group_name, '') AS group_name,
          rp.region, rp.next_release_version,
          rp.next_release_planned_date, rp.next_release_plan_updated,
          CASE WHEN coalesce(rc.all_count, 0) > 0 THEN rl.version ELSE rp.latest_version END AS latest_version,
          CASE WHEN coalesce(rc.all_count, 0) > 0 THEN rl.release_date ELSE rp.latest_date END AS latest_date,
          rl.min_platform AS latest_platform,
          rl.recommended_platform AS latest_recommended_platform,
          CASE WHEN coalesce(rc.all_count, 0) = 0 AND rp.latest_version IS NOT NULL
            THEN 1 ELSE coalesce(rc.visible_count, 0) END::int AS version_count,
          0::int AS lst_only_version_count,
          0::int AS shared_version_count,
          CASE WHEN coalesce(rc.all_count, 0) = 0 AND rp.latest_version IS NOT NULL
            THEN 1 ELSE coalesce(rc.visible_count, 0) END::int AS releases_only_version_count,
          ra.avg_days,
          (coalesce(tc.transition_count, 0) > 0 OR rp.transition_mode = 'unrestricted') AS has_graph,
          rp.mapping_mode AS mapping_status,
          rp.transition_mode,
          coalesce(ast.available_accounts, 0)::int AS available_accounts,
          coalesce(ast.available_account_labels, '[]'::jsonb) AS available_account_labels
        FROM release_projects rp
        LEFT JOIN release_counts rc ON rc.project_id = rp.id
        LEFT JOIN transition_counts tc ON tc.project_id = rp.id
        LEFT JOIN release_latest rl ON rl.project_id = rp.id
        LEFT JOIN release_avg ra ON ra.project_id = rp.id
        LEFT JOIN access_stats ast ON ast.project_id = rp.id
        WHERE rp.config_id IS NULL AND rp.is_hidden = false AND rp.catalog_state = 'ready'
      )
      SELECT *, now()
      FROM (
        SELECT * FROM graph_catalog
        UNION ALL
        SELECT * FROM release_only
      ) catalog
    `);
  }).then(() => undefined).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function ensureCatalogSummary(): Promise<void> {
  const result = await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM catalog_summary) AS ready,
      coalesce(sum(version_count), 0) = coalesce(sum(
        lst_only_version_count + shared_version_count + releases_only_version_count
      ), 0) AS sources_ready
    FROM catalog_summary
  `);
  const state = rows(result)[0] ?? {};
  const ready = Boolean(state.ready) && Boolean(state.sources_ready);
  if (!ready) await refreshCatalogSummary();
}

export async function getCatalogRevision(): Promise<string> {
  const result = await db.execute(sql`
    SELECT coalesce((SELECT value FROM settings WHERE key = 'catalog_revision'), 'initial') AS revision
  `);
  return String((rows(result)[0]?.revision) ?? "initial");
}

export async function refreshCatalogAndTouch(touchLstPolicy = false): Promise<string> {
  await refreshCatalogSummary();
  const now = new Date();
  const revision = now.toISOString();
  const keys = touchLstPolicy ? ["catalog_revision", "lst_policy_revision"] : ["catalog_revision"];
  for (const key of keys) {
    await db.insert(settings).values({ key, value: revision, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: revision, updatedAt: now } });
  }
  return revision;
}
