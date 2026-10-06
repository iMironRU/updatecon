/**
 * exchanges.ts — обмены и переходы между типовыми конфигурациями.
 *
 * Source: the 1CExchenge registry (github.com/iMironRU/1CExchenge), built from
 * the full distributions on the author's machine (ibcmd scans of CF, delivery
 * files) and published as data/registry.json. We only consume it: step 4 of
 * «Обновить всё» downloads the JSON and replaces the `exchanges` /
 * `exchange_formats` tables. The registry stays the source of truth; the
 * matrix «из → в» lives on its page, we link there.
 *
 * Sides are the registry's product keys («БП», «УТ», «ДО КОРП») plus an edition.
 * Mapping to our configurations: KEY_TEMPLATE (product key → template_code)
 * + the edition's first segment, falling back to the metadata name the registry
 * saw in the CF. Products outside the catalog (7.7, mobile apps, «прежние
 * программы») keep their label and no config id.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";

export const REGISTRY_URL = process.env.EXCHANGES_URL
  ?? "https://raw.githubusercontent.com/iMironRU/1CExchenge/main/data/registry.json";
export const REGISTRY_PAGE = "https://imiron.ru/1CExchenge/";

// Registry product key → our template_code. Editions pick the configuration row.
const KEY_TEMPLATE: Record<string, string> = {
  "БП": "1c/Accounting", "БП КОРП": "1c/AccountingCorp", "БНО": "1c/AccountingNPO",
  "УТ": "1c/Trade", "Розница": "1c/Retail", "УНФ": "1c/SmallBusiness",
  "УПП": "1c/Enterprise", "ERP": "1c/Enterprise20", "КА": "1c/ARAutomation",
  "ДО КОРП": "1c/DocMngCorp", "ЗУП": "1c/HRM", "ЗУП КОРП": "1c/HRMCorp",
  "БГУ": "1c/StateAccounting", "ЗКГУ": "1c/StateHRM", "ЗБУ": "1c/StateHRM", "БМО": "1c/BMO",
  "1С:Архив": "1c/Archive", "1С:Касса": "1c/CashboxBase", "РМК": "1c/PayDesk",
  "Вещевое довольствие": "1c/UniformAllowances", "Отчетность предпринимателя": "1c/erbase",
  "Больничная аптека": "MedSol/HospPh", "Плановое питание": "Captain/FoodComb",
  "Клиент ЭДО": "1c/ClientEDOBase", "Управление холдингом": "1c/DocMngHolding3",
};
// Sides the registry lists without an edition: the catalog edition to use.
const KEY_EDITION: Record<string, number> = { "1С:Архив": 1, "1С:Касса": 4, "РМК": 1 };
// Registry sides whose metadata name is a different template than the key's
// default (the key is a family: «БГУ» covers БГУ and БГУ КОРП, «КАМИН» two products).
const NAME_TEMPLATE: Record<string, string> = {
  "БухгалтерияГосударственногоУчрежденияКОРП": "1c/StateAccountingCorp",
  "ЗарплатаИКадрыГосударственногоУчрежденияКОРП": "1c/StateHRMCorp",
  "БухгалтерияНекоммерческойОрганизацииКОРП": "1c/AccountingNPOCorp",
  "ЗарплатаИКадрыБюджетногоУчреждения": "1c/StateHRM",
  "КаминЗарплатаДляБюджетныхУчреждений": "1ckamin/zpl55",
  "КаминЗарплата": "1ckamin/zpl50",
  "КассаБазовая": "1c/CashboxBase",
};

interface Side { product: string; edition: string | null; name: string | null; line: string }
interface Link {
  id: number; kind: string; mechanism: string; from: Side; to: Side;
  exchangePlan: string | null; formatVersions: string[] | null;
  content: { summary?: Record<string, number> } | null;
  class: { task: string; dir: string; actual: string };
  sources: string[]; shippedIn: { path: string; product: string; version: string }[];
  urls?: string[]; notes?: string | null;
}
interface Registry {
  generated: string; links: Link[];
  enterpriseData: { config: string; line: string; version: string; declared: string[]; packages: string[] }[];
}

export interface ExchangesResult { links: number; linked: number; formats: number; generated: string }

export async function syncExchanges(opts: { onLog?: (m: string) => void; registry?: Registry } = {}): Promise<ExchangesResult> {
  const log = opts.onLog ?? console.log;
  let reg = opts.registry;
  if (!reg) {
    const r = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`реестр обменов: HTTP ${r.status} на ${REGISTRY_URL}`);
    reg = (await r.json()) as Registry;
  }
  if (!Array.isArray(reg.links)) throw new Error("реестр обменов: нет поля links");

  // configurations by (template_key, edition) and by metadata name
  const rows = ((await db.execute(sql`SELECT id, template_key, edition, name FROM configurations`)) as any).rows as
    { id: number; template_key: string; edition: number | null; name: string }[];
  const byTemplate = new Map<string, number>();
  for (const c of rows) byTemplate.set(`${c.template_key}#${c.edition}`, c.id);
  const resolve = (s: Side): number | null => {
    const ed = s.edition ? Number(s.edition.split(".")[0]) : (KEY_EDITION[s.product] ?? null);
    const tpl = (s.name && NAME_TEMPLATE[s.name]) || KEY_TEMPLATE[s.product];
    if (!tpl || ed === null) return null;
    return byTemplate.get(`${tpl.toLowerCase()}#${ed}`) ?? null;
  };

  let linked = 0;
  const values = reg.links.map((l) => {
    const f = resolve(l.from), t = resolve(l.to);
    if (f || t) linked++;
    return {
      id: l.id, kind: l.kind, mechanism: l.mechanism,
      from_product: l.from.product, from_edition: l.from.edition, from_label: l.from.line, from_config_id: f,
      to_product: l.to.product, to_edition: l.to.edition, to_label: l.to.line, to_config_id: t,
      exchange_plan: l.exchangePlan, task: l.class?.task ?? null, direction: l.class?.dir ?? null, actual: l.class?.actual ?? null,
      format_versions: l.formatVersions ?? null, objects: l.content?.summary ?? null,
      sources: l.sources ?? null, shipped_in: l.shippedIn ?? null, urls: l.urls ?? null, notes: l.notes ?? null,
    };
  });
  const lineConfig = new Map<string, number | null>();
  for (const l of reg.links) for (const s of [l.from, l.to]) if (!lineConfig.has(s.line)) lineConfig.set(s.line, resolve(s));
  const formats = (reg.enterpriseData ?? []).map((e) => ({
    line: e.line, config_id: lineConfig.get(e.line) ?? null, version: e.version ?? "",
    declared: e.declared ?? null, packages: e.packages ?? null,
  }));

  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM exchange_formats`);
    await tx.execute(sql`DELETE FROM exchanges`);
    if (values.length) {
      await tx.execute(sql`
        INSERT INTO exchanges (id, kind, mechanism, from_product, from_edition, from_label, from_config_id,
          to_product, to_edition, to_label, to_config_id, exchange_plan, task, direction, actual,
          format_versions, objects, sources, shipped_in, urls, notes)
        SELECT id, kind, mechanism, from_product, from_edition, from_label, from_config_id,
          to_product, to_edition, to_label, to_config_id, exchange_plan, task, direction, actual,
          format_versions, objects, sources, shipped_in, urls, notes
        FROM json_populate_recordset(NULL::exchanges, ${JSON.stringify(values)}::json)`);
    }
    if (formats.length) {
      await tx.execute(sql`
        INSERT INTO exchange_formats (line, config_id, version, declared, packages)
        SELECT line, config_id, version, declared, packages
        FROM json_populate_recordset(NULL::exchange_formats, ${JSON.stringify(formats)}::json)`);
    }
  });
  log(`Реестр обменов от ${String(reg.generated).slice(0, 10)}: связей ${values.length}, с нашими конфигурациями ${linked}, форматов EnterpriseData ${formats.length}`);
  return { links: values.length, linked, formats: formats.length, generated: reg.generated };
}

/** The links of one configuration (either side), its EnterpriseData formats. */
export async function configExchanges(configId: number) {
  const links = ((await db.execute(sql`
    SELECT e.*, cf.display_name AS from_display, cf.name AS from_name, ct.display_name AS to_display, ct.name AS to_name
    FROM exchanges e
    LEFT JOIN configurations cf ON cf.id = e.from_config_id
    LEFT JOIN configurations ct ON ct.id = e.to_config_id
    WHERE e.from_config_id = ${configId} OR e.to_config_id = ${configId}
    ORDER BY e.kind, e.actual, e.to_label, e.from_label, e.id`)) as any).rows as any[];
  const formats = ((await db.execute(sql`SELECT * FROM exchange_formats WHERE config_id = ${configId} ORDER BY line, version DESC`)) as any).rows as any[];
  return { links: links.map(shape), formats: formats.map((f) => ({ line: f.line, version: f.version, declared: f.declared, packages: f.packages })) };
}

export async function allExchanges() {
  const links = ((await db.execute(sql`
    SELECT e.*, cf.display_name AS from_display, cf.name AS from_name, ct.display_name AS to_display, ct.name AS to_name
    FROM exchanges e
    LEFT JOIN configurations cf ON cf.id = e.from_config_id
    LEFT JOIN configurations ct ON ct.id = e.to_config_id
    ORDER BY e.id`)) as any).rows as any[];
  return { registry: REGISTRY_PAGE, links: links.map(shape) };
}

function shape(r: any) {
  const side = (p: "from" | "to") => ({
    product: r[`${p}_product`], edition: r[`${p}_edition`], label: r[`${p}_label`],
    config_id: r[`${p}_config_id`], config_name: r[`${p}_display`] || r[`${p}_name`] || null,
  });
  return {
    id: r.id, kind: r.kind, mechanism: r.mechanism, from: side("from"), to: side("to"),
    exchange_plan: r.exchange_plan, task: r.task, direction: r.direction, actual: r.actual,
    format_versions: r.format_versions, objects: r.objects, sources: r.sources, shipped_in: r.shipped_in,
    urls: r.urls, notes: r.notes,
  };
}
