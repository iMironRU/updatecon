import { createHash } from "node:crypto";

export type ReleaseChangeType =
  | "new_version"
  | "platform_changed"
  | "resource_added"
  | "patch_added";

export interface VersionSnapshot {
  version: string;
  minPlatform: string | null;
  isTest: boolean;
}

export interface IncomingVersionSnapshot extends VersionSnapshot {
  releaseDate: string | null;
}

export interface ChangeDraft {
  eventType: ReleaseChangeType;
  dedupeKey: string;
  version: string;
  isTest: boolean;
  details: Record<string, unknown>;
  occurredAt: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function resourceChangeDedupeKey(projectId: number, version: string, href: string): string {
  return `resource:${projectId}:${version}:${digest(href)}`;
}

export function versionChangeDrafts(
  projectId: number,
  existing: VersionSnapshot[],
  incoming: IncomingVersionSnapshot[],
): ChangeDraft[] {
  // The first import establishes a baseline instead of presenting the whole
  // historical archive as freshly published releases.
  if (!existing.length) return [];
  const byVersion = new Map(existing.map((row) => [row.version, row]));
  const changes: ChangeDraft[] = [];
  for (const row of incoming) {
    const previous = byVersion.get(row.version);
    if (!previous) {
      changes.push({
        eventType: "new_version",
        dedupeKey: `version:${projectId}:${row.version}`,
        version: row.version,
        isTest: row.isTest,
        occurredAt: row.releaseDate,
        details: {
          releaseDate: row.releaseDate,
          minPlatform: row.minPlatform,
        },
      });
      continue;
    }
    // A missing value on the compact project page means "not provided here",
    // not that a requirement learned from the version page was removed.
    if (row.minPlatform !== null && previous.minPlatform !== row.minPlatform) {
      const details = {
        fields: [{
          field: "minPlatform",
          previous: previous.minPlatform,
          current: row.minPlatform,
        }],
      };
      changes.push({
        eventType: "platform_changed",
        dedupeKey: `platform:${projectId}:${row.version}:${digest(details)}`,
        version: row.version,
        isTest: row.isTest,
        occurredAt: null,
        details,
      });
    }
  }
  return changes;
}

export function platformChangeDraft(
  projectId: number,
  version: string,
  isTest: boolean,
  previous: { minPlatform: string | null; recommendedPlatform: string | null },
  current: { minPlatform: string | null; recommendedPlatform: string | null },
  hasBaseline: boolean,
): ChangeDraft | null {
  if (!hasBaseline) return null;
  const fields = ([
    ["minPlatform", previous.minPlatform, current.minPlatform],
    ["recommendedPlatform", previous.recommendedPlatform, current.recommendedPlatform],
  ] as const)
    .filter(([, before, after]) => before !== after)
    .map(([field, before, after]) => ({ field, previous: before, current: after }));
  if (!fields.length) return null;
  const details = { fields };
  return {
    eventType: "platform_changed",
    dedupeKey: `platform:${projectId}:${version}:${digest(details)}`,
    version,
    isTest,
    occurredAt: null,
    details,
  };
}

export function resourceChangeDrafts(
  projectId: number,
  version: string,
  isTest: boolean,
  existingHrefs: Iterable<string>,
  resources: Array<{
    href: string;
    title: string;
    kind: string;
    category: string;
    fileName?: string | null;
    fileSizeBytes?: number | null;
    publishedAt?: string | null;
    isFile: boolean;
  }>,
  hasBaseline: boolean,
): ChangeDraft[] {
  if (!hasBaseline) return [];
  const known = new Set(existingHrefs);
  return resources.filter((resource) => !known.has(resource.href)).map((resource) => ({
    eventType: "resource_added" as const,
    dedupeKey: resourceChangeDedupeKey(projectId, version, resource.href),
    version,
    isTest,
    occurredAt: resource.publishedAt ?? null,
    details: { ...resource },
  }));
}

export function patchChangeDraft(
  version: string,
  isTest: boolean,
  patch: { uuid: string; title?: string | null; patchDate?: string | null },
  hasBaseline: boolean,
): ChangeDraft | null {
  if (!hasBaseline) return null;
  return {
    eventType: "patch_added",
    dedupeKey: `patch:${patch.uuid}`,
    version,
    isTest,
    occurredAt: patch.patchDate ?? null,
    details: patch,
  };
}
