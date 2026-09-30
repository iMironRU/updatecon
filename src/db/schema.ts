/**
 * schema.ts — Drizzle ORM schema for the 1C update-chain database.
 *
 * Design recap (from project discussion):
 *  - The .lst file is the richest source: it IS the edge list of the chain
 *    graph. We store edges directly and compute paths on query.
 *  - A chain edge = "from this version you can apply a package and reach
 *    that version", scoped to a configuration.
 *  - Version = canonical 4-segment core only (compound tail already dropped
 *    in the parser; nothing compound reaches this layer).
 *  - Two-level hash delta:
 *      file level  -> import_runs.file_sha256 : identical file => skip all.
 *      edge level  -> update_edges.content_hash : upsert only changed rows.
 */

import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  bigserial,
  date,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * An application edition: one configuration template (catalog folder in
 * tmplts, e.g. "1c/Accounting") at one edition (first version segment).
 *
 * Identity is (template_key, edition), NOT the LST metadata name: the name is
 * not unique (other vendors ship products with the same metadata name, and
 * regional ports get renamed), while the template folder is what 1C itself
 * uses to tell products apart. Name/vendor are kept for display and follow
 * the latest LST record.
 */
export const configurations = pgTable(
  "configurations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    vendor: text("vendor").notNull().default(""),
    // Template folder from cfu_path, original case: "1c/Accounting".
    templateCode: text("template_code"),
    // Lower-cased template_code — matching key.
    templateKey: text("template_key"),
    // First version segment (same meaning as update_edges.edition).
    edition: integer("edition"),
    // Populated by releases.1c.ru adapter (secondary source), copied from the
    // primary release project (see release_projects):
    displayName: text("display_name"),           // "Бухгалтерия предприятия, редакция 3.0"
    releasesHref: text("releases_href"),          // "/project/Accounting30"
    // Category from releases.1c.ru /total page group name
    groupName: text("group_name"),               // "Типовые конфигурации фирмы \"1С\" для России"
    // Short region code derived from group_name: "ru" | "kz" | "az" | "by" | "am" | "ge"
    // | "kg" | "tj" | "uz" | "md" | "lt" | "lv" | "ee" | "bg" | "baltics" | "intl" | "stdlib"
    // null = not yet synced from releases.1c.ru
    region: text("region"),
    // Next planned release (from releases.1c.ru /total)
    nextReleaseVersion: text("next_release_version"), // "3.0.209"
    nextReleasePlannedDate: text("next_release_planned_date"), // "Ноябрь 2026"
    nextReleasePlanUpdated: date("next_release_plan_updated"), // "2026-04-01"
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nameIdx: index("configurations_name_idx").on(t.name),
    templateEditionUq: uniqueIndex("configurations_template_edition_uq").on(t.templateKey, t.edition),
    releasesHrefUq: uniqueIndex("configurations_releases_href_uq").on(t.releasesHref),
  }),
);

/**
 * A project on releases.1c.ru (/project/<nick>), one row per project found on
 * /total. Linked to at most one application edition; an edition may have
 * several projects. match_method: "rule" (nick = template + edition suffix),
 * "versions" (strict version-set overlap fallback), "manual" (set in admin —
 * never overwritten by the importer). config_id NULL = not matched.
 */
export const releaseProjects = pgTable(
  "release_projects",
  {
    nick: text("nick").primaryKey(),
    href: text("href").notNull(),
    displayName: text("display_name").notNull().default(""),
    groupName: text("group_name"),
    region: text("region"),
    latestVersion: text("latest_version"),
    nextReleaseVersion: text("next_release_version"),
    nextReleasePlannedDate: text("next_release_planned_date"),
    nextReleasePlanUpdated: date("next_release_plan_updated"),
    configId: integer("config_id").references(() => configurations.id, { onDelete: "set null" }),
    matchMethod: text("match_method"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    configIdx: index("release_projects_config_idx").on(t.configId),
  }),
);

/**
 * One directed edge of the chain graph for a configuration:
 *   fromVersion --(apply cfuPath)--> toVersion
 *
 * `edition` is the first version segment (mirror of СовпадаютРедакции): edges
 * are only valid within the same edition; storing it makes the path query a
 * simple filter instead of a runtime split.
 *
 * `rawJson` keeps the original record as parsed (already canonicalized, no
 * compound tail) for audit / reprocessing without re-fetching the 80MB file.
 *
 * `contentHash` is sha256 of the semantically significant fields; the import
 * upserts a row only when this changes, so a re-run over an unchanged file
 * touches zero rows after the file-level check.
 */
