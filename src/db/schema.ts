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
import { sql } from "drizzle-orm";

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
    // "Общая информация о конфигурации" on the project page:
    // solutions.1c.ru/catalog/<slug>/features (industry/partner) or v8.1c.ru/<product>/
    infoUrl: text("info_url"),
    // "Каталог ошибок продукта" — bugboard.v8.1c.ru/project/<code>.html
    bugsUrl: text("bugs_url"),
    // Long-term support ("ДП") branch from /total: the current ДП build
    // ("11.5.27.93"; the branch is its first three segments) and its end date.
    ltsVersion: text("lts_version"),
    ltsUntil: date("lts_until"),
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
    // Full text log of a "обновить всё" run (source = 'all'); kept for the
    // latest runs only — see pipeline.ts.
    log: text("log"),
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
    sizeCheckedAt: timestamp("size_checked_at", { withTimezone: true }),   // the size backfill looked (even when the portal has none)
    // The version's files on releases.1c.ru (/version_files): [{ t: title, p: path }],
    // the project nick they were read under, and when (null = not read yet).
    // Paths differ per product (Trade\11_6_1_70\Trade_11_6_1_70_setup1c.zip), so
    // download links are built from these, never guessed.
    files: jsonb("files").$type<{ t: string; p: string }[]>(),
    filesNick: text("files_nick"),
    filesFetchedAt: timestamp("files_fetched_at", { withTimezone: true }),
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
    title: text("title"),                          // patch name on the portal (EF_00_00945951)
    description: text("description"),              // what it fixes (the portal's «Описание»)
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

/**
 * Product card from solutions.1c.ru ("1С:Решения"), one row per product page
 * that a linked releases project points to (release_projects.info_url).
 * Structured fields of the page's product_summary block; refreshed weekly.
 * status: ok | missing (404 / no product block) | error.
 */
export const solutionsInfo = pgTable("solutions_info", {
  url: text("url").primaryKey(),
  status: text("status").notNull(),
  title: text("title"),
  productKind: text("product_kind"),               // "1С-Совместно", "1С", …
  enterpriseTypes: text("enterprise_types").array(), // "Коммерческий", "Государственный"
  countries: text("countries").array(),            // "Россия" / "Для всех стран"
  developers: text("developers").array(),          // "1С", "ЦентрПрограммСистем"
  baseConfig: text("base_config"),                 // "1С:Бухгалтерия 8" / "Оригинальная"
  industries: text("industries").array(),          // "Сельское хозяйство", "ЖКХ"
  tasks: text("tasks").array(),                    // "Комплексное управление ресурсами предприятия (ERP)"
  editions: text("editions").array(),              // "Базовая", "ПРОФ", "КОРП"
  supportPhone: text("support_phone"),
  supportEmail: text("support_email"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * "Переходы": update packages in the LST that move a database to ANOTHER
 * application (УТ базовая → УТ, УТ → КА, Розница → УНФ) or to another edition
 * of the same one (БП 2.0 → 3.0). Shown for information only — the chain
 * calculator still stays within one edition (locked decision). Rebuilt from
 * the LST on every import; aggregated per (source, target) application.
 * kind: product | edition. from_config_id is NULL when the source product
 * could not be resolved to an application (only its LST name is known).
 */
export const transitions = pgTable(
  "transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fromConfigId: integer("from_config_id").references(() => configurations.id, { onDelete: "cascade" }),
    fromName: text("from_name").notNull(),
    fromVendor: text("from_vendor").notNull().default(""),
    toConfigId: integer("to_config_id").notNull().references(() => configurations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    packages: integer("packages").notNull().default(0),
    fromMin: text("from_min"),
    fromMax: text("from_max"),
    toMin: text("to_min"),
    toMax: text("to_max"),
  },
  (t) => ({
    fromIdx: index("transitions_from_idx").on(t.fromConfigId),
    toIdx: index("transitions_to_idx").on(t.toConfigId),
  }),
);

// Обмены и переходы между типовыми конфигурациями — реестр 1CExchenge
// (github.com/iMironRU/1CExchenge, data/registry.json), one row per link.
// Sides are the registry's "product + edition" (not a build); from_config_id /
// to_config_id are our configuration when the side maps to one (exchanges.ts),
// null for products outside the catalog (7.7, mobile apps, "прежние программы").
export const exchanges = pgTable(
  "exchanges",
  {
    id: integer("id").primaryKey(),                       // the registry's link id
    kind: text("kind").notNull(),                         // синхронизация | переход
    mechanism: text("mechanism").notNull(),
    fromProduct: text("from_product").notNull(),
    fromEdition: text("from_edition"),
    fromLabel: text("from_label").notNull(),              // "УТ 11.5" — the registry's line label
    fromConfigId: integer("from_config_id").references(() => configurations.id, { onDelete: "set null" }),
    toProduct: text("to_product").notNull(),
    toEdition: text("to_edition"),
    toLabel: text("to_label").notNull(),
    toConfigId: integer("to_config_id").references(() => configurations.id, { onDelete: "set null" }),
    exchangePlan: text("exchange_plan"),
    task: text("task"),                                   // class.task
    direction: text("direction"),                         // двусторонняя | односторонняя | перенос
    actual: text("actual"),                               // актуальная | устаревшая сторона
    formatVersions: text("format_versions").array(),      // EnterpriseData versions on this link
    objects: jsonb("objects").$type<Record<string, number>>(),   // content.summary: {"Справочник": 45, …}
    sources: text("sources").array(),                     // cf | files | releases
    shippedIn: jsonb("shipped_in").$type<{ path: string; product: string; version: string }[]>(),
    urls: jsonb("urls").$type<string[]>(),
    notes: text("notes"),
  },
  (t) => ({
    fromIdx: index("exchanges_from_idx").on(t.fromConfigId),
    toIdx: index("exchanges_to_idx").on(t.toConfigId),
  }),
);

// Declared EnterpriseData format versions per registry line ("БП 3.0").
export const exchangeFormats = pgTable(
  "exchange_formats",
  {
    line: text("line").notNull(),
    version: text("version").notNull(),                   // the build the registry scanned
    configId: integer("config_id").references(() => configurations.id, { onDelete: "set null" }),
    declared: text("declared").array(),
    packages: text("packages").array(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.line, t.version] }) }),
);

