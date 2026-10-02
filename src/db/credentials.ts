/**
 * credentials.ts — the ITS account and the admin password, editable from the
 * admin UI. `.env` still works; a value saved in the admin UI wins over it.
 *
 * Stored in `settings`:
 *   its_login            plain
 *   its_password         AES-256-GCM; the key is derived from the database
 *                        password in DATABASE_URL, so a DB dump alone does not
 *                        reveal it (a new DB password = enter it again)
 *   admin_password_hash  scrypt
 *
 * The rest of the code keeps reading process.env.ITS_*: applyItsCredentials()
 * puts the effective values there. The web process calls it on start and after
 * a change; the worker (another process) before each scheduled run.
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

export async function itsCredentials(): Promise<ItsCredentials> {
  const s = await read(["its_login", "its_password"]);
  if (s.its_login && s.its_password) {
    const password = decrypt(s.its_password);
    if (password !== null) return { login: s.its_login, password, source: "admin" };
    // Saved, but the key changed (new DB password): fall back to .env and say so.
    return { ...(ENV_ITS.login && ENV_ITS.password ? { ...ENV_ITS, source: "env" as const } : { login: "", password: "", source: "none" as const }), unreadable: true };
  }
  if (ENV_ITS.login && ENV_ITS.password) return { ...ENV_ITS, source: "env" };
  return { login: "", password: "", source: "none" };
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

export async function saveItsCredentials(login: string, password: string) {
  await write({ its_login: login, its_password: encrypt(password) });
  return applyItsCredentials();
}
export async function clearItsCredentials() {
  await write({ its_login: null, its_password: null });
  return applyItsCredentials();
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
