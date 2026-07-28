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
  boolean,
  bigint,
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
    isHidden: boolean("is_hidden").notNull().default(false),
    excludeFromUpdates: boolean("exclude_from_updates").notNull().default(false),
    displayNameOverride: text("display_name_override"),
    vendorOverride: text("vendor_override"),
    groupNameOverride: text("group_name_override"),
    regionOverride: text("region_override"),
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
 * `edition` preserves the first target-version segment for source analysis.
 * It is not a path restriction: explicit LST/project transitions are the
 * authority, including supported transitions whose first segments differ.
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
    // The edition-leading indexes remain useful for imports and diagnostics.
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
    // Public release-number lookup scans across every configuration, so the
    // config-leading indexes above cannot serve it efficiently.
    fromVersionIdx: index("update_edges_from_version_idx").on(t.fromVersion),
    toVersionIdx: index("update_edges_to_version_idx").on(t.toVersion),
  }),
);

/**
 * One server-side ITS account. Passwords are encrypted with AES-256-GCM;
 * the encryption key is supplied through ITS_CREDENTIALS_KEY and never
 * stored in PostgreSQL.
 */
export const itsAccounts = pgTable(
  "its_accounts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    label: text("label").notNull(),
    login: text("login").notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    requestConcurrency: integer("request_concurrency").notNull().default(4),
    lastStatus: text("last_status").notNull().default("never"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    loginUq: uniqueIndex("its_accounts_login_uq").on(t.login),
    enabledPriorityIdx: index("its_accounts_enabled_priority_idx").on(
      t.enabled,
      t.priority,
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
    accountId: integer("account_id").references(() => itsAccounts.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull().default("lst"),
    fileSha256: text("file_sha256").notNull(),
    fileBytes: bigint("file_bytes", { mode: "number" }).notNull().default(0),
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
 * Every row visible on releases.1c.ru/total, including grey rows without a
 * /project link. A project may be mapped to the LST configuration whose graph
 * powers the calculator. Until one of the configured accounts exposes the
 * project link, href remains null and identityKey keeps the row stable.
 */
export const releaseProjects = pgTable(
  "release_projects",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    identityKey: text("identity_key").notNull(),
    href: text("href"),
    displayName: text("display_name").notNull(),
    groupName: text("group_name").notNull().default(""),
    region: text("region"),
    latestVersion: text("latest_version"),
    latestDate: date("latest_date"),
    nextReleaseVersion: text("next_release_version"),
    nextReleasePlannedDate: text("next_release_planned_date"),
    nextReleasePlanUpdated: date("next_release_plan_updated"),
    previewVersion: text("preview_version"),
    previewDate: date("preview_date"),
    // Signature of /total fields at the moment the project page was checked.
    // If it remains unchanged, the expensive ?allUpdates=true page can be
    // skipped until the periodic verification interval expires.
    projectCatalogSignature: text("project_catalog_signature"),
    projectPageHash: text("project_page_hash"),
    projectPageCheckedAt: timestamp("project_page_checked_at", { withTimezone: true }),
    configId: integer("config_id").references(() => configurations.id, {
      onDelete: "set null",
    }),
    mappingMode: text("mapping_mode").notNull().default("unmatched"),
    mappingConfidence: integer("mapping_confidence").notNull().default(0),
    // discovered | ready. Rows found on /total stay in the admin catalog, but
    // become standalone public catalog cards only after their version page was
    // parsed and the versions were stored successfully.
    catalogState: text("catalog_state").notNull().default("discovered"),
    // unknown | explicit | unrestricted. The latter means the project page
    // leaves every "Обновление версии" cell empty and permits any older base.
    transitionMode: text("transition_mode").notNull().default("unknown"),
    isHidden: boolean("is_hidden").notNull().default(false),
    excludeFromUpdates: boolean("exclude_from_updates").notNull().default(false),
    // Higher values are processed first by the background release scheduler.
    updatePriority: integer("update_priority").notNull().default(0),
    displayNameOverride: text("display_name_override"),
    groupNameOverride: text("group_name_override"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    identityUq: uniqueIndex("release_projects_identity_uq").on(t.identityKey),
    hrefUq: uniqueIndex("release_projects_href_uq").on(t.href),
    configIdx: index("release_projects_config_idx").on(t.configId),
    catalogStateIdx: index("release_projects_catalog_state_idx").on(t.catalogState),
    groupIdx: index("release_projects_group_idx").on(t.groupName),
    pageCheckIdx: index("release_projects_page_check_idx").on(
      t.excludeFromUpdates,
      t.projectPageCheckedAt,
    ),
  }),
);

/** Per-account view of a row from /total. */
export const accountProjectAccess = pgTable(
  "account_project_access",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => itsAccounts.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => releaseProjects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("unavailable"),
    href: text("href"),
    lastError: text("last_error").notNull().default(""),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountProjectUq: uniqueIndex("account_project_access_uq").on(
      t.accountId,
      t.projectId,
    ),
    accountStatusIdx: index("account_project_access_status_idx").on(
      t.accountId,
      t.status,
    ),
    projectStatusIdx: index("account_project_access_project_status_idx").on(
      t.projectId,
      t.status,
      t.accountId,
    ),
  }),
);

/** Full project version history fetched by any account that has access. */
export const releaseProjectVersions = pgTable(
  "release_project_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => releaseProjects.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    releaseDate: date("release_date"),
    minPlatform: text("min_platform"),
    recommendedPlatform: text("recommended_platform"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    downloadHref: text("download_href"),
    isTest: boolean("is_test").notNull().default(false),
    isHidden: boolean("is_hidden").notNull().default(false),
    releaseDateOverride: date("release_date_override"),
    minPlatformOverride: text("min_platform_override"),
    recommendedPlatformOverride: text("recommended_platform_override"),
    fileSizeBytesOverride: bigint("file_size_bytes_override", { mode: "number" }),
    resourcesSyncedAt: timestamp("resources_synced_at", { withTimezone: true }),
    resourcesLastAttemptAt: timestamp("resources_last_attempt_at", { withTimezone: true }),
    resourcesNextAttemptAt: timestamp("resources_next_attempt_at", { withTimezone: true }),
    resourcesSyncStatus: text("resources_sync_status").notNull().default("pending"),
    resourcesSyncAttempts: integer("resources_sync_attempts").notNull().default(0),
    resourcesLastError: text("resources_last_error").notNull().default(""),
    patchesSyncedAt: timestamp("patches_synced_at", { withTimezone: true }),
    sourceAccountId: integer("source_account_id").references(
      () => itsAccounts.id,
      { onDelete: "set null" },
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectVersionUq: uniqueIndex("release_project_versions_uq").on(
      t.projectId,
      t.version,
    ),
    projectIdx: index("release_project_versions_project_idx").on(t.projectId),
    versionIdx: index("release_project_versions_version_idx").on(t.version),
    syncQueueIdx: index("release_project_versions_sync_queue_idx").on(
      t.resourcesSyncStatus,
      t.resourcesNextAttemptAt,
    ),
    visibleLatestIdx: index("release_project_versions_visible_latest_idx").on(
      t.projectId,
      t.isHidden,
      t.isTest,
      t.releaseDate,
    ),
  }),
);

/** Allowed updates declared in the "Обновление версии" column on a project page. */
export const releaseVersionTransitions = pgTable(
  "release_version_transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectVersionId: integer("project_version_id")
      .notNull()
      .references(() => releaseProjectVersions.id, { onDelete: "cascade" }),
    fromVersion: text("from_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    transitionUq: uniqueIndex("release_version_transitions_uq").on(
      t.projectVersionId,
      t.fromVersion,
    ),
    fromIdx: index("release_version_transitions_from_idx").on(t.fromVersion),
  }),
);

