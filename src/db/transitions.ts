/**
 * transitions.ts — "переходы": update packages that move a database to
 * another application (УТ базовая → УТ, УТ → КА → ERP, Розница → УНФ) or to
 * another edition of the same one (БП 2.0 → 3.0, УНФ 1.6 → 3.0).
 *
 * Every package in the LST lists its source configurations by name, vendor
 * and version:
 *   { {"УправлениеТорговлей","Фирма ""1С""","11.5.1.1",<guid>}, 2,
 *     { {"УправлениеТорговлейБазовая","Фирма ""1С""","11.5.0.9",<guid>}, … },
 *     "1c/Trade/11_5_1_1/1cv8.cfu" }
 * The locked parsers (lst-parser.ts / lst-parser-stream.ts) keep only the
 * source *versions*, so this is a separate, read-only pass over the same text:
 * a strict mini-parser that bails out on anything that is not a package.
 *
 * Information only: the chain calculator still never crosses editions or
 * products (locked decision in CLAUDE.md).
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { transitions } from "./schema.js";
import { templateCodeFor } from "./template.js";
import { toCore, compareVersions } from "../parser/version.js";
import { parseLstStream, type UpdateRecord } from "../parser/lst-parser-stream.js";

export interface RawTransition {
  fromName: string; fromVendor: string; fromVersion: string;
  toName: string; toVendor: string; toVersion: string;
  cfuPath: string;
}

const STR = '"((?:[^"]|"")*)"';
const GUID = "[0-9a-fA-F-]{36}";
// Package header: {<configId>},<numFrom>,{   — the "{" opens the source list.
const HEADER = new RegExp(`\\{\\s*\\{${STR},${STR},${STR},${GUID}\\}\\s*,\\s*(\\d+)\\s*,\\s*\\{`, "g");
// One source entry, followed by "," (more) or "}" (end of list).
const ENTRY = new RegExp(`\\s*\\{${STR},${STR},${STR},${GUID}\\}\\s*([,}])`, "y");
const EMPTY_LIST = /\s*\}/y;
const TAIL = /\s*,\s*"((?:[^"]|"")*\.cfu)"\s*\}/iy;

const unq = (s: string) => s.replace(/""/g, '"');
const edition = (v: string) => v.split(".")[0];

/** All package sources that change product (name/vendor) or edition. */
export function extractTransitions(text: string): RawTransition[] {
  const out: RawTransition[] = [];
  HEADER.lastIndex = 0;
  let h: RegExpExecArray | null;
  while ((h = HEADER.exec(text)) !== null) {
    const toName = unq(h[1]), toVendor = unq(h[2]);
    const toVersion = toCore(h[3]);
    let pos = HEADER.lastIndex;
    const sources: { name: string; vendor: string; version: string }[] = [];
    let ok = true;
    if (Number(h[4]) === 0) {
      EMPTY_LIST.lastIndex = pos;
      if (!EMPTY_LIST.exec(text)) ok = false; else pos = EMPTY_LIST.lastIndex;
    } else {
      for (;;) {
        ENTRY.lastIndex = pos;
        const e = ENTRY.exec(text);
        if (!e) { ok = false; break; }
        const v = toCore(e[3]);
        if (v) sources.push({ name: unq(e[1]), vendor: unq(e[2]), version: v });
        pos = ENTRY.lastIndex;
        if (e[4] === "}") break;
      }
    }
    if (!ok || !toVersion) continue;          // not a package (a record header, a distribution…)
    TAIL.lastIndex = pos;
    const t = TAIL.exec(text);
    if (!t) continue;
    HEADER.lastIndex = TAIL.lastIndex;
    const cfuPath = unq(t[1]);
    for (const s of sources) {
      if (s.name !== toName || s.vendor !== toVendor || edition(s.version) !== edition(toVersion)) {
        out.push({ fromName: s.name, fromVendor: s.vendor, fromVersion: s.version, toName, toVendor, toVersion, cfuPath });
      }
    }
  }
  return out;
}

const groupKey = (cfuPath: string, name: string, version: string) =>
  `${templateCodeFor(cfuPath, name).toLowerCase()}#${edition(version)}`;

