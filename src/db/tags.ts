/**
 * tags.ts — product-line tags ("БУХ", "ЗУП", "УТ", "УНФ", …) per template.
 *
 * Three sources, in priority order:
 *   manual   — set in the admin UI; such templates are never recomputed.
 *   rule     — template name matches the dictionary below. For typical 1C
 *              templates (vendor folder "1c") that is the line itself
 *              (kind "own"); for other vendors it means "built on" (kind
 *              "based"), e.g. "1CMinsk/HRMCorpBe", "practicon/TradeAZS".
 *   solutions — solutions.1c.ru states the base configuration of a partner or
 *              industry product ("Базовая конфигурация: 1С:Бухгалтерия 8");
 *              "Оригинальная" means it is built on nothing. Official, so it
 *              outranks both rules below for non-typical templates.
 *   versions — partner/industry solutions follow the version numbering of
 *              their base (Элеватор 3.0.x = БП 3.0.x). Strict: ≥40 shared
 *              versions, ≥50% of the solution's versions, and a clear winner
 *              over any other line — small shared numbers like 1.0.1.1 are
 *              pure coincidence.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { templateTags } from "./schema.js";
import { templateName } from "./template.js";

export interface TagDef {
  tag: string;
  title: string;
  /** Matched against the template name (last path component). Order matters: first match wins. */
  pattern: RegExp;
  /** Matched against solutions.1c.ru "Базовая конфигурация" ("1С:Бухгалтерия 8"). */
  base: RegExp;
  /** Template name of the line's original product ("Accounting" for БУХ): with
   *  level/country suffixes stripped, it marks the flagship (БП ПРОФ/КОРП/базовая,
   *  БП для Казахстана) as opposed to typical derivatives (БНКО, БАУ). */
  core: string;
}

export const TAGS: TagDef[] = [
  { tag: "ЗКГУ",    title: "Зарплата и кадры государственного учреждения", pattern: /^(StateHRM|BudgetHRM)/i,
    base: /Зарплата и кадры (государственного|бюджетного)/i, core: "StateHRM" },
  { tag: "БГУ",     title: "Бухгалтерия государственного (автономного) учреждения", pattern: /^(StateAccounting|BudgetAccounting|AccountingAI)/i,
    base: /Бухгалтерия (государственного|автономного|бюджетного)/i, core: "StateAccounting" },
  { tag: "БУХ",     title: "Бухгалтерия предприятия",            pattern: /^Accounting(?!G[CP])/i, // not AccountingGC «Гаражи» / GP «Садовод»
    base: /Бухгалтери/i, core: "Accounting" },
  { tag: "ЗУП",     title: "Зарплата и управление персоналом",   pattern: /^HRM/i,
    base: /Зарплата и управление персоналом/i, core: "HRM" },
  { tag: "ERP",     title: "ERP Управление предприятием",        pattern: /^(Enterprise2|ERP)/i,
    base: /ERP/i, core: "Enterprise20" },
  { tag: "УПП",     title: "Управление производственным предприятием", pattern: /^Enterprise/i,
    base: /Управление производственным предприятием/i, core: "Enterprise" },
  { tag: "КА",      title: "Комплексная автоматизация",          pattern: /^ARAutomation/i,
    base: /Комплексная автоматизация/i, core: "ARAutomation" },
  { tag: "УТ",      title: "Управление торговлей",               pattern: /^(Trade|TrCRM|TrCP)/i,
    base: /Управление торговлей/i, core: "Trade" },
  { tag: "УНФ",     title: "Управление нашей фирмой / Управление компанией", pattern: /^(SmallBusiness|CompanyManage?ment)/i,
    base: /Управление (нашей|небольшой) фирмой/i, core: "SmallBusiness" },
  { tag: "Розница", title: "Розница",                            pattern: /^Retail/i,
    base: /Розница/i, core: "Retail" },
  { tag: "ДО",      title: "Документооборот",                    pattern: /^(DocMng|BudgetDocMng)/i,
    base: /Документооборот/i, core: "DocMng" },
  { tag: "Касса",   title: "Касса",                              pattern: /^Cashbox/i,
    base: /(^|[^а-яё])Касса/i, core: "Cashbox" },
];

const MIN_SHARED = 40;
const MIN_SHARE = 0.5;
const MAX_RUNNER_UP = 0.5;

export function tagByName(templateCode: string): TagDef | null {
  const name = templateName(templateCode);
  return TAGS.find((d) => d.pattern.test(name)) ?? null;
}

const isTypical = (templateCode: string) => templateCode.split("/")[0].toLowerCase() === "1c";

interface Row { templateKey: string; tag: string; kind: "own" | "based"; source: "rule" | "solutions" | "versions"; }

