/**
 * lst-parser-stream.ts
 *
 * Streaming variant of the verified ПарСерLST port.
 *
 * The in-memory port (lst-parser.ts) is the correctness oracle: it is a
 * faithful twin of the working 1C module and was hand-verified against raw
 * sample data. This file MUST produce identical records — that parity is
 * checked by verify-stream.ts, so we no longer need 1C in the loop for this
 * step.
 *
 * Difference: we never build the whole tree. The grammar guarantees the flat
 * record array is root[4]; within it a configuration record is exactly 6
 * top-level slots. We track brace depth, and as soon as a full 6-slot record
 * has been read at the record-array depth we extract it, emit it, and discard
 * it. Memory stays ~O(one record) instead of O(whole file).
 *
 * For now the input is still a full string (matches how the file is fetched
 * today). The structural change is the important part; swapping the string
 * for a chunked Readable is mechanical and additive once we wire the fetcher.
 */

import { toCore } from "./version.js";

const NULL_GUID = "00000000-0000-0000-0000-000000000000";

export type LstNode = string | LstNode[];

export interface UpdateRecord {
  name: string;
  vendor: string;
  /** Версия "до" — canonical core only (compound tail dropped at parse). */
  version: string;
  cfuPath: string;
  /** Версии "откуда" — canonical core only. */
  fromVersions: string[];
}

export interface StreamStats {
  configsFound: number;
  packagesEmitted: number;
}

// ─── Tokenizer (identical semantics to the verified port) ───────────────────

type TokenType = "{" | "}" | "," | "s" | "v" | "";
interface Token {
  type: TokenType;
  value: string;
}

class Tokenizer {
  private readonly text: string;
  private pos: number;
  private readonly len: number;

  constructor(input: string) {
    this.text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    this.pos = 0;
    this.len = this.text.length;
  }
  private static isSpace(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }
  next(): Token {
    while (this.pos < this.len && Tokenizer.isSpace(this.text[this.pos]))
      this.pos++;
    if (this.pos >= this.len) return { type: "", value: "" };
    const ch = this.text[this.pos];
    if (ch === "{" || ch === "}" || ch === ",") {
      this.pos++;
      return { type: ch as TokenType, value: ch };
    }
    if (ch === '"') return this.readString();
    return this.readAtom();
  }
  private readString(): Token {
    let result = "";
    let start = this.pos + 1;
    let scan = start;
    while (scan <= this.len) {
      const q = this.text.indexOf('"', scan);
      if (q === -1) {
        result += this.text.slice(start);
        this.pos = this.len;
        break;
      }
      result += this.text.slice(start, q);
      if (q + 1 < this.len && this.text[q + 1] === '"') {
        result += '"';
        start = q + 2;
        scan = start;
      } else {
        this.pos = q + 1;
        break;
      }
    }
    return { type: "s", value: result };
  }
  private readAtom(): Token {
    const startPos = this.pos;
    let p = startPos;
    while (p < this.len) {
      const c = this.text[p];
      if (
        c === "{" || c === "}" || c === "," || c === '"' ||
        Tokenizer.isSpace(c)
      )
        break;
      p++;
    }
    if (p === startPos) p = startPos + 1;
    const value = this.text.slice(startPos, p);
    this.pos = p;
    return { type: "v", value };
  }
  mark(): number {
    return this.pos;
  }
  reset(m: number): void {
    this.pos = m;
  }
}

// Reuse the verified recursive reader for SUBTREES only (a single 6-slot
// record's children are small — bounded, not file-sized).
function parseValue(tk: Tokenizer): LstNode | undefined {
  const token = tk.next();
  if (token.type === "{") {
    const arr: LstNode[] = [];
    for (;;) {
      const m1 = tk.mark();
      const t1 = tk.next();
      if (t1.type === "}") break;
      if (t1.type === ",") continue;
      if (t1.type === "") break;
      tk.reset(m1);
      const v = parseValue(tk);
      if (v !== undefined) arr.push(v);
      const m2 = tk.mark();
      const t2 = tk.next();
      if (t2.type === "}") break;
      if (t2.type !== ",") tk.reset(m2);
    }
    return arr;
  }
  if (token.type === "s" || token.type === "v") return token.value;
  return undefined;
}

// ─── Helpers (identical to the verified port) ───────────────────────────────

function asScalar(n: LstNode | undefined): string {
  return typeof n === "string" ? n.trim() : "";
}
function isArr(n: LstNode | undefined): n is LstNode[] {
  return Array.isArray(n);
}
function endsWithCfu(s: string): boolean {
  return s.length >= 4 && s.slice(-4).toLowerCase() === ".cfu";
}