/**
 * Rebuild the transitions table from the LST text. `records` (from the main
 * parse) resolve a source (name, vendor, version) to the application that
 * produced that version; pass null to parse here.
 */
export async function rebuildTransitions(
  text: string,
  records: UpdateRecord[] | null,
  log: (m: string) => void = console.log,
): Promise<{ raw: number; rows: number; unresolved: number }> {
  const raw = extractTransitions(text);
  if (!records) {
    records = [];
    parseLstStream(text, (r) => records!.push(r));
  }

  // Where does a given (name, vendor, version) live? Exact version first,
  // then the most common application of that name/vendor/edition.
  const exact = new Map<string, string>();
  const byEdition = new Map<string, Map<string, number>>();
  for (const r of records) {
    const g = groupKey(r.cfuPath, r.name, r.version);
    exact.set(`${r.name}\u0000${r.vendor}\u0000${r.version}`, g);
    const ek = `${r.name}\u0000${r.vendor}\u0000${edition(r.version)}`;
    const m = byEdition.get(ek) ?? new Map<string, number>();
    m.set(g, (m.get(g) ?? 0) + 1);
    byEdition.set(ek, m);
  }
  const sourceGroup = (name: string, vendor: string, version: string): string | null => {
    const g = exact.get(`${name}\u0000${vendor}\u0000${version}`);
    if (g) return g;
    const m = byEdition.get(`${name}\u0000${vendor}\u0000${edition(version)}`);
    if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  const cfgRes = await db.execute(sql`
    SELECT id, template_key, edition FROM configurations WHERE template_key IS NOT NULL
  `);
  const cfgId = new Map<string, number>();
  for (const r of ((cfgRes as any).rows ?? cfgRes) as { id: number; template_key: string; edition: number }[]) {
    cfgId.set(`${r.template_key}#${r.edition}`, Number(r.id));
  }

  interface Agg {
    fromConfigId: number | null; fromName: string; fromVendor: string; toConfigId: number; kind: string;
    packages: number; fromMin: string; fromMax: string; toMin: string; toMax: string;
  }
  const agg = new Map<string, Agg>();
  let unresolved = 0;
  for (const t of raw) {
    const toGroup = groupKey(t.cfuPath, t.toName, t.toVersion);
    const toId = cfgId.get(toGroup);
    if (toId === undefined) continue;
    const fromGroup = sourceGroup(t.fromName, t.fromVendor, t.fromVersion);
    if (fromGroup === toGroup) continue;      // same application (e.g. a vendor rename)
    const fromId = fromGroup ? cfgId.get(fromGroup) ?? null : null;
    if (fromId === null) unresolved++;
    const kind = fromGroup && fromGroup.split("#")[0] === toGroup.split("#")[0] ? "edition" : "product";
    const key = `${fromId ?? "n:" + t.fromName + "|" + t.fromVendor}>${toId}`;
    const a = agg.get(key);
    if (!a) {
      agg.set(key, { fromConfigId: fromId, fromName: t.fromName, fromVendor: t.fromVendor, toConfigId: toId, kind,
        packages: 1, fromMin: t.fromVersion, fromMax: t.fromVersion, toMin: t.toVersion, toMax: t.toVersion });
    } else {
      a.packages++;
      if (compareVersions(t.fromVersion, a.fromMin) < 0) a.fromMin = t.fromVersion;
      if (compareVersions(t.fromVersion, a.fromMax) > 0) a.fromMax = t.fromVersion;
      if (compareVersions(t.toVersion, a.toMin) < 0) a.toMin = t.toVersion;
      if (compareVersions(t.toVersion, a.toMax) > 0) a.toMax = t.toVersion;
    }
  }

  const rows = [...agg.values()];
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM transitions`);
    for (let i = 0; i < rows.length; i += 500) await tx.insert(transitions).values(rows.slice(i, i + 500));
  });
  log(`Переходы: ${rows.length} (пакетов-источников ${raw.length}, источник не распознан у ${unresolved})`);
  return { raw: raw.length, rows: rows.length, unresolved };
}
