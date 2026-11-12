/// <reference types="node" />
/**
 * dump-total-row.ts — the raw HTML of one /total row, for names that look wrong.
 *
 * The catalog's display_name is the text of the project link on /total
 * (parse-releases.ts: `href="(.+?)">([^<]+)<`). When a name comes out truncated
 * («Бухгалтерия предприятия (базовая для 1)») we need the original markup to
 * tell our parse from what the portal actually ships — this prints that row,
 * the link text with codepoints, and every tag inside the link.
 *
 *   ITS_LOGIN=… ITS_PASSWORD=… npx tsx tools/dump-total-row.ts AccountingOneBase30
 */
import { ReleasesSession } from "../src/releases/fetch-releases.js";

const nick = process.argv[2] || "AccountingOneBase30";

const s = new ReleasesSession();
await s.login();
const html = await s.get("/total");
console.log(`/total: ${html.length} bytes, link /project/${nick}: ${html.includes(`/project/${nick}`)}`);

// The whole <tr> that carries the project link.
const rowStart = html.indexOf(`/project/${nick}`);
if (rowStart < 0) {
  const near = html.match(new RegExp(`.{0,120}${nick}.{0,120}`));
  console.log("ник не найден; вокруг:", near ? near[0] : "—");
  process.exit(1);
}
const trOpen = html.lastIndexOf("<tr", rowStart);
const trClose = html.indexOf("</tr>", rowStart);
const row = html.slice(trOpen, trClose + 5);
console.log(`\n=== строка (${row.length} символов) ===\n${row}\n=== /строка ===\n`);

// Everything the catalog parse reads: the anchor text and what sits inside it.
const anchor = row.match(/href="(\/project\/[^"?]+)">([\s\S]*?)<\/a>/);
if (!anchor) {
  console.log("ссылка проекта не распознана как href=…>…</a>");
} else {
  const text = anchor[2];
  console.log(`anchor html: ${JSON.stringify(text)}`);
  console.log(`anchor text: ${JSON.stringify(text.replace(/<[^>]+>/g, ""))}`);
  const tags = text.match(/<[^>]+>/g) || [];
  console.log(`теги внутри ссылки: ${tags.length ? tags.join(" ") : "нет"}`);
  const entities = text.match(/&#?\w+;/g) || [];
  console.log(`сущности внутри ссылки: ${entities.length ? entities.join(" ") : "нет"}`);
  console.log(
    "кодпоинты:",
    [...text.replace(/<[^>]+>/g, "")]
      .map((ch) => `${ch}U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(" "),
  );
}

// What our parser would store: the regex from parse-releases.ts.
const hrefMatch = row.match(/href="(\/project\/[^"?]+)">([^<]+)</);
console.log(`\nнаш parse-releases: ${hrefMatch ? JSON.stringify(hrefMatch[2].trim()) : "не совпало"}`);
