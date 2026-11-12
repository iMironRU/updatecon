/**
 * parse-releases.test.ts — the catalog name cleaning, on the cases the portal
 * actually ships: markup/entities inside the project link, double spaces, and a
 * name that only *looks* truncated (1C's own text, see issue #39).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanProjectName, parseTotalPage } from "../releases/parse-releases.js";

test("name: markup inside the link does not leak into the catalog", () => {
  assert.equal(cleanProjectName('Айлант: <b>Управление ЖКХ</b> КОРП'), "Айлант: Управление ЖКХ КОРП");
});

test("name: entities are decoded, non-breaking spaces become spaces", () => {
  assert.equal(cleanProjectName("1С:Бухгалтерия&nbsp;&amp;&nbsp;учёт"), "1С:Бухгалтерия & учёт");
  assert.equal(cleanProjectName("&#171;БП&#187; 3.0"), "«БП» 3.0");
  assert.equal(cleanProjectName("ООО &quot;Ромашка&quot;"), 'ООО "Ромашка"');
});

test("name: a double space is collapsed (id 176 in the live catalog)", () => {
  assert.equal(cleanProjectName("Управление ЖКХ  КОРП, ред. 3.1"), "Управление ЖКХ КОРП, ред. 3.1");
});

test("name: the portal's own truncated text is kept as is, not invented", () => {
  // /project/AccountingOneBase30 ships exactly this in its link text (checked
  // against the raw row): «1)» is 1C's, not our cut. Cleaning must not guess.
  const raw = "Бухгалтерия предприятия (базовая для 1), редакция 3.0; 1С:БизнесСтарт";
  assert.equal(cleanProjectName(raw), raw);
});

test("total page: a tagged link text is read whole, not cut at the tag", () => {
  const row = `<table><tr parent-group="4" style="">
    <td class="nameColumn"><a href="/project/X30"><span class="bold">Бухгалтерия</span> предприятия, редакция 3.0</a></td>
    <td class="versionColumn actualVersionColumn"><a href="/version_files?nick=X30&ver=3.0.1.2">3.0.1.2</a></td>
    <td class="releaseDate"><span>01.02.26</span></td>
  </tr></table>`;
  const [c] = parseTotalPage(row);
  assert.equal(c.href, "/project/X30");
  assert.equal(c.displayName, "Бухгалтерия предприятия, редакция 3.0");
  assert.equal(c.latestVersion, "3.0.1.2");
});
