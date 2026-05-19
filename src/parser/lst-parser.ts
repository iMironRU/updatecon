/**
 * lst-parser.ts
 *
 * Faithful TypeScript port of the 1C common module `ПарсерLST`.
 *
 * Goal of THIS file: be a byte-for-byte behavioural twin of the working 1C
 * code so it can be used as an oracle-verified baseline. It is intentionally
 * NOT streaming yet — the 1C original loads the whole text and builds a nested
 * array tree, then walks the flat array. We replicate that exactly first,
 * prove output parity against the 1C log, THEN optimise to a streaming
 * tokenizer that emits records without materialising the full tree.
 *
 * Source file in production:
 *   host  : downloads.v8.1c.ru
 *   path  : /tmplts/v8cscdsc.lst
 *   auth  : HTTP Basic (ИТС login/password)
 *
 * File shape:
 *   { 0, "<date>", "<path>", <numConfigs>, { <flat record array> } }
 *
 * Inside root[4] each configuration record occupies exactly 6 slots:
 *   [0] configId   = [name, vendor, version, "00000000-0000-0000-0000-000000000000"]
 *   [1] numDistribs (string, e.g. "2")
 *   [2] distribsArray
 *   [3] numUpdates  (string, e.g. "1")
 *   [4] updatesPackage = [configId, numFrom, fromList, ... , "path.cfu"]
 *   [5] "path.mft"
 */

const NULL_GUID = "00000000-0000-0000-0000-000000000000";

/** A parsed node is either a scalar token value (string) or a nested group. */
export type LstNode = string | LstNode[];

export interface UpdateRecord {
  /** Конфигурация: Наименование */
  name: string;
  /** Вендор */
  vendor: string;
  /** Версия "до" (целевая версия пакета) */
  version: string;
  /** Путь к .cfu файлу */
  cfuPath: string;
  /** Версии "откуда" — исходные версии, с которых можно ставить пакет */
  fromVersions: string[];
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

type TokenType = "{" | "}" | "," | "s" | "v" | "";

interface Token {
  type: TokenType;
  value: string;
}

class Tokenizer {
  private readonly text: string;
  private pos: number; // 0-based (1C code is 1-based; semantics preserved)
  private readonly len: number;

  constructor(input: string) {
    // Strip BOM (1C: Символ(65279) === U+FEFF).
    this.text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    this.pos = 0;
    this.len = this.text.length;
  }