/**
 * Extract one record from its 6 already-parsed top-level slots.
 * Byte-identical logic to ИзвлечьКонфигурации's per-record body.
 * Returns the record, or null if this 6-slot window is not a valid header
 * (caller then advances by 1 instead of 6 — same resilience heuristic).
 */
function extractRecord(slots: LstNode[]): UpdateRecord | null {
  const el = slots[0];
  if (!isArr(el) || el.length < 4 || asScalar(el[3]) !== NULL_GUID) return null;

  const name = asScalar(el[0]);
  const vendor = asScalar(el[1]);
  if (name === "") return null;

  const pkg = slots[4];
  if (!isArr(pkg)) return null;
  // header matched → counts as a found config even if package is unusable
  if (pkg.length < 4) return { __skip: true } as unknown as UpdateRecord;

  const pkgConfigId = pkg[0];
  if (!isArr(pkgConfigId) || pkgConfigId.length < 3)
    return { __skip: true } as unknown as UpdateRecord;

  const versionToRaw = asScalar(pkgConfigId[2]);
  if (versionToRaw === "") return { __skip: true } as unknown as UpdateRecord;
  const versionTo = toCore(versionToRaw);
  if (versionTo === null) return { __skip: true } as unknown as UpdateRecord;

  let cfuPath = "";
  for (const part of pkg) {
    if (typeof part === "string" && endsWithCfu(part)) {
      cfuPath = part;
      break;
    }
  }
  if (cfuPath === "") return { __skip: true } as unknown as UpdateRecord;

  const fromVersions: string[] = [];
  const fromList = pkg[2];
  if (isArr(fromList)) {
    for (const entry of fromList) {
      if (isArr(entry) && entry.length >= 3) {
        const v = toCore(asScalar(entry[2]));
        if (v !== null && v !== versionTo) fromVersions.push(v);
      }
    }
  }

  return {
    name,
    vendor,
    version: versionTo,
    cfuPath,
    fromVersions,
  };
}

// ─── Streaming driver ───────────────────────────────────────────────────────

/**
 * Walk root, descend into root[4] (the flat record array), and for every
 * 6-slot window invoke the same header check / +6-or-+1 advance as the 1C
 * code — but parse only one record's subtree at a time and emit immediately.
 */
export function parseLstStream(
  text: string,
  onRecord: (rec: UpdateRecord) => void,
): StreamStats {
  const tk = new Tokenizer(text);

  // Enter root group.
  if (tk.next().type !== "{")
    return { configsFound: 0, packagesEmitted: 0 };

  // Read the 4 scalar prefix elements (0, "date", "path", numConfigs) until
  // we reach the nested group that is root[4] — the flat record array.
  let prefixGroupsSeen = 0;
  for (;;) {
    const m = tk.mark();
    const t = tk.next();
    if (t.type === "") return { configsFound: 0, packagesEmitted: 0 };
    if (t.type === ",") continue;
    if (t.type === "}") return { configsFound: 0, packagesEmitted: 0 };
    if (t.type === "{") {
      prefixGroupsSeen++;
      // root[4] is the first nested group at root level.
      tk.reset(m);
      break;
    }
    // scalar prefix element — skip
  }

  // Enter root[4].
  if (tk.next().type !== "{")
    return { configsFound: 0, packagesEmitted: 0 };

  let configsFound = 0;
  let packagesEmitted = 0;

  // Sliding window of up to 6 parsed top-level slots inside root[4].
  let window: LstNode[] = [];

  const flushWindow = () => {
    // Try to interpret the current 6-slot window as a record.
    const rec = extractRecord(window);
    if (rec === null) {
      // Not a header → drop 1 slot (mirror: Инд = Инд + 1).
      window.shift();
      return;
    }
    configsFound++;
    if ((rec as unknown as { __skip?: boolean }).__skip !== true) {
      packagesEmitted++;
      onRecord(rec);
    }
    // Consumed a full record → drop 6 slots (mirror: Инд = Инд + 6).
    window = window.slice(6);
  };

  for (;;) {
    const m = tk.mark();
    const t = tk.next();
    if (t.type === "}") break; // end of root[4]
    if (t.type === "") break; // EOF safety
    if (t.type === ",") continue;
    tk.reset(m);

    const node = parseValue(tk);
    if (node !== undefined) window.push(node);

    if (window.length >= 6) flushWindow();
  }

  // Tail: try remaining windows (the 1C loop condition is Инд <= total-6,
  // so trailing <6 slots are intentionally not emitted — we match that).
  while (window.length >= 6) flushWindow();

  return { configsFound, packagesEmitted };
}
