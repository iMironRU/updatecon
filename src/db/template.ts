/**
 * template.ts — application identity helpers.
 *
 * An application edition is identified by the template folder of its update
 * packages plus the edition (first version segment), not by the LST metadata
 * name (that one is not unique across vendors and changes on renames).
 *
 * The folder is the cfu_path prefix before the version folder:
 *   "1c/Accounting/3_0_197_22/1cv8.cfu"    -> "1c/Accounting"
 *   "KassirBase/4_0_6_1/1cv8.cfu"          -> "KassirBase"
 *   "AXELOT/MDM/2_0_4_15/Update/1Cv8.cfu"  -> "AXELOT/MDM"
 *
 * Mirrors the SQL in drizzle/0005_sleepy_nocturne.sql — keep them in sync.
 */

const VERSION_FOLDER = /^\d+(?:_\d+){3,}$/;

/** Template folder of an update package, or null if the path has none. */
export function templateOf(cfuPath: string): string | null {
  const segs = cfuPath.replace(/\\/g, "/").split("/");
  const i = segs.findIndex((s) => VERSION_FOLDER.test(s));
  if (i <= 0) return null;
  return segs.slice(0, i).join("/") || null;
}

/** Template code with a fallback for records without a recognisable folder. */
export function templateCodeFor(cfuPath: string, name: string): string {
  return templateOf(cfuPath) ?? "~" + name;
}

/** Last component of a template code: "1c/Accounting" -> "Accounting". */
export function templateName(code: string): string {
  const i = code.lastIndexOf("/");
  return i >= 0 ? code.slice(i + 1) : code;
}

// What may follow the template name in a releases.1c.ru nick: edition digits
// ("30", "110", "_82_20") and an optional "_New". Anything else ("Corp30",
// "Kz") means a different template.
const NICK_SUFFIX = /^(?:_?\d{1,3}){0,3}(?:_?new)?$/i;

/**
 * Does a releases.1c.ru nick belong to this template?
 *   "Accounting30"     ~ "1c/Accounting"
 *   "AccountingCorp30" ≁ "1c/Accounting"   (that is "1c/AccountingCorp")
 */
export function nickMatchesTemplate(nick: string, code: string): boolean {
  const t = templateName(code).toLowerCase();
  const n = nick.toLowerCase();
  return t.length > 0 && !t.startsWith("~") && n.startsWith(t) && NICK_SUFFIX.test(n.slice(t.length));
}
