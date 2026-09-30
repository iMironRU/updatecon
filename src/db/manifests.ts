/**
 * manifests.ts — platform generation (8.2 / 8.3 / 8.5 …) of update packages.
 *
 * Every package in tmplts has a manifest next to its .cfu:
 *   https://downloads.v8.1c.ru/tmplts/1c/Accounting/3_0_206_19/1cv8.mft
 *     Vendor=Фирма "1С"
 *     Name=БухгалтерияПредприятия
 *     Version=3.0.206.19
 *     AppVersion=8.3          ← what we want
 * The LST itself carries no platform info, and lst-parser.ts is a locked
 * oracle — so the manifest path is derived from the cfu folder instead of
 * being parsed out of the LST. The file name is case-sensitive: "1cv8.mft".
 *
 * Only the newest package of each application edition is fetched (that is
 * what "the app is on 8.5" means); results are cached in package_manifests,
 * so later runs only fetch new packages. Partner packages the ITS account
 * can't read answer 401 — cached as "denied" and retried after a while; the
 * catalog then falls back to releases.1c.ru's minimum platform.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { packageManifests } from "./schema.js";

const BASE = "https://downloads.v8.1c.ru/tmplts/";
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;
const RETRY_AFTER_DAYS = 30;

export interface ManifestStats { candidates: number; fetched: number; ok: number; denied: number; missing: number; errors: number; }

/** "1c\Accounting\3_0_206_19\1cv8.cfu" → "1c/Accounting/3_0_206_19" */
export function packageDir(cfuPath: string): string {
  return cfuPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
}

async function fetchManifest(dir: string, auth: string): Promise<{ status: string; appVersion: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + dir.split("/").map(encodeURIComponent).join("/") + "/1cv8.mft", {
      headers: { Authorization: auth, "User-Agent": "1C+Enterprise/8.3" },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { status: "denied", appVersion: null };
    if (res.status === 404) return { status: "missing", appVersion: null };
    if (!res.ok) return { status: "error", appVersion: null };
    const text = (await res.text()).replace(/^﻿/, "");
    const m = text.match(/^AppVersion=\s*([0-9]+(?:\.[0-9]+)*)/m);
    return { status: "ok", appVersion: m ? m[1] : null };
  } catch {
    return { status: "error", appVersion: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function syncManifests(opts: { onLog?: (msg: string) => void } = {}): Promise<ManifestStats | null> {
  const log = (m: string) => (opts.onLog ? opts.onLog(m) : console.log(m));
  const login = process.env.ITS_LOGIN, password = process.env.ITS_PASSWORD;
  if (!login || !password) {
    log("Манифесты платформы: ITS_LOGIN / ITS_PASSWORD не заданы — пропуск");
    return null;
  }
  const auth = "Basic " + Buffer.from(`${login}:${password}`).toString("base64");

  // Newest package of every edition that we don't know yet (or should retry).
  const res = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (config_id)
             regexp_replace(replace(cfu_path, '\\', '/'), '/[^/]*$', '') AS dir
      FROM update_edges
      WHERE cfu_path <> ''
      ORDER BY config_id, string_to_array(to_version, '.')::bigint[] DESC
    )
    SELECT DISTINCT l.dir FROM latest l
    LEFT JOIN package_manifests m ON m.dir = l.dir
    WHERE m.dir IS NULL
       OR (m.status IN ('denied', 'error')
           AND m.fetched_at < now() - make_interval(days => ${RETRY_AFTER_DAYS}))
  `);
  const dirs = (((res as any).rows ?? res) as { dir: string }[]).map((r) => r.dir);
  const stats: ManifestStats = { candidates: dirs.length, fetched: 0, ok: 0, denied: 0, missing: 0, errors: 0 };
  if (dirs.length === 0) {
    log("Манифесты платформы: новых пакетов нет");
    return stats;
  }
  log(`Манифесты платформы: проверяем ${dirs.length} пакетов...`);

  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const dir = dirs[next++];
      const r = await fetchManifest(dir, auth);
      stats.fetched++;
      if (r.status === "ok") stats.ok++;
      else if (r.status === "denied") stats.denied++;
      else if (r.status === "missing") stats.missing++;
      else stats.errors++;
      await db.insert(packageManifests)
        .values({ dir, appVersion: r.appVersion, status: r.status, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: packageManifests.dir,
          set: { appVersion: r.appVersion, status: r.status, fetchedAt: new Date() },
        });
      if (stats.fetched % 100 === 0) log(`Манифесты платформы: ${stats.fetched} / ${dirs.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(
    `Манифесты платформы: получено ${stats.ok}, закрыто для аккаунта ${stats.denied}, ` +
    `нет файла ${stats.missing}, ошибок ${stats.errors}`,
  );
  return stats;
}