/**
 * Every link shown on a version_files page. `kind` and `category` power the
 * UI, while the original title is always preserved for uncommon 1C files.
 */
export const releaseVersionResources = pgTable(
  "release_version_resources",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectVersionId: integer("project_version_id")
      .notNull()
      .references(() => releaseProjectVersions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("other"),
    category: text("category").notNull().default("additional"),
    title: text("title").notNull(),
    href: text("href").notNull(),
    propertiesId: text("properties_id"),
    fileName: text("file_name"),
    fileExtension: text("file_extension"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    publishedAt: date("published_at"),
    sha512: text("sha512"),
    isFile: boolean("is_file").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    isHidden: boolean("is_hidden").notNull().default(false),
    titleOverride: text("title_override"),
    hrefOverride: text("href_override"),
    fileSizeBytesOverride: bigint("file_size_bytes_override", { mode: "number" }),
    publishedAtOverride: date("published_at_override"),
    sha512Override: text("sha512_override"),
    metadataCheckedAt: timestamp("metadata_checked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    resourceUq: uniqueIndex("release_version_resources_uq").on(
      t.projectVersionId,
      t.href,
    ),
    versionIdx: index("release_version_resources_version_idx").on(t.projectVersionId),
  }),
);

/**
 * Public feed of changes detected while refreshing releases.1c.ru or managed
 * manually by an administrator.
 * `dedupeKey` makes retries and overlapping ITS accounts idempotent.
 */
export const releaseChangeEvents = pgTable(
  "release_change_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    eventType: text("event_type").notNull(),
    projectId: integer("project_id")
      .notNull()
      .references(() => releaseProjects.id, { onDelete: "cascade" }),
    projectVersionId: integer("project_version_id").references(
      () => releaseProjectVersions.id,
      { onDelete: "cascade" },
    ),
    configId: integer("config_id").references(() => configurations.id, {
      onDelete: "set null",
    }),
    version: text("version"),
    isTest: boolean("is_test").notNull().default(false),
    details: jsonb("details").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    dedupeUq: uniqueIndex("release_change_events_dedupe_uq").on(t.dedupeKey),
    occurredIdx: index("release_change_events_occurred_idx").on(t.occurredAt, t.id),
    projectIdx: index("release_change_events_project_idx").on(t.projectId, t.id),
    typeIdx: index("release_change_events_type_idx").on(t.eventType, t.id),
  }),
);