export type Configuration = typeof configurations.$inferSelect;
export type UpdateEdge = typeof updateEdges.$inferSelect;
export type ImportRun = typeof importRuns.$inferSelect;
export type VersionMeta = typeof versionMeta.$inferSelect;
export type Patch = typeof patches.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type ReleaseProject = typeof releaseProjects.$inferSelect;
export type TemplateTag = typeof templateTags.$inferSelect;
export type PackageManifest = typeof packageManifests.$inferSelect;
export type SolutionInfo = typeof solutionsInfo.$inferSelect;
export type Transition = typeof transitions.$inferSelect;

/**
 * Builds of the 1С:Предприятие platform from releases.1c.ru
 * (src/releases/platform.ts): every 8.2/8.3/8.5 build with its date; for
 * 8.3/8.5 also the OS it ships for (win64 win32 linux64 linux32 arm64 e2k
 * mac), the release notes and the bugboard page. details_status: null = the
 * build page was not fetched yet, ok | error (retried after a week).
 */
export const platformBuilds = pgTable(
  "platform_builds",
  {
    version: text("version").primaryKey(),
    nick: text("nick").notNull(),           // Platform83 | Platform85 | Platform82
    line: text("line").notNull(),           // "8.3.27"
    releaseDate: date("release_date"),
    os: text("os").array(),
    notesUrl: text("notes_url"),
    bugsUrl: text("bugs_url"),
    detailsStatus: text("details_status"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  },
  (t) => ({
    lineIdx: index("platform_builds_line_idx").on(t.line),
  }),
);

/**
 * push_subscriptions — Web Push subscriptions of the site's visitors («Мои
 * конфигурации» → «Уведомлять о релизах»). `config_ids` is the subscriber's
 * favourites at the time of the last sync; `seen` = {config_id: version} the
 * subscriber was last told about, so a run notifies only what is newer.
 * Never in a snapshot (it is this install's own audience).
 */
export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  configIds: integer("config_ids").array().notNull().default(sql`'{}'::int[]`),
  seen: jsonb("seen").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  userAgent: text("user_agent"),
  failures: integer("failures").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
});
