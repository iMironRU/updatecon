/**
 * solutions.ts — product cards from solutions.1c.ru ("1С:Решения").
 *
 * releases.1c.ru project pages link to "Общая информация о конфигурации";
 * for industry/partner products that is solutions.1c.ru/catalog/<slug>/…,
 * whose product_summary block carries structured fields:
 *   Программный продукт 1С-Совместно
 *   Тип предприятий: Коммерческий, Государственный
 *   Подходит для стран: Россия | Для всех стран
 *   Версии: Базовая, Стандарт, ПРОФ, КОРП
 *   Разработчик: 1С, ЦентрПрограммСистем
 *   Базовая конфигурация: 1С:Бухгалтерия 8 | Оригинальная
 *   Подходит для отраслей: <a href="/agriculture">Сельское хозяйство</a>
 *   Подходит для задач: Комплексное управление ресурсами предприятия (ERP)
 * plus a support block (phone / e-mail). Public site, no auth; fetched
 * politely (one page a second) and refreshed weekly.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { solutionsInfo } from "../db/schema.js";

const MAX_AGE_DAYS = 7;
const DELAY_MS = 1000;
const TIMEOUT_MS = 20000;
const USER_AGENT = "Mozilla/5.0 (compatible; Updatecon/1.0; 1C update navigator)";

export interface SolutionPage {
  title: string | null;
  productKind: string | null;
  enterpriseTypes: string[];
  countries: string[];
  developers: string[];
  baseConfig: string | null;
  industries: string[];
  tasks: string[];
  editions: string[];
  supportPhone: string | null;
  supportEmail: string | null;
}

const decode = (s: string) => s
  .replace(/&nbsp;|&#160;/g, " ").replace(/&quot;/g, '"').replace(/&laquo;/g, "«")
  .replace(/&raquo;/g, "»").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Parse a solutions.1c.ru product page; null when it has no product block. */
export function parseSolutionPage(html: string): SolutionPage | null {
  const start = html.indexOf('class="product_summary"');
  if (start < 0) return null;
  const endCandidates = ['class="workplaces"', 'class="sidebar_links', "</aside>"]
    .map((m) => html.indexOf(m, start)).filter((i) => i > 0);
  const block = html.slice(start, endCandidates.length ? Math.min(...endCandidates) : start + 20000);

  const kind = block.match(/class="product_type__title">([^<]+)</);
  const out: SolutionPage = {
    title: null,
    productKind: kind ? text(kind[1]).replace(/^Программный продукт\s*/i, "") || null : null,
    enterpriseTypes: [], countries: [], developers: [], baseConfig: null,
    industries: [], tasks: [], editions: [], supportPhone: null, supportEmail: null,
  };

  // Each item: <div class="product_(info|suitable)__title">Label:</div>
  //            <div class="product_(info|suitable)__descr …">value…</div>
  const items = [...block.matchAll(/class="product_(?:info|suitable)__title">\s*([^<]+?)\s*<\/div>/g)];
  items.forEach((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < items.length ? items[i + 1].index ?? block.length : block.length;
    // The slice ends inside the next item's opening "<div …": drop that stub.
    const descr = block.slice(from, to).replace(/<[^>]*$/, "");
    const links = [...descr.matchAll(/<a\b[^>]*href="\/[^"]*"[^>]*>([^<]+)<\/a>/g)].map((a) => text(a[1])).filter(Boolean);
    const values = links.length ? links : list(text(descr));
    switch (m[1].replace(/:$/, "").trim()) {
      case "Тип предприятий": out.enterpriseTypes = values; break;
      case "Подходит для стран": out.countries = values; break;
      case "Версии": out.editions = values; break;
      case "Разработчик": out.developers = list(text(descr)); break;
      case "Базовая конфигурация": out.baseConfig = text(descr) || null; break;
      case "Подходит для отраслей": out.industries = values; break;
      case "Подходит для задач": out.tasks = values; break;
    }
  });

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  out.title = h1 ? text(h1[1]) || null : null;

  const support = html.slice(Math.max(0, html.indexOf("sidebar_phone__list")));
  if (html.includes("sidebar_phone__list")) {
    const tel = support.match(/href="tel:([^"]+)"[^>]*>\s*([^<]+?)\s*</);
    out.supportPhone = tel ? text(tel[2]) || tel[1] : null;
    const mail = support.match(/href=['"]mailto:([^'"]+)['"]/);
    out.supportEmail = mail ? mail[1].trim() : null;
  }
  return out;
}

async function fetchPage(url: string): Promise<{ status: string; page: SolutionPage | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal, redirect: "follow" });
    if (res.status === 404) return { status: "missing", page: null };
    if (!res.ok) return { status: "error", page: null };
    const page = parseSolutionPage(await res.text());
    return page ? { status: "ok", page } : { status: "missing", page: null };
  } catch {
    return { status: "error", page: null };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch product cards for linked projects that point to solutions.1c.ru. */
export async function syncSolutions(opts: { onLog?: (m: string) => void; signal?: AbortSignal } = {}) {
  const log = (m: string) => (opts.onLog ? opts.onLog(m) : console.log(m));
  const res = await db.execute(sql`
    SELECT DISTINCT p.info_url AS url
    FROM release_projects p
    LEFT JOIN solutions_info s ON s.url = p.info_url
    WHERE p.config_id IS NOT NULL
      AND p.info_url LIKE 'https://solutions.1c.ru/%'
      AND (s.url IS NULL OR s.fetched_at < now() - make_interval(days => ${MAX_AGE_DAYS}))
  `);
  const urls = (((res as any).rows ?? res) as { url: string }[]).map((r) => r.url);
  const stats = { checked: urls.length, ok: 0, missing: 0, errors: 0 };
  if (urls.length === 0) { log("1С:Решения: обновлять нечего"); return stats; }
  log(`1С:Решения: загружаем ${urls.length} карточек продуктов...`);

  for (let i = 0; i < urls.length; i++) {
    if (opts.signal?.aborted) break;
    const url = urls[i];
    const { status, page } = await fetchPage(url);
    if (status === "ok") stats.ok++; else if (status === "missing") stats.missing++; else stats.errors++;
    const values = {
      status,
      title: page?.title ?? null,
      productKind: page?.productKind ?? null,
      enterpriseTypes: page?.enterpriseTypes ?? null,
      countries: page?.countries ?? null,
      developers: page?.developers ?? null,
      baseConfig: page?.baseConfig ?? null,
      industries: page?.industries ?? null,
      tasks: page?.tasks ?? null,
      editions: page?.editions ?? null,
      supportPhone: page?.supportPhone ?? null,
      supportEmail: page?.supportEmail ?? null,
      fetchedAt: new Date(),
    };
    // A transient error must not wipe good data from last week (and keeps the
    // old fetched_at, so the next run retries).
    if (status === "error") {
      await db.insert(solutionsInfo).values({ url, ...values }).onConflictDoNothing();
    } else {
      await db.insert(solutionsInfo).values({ url, ...values })
        .onConflictDoUpdate({ target: solutionsInfo.url, set: values });
    }
    if ((i + 1) % 50 === 0) log(`1С:Решения: ${i + 1} / ${urls.length}`);
    await delay(DELAY_MS);
  }
  log(`1С:Решения: получено ${stats.ok}, без карточки ${stats.missing}, ошибок ${stats.errors}`);
  return stats;
}