  private static isSpace(ch: string): boolean {
    // 1C checks: " ", Таб(\t), ПС(\n), ВК(\r).
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  next(): Token {
    while (this.pos < this.len && Tokenizer.isSpace(this.text[this.pos])) {
      this.pos++;
    }
    if (this.pos >= this.len) return { type: "", value: "" };

    const ch = this.text[this.pos];

    if (ch === "{" || ch === "}" || ch === ",") {
      this.pos++;
      return { type: ch as TokenType, value: ch };
    }

    if (ch === '"') return this.readString();

    return this.readAtom();
  }

  /** Mirror of ПрочитатьСтроку: "" is an escaped quote inside a string. */
  private readString(): Token {
    let result = "";
    let start = this.pos + 1; // skip opening quote
    let scan = start;

    while (scan <= this.len) {
      const q = this.text.indexOf('"', scan);
      if (q === -1) {
        // Unterminated string — consume the rest (matches 1C fallback).
        result += this.text.slice(start);
        this.pos = this.len;
        break;
      }
      result += this.text.slice(start, q);
      if (q + 1 < this.len && this.text[q + 1] === '"') {
        // Escaped quote.
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

  /** Mirror of ПрочитатьАтом: read until a delimiter or whitespace. */
  private readAtom(): Token {
    const startPos = this.pos;
    let p = startPos;
    while (p < this.len) {
      const c = this.text[p];
      if (
        c === "{" ||
        c === "}" ||
        c === "," ||
        c === '"' ||
        Tokenizer.isSpace(c)
      ) {
        break;
      }
      p++;
    }
    if (p === startPos) {
      // Defensive: never stall (matches 1C zero-atom guard).
      p = startPos + 1;
    }
    const value = this.text.slice(startPos, p);
    this.pos = p;
    return { type: "v", value };
  }

  // Save/restore for the lookahead-with-rewind the 1C parser relies on.
  mark(): number {
    return this.pos;
  }
  reset(mark: number): void {
    this.pos = mark;
  }
}

// ─── Recursive-descent parser ────────────────────────────────────────────────

/**
 * Mirror of ПрочитатьЗначение. A `{` opens a group; values inside are
 * comma-separated; stray commas are skipped; `}` or EOF closes the group.
 * Scalars ("s"/"v") return their string value.
 */
function parseValue(tk: Tokenizer): LstNode | undefined {
  const token = tk.next();

  if (token.type === "{") {
    const arr: LstNode[] = [];
    for (;;) {
      const mark1 = tk.mark();
      const t1 = tk.next();
      if (t1.type === "}") break;
      if (t1.type === ",") continue;
      if (t1.type === "") break; // EOF inside group
      tk.reset(mark1);

      const v = parseValue(tk);
      if (v !== undefined) arr.push(v);

      const mark2 = tk.mark();
      const t2 = tk.next();
      if (t2.type === "}") break;
      if (t2.type !== ",") tk.reset(mark2);
    }
    return arr;
  }

  if (token.type === "s" || token.type === "v") {
    return token.value;
  }

  return undefined;
}

// ─── Helpers (mirror SokrLP / Stroka / NRег behaviour) ──────────────────────

function asScalar(node: LstNode | undefined): string {
  // Строка() of an array is meaningless here; treat as empty so header /
  // null-GUID checks fail gracefully exactly like they would in practice.
  return typeof node === "string" ? node.trim() : "";
}

function isArray(node: LstNode | undefined): node is LstNode[] {
  return Array.isArray(node);
}

function endsWithCfu(s: string): boolean {
  return s.length >= 4 && s.slice(-4).toLowerCase() === ".cfu";
}

// ─── Extraction (mirror ИзвлечьКонфигурации) ────────────────────────────────

export interface ParseStats {
  configsFound: number;
  packagesEmitted: number;
}

function extractConfigurations(
  records: LstNode[],
): { result: UpdateRecord[]; stats: ParseStats } {
  const result: UpdateRecord[] = [];
  const total = records.length;
  let configsFound = 0;
  let idx = 0;

  while (idx <= total - 6) {
    const el = records[idx];

    // Configuration header: array of >=4 elements whose [3] is the null GUID.
    if (!isArray(el) || el.length < 4 || asScalar(el[3]) !== NULL_GUID) {
      idx += 1;
      continue;
    }

    const name = asScalar(el[0]);
    const vendor = asScalar(el[1]);

    if (name === "") {
      idx += 1;
      continue;
    }

    const updatesPackage = records[idx + 4];

    if (!isArray(updatesPackage)) {
      idx += 1;
      continue;
    }

    configsFound++;

    // updatesPackage is ONE package: [configId, numFrom, fromList, ..., "*.cfu"]
    if (updatesPackage.length < 4) {
      idx += 6;
      continue;
    }

    const pkgConfigId = updatesPackage[0];
    if (!isArray(pkgConfigId) || pkgConfigId.length < 3) {
      idx += 6;
      continue;
    }

    const versionTo = asScalar(pkgConfigId[2]);
    if (versionTo === "") {
      idx += 6;
      continue;
    }

    // Find the .cfu path among package elements.
    let cfuPath = "";
    for (const part of updatesPackage) {
      if (typeof part === "string" && endsWithCfu(part)) {
        cfuPath = part;
        break;
      }
    }
    if (cfuPath === "") {
      idx += 6;
      continue;
    }

    // fromList = updatesPackage[2] : [[name, vendor, fromVersion, guid], ...]
    const fromVersions: string[] = [];
    const fromList = updatesPackage[2];
    if (isArray(fromList)) {
      for (const entry of fromList) {
        if (isArray(entry) && entry.length >= 3) {
          const v = asScalar(entry[2]);
          if (v !== "" && v !== versionTo) {
            fromVersions.push(v);
          }
        }
      }
    }

    result.push({ name, vendor, version: versionTo, cfuPath, fromVersions });
    idx += 6; // jump over the whole 6-slot record
  }

  return { result, stats: { configsFound, packagesEmitted: result.length } };
}

// ─── Public API (mirror РазобратьLST) ────────────────────────────────────────

export interface ParseResult {
  records: UpdateRecord[];
  stats: ParseStats;
}

export function parseLst(text: string): ParseResult {
  const tk = new Tokenizer(text);
  const root = parseValue(tk);

  if (!isArray(root)) {
    return { records: [], stats: { configsFound: 0, packagesEmitted: 0 } };
  }
  if (root.length < 5) {
    return { records: [], stats: { configsFound: 0, packagesEmitted: 0 } };
  }

  const recordArray = root[4];
  if (!isArray(recordArray)) {
    return { records: [], stats: { configsFound: 0, packagesEmitted: 0 } };
  }

  const { result, stats } = extractConfigurations(recordArray);
  return { records: result, stats };
}
