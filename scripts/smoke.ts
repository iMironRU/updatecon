import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLstStream } from "../src/parser/lst-parser-stream.js";
import {
  compareReleaseVersions,
  isReleaseVersion,
  parseProjectPage,
  parseTotalPage,
  parseVersionFilePage,
  parseVersionFilesPage,
} from "../src/releases/parse-releases.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const totalFixture = `
<table>
  <tr group="10"><td><span class="group-name">Тестовая группа</span></td></tr>
  <tr parent-group="10">
    <td class="nameColumn"><a href="/project/Available">Доступная конфигурация</a></td>
    <td class="versionColumn">1.2.3.4</td><td class="releaseDate">01.07.26</td>
    <td class="versionColumn">1.2.4.1</td><td class="planReleaseDate">Август 2026</td>
    <td class="updateDate">02.07.26</td><td class="versionColumn">1.2.5.1</td>
    <td class="publicationDate">03.07.26</td>
  </tr>
  <tr class="disabled" parent-group="10">
    <td class="nameColumn">Недоступная конфигурация</td>
    <td class="versionColumn">2.0.1.1</td><td class="releaseDate">04.07.26</td>
  </tr>
</table>`;

const fixtureRows = parseTotalPage(totalFixture);
assert.equal(fixtureRows.length, 2);
assert.equal(fixtureRows[0].accessible, true);
assert.equal(fixtureRows[1].accessible, false);
assert.equal(fixtureRows[1].groupName, "Тестовая группа");

const projectFixture = `<table><tr><td>2.5.27.61</td><td>13.07.26</td><td>2.5.26.118, 2.5.27.58</td><td>8.3.27.1859</td></tr></table>
<div class="formLine"><h5>Версии для тестирования</h5>
  <p>17.06.26 опубликована версия <a href='/version_files?nick=Accounting30&ver=3.0.200.18'>3.0.200.18</a>, предназначена для тестирования</p>
</div>`;
const projectRows = parseProjectPage(projectFixture);
assert.deepEqual(projectRows[0]?.previousVersions, ["2.5.26.118", "2.5.27.58"]);
assert.equal(projectRows[0]?.isTest, false);
assert.deepEqual(projectRows[1], {
  version: "3.0.200.18",
  releaseDate: "2026-06-17",
  minPlatform: null,
  previousVersions: [],
  isTest: true,
});

const postgresTotalFixture = `
<table>
  <tr group="20"><td><span class="group-name">Технологические дистрибутивы</span></td></tr>
  <tr parent-group="20">
    <td class="nameColumn"><a href="/project/AddCompPostgre">PostgreSQL</a></td>
    <td class="versionColumn">18.3-5.1C</td><td class="releaseDate">26.05.26</td>
  </tr>
</table>`;
assert.equal(parseTotalPage(postgresTotalFixture)[0]?.latestVersion, "18.3-5.1C");
assert.equal(isReleaseVersion("18.3-5.1C"), true);
assert.equal(isReleaseVersion("Зависимости от 22.05.2025"), false);

const postgresProjectFixture = `<table>
  <tr><td>18.3-5.1C</td><td>26.05.26</td><td></td><td></td></tr>
  <tr><td>17.9-3.1C</td><td>26.05.26</td><td></td><td></td></tr>
  <tr><td>9.6.7-1.1С</td><td>20.02.18</td><td></td><td>8.3.10.2252</td></tr>
</table>`;
const postgresRows = parseProjectPage(postgresProjectFixture);
assert.deepEqual(postgresRows.map((row) => row.version), [
  "18.3-5.1C",
  "17.9-3.1C",
  "9.6.7-1.1С",
]);
assert.deepEqual(
  [...postgresRows.map((row) => row.version)].sort(compareReleaseVersions),
  ["9.6.7-1.1С", "17.9-3.1C", "18.3-5.1C"],
);

const javaTotalFixture = `
<table>
  <tr group="30"><td><span class="group-name">Технологические дистрибутивы</span></td></tr>
  <tr parent-group="30">
    <td class="nameColumn"><a href="/project/Axiom11FullJDK">Axiom 11 Full JDK</a></td>
    <td class="versionColumn">11.0.30+9</td><td class="releaseDate">15.07.26</td>
  </tr>
