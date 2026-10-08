/**
 * push.ts — Web Push: «Вышел релиз» for the subscriber's «Мои конфигурации».
 *
 * The page subscribes through the service worker (sw.js `push` event shows the
 * notification, `notificationclick` opens the page) and sends us the
 * subscription with its favourite config ids (/api/push/subscribe). After every
 * data change (snapshot applied, «Обновить всё») notifyReleases() compares each
 * subscriber's `seen` {config_id: version} with the newest versions and sends
 * one notification per subscriber with what is new. VAPID keys are made once
 * and kept in settings (the private one sealed like the ITS passwords).
 * Endpoints answering 404/410 (unsubscribed) are deleted; five failures in a row
 * delete too.
 */

import webpush from "web-push";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import { pushSubscriptions, settings } from "./schema.js";
import { openSecret, sealSecret } from "./credentials.js";

export const PUSH_SUBJECT = process.env.PUSH_SUBJECT ?? "https://github.com/iMironRU/updatecon";
const MAX_IDS = 200;
let keys: { publicKey: string; privateKey: string } | null = null;

/** The VAPID pair: from settings, made on first use. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (keys) return keys;
  const rows = await db.select().from(settings).where(inArray(settings.key, ["vapid_public", "vapid_private"]));
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value ?? ""]));
  const priv = v.vapid_private ? openSecret(v.vapid_private) : null;
  if (v.vapid_public && priv) { keys = { publicKey: v.vapid_public, privateKey: priv }; return keys; }
  const made = webpush.generateVAPIDKeys();
  for (const [k, val] of [["vapid_public", made.publicKey], ["vapid_private", sealSecret(made.privateKey)]] as const) {
    await db.insert(settings).values({ key: k, value: val, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: val, updatedAt: new Date() } });
  }
  console.log("[push] созданы VAPID-ключи");
  keys = made;
  return keys;
}

async function configured() {
  const k = await vapidKeys();
  webpush.setVapidDetails(PUSH_SUBJECT, k.publicKey, k.privateKey);
}

export interface SubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }

export function validSubscription(x: unknown): x is SubscriptionInput {
  const s = x as SubscriptionInput;
  return !!s && typeof s.endpoint === "string" && /^https:\/\/\S{10,1500}$/.test(s.endpoint)
    && !!s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}

/** Newest version per configuration (highest number with a release date, else the LST's highest edge target). */
async function latestVersions(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const rows = ((await db.execute(sql`
    SELECT c.id,
      COALESCE(
        (SELECT version FROM version_meta vm WHERE vm.config_id = c.id AND vm.release_date IS NOT NULL AND vm.version ~ '^[0-9]+(\\.[0-9]+)*$'
           ORDER BY string_to_array(vm.version, '.')::bigint[] DESC LIMIT 1),
        (SELECT to_version FROM update_edges ue WHERE ue.config_id = c.id AND ue.to_version ~ '^[0-9]+(\\.[0-9]+)*$'
           ORDER BY string_to_array(ue.to_version, '.')::bigint[] DESC LIMIT 1)
      ) AS v
    FROM configurations c WHERE c.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)) as any).rows as { id: number; v: string | null }[];
  for (const r of rows) if (r.v) out.set(Number(r.id), r.v);
  return out;
}

/** Save (or refresh) a subscription with the subscriber's favourites; `seen` starts at today's versions. */
export async function saveSubscription(sub: SubscriptionInput, configIds: number[], userAgent?: string) {
  const ids = [...new Set(configIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS);
  const latest = await latestVersions(ids);
  const existing = (await db.select({ seen: pushSubscriptions.seen }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)))[0];
  const seen: Record<string, string> = {};
  for (const id of ids) seen[id] = existing?.seen?.[id] ?? latest.get(id) ?? "";
  const row = { p256dh: sub.keys.p256dh, auth: sub.keys.auth, configIds: ids, seen, userAgent: userAgent?.slice(0, 300) ?? null, failures: 0, updatedAt: new Date() };
  await db.insert(pushSubscriptions).values({ endpoint: sub.endpoint, ...row })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });
  return ids.length;
}

export async function removeSubscription(endpoint: string) {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

export async function subscriptionCount(): Promise<number> {
  return Number(((await db.execute(sql`SELECT count(*)::int AS n FROM push_subscriptions`)) as any).rows[0].n);
}

interface Payload { title: string; body: string; url: string; tag?: string }

async function send(row: { endpoint: string; p256dh: string; auth: string; failures: number }, payload: Payload): Promise<"ok" | "gone" | "error"> {
  await configured();
  try {
    await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: "normal" });
    await db.update(pushSubscriptions).set({ failures: 0, lastSentAt: new Date() }).where(eq(pushSubscriptions.endpoint, row.endpoint));
    return "ok";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410 || row.failures + 1 >= 5) {
      await removeSubscription(row.endpoint);
      return "gone";
    }
    await db.update(pushSubscriptions).set({ failures: row.failures + 1 }).where(eq(pushSubscriptions.endpoint, row.endpoint));
    console.warn(`[push] не отправлено (${code ?? (e as Error).message})`);
    return "error";
  }
}

/** A test notification to one subscriber (the page's «Проверить» button). */
export async function sendTest(endpoint: string): Promise<"ok" | "gone" | "error" | "unknown"> {
  const row = (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)))[0];
  if (!row) return "unknown";
  return send(row, { title: "Апдейкон", body: "Уведомления работают: так придёт сообщение о новом релизе.", url: "/news?mine=1", tag: "test" });
}

export interface NotifyResult { subscribers: number; notified: number; releases: number; gone: number }

/** Tell every subscriber about releases newer than what they were told about. */
export async function notifyReleases(log: (m: string) => void = (m) => console.log(`[push] ${m}`)): Promise<NotifyResult> {
  const subs = await db.select().from(pushSubscriptions);
  const res: NotifyResult = { subscribers: subs.length, notified: 0, releases: 0, gone: 0 };
  if (!subs.length) return res;
  const ids = [...new Set(subs.flatMap((s) => s.configIds))];
  const latest = await latestVersions(ids);
  const names = new Map<number, string>();
  if (ids.length) {
    const rows = ((await db.execute(sql`SELECT id, coalesce(display_name, name) AS name FROM configurations
      WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)) as any).rows as { id: number; name: string }[];
    for (const r of rows) names.set(Number(r.id), r.name);
  }
  const newer = (a: string, b: string) => {   // a > b by numeric segments
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0; }
    return false;
  };
  for (const s of subs) {
    const fresh: { id: number; v: string }[] = [];
    const seen = { ...s.seen };
    for (const id of s.configIds) {
      const v = latest.get(id);
      if (!v) continue;
      const was = seen[id];
      if (!was || newer(v, was)) { if (was) fresh.push({ id, v }); seen[id] = v; }   // no `was`: first sight, nothing to tell
    }
    if (!fresh.length) { if (JSON.stringify(seen) !== JSON.stringify(s.seen)) await db.update(pushSubscriptions).set({ seen }).where(eq(pushSubscriptions.endpoint, s.endpoint)); continue; }
    const lines = fresh.slice(0, 4).map((f) => `${names.get(f.id) ?? "#" + f.id} — ${f.v}`);
    if (fresh.length > 4) lines.push(`и ещё ${fresh.length - 4}`);
    const payload: Payload = {
      title: fresh.length === 1 ? "Новый релиз" : `Новых релизов: ${fresh.length}`,
      body: lines.join("\n"),
      url: fresh.length === 1 ? `/config/${fresh[0].id}` : "/news?mine=1",
      tag: "releases",
    };
    const r = await send(s, payload);
    if (r === "gone") { res.gone++; continue; }
    if (r !== "ok") continue;   // not delivered: `seen` stays, the next run tries again
    res.notified++; res.releases += fresh.length;
    await db.update(pushSubscriptions).set({ seen }).where(eq(pushSubscriptions.endpoint, s.endpoint));
  }
  log(`подписчиков ${res.subscribers}, уведомлено ${res.notified} (релизов ${res.releases}), отписалось ${res.gone}`);
  return res;
}
