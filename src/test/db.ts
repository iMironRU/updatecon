/**
 * db.ts — a real Postgres for the tests (no pg-mem: the routes use recursive CTEs,
 * arrays and window functions). TEST_DATABASE_URL names the database the tests
 * own (created from DATABASE_URL's server when missing, migrated, emptied before
 * every seed). Locally: scripts/dev-local.sh's container on :55432; in CI: the
 * Postgres service. Tests import the app only after DATABASE_URL points here.
 */

import { Pool } from "pg";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.DATABASE_URL ?? "postgres://upd:upd@localhost:55432/upd";
export const TEST_URL = process.env.TEST_DATABASE_URL ?? BASE.replace(/\/[^/?]+(\?.*)?$/, "/upd_test$1");

let ready: Promise<void> | null = null;
export function prepare(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const name = new URL(TEST_URL).pathname.slice(1);
    const admin = new Pool({ connectionString: BASE });
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    process.env.DATABASE_URL = TEST_URL;
    const { db } = await import("../db/client.js");
    await drizzleMigrate(db, { migrationsFolder: join(__dirname, "../../drizzle") });
  })();
  return ready;
}

/** Empty the data tables (settings too: VAPID keys etc. are made on demand). */
export async function clean() {
  const { pool } = await import("../db/client.js");
  await pool.query(`TRUNCATE push_subscriptions, release_events, patches, exchange_formats, exchanges, transitions,
    solutions_info, package_manifests, template_tags, version_meta, update_edges, release_projects, configurations,
    platform_builds, import_runs, settings RESTART IDENTITY CASCADE`);
}

/**
 * A small world: Бухгалтерия предприятия 3.0 (id 1, linked to the portal) with a chain
 * 3.0.100.1 → 3.0.101.2 → 3.0.102.3 → 3.0.103.4, an LTS-branch update 3.0.102.9 released
 * after the newest, sizes for two versions, patches for the newest; its basic sibling
 * (id 2, same versions, no portal link); a 2.0 edition (id 3); another product (id 4).
 */
export async function seed() {
  const { pool } = await import("../db/client.js");
  const q = (sql: string, params?: unknown[]) => pool.query(sql, params);
  await q(`INSERT INTO configurations (id, name, vendor, display_name, releases_href, group_name, region, template_code, template_key, edition) VALUES
    (1, 'БухгалтерияПредприятия', 'Фирма "1С"', 'Бухгалтерия предприятия, редакция 3.0', '/project/Accounting30', 'Типовые конфигурации фирмы "1С" для России', 'ru', '1c/Accounting', '1c/accounting', 3),
    (2, 'БухгалтерияПредприятияБазовая', 'Фирма "1С"', NULL, NULL, NULL, 'ru', '1c/AccountingBase', '1c/accountingbase', 3),
    (3, 'БухгалтерияПредприятия', 'Фирма "1С"', 'Бухгалтерия предприятия, редакция 2.0', '/project/Accounting20', 'Типовые конфигурации фирмы "1С" для России', 'ru', '1c/Accounting', '1c/accounting', 2),
    (4, 'Автосервис', 'Рарус', NULL, NULL, NULL, 'ru', 'Rarus/AutoService', 'rarus/autoservice', 5)`);
  await q(`INSERT INTO release_projects (nick, href, display_name, group_name, region, config_id, match_method, lts_version, lts_until) VALUES
    ('Accounting30', '/project/Accounting30', 'Бухгалтерия предприятия, редакция 3.0', 'Типовые конфигурации фирмы "1С" для России', 'ru', 1, 'rule', '3.0.102.9', '2027-04-30'),
    ('Accounting20', '/project/Accounting20', 'Бухгалтерия предприятия, редакция 2.0', 'Типовые конфигурации фирмы "1С" для России', 'ru', 3, 'rule', NULL, NULL)`);
  const edges = [
    [1, "3.0.100.1", "3.0.101.2"], [1, "3.0.101.2", "3.0.102.3"], [1, "3.0.102.3", "3.0.103.4"], [1, "3.0.102.3", "3.0.102.9"],
    [2, "3.0.100.1", "3.0.101.2"], [2, "3.0.101.2", "3.0.102.3"], [2, "3.0.102.3", "3.0.103.4"],
    [3, "2.0.60.1", "2.0.61.2"],
    [4, "5.0.1.1", "5.0.2.2"],
  ];
  for (const [c, f, t] of edges) {
    const tpl = c === 1 ? "1c/Accounting" : c === 2 ? "1c/AccountingBase" : c === 3 ? "1c/Accounting" : "Rarus/AutoService";
    await q(`INSERT INTO update_edges (config_id, from_version, to_version, edition, cfu_path, content_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [c, f, t, Number(String(t).split(".")[0]), `${tpl}/${String(t).replace(/\./g, "_")}/1cv8.cfu`, `${c}|${f}|${t}`]);
  }
  // Dates: the LTS-branch build 3.0.102.9 is the newest by date but not by number.
  const meta: [number, string, string, string, number | null][] = [
    [1, "3.0.100.1", "2026-06-01", "8.3.25.1000", 200_000_000],
    [1, "3.0.101.2", "2026-07-01", "8.3.25.1000", null],
    [1, "3.0.102.3", "2026-08-01", "8.3.27.1688", 250_000_000],
    [1, "3.0.103.4", "2026-09-01", "8.3.27.1688", null],
    [1, "3.0.102.9", "2026-09-15", "8.3.27.1688", null],
    [2, "3.0.103.4", "2026-09-01", "8.3.27.1688", null],
    [3, "2.0.61.2", "2026-05-01", "8.3.20.1000", null],
  ];
  for (const [c, v, d, p, size] of meta) {
    await q(`INSERT INTO version_meta (config_id, version, release_date, min_platform, file_size_bytes, files, files_nick) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c, v, d, p, size, c === 1 ? JSON.stringify([{ t: "Дистрибутив обновления", p: `Accounting\\${v.replace(/\./g, "_")}\\updsetup.zip` }, { t: "Полный дистрибутив", p: `Accounting\\${v.replace(/\./g, "_")}\\setup.zip` }]) : null, c === 1 ? "Accounting30" : null]);
  }
  await q(`INSERT INTO patches (config_id, version, uuid, title, description, patch_date) VALUES
    (1, '3.0.103.4', '11111111-1111-1111-1111-111111111111', 'EF_1', 'Первое исправление', '2026-09-05'),
    (1, '3.0.103.4', '22222222-2222-2222-2222-222222222222', 'EF_2', 'Второе исправление', '2026-09-06'),
    (2, '3.0.103.4', '11111111-1111-1111-1111-111111111111', 'EF_1', 'Первое исправление', '2026-09-05')`);
  await q(`INSERT INTO platform_builds (version, nick, line, release_date) VALUES ('8.3.27.1688', 'Platform83', '8.3', '2026-08-20')`);
}
