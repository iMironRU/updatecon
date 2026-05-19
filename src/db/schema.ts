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
} from "drizzle-orm/pg-core";

/**
 * A configuration template (Справочник.ШаблоныКонфигурации).
 * Identified by its human name; vendor kept for display/disambiguation.
 */
export const configurations = pgTable(
  "configurations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    vendor: text("vendor").notNull().default(""),
    // Populated by releases.1c.ru adapter (secondary source):
    displayName: text("display_name"),           // "Бухгалтерия предприятия, редакция 3.0"
    releasesHref: text("releases_href"),          // "/project/Accounting30"
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nameUq: uniqueIndex("configurations_name_uq").on(t.name),
    releasesHrefUq: uniqueIndex("configurations_releases_href_uq").on(t.releasesHref),
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

export type Configuration = typeof configurations.$inferSelect;
export type UpdateEdge = typeof updateEdges.$inferSelect;
export type ImportRun = typeof importRuns.$inferSelect;
export type VersionMeta = typeof versionMeta.$inferSelect;
