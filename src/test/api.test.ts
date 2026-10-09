/**
 * api.test.ts — the SQL routes on a real Postgres: the rules that live in several
 * places (the newest version is the highest number, not the newest date; chains,
 * sizes and patches per step; the journal behind the news; the push cursor).
 *
 *   npm test          (builds, then node --test dist/test)
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prepare, clean, seed } from "./db.js";

let app: Awaited<ReturnType<typeof import("../db/server.js").buildServer>>;
const get = async (url: string) => { const r = await app.inject({ method: "GET", url }); assert.equal(r.statusCode, 200, `${url}: ${r.body.slice(0, 200)}`); return r.json(); };

before(async () => {
  await prepare();
  await clean();
  await seed();
  process.env.LOG_LEVEL = "silent";
  ({ app } = { app: await (await import("../db/server.js")).buildServer() });
});
after(async () => { await app.close(); (await import("../db/client.js")).pool.end(); });

test("catalog: the newest version is the highest number, not the newest date", async () => {
  const rows = await get("/api/configs");
  const bp = rows.find((r: any) => Number(r.id) === 1);   // bigint ids arrive as strings
  assert.equal(bp.latest_version, "3.0.103.4");       // 3.0.102.9 came out later but is the LTS branch
  assert.equal(bp.latest_date, "2026-09-01");
  assert.equal(bp.version_count, 4);
  assert.equal(rows.find((r: any) => Number(r.id) === 2).latest_version, "3.0.103.4");
  assert.equal(rows.find((r: any) => Number(r.id) === 4).latest_version, "5.0.2.2");   // LST only, no portal
});

test("configs by version: every match of that edition, nothing capped", async () => {
  const rows = await get("/api/configs?version=3.0.101.2");
  assert.deepEqual(rows.map((r: any) => Number(r.id)).sort(), [1, 2]);
  assert.equal((await get("/api/configs?version=2.0.61.2")).length, 1);
  assert.equal((await get("/api/configs?version=9.9.9.9")).length, 0);
});

test("version suggestions: prefix, newest first, with the configuration count", async () => {
  const s = await get("/api/versions/suggest?q=3.0.10");
  assert.deepEqual(s.map((x: any) => x.version), ["3.0.103.4", "3.0.102.9", "3.0.102.3", "3.0.101.2"]);   // 3.0.100.1 is never a target
  assert.equal(s[0].configs, 2);
  const r = await app.inject({ method: "GET", url: "/api/versions/suggest?q=abc" });
  assert.equal(r.statusCode, 400);
});

test("files: the highest version with its portal links, a note without portal data", async () => {
  const f = await get("/api/files?config_id=1");
  assert.equal(f.version, "3.0.103.4");
  assert.equal(f.nick, "Accounting30");
  assert.match(f.links.update, /version_file\?nick=Accounting30&ver=3\.0\.103\.4/);
  assert.match(f.links.full, /setup\.zip/);
  const g = await get("/api/files?config_id=4");
  assert.equal(g.version, "5.0.2.2");
  assert.ok(g.note);
  assert.match(g.links.cfu, /Rarus\/AutoService\/5_0_2_2\/1cv8\.cfu$/);
});

test("chain: shortest path with sizes, dates and patches per step; editions are not chained", async () => {
  const c = await get("/api/chain?config_id=1&from=3.0.100.1&to=3.0.103.4");
  assert.equal(c.found, true);
  assert.deepEqual(c.steps.map((s: any) => s.toVersion), ["3.0.101.2", "3.0.102.3", "3.0.103.4"]);
  assert.equal(c.steps[1].sizeBytes, 250_000_000);
  assert.equal(c.steps[0].sizeBytes, null);
  assert.equal(c.steps[2].releaseDate, "2026-09-01");
  assert.equal(c.steps[2].patches.length, 2);
  assert.equal(c.steps[2].patches[0].title, "EF_2");                    // newest first
  assert.match(c.steps[2].patchesUrl, /patches\/total\?nick=Accounting30&ver=3\.0\.103\.4/);
  assert.equal(c.totalBytes, 250_000_000);
  assert.equal(c.sizesKnown, 1);
  const lts = await get("/api/chain?config_id=1&from=3.0.100.1&to=3.0.102.9");
  assert.deepEqual(lts.steps.map((s: any) => s.toVersion), ["3.0.101.2", "3.0.102.3", "3.0.102.9"]);
  const x = await get("/api/chain?config_id=3&from=2.0.60.1&to=3.0.103.4");
  assert.equal(x.found, false);
  assert.match(x.note, /редакци/);
});

test("journal: recorded once, flags decided then; the news feed reads it", async () => {
  const { recordEvents } = await import("../db/events.js");
  const r1 = await recordEvents({ horizonDays: 365, onLog: () => {} });
  assert.equal(r1.release, 7);
  assert.equal(r1.patch, 3);
  assert.equal(r1.platform_build, 1);
  const r2 = await recordEvents({ horizonDays: 365, onLog: () => {} });
  assert.equal(r2.total, 0);
  const news = await get("/api/news?days=365");
  const rel = news.events.filter((e: any) => e.type === "release" && e.config_id === 1);
  const byV = Object.fromEntries(rel.map((e: any) => [e.version, e]));
  assert.equal(byV["3.0.100.1"].first, true);                       // the product's first release
  assert.equal(byV["3.0.102.3"].raised_from, "8.3.25.1000");        // minimum platform went up
  assert.equal(byV["3.0.103.4"].raised_from, undefined);
  assert.equal(byV["3.0.102.9"].branch, true);                      // an older line updated after a newer one
  assert.equal(byV["3.0.103.4"].branch, undefined);
  const pat = news.events.filter((e: any) => e.type === "patch" && e.config_id === 1);
  assert.equal(pat.length, 2);                                       // two days → two groups
  assert.equal(news.events.some((e: any) => e.type === "platform_build" && e.build === "8.3.27.1688"), true);
});

test("push: a new subscription starts at the journal's end; favourites are re-sent; the cursor moves only on delivery", async () => {
  const sub = { endpoint: "https://push.example.invalid/send/test-1", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
  const bad = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: { subscription: { endpoint: "x" } } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: { subscription: sub, config_ids: [1, 1, 2, 0, -5] } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().configs, 2);
  const { pool } = await import("../db/client.js");
  const row = async () => (await pool.query("SELECT config_ids, last_event_id, failures FROM push_subscriptions")).rows[0];
  const r = await row();
  assert.deepEqual(r.config_ids, [1, 2]);
  const maxId = Number((await pool.query("SELECT max(id) AS m FROM release_events")).rows[0].m);
  assert.equal(r.last_event_id, maxId);                               // nothing from the past is sent
  const again = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: { subscription: sub, config_ids: [1] } });
  assert.equal(again.json().configs, 1);
  assert.deepEqual((await row()).config_ids, [1]);
  assert.equal((await row()).last_event_id, maxId);                  // the cursor is kept
  // A new patch appears → one event after the cursor. Delivery to the fake endpoint fails,
  // so the cursor must stay for the next run.
  await pool.query(`INSERT INTO patches (config_id, version, uuid, title, patch_date) VALUES (1, '3.0.103.4', '33333333-3333-3333-3333-333333333333', 'EF_3', '2026-09-07')`);
  const { recordEvents } = await import("../db/events.js");
  assert.equal((await recordEvents({ horizonDays: 365, onLog: () => {} })).patch, 1);
  const { notifyReleases } = await import("../db/push.js");
  const res = await notifyReleases(() => {});
  assert.equal(res.subscribers, 1);
  assert.equal(res.notified, 0);
  assert.equal((await row()).last_event_id, maxId);
  assert.equal((await row()).failures, 1);
  const del = await app.inject({ method: "DELETE", url: "/api/push/subscribe", payload: { endpoint: sub.endpoint } });
  assert.equal(del.statusCode, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM push_subscriptions")).rows[0].n, 0);
});