/**
 * Precomputed public catalog. The expensive graph/release aggregation is
 * rebuilt once after a data mutation; public requests only scan this compact
 * table and can therefore be cached by catalog revision.
 */
export const catalogSummary = pgTable(
  "catalog_summary",
  {
    catalogKey: text("catalog_key").primaryKey(),
    configId: integer("config_id"),
    projectId: integer("project_id"),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    vendor: text("vendor").notNull().default(""),
    releasesHref: text("releases_href"),
    groupName: text("group_name").notNull().default(""),
    region: text("region"),
    nextReleaseVersion: text("next_release_version"),
    nextReleasePlannedDate: text("next_release_planned_date"),
    nextReleasePlanUpdated: date("next_release_plan_updated"),
    latestVersion: text("latest_version"),
    latestDate: date("latest_date"),
    latestPlatform: text("latest_platform"),
    latestRecommendedPlatform: text("latest_recommended_platform"),
    versionCount: integer("version_count").notNull().default(0),
    lstOnlyVersionCount: integer("lst_only_version_count").notNull().default(0),
    sharedVersionCount: integer("shared_version_count").notNull().default(0),
    releasesOnlyVersionCount: integer("releases_only_version_count").notNull().default(0),
    avgDays: integer("avg_days"),
    hasGraph: boolean("has_graph").notNull().default(false),
    mappingStatus: text("mapping_status").notNull().default("unmatched"),
    transitionMode: text("transition_mode").notNull().default("unknown"),
    availableAccounts: integer("available_accounts").notNull().default(0),
    availableAccountLabels: jsonb("available_account_labels").notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    configIdx: index("catalog_summary_config_idx").on(t.configId),
    projectIdx: index("catalog_summary_project_idx").on(t.projectId),
    latestDateIdx: index("catalog_summary_latest_date_idx").on(t.latestDate),
    groupIdx: index("catalog_summary_group_idx").on(t.groupName),
    regionIdx: index("catalog_summary_region_idx").on(t.region),
  }),
);

/** One user-visible full refresh (online LST followed by releases.1c.ru). */
export const updateJobs = pgTable(
  "update_jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    origin: text("origin").notNull().default("manual"),
    status: text("status").notNull().default("running"),
    stage: text("stage").notNull().default("starting"),
    message: text("message").notNull().default(""),
    requestPayload: jsonb("request_payload").notNull().default({}),
    resumeCount: integer("resume_count").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    progressCurrent: integer("progress_current").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    progressLabel: text("progress_label").notNull().default(""),
    pagesCurrent: integer("pages_current").notNull().default(0),
    pagesTotal: integer("pages_total").notNull().default(0),
    activeWorkers: integer("active_workers").notNull().default(0),
    maxWorkers: integer("max_workers").notNull().default(1),
    requestsCompleted: integer("requests_completed").notNull().default(0),
    requestRetries: integer("request_retries").notNull().default(0),
    queuePending: integer("queue_pending").notNull().default(0),
    queueRetry: integer("queue_retry").notNull().default(0),
    estimatedFinishAt: timestamp("estimated_finish_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    statusStartedIdx: index("update_jobs_status_started_idx").on(t.status, t.startedAt),
  }),
);

/** Persistent, ordered log lines for an update job. */
export const updateJobEvents = pgTable(
  "update_job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => updateJobs.id, { onDelete: "cascade" }),
    stage: text("stage").notNull().default("system"),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    jobEventIdx: index("update_job_events_job_idx").on(t.jobId, t.id),
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
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
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
    configId: integer("config_id").references(() => configurations.id, {
      onDelete: "set null",
    }),
    projectVersionId: integer("project_version_id").references(
      () => releaseProjectVersions.id,
      { onDelete: "cascade" },
    ),
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
    projectVersionIdx: index("patches_project_version_idx").on(t.projectVersionId),
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

export type Configuration = typeof configurations.$inferSelect;
export type UpdateEdge = typeof updateEdges.$inferSelect;
export type ItsAccount = typeof itsAccounts.$inferSelect;
export type ImportRun = typeof importRuns.$inferSelect;
export type ReleaseProject = typeof releaseProjects.$inferSelect;
export type AccountProjectAccess = typeof accountProjectAccess.$inferSelect;
export type ReleaseProjectVersion = typeof releaseProjectVersions.$inferSelect;
export type ReleaseVersionTransition = typeof releaseVersionTransitions.$inferSelect;
export type ReleaseVersionResource = typeof releaseVersionResources.$inferSelect;
export type ReleaseChangeEvent = typeof releaseChangeEvents.$inferSelect;
export type UpdateJob = typeof updateJobs.$inferSelect;
export type UpdateJobEvent = typeof updateJobEvents.$inferSelect;
export type VersionMeta = typeof versionMeta.$inferSelect;
export type Patch = typeof patches.$inferSelect;
export type Setting = typeof settings.$inferSelect;
