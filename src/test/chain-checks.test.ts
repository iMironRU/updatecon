/**
 * chain-checks.test.ts — the verdict of the comparison with 1C's update service.
 *
 * The service's `upgradeSequence` is its own recommended order of files, not the
 * shortest path: 3.1.37.54 → 3.1.39.53 is 3 files for it, while both legs of a
 * 2-file path are packages whose from-lists include the previous version (#47).
 * So «наш путь короче» must not read as an error, and the statuses it produces
 * must stay distinct from «нет пути».
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCheck } from "../db/chain-checks.js";

const svc = (o: { known?: boolean; next?: string | null; files?: number | null }) =>
  ({ known: o.known ?? true, next: o.next ?? null, files: o.files ?? null });
const ours = (o: { found?: boolean; steps?: number; targetKnown?: boolean }) =>
  ({ found: o.found ?? true, steps: o.steps ?? 1, targetKnown: o.targetKnown ?? true });

test("служба не знает программу или версию → unknown", () => {
  assert.equal(compareCheck(svc({ known: false }), ours({}), null, "1.0.0.1").status, "unknown");
});

test("сервис говорит «актуальна», у нас тоже → match", () => {
  const r = compareCheck(svc({ next: null }), ours({}), "1.0.0.5", "1.0.0.5");
  assert.equal(r.status, "match");
  assert.equal(r.note, "актуальна");
});

test("сервис говорит «актуальна», а у нас есть следующая → ours_longer (региональные линейки)", () => {
  const r = compareCheck(svc({ next: null }), ours({}), "1.0.0.7", "1.0.0.5");
  assert.equal(r.status, "ours_longer");
  assert.match(r.note ?? "", /версия актуальна, у нас есть 1\.0\.0\.7/);
});

test("целевой версии у нас ещё нет → behind, это не ошибка цепочки", () => {
  assert.equal(compareCheck(svc({ next: "1.0.1.0", files: 2 }), ours({ targetKnown: false }), null, "1.0.0.5").status, "behind");
});

test("пути до цели нет → no_path, единственный настоящий дефект", () => {
  assert.equal(compareCheck(svc({ next: "1.0.1.0", files: 2 }), ours({ found: false, steps: 0 }), null, "1.0.0.5").status, "no_path");
});

test("одинаковое число шагов → match", () => {
  const r = compareCheck(svc({ next: "1.0.1.0", files: 2 }), ours({ steps: 2 }), "1.0.1.0", "1.0.0.5");
  assert.equal(r.status, "match");
  assert.match(r.note ?? "", /^2 шага до /);
});

test("наш путь короче рекомендованного сервисом → ours_shorter, в тексте «короче»", () => {
  const r = compareCheck(svc({ next: "3.1.39.53", files: 3 }), ours({ steps: 2 }), "3.1.39.53", "3.1.37.54");
  assert.equal(r.status, "ours_shorter");
  assert.match(r.note ?? "", /наш путь короче: 2 против 3/);
});

test("наш путь длиннее сервиса → ours_longer, в тексте «длиннее»", () => {
  const r = compareCheck(svc({ next: "1.0.1.0", files: 2 }), ours({ steps: 4 }), "1.0.1.0", "1.0.0.5");
  assert.equal(r.status, "ours_longer");
  assert.match(r.note ?? "", /наш путь длиннее: 4 против 2/);
});

test("сервис не назвал число файлов → match, сравнивать нечего", () => {
  assert.equal(compareCheck(svc({ next: "1.0.1.0", files: null }), ours({ steps: 4 }), "1.0.1.0", "1.0.0.5").status, "match");
});
