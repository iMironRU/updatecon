/**
 * credentials.ts — the ITS account and the admin password, editable from the
 * admin UI. `.env` still works; a value saved in the admin UI wins over it.
 *
 * Stored in `settings`:
 *   its_accounts         JSON [{login, password}] — several ITS accounts, the first
 *                        is the main one; passwords AES-256-GCM, the key derived
 *                        from the database password in DATABASE_URL, so a DB dump
 *                        alone does not reveal them (a new DB password = enter again)
 *   its_login / its_password   the old single account (read as the first entry)
 *   admin_password_hash  scrypt
 *
 * The rest of the code keeps reading process.env.ITS_* for the main account:
 * applyItsCredentials() puts it there. The web process calls it on start and
 * after a change; the worker (another process) before each scheduled run.
 * Imports that may hit products one account cannot see take allItsAccounts()
 * and try the others (releases.1c.ru hides unsubscribed products, downloads
 * answers 401 for partner packages).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "./client.js";
import { settings } from "./schema.js";
import { ReleasesSession } from "../releases/fetch-releases.js";

const ENV_ITS = { login: process.env.ITS_LOGIN ?? "", password: process.env.ITS_PASSWORD ?? "" };
const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

function key(): Buffer {
  let pw = "";
  try { pw = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").password); } catch { /* no URL */ }
  return createHash("sha256").update("updatecon/settings/" + pw).digest();
}
/** Settings secrets (ITS passwords, VAPID private key) — AES-GCM under a key derived from the DB password. */
export function sealSecret(text: string): string { return encrypt(text); }
export function openSecret(stored: string): string | null { return decrypt(stored); }

function encrypt(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
function decrypt(stored: string): string | null {
  try {
    const raw = Buffer.from(stored.replace(/^v1:/, ""), "base64");
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;   // another DB password, or tampered
  }
}

async function read(keys: string[]): Promise<Record<string, string>> {
  const rows = await db.select().from(settings).where(inArray(settings.key, keys));
  return Object.fromEntries(rows.filter((r) => r.value != null).map((r) => [r.key, r.value as string]));
}
async function write(values: Record<string, string | null>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === null) await db.delete(settings).where(inArray(settings.key, [k]));
    else await db.insert(settings).values({ key: k, value: v, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: v, updatedAt: new Date() } });
  }
}

export interface ItsCredentials { login: string; password: string; source: "admin" | "env" | "none"; unreadable?: boolean }
export interface ItsAccount { login: string; password: string }

/** The accounts saved in the admin UI, in order; `unreadable` = some password no longer decrypts. */
async function savedAccounts(): Promise<{ accounts: ItsAccount[]; unreadable: boolean }> {
  const s = await read(["its_accounts", "its_login", "its_password"]);
  let raw: { login: string; password: string }[] = [];
  if (s.its_accounts) { try { raw = JSON.parse(s.its_accounts); } catch { raw = []; } }
  else if (s.its_login && s.its_password) raw = [{ login: s.its_login, password: s.its_password }];
  let unreadable = false;
  const accounts: ItsAccount[] = [];
  for (const a of raw) {
    const password = decrypt(a.password);
    if (password === null) { unreadable = true; continue; }
    accounts.push({ login: a.login, password });
  }
  return { accounts, unreadable };
}

export async function itsCredentials(): Promise<ItsCredentials> {
  const { accounts, unreadable } = await savedAccounts();
  if (accounts.length) return { login: accounts[0].login, password: accounts[0].password, source: "admin", ...(unreadable ? { unreadable } : {}) };
  // Saved, but the key changed (new DB password): fall back to .env and say so.
  if (ENV_ITS.login && ENV_ITS.password) return { ...ENV_ITS, source: "env", ...(unreadable ? { unreadable } : {}) };
  return { login: "", password: "", source: "none", ...(unreadable ? { unreadable } : {}) };
}

// Extra accounts from the environment: ITS_ACCOUNTS='[{"login":"…","password":"…"}]' —
// the snapshot workflow gets them from a repository secret (products one account
// cannot see: ERP, Управление холдингом). Never the main account, never logged.
function envExtraAccounts(): ItsAccount[] {
  const raw = process.env.ITS_ACCOUNTS?.trim();
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error("не массив");
    return list.filter((a) => a && typeof a.login === "string" && typeof a.password === "string" && a.login && a.password)
      .map((a) => ({ login: String(a.login).trim(), password: String(a.password) }));
  } catch (e) {
    console.warn(`[its] ITS_ACCOUNTS не разобран (${(e as Error).message}) — ожидается JSON-массив {login, password}`);
    return [];
  }
}