/** Recompute rule/versions tags for every template without manual tags. */
export async function refreshTags(): Promise<{ own: number; based: number; bySolutions: number; byVersions: number }> {
  // Latest edition of each template stands for the whole template.
  const latestRes = await db.execute(sql`
    SELECT DISTINCT ON (template_key) id, template_key, template_code
    FROM configurations
    WHERE template_key IS NOT NULL
    ORDER BY template_key, edition DESC
  `);
  const latest = ((latestRes as any).rows ?? latestRes) as { id: number; template_key: string; template_code: string }[];

  const manualRes = await db.execute(sql`
    SELECT DISTINCT template_key FROM template_tags WHERE source = 'manual'
  `);
  const manual = new Set((((manualRes as any).rows ?? manualRes) as { template_key: string }[]).map((r) => r.template_key));

  // Official base configuration from solutions.1c.ru, per template (newest edition).
  const baseRes = await db.execute(sql`
    SELECT DISTINCT ON (c.template_key) c.template_key, si.base_config
    FROM configurations c
    JOIN release_projects rp ON rp.href = c.releases_href
    JOIN solutions_info si ON si.url = rp.info_url AND si.status = 'ok' AND si.base_config IS NOT NULL
    WHERE c.template_key IS NOT NULL
    ORDER BY c.template_key, c.edition DESC
  `);
  const officialBase = new Map(
    (((baseRes as any).rows ?? baseRes) as { template_key: string; base_config: string }[])
      .map((r) => [r.template_key, r.base_config]),
  );

  const rows: Row[] = [];
  let bySolutions = 0;
  const typicalTag = new Map<number, string | null>(); // typical config id → its own tag (or none)
  const pending: { id: number; key: string }[] = [];

  for (const t of latest) {
    const def = tagByName(t.template_code);
    const typical = isTypical(t.template_code);
    if (typical) typicalTag.set(Number(t.id), def?.tag ?? null);
    if (manual.has(t.template_key)) continue;
    const base = !typical ? officialBase.get(t.template_key) : undefined;
    if (base !== undefined) {
      // Official answer: "Оригинальная" = built on nothing; else map the named
      // 1C product to a line (a product outside the dictionary → no tag).
      const baseDef = /Оригинальн/i.test(base) ? null : TAGS.find((d) => d.base.test(base));
      if (baseDef) {
        rows.push({ templateKey: t.template_key, tag: baseDef.tag, kind: "based", source: "solutions" });
        bySolutions++;
      }
      continue;
    }
    if (def) rows.push({ templateKey: t.template_key, tag: def.tag, kind: typical ? "own" : "based", source: "rule" });
    else if (!typical) pending.push({ id: Number(t.id), key: t.template_key });
  }

  // Version overlap: pending solutions vs every typical template (tagged or not —
  // if the best fit is an untagged typical product, the solution gets no tag).
  let byVersions = 0;
  if (pending.length > 0 && typicalTag.size > 0) {
    const ids = (xs: number[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
    const pendingIds = pending.map((p) => p.id);
    const typicalIds = [...typicalTag.keys()];
    const res = await db.execute(sql`
      WITH v AS (
        SELECT DISTINCT config_id, to_version FROM update_edges
        WHERE config_id IN (${ids(pendingIds)}) OR config_id IN (${ids(typicalIds)})
      ),
      tot AS (SELECT config_id, count(*)::int AS n FROM v WHERE config_id IN (${ids(pendingIds)}) GROUP BY 1)
      SELECT a.config_id AS nt, b.config_id AS ty, count(*)::int AS ov, tot.n
      FROM v a
      JOIN v b ON b.to_version = a.to_version
      JOIN tot ON tot.config_id = a.config_id
      WHERE a.config_id IN (${ids(pendingIds)}) AND b.config_id IN (${ids(typicalIds)})
      GROUP BY a.config_id, b.config_id, tot.n
    `);
    // Per solution: best overlap per line ("" = untagged typical product).
    const best = new Map<number, { n: number; perTag: Map<string, number> }>();
    for (const r of ((res as any).rows ?? res) as { nt: number; ty: number; ov: number; n: number }[]) {
      const tag = typicalTag.get(Number(r.ty)) ?? "";
      const e = best.get(Number(r.nt)) ?? { n: Number(r.n), perTag: new Map<string, number>() };
      e.perTag.set(tag, Math.max(e.perTag.get(tag) ?? 0, Number(r.ov)));
      best.set(Number(r.nt), e);
    }
    for (const p of pending) {
      const e = best.get(p.id);
      if (!e) continue;
      const ranked = [...e.perTag.entries()].sort((a, b) => b[1] - a[1]);
      const [winTag, winOv] = ranked[0];
      const runnerUp = ranked[1]?.[1] ?? 0;
      if (!winTag || winOv < MIN_SHARED || winOv / e.n < MIN_SHARE || runnerUp >= winOv * MAX_RUNNER_UP) continue;
      rows.push({ templateKey: p.key, tag: winTag, kind: "based", source: "versions" });
      byVersions++;
    }
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM template_tags WHERE source <> 'manual'`);
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(templateTags).values(rows.slice(i, i + 500)).onConflictDoNothing();
    }
  });

  return {
    own: rows.filter((r) => r.kind === "own").length,
    based: rows.filter((r) => r.kind === "based").length,
    bySolutions,
    byVersions,
  };
}

/**
 * Admin: set tags of a template by hand (empty list = "no tags"), or
 * `null` to drop the manual decision and recompute automatically.
 */
export async function setManualTags(
  templateKey: string,
  tags: { tag: string; kind: "own" | "based" }[] | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM template_tags WHERE template_key = ${templateKey}`);
    if (tags === null) return;
    const values = tags.length > 0
      ? tags.map((t) => ({ templateKey, tag: t.tag, kind: t.kind, source: "manual" }))
      : [{ templateKey, tag: "", kind: "own", source: "manual" }];
    await tx.insert(templateTags).values(values);
  });
  if (tags === null) await refreshTags();
}
