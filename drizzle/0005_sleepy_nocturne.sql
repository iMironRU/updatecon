CREATE TABLE IF NOT EXISTS "release_projects" (
	"nick" text PRIMARY KEY NOT NULL,
	"href" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"group_name" text,
	"region" text,
	"latest_version" text,
	"next_release_version" text,
	"next_release_planned_date" text,
	"next_release_plan_updated" date,
	"config_id" integer,
	"match_method" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "configurations_name_uq";--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "template_code" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "edition" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_projects" ADD CONSTRAINT "release_projects_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_projects_config_idx" ON "release_projects" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "configurations_name_idx" ON "configurations" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "configurations_template_edition_uq" ON "configurations" USING btree ("template_key","edition");--> statement-breakpoint
-- Seed dumps (data-only) do not carry sequence positions: realign every
-- bigserial with its table before inserting anything.
SELECT setval(pg_get_serial_sequence('configurations', 'id'), greatest((SELECT max(id) FROM "configurations"), 1));
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('update_edges', 'id'), greatest((SELECT max(id) FROM "update_edges"), 1));
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('import_runs', 'id'), greatest((SELECT max(id) FROM "import_runs"), 1));
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('version_meta', 'id'), greatest((SELECT max(id) FROM "version_meta"), 1));
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('patches', 'id'), greatest((SELECT max(id) FROM "patches"), 1));
--> statement-breakpoint
-- ── Data migration: re-key configurations by (template folder, edition) ──────
-- Template = cfu_path prefix before the version folder (N_N_N_N...):
--   "1c/Accounting/3_0_197_22/1cv8.cfu" -> "1c/Accounting"
--   "KassirBase/4_0_6_1/1cv8.cfu"        -> "KassirBase"
-- Edges without a recognisable folder fall back to "~" || config name.
CREATE TABLE "_mig_edge_grp" AS
SELECT t.edge_id, t.old_cfg, t.edition, t.tcode, lower(t.tcode) AS tkey
FROM (
  SELECT e.id AS edge_id, e.config_id AS old_cfg, e.edition,
         coalesce(
           nullif(substring(replace(e.cfu_path, '\', '/') from '^(.*?)/[0-9]+(_[0-9]+){3,}(/|$)'), ''),
           '~' || c.name
         ) AS tcode
  FROM "update_edges" e
  JOIN "configurations" c ON c.id = e.config_id
) t;
--> statement-breakpoint
CREATE TABLE "_mig_grp" AS
SELECT tkey, edition,
       mode() WITHIN GROUP (ORDER BY tcode) AS tcode,
       count(*)::int AS cnt,
       NULL::bigint AS cfg_id
FROM "_mig_edge_grp"
GROUP BY tkey, edition;
--> statement-breakpoint
-- Each old configuration keeps its id for the LATEST edition of its dominant
-- template (so old links like #/config/41 keep pointing at the current
-- product, not at a legacy edition). Editions with < 5 edges are noise and
-- are only picked when nothing else exists. If several old configs claim the
-- same group, the one with the most edges in that template wins.
UPDATE "_mig_grp" g SET cfg_id = o.old_cfg
FROM (
  SELECT DISTINCT ON (tkey, edition) tkey, edition, old_cfg
  FROM (
    SELECT DISTINCT ON (old_cfg) old_cfg, tkey, edition, tcnt
    FROM (
      SELECT old_cfg, tkey, edition, count(*) AS cnt,
             sum(count(*)) OVER (PARTITION BY old_cfg, tkey) AS tcnt
      FROM "_mig_edge_grp" GROUP BY old_cfg, tkey, edition
    ) x
    ORDER BY old_cfg, tcnt DESC, (cnt >= 5) DESC, edition DESC, tkey
  ) d
  ORDER BY tkey, edition, tcnt DESC, old_cfg
) o
WHERE g.tkey = o.tkey AND g.edition = o.edition;
--> statement-breakpoint
UPDATE "configurations" c
SET template_code = g.tcode, template_key = g.tkey, edition = g.edition
FROM "_mig_grp" g
WHERE g.cfg_id = c.id;
--> statement-breakpoint
-- Groups split off from an old config become new application editions.
INSERT INTO "configurations" (name, vendor, template_code, template_key, edition)
SELECT DISTINCT ON (g.tkey, g.edition)
       coalesce(e.raw_json->>'name', oc.name),
       coalesce(e.raw_json->>'vendor', oc.vendor, ''),
       g.tcode, g.tkey, g.edition
FROM "_mig_grp" g
JOIN "_mig_edge_grp" eg ON eg.tkey = g.tkey AND eg.edition = g.edition
JOIN "update_edges" e ON e.id = eg.edge_id
JOIN "configurations" oc ON oc.id = eg.old_cfg
WHERE g.cfg_id IS NULL
ORDER BY g.tkey, g.edition, string_to_array(e.to_version, '.')::bigint[] DESC;
--> statement-breakpoint
UPDATE "_mig_grp" g SET cfg_id = c.id
FROM "configurations" c
WHERE g.cfg_id IS NULL AND c.template_key = g.tkey AND c.edition = g.edition;
--> statement-breakpoint
-- Name/vendor follow the latest LST record of the group (renames, vendor moves).
UPDATE "configurations" c SET name = l.name, vendor = l.vendor
FROM (
  SELECT DISTINCT ON (g.cfg_id) g.cfg_id,
         e.raw_json->>'name' AS name,
         coalesce(e.raw_json->>'vendor', '') AS vendor
  FROM "_mig_grp" g
  JOIN "_mig_edge_grp" eg ON eg.tkey = g.tkey AND eg.edition = g.edition
  JOIN "update_edges" e ON e.id = eg.edge_id
  WHERE e.raw_json ? 'name'
  ORDER BY g.cfg_id, string_to_array(e.to_version, '.')::bigint[] DESC
) l
WHERE c.id = l.cfg_id;
--> statement-breakpoint
DROP INDEX IF EXISTS "update_edges_edge_uq";
--> statement-breakpoint
UPDATE "update_edges" e SET config_id = g.cfg_id
FROM "_mig_edge_grp" eg
JOIN "_mig_grp" g ON g.tkey = eg.tkey AND g.edition = eg.edition
WHERE eg.edge_id = e.id AND e.config_id <> g.cfg_id;
--> statement-breakpoint
-- The same package may have been listed under several old names: keep one.
DELETE FROM "update_edges" e
USING (
  SELECT id, row_number() OVER (
    PARTITION BY config_id, from_version, to_version
    ORDER BY last_seen_at DESC, id DESC
  ) AS rn
  FROM "update_edges"
) d
WHERE d.id = e.id AND d.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "update_edges_edge_uq" ON "update_edges" USING btree ("config_id","from_version","to_version");
--> statement-breakpoint
-- Old configurations left without edges disappear (their data moved away).
DELETE FROM "version_meta" WHERE config_id IN (
  SELECT id FROM "configurations" c
  WHERE NOT EXISTS (SELECT 1 FROM "update_edges" e WHERE e.config_id = c.id)
);
--> statement-breakpoint
DELETE FROM "patches" WHERE config_id IN (
  SELECT id FROM "configurations" c
  WHERE NOT EXISTS (SELECT 1 FROM "update_edges" e WHERE e.config_id = c.id)
);
--> statement-breakpoint
DELETE FROM "configurations" c
WHERE NOT EXISTS (SELECT 1 FROM "update_edges" e WHERE e.config_id = c.id);
--> statement-breakpoint
-- Keep releases.1c.ru enrichment only where the old heuristic link agrees
-- with the new rule (nick = template name + edition suffix); drop the rest —
-- the next releases import re-links them properly.
UPDATE "configurations" SET
  display_name = NULL, releases_href = NULL, group_name = NULL, region = NULL,
  next_release_version = NULL, next_release_planned_date = NULL,
  next_release_plan_updated = NULL
WHERE releases_href IS NOT NULL AND NOT (
  left(lower(replace(releases_href, '/project/', '')),
       length(regexp_replace(template_code, '^.*/', '')))
    = lower(regexp_replace(template_code, '^.*/', ''))
  AND substr(lower(replace(releases_href, '/project/', '')),
             length(regexp_replace(template_code, '^.*/', '')) + 1)
    ~ '^(_?[0-9]{1,3}){0,3}(_?new)?$'
);
--> statement-breakpoint
DELETE FROM "version_meta" vm USING "configurations" c
WHERE vm.config_id = c.id
  AND (c.releases_href IS NULL OR split_part(vm.version, '.', 1) <> c.edition::text);
--> statement-breakpoint
DELETE FROM "patches" p USING "configurations" c
WHERE p.config_id = c.id
  AND (c.releases_href IS NULL OR split_part(p.version, '.', 1) <> c.edition::text);
--> statement-breakpoint
INSERT INTO "release_projects" (nick, href, display_name, group_name, region,
  next_release_version, next_release_planned_date, next_release_plan_updated,
  config_id, match_method)
SELECT replace(releases_href, '/project/', ''), releases_href, coalesce(display_name, ''),
       group_name, region, next_release_version, next_release_planned_date,
       next_release_plan_updated, id, 'rule'
FROM "configurations"
WHERE releases_href IS NOT NULL
ON CONFLICT (nick) DO NOTHING;
--> statement-breakpoint
DROP TABLE "_mig_grp";
--> statement-breakpoint
DROP TABLE "_mig_edge_grp";
