/**
 * scripts.ts — ready-to-run scripts for the user's own machine:
 *   chain    download an update chain's .cfu files from downloads.v8.1c.ru and
 *            apply them to an infobase in the designer's batch mode
 *   platform download a 1С:Предприятие build from releases.1c.ru and install it
 * for Windows (PowerShell) and Linux (bash). Templates live in src/scripts
 * (copied to dist/scripts like src/admin); @@NAME@@ markers are filled here.
 * Nothing secret goes into a script: the ITS account is asked for when it runs
 * and is sent only to 1C's servers.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(__dirname, "..", "scripts");

export type ScriptOs = "windows" | "linux";

export interface ScriptFile {
  filename: string;
  contentType: string;
  body: string | Buffer;
}

export interface ChainScriptInput {
  title: string;          // «Бухгалтерия предприятия, редакция 3.0»
  slug: string;           // ASCII part of the file name: "Accounting"
  from: string;
  to: string;
  steps: { version: string; cfuPath: string; platform: string | null }[];
  site: string;           // https://upd.imiron.ru
}

export interface PlatformScriptInput {
  version: string;        // 8.3.27.2342; "" — any build, chosen at run time (-Version / --version)
  site: string;
}

/** Linux: the unified installer (setup-full-*.run) exists from 8.3.20 on. */
export function linuxInstallerAvailable(version: string): boolean {
  const [a, b, c] = version.split(".").map(Number);
  return a > 8 || (a === 8 && (b > 3 || (b === 3 && c >= 20)));
}

const psq = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const shq = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";
const fill = (tpl: string, values: Record<string, string>) =>
  tpl.replace(/@@([A-Z_]+)@@/g, (m, k: string) => (k in values ? values[k] : m));
const template = (name: string) => readFileSync(join(TEMPLATES, name), "utf8");
const today = () => new Date().toISOString().slice(0, 10);
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
};
const host = (site: string) => site.replace(/^https?:\/\//, "");

/** Where downloads.v8.1c.ru serves a package (the LST path, backslashes possible). */
export function cfuUrl(cfuPath: string): string {
  return "https://downloads.v8.1c.ru/tmplts/" +
    cfuPath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

export function chainScript(os: ScriptOs, d: ChainScriptInput): ScriptFile {
  const base = `updatecon-${d.slug}-${d.from}-${d.to}`;
  const file = base + (os === "windows" ? ".ps1" : ".sh");
  const steps = d.steps.map((s, i) => ({
    n: i + 1,
    version: s.version,
    file: `${String(i + 1).padStart(2, "0")}-${s.version}.cfu`,
    url: cfuUrl(s.cfuPath),
    platform: s.platform ?? "",
  }));
  const common = {
    TITLE: d.title.replace(/[\r\n]+/g, " "),
    FROM: d.from,
    TO: d.to,
    STEPS_TEXT: `${steps.length} ${plural(steps.length, "шаг", "шага", "шагов")}`,
    SITE: host(d.site),
    DATE: today(),
    FILE: file,
  };
  if (os === "windows") {
    const body = fill(template("chain.ps1"), {
      ...common,
      TITLE_Q: psq(common.TITLE), FROM_Q: psq(d.from), TO_Q: psq(d.to), SITE_Q: psq(d.site),
      WORKDIR_Q: psq(base),
      STEPS: steps.map((s) =>
        `  @{ N = ${s.n}; Version = ${psq(s.version)}; File = ${psq(s.file)}; Url = ${psq(s.url)}; Platform = ${psq(s.platform)} }`,
      ).join(",\n"),
    });
    return { filename: file, contentType: "text/plain; charset=utf-8", body: windowsText(body) };
  }
  const body = fill(template("chain.sh"), {
    ...common,
    TITLE_Q: shq(common.TITLE), FROM_Q: shq(d.from), TO_Q: shq(d.to), SITE_Q: shq(d.site),
    WORKDIR_Q: shq(base),
    STEP_VERSIONS: steps.map((s) => shq(s.version)).join(" "),
    STEP_FILES: steps.map((s) => shq(s.file)).join(" "),
    STEP_URLS: steps.map((s) => shq(s.url)).join(" "),
    STEP_PLATFORMS: steps.map((s) => shq(s.platform)).join(" "),
  });
  return { filename: file, contentType: "text/x-shellscript; charset=utf-8", body };
}

export function platformScript(os: ScriptOs, d: PlatformScriptInput): ScriptFile {
  const file = (d.version ? `updatecon-platform-${d.version}` : "install-1c-platform") + (os === "windows" ? ".ps1" : ".sh");
  const common = {
    VERSION_TITLE: d.version || "(сборка на выбор)",
    VERSION_DEFAULT: d.version || "скрипт спросит: последняя 8.3, последняя 8.5 или свой номер",
    VERSION_DEFAULT_NOTE: d.version ? `; без параметра — ${d.version}` : "",
    SITE: host(d.site), DATE: today(), FILE: file,
  };
  if (os === "windows") {
    const body = fill(template("platform.ps1"), { ...common, VERSION_Q: psq(d.version), SITE_Q: psq(d.site) });
    return { filename: file, contentType: "text/plain; charset=utf-8", body: windowsText(body) };
  }
  const body = fill(template("platform.sh"), { ...common, VERSION_Q: shq(d.version), SITE_Q: shq(d.site) });
  return { filename: file, contentType: "text/x-shellscript; charset=utf-8", body };
}

/**
 * Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page,
 * which garbles every Russian string: UTF-8 with BOM and CRLF line ends.
 */
function windowsText(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8")]);
}