export const updateEdges = pgTable(
  "update_edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    configId: integer("config_id")
      .notNull()
      .references(() => configurations.id),
    fromVersion: text("from_version").notNull(),
    toVersion: text("to_version").notNull(),
    edition: integer("edition").notNull(),
    cfuPath: text("cfu_path").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    rawJson: jsonb("raw_json"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One logical edge per (config, from, to). Re-import upserts in place.
    edgeUq: uniqueIndex("update_edges_edge_uq").on(
      t.configId,
      t.fromVersion,
      t.toVersion,
    ),
    // Path search walks edges forward from a version within a config+edition.
    fromIdx: index("update_edges_from_idx").on(
      t.configId,
      t.edition,
      t.fromVersion,
    ),
    toIdx: index("update_edges_to_idx").on(
      t.configId,
      t.edition,
      t.toVersion,
    ),
  }),
);

/**
 * One import attempt. `fileSha256` powers the file-level skip: if the freshly
 * fetched .lst hashes to the same value as the last successful run, the whole
 * import is a no-op.
 */
export const importRuns = pgTable(
  "import_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: text("source").notNull().default("lst"),
    fileSha256: text("file_sha256").notNull(),
    fileBytes: integer("file_bytes").notNull().default(0),
    configsFound: integer("configs_found").notNull().default(0),
    edgesUpserted: integer("edges_upserted").notNull().default(0),
    edgesUnchanged: integer("edges_unchanged").notNull().default(0),
    status: text("status").notNull().default("ok"), // ok | skipped | error
    message: text("message").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    shaIdx: index("import_runs_sha_idx").on(t.source, t.fileSha256),
  }),
);

/**
 * Release metadata per version, populated by secondary sources.
 * Primary source (lst) does not touch this table.
 *
 * `releaseDate`  — when 1C published this version.
 * `minPlatform`  — minimum 1C:Enterprise platform version required.
 * `source`       — which adapter wrote this row (e.g. "releases").
 */
export const versionMeta = pgTable(
  "version_meta",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    configId: integer("config_id")
      .notNull()
      .references(() => configurations.id),
    version: text("version").notNull(),
    releaseDate: date("release_date"),
    minPlatform: text("min_platform"),
    // Size of the update file (.zip installer from releases.1c.ru) in bytes
    fileSizeBytes: integer("file_size_bytes"),
    source: text("source").notNull().default("releases"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionUq: uniqueIndex("version_meta_uq").on(t.configId, t.version),
    configIdx: index("version_meta_config_idx").on(t.configId),
  }),
);

/**
 * Patches (hotfixes) for a specific version, from releases.1c.ru.
 * Each patch is a small fix published between major releases.
 */
export const patches = pgTable(
  "patches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    configId: integer("config_id")
      .notNull()
      .references(() => configurations.id),
    version: text("version").notNull(),           // version this patch applies to
    uuid: text("uuid").notNull(),                  // releases.1c.ru patch UUID
    title: text("title"),                          // patch description/name
    patchDate: date("patch_date"),                 // date of fix
    downloadKey: text("download_key"),             // key for download URL
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    patchUq: uniqueIndex("patches_uuid_uq").on(t.uuid),
    configVersionIdx: index("patches_config_version_idx").on(t.configId, t.version),
  }),
);

/**
 * Generic key-value store for application settings.
 * Used for: domain name, Telegram bot token, etc.
 * Populated at runtime — never contains secrets (use .env for those).
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Product-line tags ("БУХ", "ЗУП", "УТ", …) per template — shared by all its
 * editions. kind: "own" = the 1C product line itself, "based" = a partner or
 * industry solution built on that line. source: "rule" (template name),
 * "versions" (shares its version numbers with a typical 1C template),
 * "manual" (admin UI). A template with manual rows is never recomputed;
 * a manual row with tag '' means "manually set to no tags".
 */
export const templateTags = pgTable(
  "template_tags",
  {
    templateKey: text("template_key").notNull(),
    tag: text("tag").notNull(),
    kind: text("kind").notNull().default("own"),
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.templateKey, t.tag] }),
  }),
);

/**
 * 1C:Enterprise platform generation of an update package, from its manifest
 * (tmplts/<dir>/1cv8.mft, line "AppVersion=8.3"). Keyed by the package folder
 * ("1c/Accounting/3_0_206_19") — independent of how packages are grouped into
 * applications. status: ok | denied (401/403 — partner packages the ITS
 * account can't read) | missing (404) | error. denied/error are retried.
 */
export const packageManifests = pgTable("package_manifests", {
  dir: text("dir").primaryKey(),
  appVersion: text("app_version"),
  status: text("status").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Configuration = typeof configurations.$inferSelect;
export type UpdateEdge = typeof updateEdges.$inferSelect;
export type ImportRun = typeof importRuns.$inferSelect;
export type VersionMeta = typeof versionMeta.$inferSelect;
export type Patch = typeof patches.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type ReleaseProject = typeof releaseProjects.$inferSelect;
export type TemplateTag = typeof templateTags.$inferSelect;
export type PackageManifest = typeof packageManifests.$inferSelect;
