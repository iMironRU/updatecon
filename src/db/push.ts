/**
 * push.ts — Web Push: «Вышел релиз» for the subscriber's «Мои конфигурации».
 *
 * The page subscribes through the service worker (sw.js `push` event shows the
 * notification, `notificationclick` opens the page) and sends us the
 * subscription with its favourite config ids (/api/push/subscribe). After every
 * data change (snapshot applied, «Обновить всё») notifyReleases() reads the
 * release journal (release_events) after each subscriber's cursor
 * (last_event_id): releases, branch (ДП) updates and patches of its
 * configurations, one notification per subscriber. VAPID keys are made once
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

/** Save (or refresh) a subscription with the subscriber's favourites; a new one starts at the journal's end. */
export async function saveSubscription(sub: SubscriptionInput, configIds: number[], userAgent?: string) {
  const ids = [...new Set(configIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS);
  const lastId = Number(((await db.execute(sql`SELECT coalesce(max(id), 0)::int AS n FROM release_events`)) as any).rows[0].n);
  const row = { p256dh: sub.keys.p256dh, auth: sub.keys.auth, configIds: ids, userAgent: userAgent?.slice(0, 300) ?? null, failures: 0, updatedAt: new Date() };
  await db.insert(pushSubscriptions).values({ endpoint: sub.endpoint, ...row, lastEventId: lastId })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });   // an existing cursor stays
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

export interface NotifyResult { subscribers: number; notified: number; events: number; gone: number }

interface Ev { id: number; type: string; config_id: number; version: string; data: Record<string, any> }

/** Tell every subscriber about the journal entries after its cursor: releases, branch updates, patches. */
export async function notifyReleases(log: (m: string) => void = (m) => console.log(`[push] ${m}`)): Promise<NotifyResult> {
  const subs = await db.select().from(pushSubscriptions);
  const res: NotifyResult = { subscribers: subs.length, notified: 0, events: 0, gone: 0 };
  if (!subs.length) return res;
  const minId = Math.min(...subs.map((s) => s.lastEventId));
  const ids = [...new Set(subs.flatMap((s) => s.configIds))];
  if (!ids.length) return res;
  const events = ((await db.execute(sql`
    SELECT id, type, config_id, version, data FROM release_events
    WHERE id > ${minId} AND type IN ('release', 'patch') AND config_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    ORDER BY id`)) as any).rows as Ev[];
  const maxId = Number(((await db.execute(sql`SELECT coalesce(max(id), 0)::int AS n FROM release_events`)) as any).rows[0].n);
  const names = new Map<number, string>();
  const nrows = ((await db.execute(sql`SELECT id, coalesce(display_name, name) AS name FROM configurations
    WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)) as any).rows as { id: number; name: string }[];
  for (const r of nrows) names.set(Number(r.id), r.name);

  for (const s of subs) {
    const mine = events.filter((e) => e.id > s.lastEventId && s.configIds.includes(Number(e.config_id)));
    if (!mine.length) {
      if (maxId > s.lastEventId) await db.update(pushSubscriptions).set({ lastEventId: maxId }).where(eq(pushSubscriptions.endpoint, s.endpoint));
      continue;
    }
    const rel = mine.filter((e) => e.type === "release");
    const patches = new Map<string, number>();   // "config:version" → count
    for (const e of mine) if (e.type === "patch") { const k = `${e.config_id}:${e.version}`; patches.set(k, (patches.get(k) ?? 0) + 1); }
    const lines: string[] = [];
    for (const e of rel.slice(0, 4)) lines.push(`${names.get(Number(e.config_id)) ?? "#" + e.config_id} — ${e.version}${e.data?.branch ? " (ветка ДП)" : ""}${e.data?.raised_from ? ", платформа ↑" : ""}`);
    if (rel.length > 4) lines.push(`и ещё релизов: ${rel.length - 4}`);
    for (const [k, c] of [...patches].slice(0, 3)) { const [cid, v] = k.split(":"); lines.push(`${names.get(Number(cid)) ?? "#" + cid} ${v}: ${c} ${c === 1 ? "исправление" : c < 5 ? "исправления" : "исправлений"}`); }
    if (patches.size > 3) lines.push(`и ещё патчей: ${patches.size - 3}`);
    const one = rel.length === 1 && patches.size === 0;
    const payload: Payload = {
      title: one ? "Новый релиз" : rel.length ? `Новых релизов: ${rel.length}${patches.size ? ", патчи" : ""}` : "Новые патчи",
      body: lines.join("\n"),
      url: one ? `/config/${rel[0].config_id}` : patches.size === 1 && !rel.length ? `/config/${[...patches.keys()][0].split(":")[0]}` : "/news?mine=1",
      tag: "releases",
    };
    const r = await send(s, payload);
    if (r === "gone") { res.gone++; continue; }
    if (r !== "ok") continue;   // not delivered: the cursor stays, the next run tries again
    res.notified++; res.events += mine.length;
    await db.update(pushSubscriptions).set({ lastEventId: maxId }).where(eq(pushSubscriptions.endpoint, s.endpoint));
  }
  log(`подписчиков ${res.subscribers}, уведомлено ${res.notified} (событий ${res.events}), отписалось ${res.gone}`);
  return res;
}