/** Every usable account: the admin UI's list, else the .env one, plus ITS_ACCOUNTS. The first is the main account. */
export async function allItsAccounts(): Promise<ItsAccount[]> {
  const { accounts } = await savedAccounts();
  const out: ItsAccount[] = accounts.length ? [...accounts] : (ENV_ITS.login && ENV_ITS.password ? [{ ...ENV_ITS }] : []);
  for (const a of envExtraAccounts()) if (!out.some((x) => x.login.toLowerCase() === a.login.toLowerCase())) out.push(a);
  return out;
}
/** Logins only, for the admin UI. */
export async function itsAccountLogins(): Promise<string[]> {
  return (await allItsAccounts()).map((a) => a.login);
}

/** Put the effective ITS account into process.env for the import code. */
export async function applyItsCredentials(): Promise<ItsCredentials> {
  const c = await itsCredentials();
  if (c.login && c.password) { process.env.ITS_LOGIN = c.login; process.env.ITS_PASSWORD = c.password; }
  else { delete process.env.ITS_LOGIN; delete process.env.ITS_PASSWORD; }
  return c;
}

/**
 * Does releases.1c.ru accept this account? The SSO answers 200 with the login
 * form on a wrong password, so check a page that needs the session.
 *   true — accepted; false — rejected; throws — could not reach the portal.
 */
export async function verifyItsLogin(login: string, password: string): Promise<boolean> {
  const s = new ReleasesSession();
  try {
    await s.login(login, password);
  } catch (e) {
    if (/SSO login failed/.test((e as Error).message)) return false;
    throw e;
  }
  const page = await s.get("/project/Platform83");
  return /Выход/.test(page) && !/name="execution"/.test(page);
}

async function writeAccounts(list: ItsAccount[]) {
  await write({
    its_accounts: list.length ? JSON.stringify(list.map((a) => ({ login: a.login, password: encrypt(a.password) }))) : null,
    its_login: null, its_password: null,
  });
  return applyItsCredentials();
}
/** Add or replace (same login) an account; `main` puts it first. */
export async function saveItsCredentials(login: string, password: string, main = false) {
  const list = (await savedAccounts()).accounts.filter((a) => a.login !== login);
  if (main || list.length === 0) list.unshift({ login, password }); else list.push({ login, password });
  return writeAccounts(list);
}
export async function removeItsAccount(login: string) {
  return writeAccounts((await savedAccounts()).accounts.filter((a) => a.login !== login));
}
export async function makeItsAccountMain(login: string) {
  const list = (await savedAccounts()).accounts;
  const i = list.findIndex((a) => a.login === login);
  if (i > 0) list.unshift(...list.splice(i, 1));
  return writeAccounts(list);
}
/** Forget every saved account: back to ITS_LOGIN / ITS_PASSWORD from .env. */
export async function clearItsCredentials() {
  return writeAccounts([]);
}

// ── Admin password ─────────────────────────────────────────────────────────

function hash(password: string, salt = randomBytes(16)): string {
  return "scrypt:" + salt.toString("base64") + ":" + scryptSync(password, salt, 32).toString("base64");
}
function verifyHash(password: string, stored: string): boolean {
  const [, salt, h] = stored.split(":");
  if (!salt || !h) return false;
  const a = scryptSync(password, Buffer.from(salt, "base64"), 32), b = Buffer.from(h, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}
const sameText = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

export async function adminPasswordSource(): Promise<"admin" | "env"> {
  return (await read(["admin_password_hash"])).admin_password_hash ? "admin" : "env";
}
export async function checkAdminPassword(password: string): Promise<boolean> {
  const stored = (await read(["admin_password_hash"])).admin_password_hash;
  return stored ? verifyHash(password, stored) : sameText(password, ENV_ADMIN_PASSWORD);
}
export async function setAdminPassword(password: string) {
  await write({ admin_password_hash: hash(password) });
}