</table>`;
assert.equal(parseTotalPage(javaTotalFixture)[0]?.latestVersion, "11.0.30+9");
assert.equal(isReleaseVersion("11.0.29+12"), true);
const javaProjectRows = parseProjectPage(`<table>
  <tr><td>11.0.30+9</td><td>15.07.26</td><td></td><td></td></tr>
  <tr><td>11.0.29+12</td><td>20.05.26</td><td></td><td></td></tr>
</table>`);
assert.deepEqual(javaProjectRows.map((row) => row.version), ["11.0.30+9", "11.0.29+12"]);
assert.equal(compareReleaseVersions("11.0.29+12", "11.0.30+9") < 0, true);

const filesFixture = `<div class="formLine fileInfoFormLine">
  <a href="/version_file?nick=Trade110&amp;ver=11.5.27.61&amp;path=Trade%5c11_5_27_61%5cTrade_11_5_27_61_updsetup.zip">Дистрибутив обновления</a>
  <a href="/files/properties/version-files/42">Свойства</a>
</div><div class="formLine fileInfoFormLine">
  <a href="/version_file?nick=Trade110&amp;ver=11.5.27.61&amp;path=Trade%5c11_5_27_61%5cReadMe.txt">ReadMe</a>
</div><div>Минимальная версия платформы: 8.3.27.1859</div>
<div>Релиз, опубликованный на данной странице, предназначен только для тестирования!</div>`;
const filesPage = parseVersionFilesPage(filesFixture);
assert.equal(filesPage.resources.length, 2);
assert.equal(filesPage.resources[0]?.kind, "update_distribution");
assert.equal(filesPage.resources[0]?.propertiesId, "42");
assert.equal(filesPage.resources[0]?.fileName, "Trade_11_5_27_61_updsetup.zip");
assert.equal(filesPage.minPlatform, "8.3.27.1859");
assert.equal(filesPage.isTest, true);

const fileLandingFixture = `<dl>
  <dt>Пользовательское название:</dt><dd>Дистрибутив обновления</dd>
  <dt>Имя файла:</dt><dd>AccountingOneBase_3_0_202_14_updsetup.zip</dd>
  <dt>Размер:</dt><dd>429.15 Мб (450 000 123 байт)</dd>
  <dt>Дата публикации:</dt><dd>18.07.2026</dd>
  <dt>Контрольная сумма SHA-512:</dt><dd>${"a1".repeat(64)}</dd>
</dl><a href="https://downloads.v8.1c.ru/example">Скачать дистрибутив</a>`;
const fileMetadata = parseVersionFilePage(fileLandingFixture);
assert.equal(fileMetadata.fileName, "AccountingOneBase_3_0_202_14_updsetup.zip");
assert.equal(fileMetadata.fileSizeBytes, 450000123);
assert.equal(fileMetadata.publishedAt, "2026-07-18");
assert.equal(fileMetadata.sha512, "a1".repeat(64));

const htmlPath = argument("--html");
if (htmlPath) {
  const rows = parseTotalPage(readFileSync(htmlPath, "utf8"));
  const available = rows.filter((row) => row.accessible).length;
  const unavailable = rows.length - available;
  assert(rows.length > 0, "Страница /total не распознана");
  const target = rows.find((row) =>
    row.displayName.includes("Корпоративное хранилище данных"),
  );
  console.log(`HTML: ${rows.length} строк, доступно ${available}, недоступно ${unavailable}`);
  if (target) {
    console.log(`HTML: ${target.displayName} — ${target.accessible ? "доступна" : "нет доступа"}`);
  }
}

const versionHtmlPath = argument("--version-html");
if (versionHtmlPath) {
  const page = parseVersionFilesPage(readFileSync(versionHtmlPath, "utf8"));
  assert(page.resources.length > 0, "Страница релиза не содержит распознанных ссылок");
  assert(
    page.resources.some((resource) => resource.kind === "update_distribution"),
    "На странице релиза не найден дистрибутив обновления",
  );
  console.log(`Страница релиза: ${page.resources.length} ссылок`);
}

const lstPath = argument("--lst");
if (lstPath) {
  let records = 0;
  const raw = readFileSync(lstPath, "utf8");
  const stats = parseLstStream(raw, () => records++);
  assert(stats.configsFound > 0, "LST не содержит распознанных записей");
  assert.equal(records, stats.packagesEmitted);
  console.log(`LST: ${stats.configsFound} записей, ${stats.packagesEmitted} пакетов`);
}

console.log("Smoke-проверка пройдена");
