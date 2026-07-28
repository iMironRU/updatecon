import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, rows as extractRows } from "../db/client.js";
import {
  configurations,
  releaseChangeEvents,
  releaseProjects,
} from "../db/schema.js";
import { batches } from "../utils/index.js";
import {
  patchChangeDraft,
  resourceChangeDedupeKey,
  resourceChangeDrafts,
  type ChangeDraft,
} from "./change-feed.js";

export interface BackfillArgs {
  all: boolean;
  projects: string[];
  dryRun: boolean;
  help: boolean;
}

export interface BackfillResult {
  projects: number;
  versions: number;
  resources: number;
  patches: number;
  dryRun: boolean;
}

const HELP = `Заполнение ленты историческими данными

Использование:
  npm run backfill:changes -- --all
  npm run backfill:changes -- --config Trade110
  npm run backfill:changes -- --config Trade110 --config Accounting30

Параметры:
  --all                 все конфигурации releases.1c.ru
  --config, -c VALUE    ID, nick, identity key, имя или имя конфигурации
  --project, -p VALUE   псевдоним параметра --config
  --dry-run             показать объём без записи в базу
  --help, -h            показать эту справку`;

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const result: BackfillArgs = { all: false, projects: [], dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--all") result.all = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (["--config", "-c", "--project", "-p"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`После ${arg} нужно указать конфигурацию`);
      result.projects.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
    } else if (arg.startsWith("--project=") || arg.startsWith("--config=")) {
      result.projects.push(...arg.slice(arg.indexOf("=") + 1).split(",").map((item) => item.trim()).filter(Boolean));
    } else {
      throw new Error(`Неизвестный параметр: ${arg}`);
    }
  }
  result.projects = [...new Set(result.projects)];
  if (!result.help && result.all === Boolean(result.projects.length)) {
    throw new Error("Укажите либо --all, либо один или несколько --config");
  }
  return result;
}

interface ProjectChoice {
  id: number;
  identityKey: string;
  href: string | null;
  displayName: string;
  configName: string | null;
}

