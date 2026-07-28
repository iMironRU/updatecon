import { asc, eq, sql } from "drizzle-orm";
import { db, rows as unwrapRows } from "../db/client.js";
import {
  itsAccounts,
} from "../db/schema.js";
import { decryptCredential, encryptCredential } from "./crypto.js";

export interface AccountCredentials {
  id: number;
  label: string;
  login: string;
  password: string;
  priority: number;
  requestConcurrency: number;
}

export interface AccountInput {
  label: string;
  login: string;
  password?: string;
  enabled?: boolean;
  priority?: number;
  requestConcurrency?: number;
}

export interface AccountSummary {
  id: number;
  label: string;
  login: string;
  enabled: boolean;
  priority: number;
  request_concurrency: number;
  last_status: string;
  last_success_at: Date | string | null;
  last_error: string;
  created_at: Date | string;
  updated_at: Date | string;
  projects_seen: number;
  projects_available: number;
  projects_unavailable: number;
}

function cleanInput(input: AccountInput) {
  const login = input.login?.trim();
  if (!login) throw new Error("Логин ИТС обязателен");
  const label = input.label?.trim() || login;
  const requestConcurrency = Number(input.requestConcurrency ?? 4);
  if (!Number.isInteger(requestConcurrency) || requestConcurrency < 1 || requestConcurrency > 8) {
    throw new Error("Лимит параллельных запросов аккаунта должен быть от 1 до 8");
  }
  return {
    label,
    login,
    enabled: input.enabled ?? true,
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 100,
    requestConcurrency,
  };
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const result = await db.execute(sql`
    SELECT
      a.id, a.label, a.login, a.enabled, a.priority, a.request_concurrency,
      CASE
        WHEN a.last_status = 'error'
          AND a.last_error = 'Обновление прервано пользователем'
          THEN CASE WHEN a.last_success_at IS NULL THEN 'never' ELSE 'ok' END
        ELSE a.last_status
      END AS last_status,
      a.last_success_at,
      CASE
        WHEN a.last_status = 'error'
          AND a.last_error = 'Обновление прервано пользователем'
          THEN ''
        ELSE a.last_error
      END AS last_error,
      a.created_at, a.updated_at,
      coalesce(latest_check.projects_seen, access.projects_seen, 0)::int AS projects_seen,
      coalesce(latest_check.projects_available, access.projects_available, 0)::int AS projects_available,
      coalesce(latest_check.projects_unavailable, access.projects_unavailable, 0)::int AS projects_unavailable
    FROM its_accounts a
    LEFT JOIN LATERAL (
      SELECT
        ir.configs_found::int AS projects_seen,
        CASE
          WHEN ir.source = 'account-check' THEN ir.edges_upserted
          ELSE greatest(ir.configs_found - ir.edges_unchanged, 0)
        END::int AS projects_available,
        ir.edges_unchanged::int AS projects_unavailable
      FROM import_runs ir
      WHERE ir.account_id = a.id
        AND ir.source IN ('account-check', 'releases')
        AND ir.status = 'ok'
      ORDER BY ir.finished_at DESC NULLS LAST, ir.id DESC
      LIMIT 1
    ) latest_check ON true
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS projects_seen,
        count(*) FILTER (WHERE apa.status = 'available')::int AS projects_available,
        count(*) FILTER (WHERE apa.status = 'unavailable')::int AS projects_unavailable
      FROM account_project_access apa
      WHERE apa.account_id = a.id
    ) access ON true
    ORDER BY a.priority, a.id
  `);
  return unwrapRows(result).map((row) => ({
    id: Number(row.id),
    label: String(row.label),
    login: String(row.login),
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    request_concurrency: Number(row.request_concurrency),
    last_status: String(row.last_status),
    last_success_at: (row.last_success_at as Date | string | null) ?? null,
    last_error: String(row.last_error ?? ""),
    created_at: row.created_at as Date | string,
    updated_at: row.updated_at as Date | string,
    projects_seen: Number(row.projects_seen),
    projects_available: Number(row.projects_available),
    projects_unavailable: Number(row.projects_unavailable),
  }));
}

export async function enabledAccountCredentials(): Promise<AccountCredentials[]> {
  const rows = await db
    .select()
    .from(itsAccounts)
    .where(eq(itsAccounts.enabled, true))
    .orderBy(asc(itsAccounts.priority), asc(itsAccounts.id));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    login: row.login,
    password: decryptCredential(row.passwordEncrypted),
    priority: row.priority,
    requestConcurrency: row.requestConcurrency,
  }));
}

export async function accountCredentials(id: number): Promise<AccountCredentials | null> {
  const [row] = await db
    .select()
    .from(itsAccounts)
    .where(eq(itsAccounts.id, id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    login: row.login,
    password: decryptCredential(row.passwordEncrypted),
    priority: row.priority,
    requestConcurrency: row.requestConcurrency,
  };
}

export async function createAccount(input: AccountInput) {
  const clean = cleanInput(input);
  if (!input.password) throw new Error("Пароль ИТС обязателен");
  const [created] = await db
    .insert(itsAccounts)
    .values({
      ...clean,
      passwordEncrypted: encryptCredential(input.password),
    })
    .returning({ id: itsAccounts.id });
  return created;
}

export async function updateAccount(id: number, input: AccountInput) {
  const clean = cleanInput(input);
  const values: Partial<typeof itsAccounts.$inferInsert> = {
    ...clean,
    updatedAt: new Date(),
  };
  if (input.password) values.passwordEncrypted = encryptCredential(input.password);
  const [updated] = await db
    .update(itsAccounts)
    .set(values)
    .where(eq(itsAccounts.id, id))
    .returning({ id: itsAccounts.id });
  if (!updated) throw new Error("Учётная запись не найдена");
  return updated;
}

export async function deleteAccount(id: number) {
  const deleted = await db
    .delete(itsAccounts)
    .where(eq(itsAccounts.id, id))
    .returning({ id: itsAccounts.id });
  return deleted.length > 0;
}

export async function markAccountSuccess(id: number) {
  await db
    .update(itsAccounts)
    .set({
      lastStatus: "ok",
      lastSuccessAt: new Date(),
      lastError: "",
      updatedAt: new Date(),
    })
    .where(eq(itsAccounts.id, id));
}

export async function markAccountError(id: number, error: unknown) {
  const message = (error as Error)?.message ?? String(error);
  await db
    .update(itsAccounts)
    .set({
      lastStatus: "error",
      lastError: message.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(itsAccounts.id, id));
}

/** Import the legacy single-account environment variables exactly once. */
export async function ensureLegacyAccount(): Promise<void> {
  const login = process.env.ITS_LOGIN?.trim();
  const password = process.env.ITS_PASSWORD;
  if (!login || !password) return;

  const existing = await db
    .select({ id: itsAccounts.id })
    .from(itsAccounts)
    .where(eq(itsAccounts.login, login))
    .limit(1);
  if (existing.length) return;

  await createAccount({
    label: "Основная учётная запись",
    login,
    password,
    enabled: true,
    priority: 10,
  });
}