function projectNick(href: string | null): string {
  return href?.replace(/^\/project\//, "") ?? "";
}

async function resolveProjects(args: BackfillArgs): Promise<ProjectChoice[]> {
  const rows = await db.select({
    id: releaseProjects.id,
    identityKey: releaseProjects.identityKey,
    href: releaseProjects.href,
    displayName: sql<string>`coalesce(${releaseProjects.displayNameOverride}, ${releaseProjects.displayName})`,
    configName: configurations.name,
  }).from(releaseProjects).leftJoin(configurations, sql`${configurations.id} = ${releaseProjects.configId}`);
  const projects = rows.map((row) => ({ ...row, id: Number(row.id) }));
  if (args.all) return projects;

  const selected = new Map<number, ProjectChoice>();
  for (const selector of args.projects) {
    const normalized = selector.toLocaleLowerCase("ru-RU");
    const configurationMatches = projects.filter((project) =>
      project.configName?.toLocaleLowerCase("ru-RU") === normalized);
    if (configurationMatches.length) {
      for (const match of configurationMatches) selected.set(match.id, match);
      continue;
    }
    const matches = projects.filter((project) => [
      String(project.id),
      project.identityKey,
      project.href ?? "",
      projectNick(project.href),
      project.displayName,
    ].some((value) => value.toLocaleLowerCase("ru-RU") === normalized));
    if (!matches.length) throw new Error(`Конфигурация «${selector}» не найдена`);
    if (matches.length > 1) {
      throw new Error(`Конфигурация «${selector}» неоднозначна: ${matches.map((row) => `${row.id} (${projectNick(row.href) || row.displayName})`).join(", ")}`);
    }
    selected.set(matches[0]!.id, matches[0]!);
  }
  return [...selected.values()];
}

function eventDate(value: unknown): Date {
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text;
  const result = new Date(normalized);
  if (Number.isNaN(result.getTime())) throw new Error(`Некорректная дата исторического события: ${text}`);
  return result;
}

interface StoredDraft extends ChangeDraft {
  projectId: number;
  projectVersionId: number;
  configId: number | null;
}

async function storeDrafts(drafts: StoredDraft[], dryRun: boolean): Promise<void> {
  if (dryRun) return;
  for (const batch of batches(drafts)) {
    await db.insert(releaseChangeEvents).values(batch.map((draft) => ({
      dedupeKey: draft.dedupeKey,
      eventType: draft.eventType,
      projectId: draft.projectId,
      projectVersionId: draft.projectVersionId,
      configId: draft.configId,
      version: draft.version,
      isTest: draft.isTest,
      details: draft.details,
      occurredAt: eventDate(draft.occurredAt),
    }))).onConflictDoUpdate({
      target: releaseChangeEvents.dedupeKey,
      set: {
        eventType: sql`excluded.event_type`,
        projectId: sql`excluded.project_id`,
        projectVersionId: sql`excluded.project_version_id`,
        configId: sql`excluded.config_id`,
        version: sql`excluded.version`,
        isTest: sql`excluded.is_test`,
        details: sql`excluded.details`,
        occurredAt: sql`excluded.occurred_at`,
      },
    });
  }
}

export async function backfillChangeFeed(args: BackfillArgs): Promise<BackfillResult> {
  const projects = await resolveProjects(args);
  if (!projects.length) return { projects: 0, versions: 0, resources: 0, patches: 0, dryRun: args.dryRun };
  const projectIds = sql.join(projects.map((project) => sql`${project.id}`), sql`, `);

  const versionRows = extractRows<Record<string, unknown>>(await db.execute(sql`
    SELECT rpv.id AS project_version_id, rpv.project_id, rp.config_id, rpv.version, rpv.is_test,
      coalesce(rpv.release_date_override, rpv.release_date)::text AS release_date,
      coalesce(rpv.min_platform_override, rpv.min_platform) AS min_platform
    FROM release_project_versions rpv
    JOIN release_projects rp ON rp.id = rpv.project_id
    WHERE rpv.project_id IN (${projectIds})
      AND coalesce(rpv.release_date_override, rpv.release_date) IS NOT NULL
  `));
  const versions: StoredDraft[] = versionRows.map((row) => ({
    eventType: "new_version",
    dedupeKey: `version:${Number(row.project_id)}:${String(row.version)}`,
    projectId: Number(row.project_id),
    projectVersionId: Number(row.project_version_id),
    configId: row.config_id == null ? null : Number(row.config_id),
    version: String(row.version),
    isTest: Boolean(row.is_test),
    occurredAt: String(row.release_date),
    details: { releaseDate: String(row.release_date), minPlatform: row.min_platform ?? null },
  }));

  const resourceRows = extractRows<Record<string, unknown>>(await db.execute(sql`
    SELECT rvr.id, rpv.id AS project_version_id, rpv.project_id, rp.config_id, rpv.version, rpv.is_test,
      rvr.kind, rvr.category, coalesce(rvr.title_override, rvr.title) AS title, rvr.href AS dedupe_href,
      coalesce(rvr.href_override, rvr.href) AS href, rvr.file_name,
      coalesce(rvr.file_size_bytes_override, rvr.file_size_bytes) AS file_size_bytes,
      coalesce(rvr.published_at_override, rvr.published_at)::text AS published_at, rvr.is_file
    FROM release_version_resources rvr
    JOIN release_project_versions rpv ON rpv.id = rvr.project_version_id
    JOIN release_projects rp ON rp.id = rpv.project_id
    WHERE rpv.project_id IN (${projectIds})
      AND coalesce(rvr.published_at_override, rvr.published_at) IS NOT NULL
  `));
  const resources: StoredDraft[] = resourceRows.map((row) => {
    const draft = resourceChangeDrafts(Number(row.project_id), String(row.version), Boolean(row.is_test), [], [{
      href: String(row.href), title: String(row.title), kind: String(row.kind), category: String(row.category),
      fileName: row.file_name == null ? null : String(row.file_name),
      fileSizeBytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
      publishedAt: String(row.published_at), isFile: Boolean(row.is_file),
    }], true)[0]!;
    return {
      ...draft,
      dedupeKey: resourceChangeDedupeKey(Number(row.project_id), String(row.version), String(row.dedupe_href)),
      projectId: Number(row.project_id),
      projectVersionId: Number(row.project_version_id),
      configId: row.config_id == null ? null : Number(row.config_id),
    };
  });

  const patchRows = extractRows<Record<string, unknown>>(await db.execute(sql`
    SELECT p.uuid, p.title, p.patch_date::text AS patch_date, p.version,
      target.id AS project_version_id, target.project_id, target.config_id, target.is_test
    FROM patches p
    JOIN LATERAL (
      SELECT rpv.id, rpv.project_id, rp.config_id, rpv.is_test
      FROM release_project_versions rpv
      JOIN release_projects rp ON rp.id = rpv.project_id
      WHERE rpv.project_id IN (${projectIds})
        AND rpv.version = p.version
        AND (rpv.id = p.project_version_id OR (p.project_version_id IS NULL AND rp.config_id = p.config_id))
      ORDER BY CASE WHEN rpv.id = p.project_version_id THEN 0 ELSE 1 END, rpv.id
      LIMIT 1
    ) target ON true
    WHERE p.patch_date IS NOT NULL
  `));
  const patchDrafts: StoredDraft[] = patchRows.map((row) => ({
    ...patchChangeDraft(String(row.version), Boolean(row.is_test), {
      uuid: String(row.uuid),
      title: row.title == null ? null : String(row.title),
      patchDate: String(row.patch_date),
    }, true)!,
    projectId: Number(row.project_id),
    projectVersionId: Number(row.project_version_id),
    configId: row.config_id == null ? null : Number(row.config_id),
  }));

  await storeDrafts([...versions, ...resources, ...patchDrafts], args.dryRun);
  return {
    projects: projects.length,
    versions: versions.length,
    resources: resources.length,
    patches: patchDrafts.length,
    dryRun: args.dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const result = await backfillChangeFeed(args);
  const prefix = result.dryRun ? "Будет обработано" : "Лента заполнена";
  process.stdout.write(`${prefix}: проектов ${result.projects}, версий ${result.versions}, материалов ${result.resources}, исправлений ${result.patches}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }).finally(() => pool.end());
}
