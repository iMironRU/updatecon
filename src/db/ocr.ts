/**
 * ocr.ts — скриншот «О программе» → версия конфигурации и версия платформы.
 *
 * Разделение намеренное: **движок** только читает буквы (сегодня tesseract в
 * браузере, завтра — модель на сервере), а **смысл** достаётся здесь, одним кодом
 * для всех движков. Причина в том, что правильный ответ даёт не OCR, а наш словарь:
 * «8.3.24.169» → «8.3.24.1691» — это одна правка, «3.0.21О.11» — кириллическая О
 * вместо нуля. Ни один OCR-движок этого сам не знает, а мы знаем все 14 тыс.
 * версий и 327 сборок платформы.
 *
 * Поэтому движок присылает токены, а не картинку, и получает обратно версии.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { ocrEvents } from "./schema.js";

export type OcrHit = { value: string; distance: number };
export type OcrResolution = {
  config_version: OcrHit | null;
  platform_version: OcrHit | null;
  alternatives: { config: string[]; platform: string[] };
  tokens: string[];
};

// ── Словари ────────────────────────────────────────────────────────────────
type Dict = { exact: Set<string>; byPrefix: Map<string, string[]> };
let dictCache: { at: number; stamp: string; versions: Dict; platforms: Dict } | null = null;

const DICT_TTL_MS = 15 * 60_000;

function buildDict(values: string[]): Dict {
  const exact = new Set<string>();
  const byPrefix = new Map<string, string[]>();
  for (const v of values) {
    if (!/^\d+(\.\d+){1,3}$/.test(v)) continue;   // 4 сегмента или меньше, только цифры
    exact.add(v);
    const bucket = byPrefix.get(dictKey(v));
    if (bucket) bucket.push(v); else byPrefix.set(dictKey(v), [v]);
  }
  return { exact, byPrefix };
}

/** Ключ бакета — первые две цифры без точек: OCR теряет точки, а не разряды. */
function dictKey(v: string): string {
  return v.replace(/\D/g, "").slice(0, 2);
}

/**
 * Версии конфигураций — из рёбер цепочек и из таблицы релизов портала: вместе они
 * покрывают и то, что мы знаем по LST, и то, что портал когда-либо публиковал.
 * Сборки платформы — из platform_builds.
 */
export async function ocrDictionaries(): Promise<{ versions: Dict; platforms: Dict }> {
  const stamp = await ocrStamp();
  if (dictCache && Date.now() - dictCache.at < DICT_TTL_MS && dictCache.stamp === stamp) return dictCache;

  const [versions, platforms] = await Promise.all([
    db.execute(sql`
      SELECT DISTINCT to_version AS v FROM update_edges
      UNION
      SELECT DISTINCT version FROM version_meta WHERE release_date IS NOT NULL`),
    db.execute(sql`SELECT version AS v FROM platform_builds`),
  ]);
  const vRows = ((versions as any).rows ?? versions) as { v: string }[];
  const pRows = ((platforms as any).rows ?? platforms) as { v: string }[];
  const built = {
    at: Date.now(),
    stamp,
    versions: buildDict(vRows.map((r) => r.v)),
    platforms: buildDict(pRows.map((r) => r.v)),
  };
  dictCache = built;
  return built;
}

/** Импорт меняет словари — тот же отпечаток, что у кэшей каталога и статистики. */
async function ocrStamp(): Promise<string> {
  const r = await db.execute(sql`SELECT coalesce(max(id), 0)::text AS run, count(*)::text AS n FROM import_runs`);
  const row = ((r as any).rows ?? r)[0] as any;
  return `${row.run}/${row.n}`;
}

// ── Нормализация и поиск ───────────────────────────────────────────────────

/** Путаница, которая реально встречается в OCR-тексте русских скриншотов. */
const CONFUSABLES: [RegExp, string][] = [
  [/[ООoО]/g, "0"],   // латинская и кириллическая О
  [/[Зз]/g, "3"],
  [/[бБ]/g, "6"],
  [/[Іl|!]/g, "1"],
  [/[ВB]/g, "8"],
  [/[S$]/g, "5"],
  [/[,;]/g, "."],            // «8,3,24,1691» — частая замена точек при пережатии
  [/[\u00a0 ]/g, ""],
];

const TOKEN_RE = /[0-9OoОЗзбБІlI|!ВB S$][0-9OoОЗзбБІlI|!ВBS$.,]{2,18}[0-9OoОЗзбБІlI|!ВBS$]/g;

export function normalizeToken(raw: string): string {
  let t = raw.trim();
  for (const [re, to] of CONFUSABLES) t = t.replace(re, to);
  // «3.0.210.11» — точка между сегментами; двойные точки и висячие точки убираем
  t = t.replace(/\.+/g, ".");
  return t.replace(/^\.|\.$/g, "");
}

/** Все «похожие на версию» куски текста, нормализованные и без повторов. */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.match(TOKEN_RE) ?? []) {
    const t = normalizeToken(raw);
    // минимум «1.2» — но нам нужны версии от трёх сегментов, иначе шум
    if (/^\d+(\.\d+){1,3}$/.test(t)) out.add(t);
  }
  return [...out];
}

function levenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Ближайшее слово словаря. Сравниваем только с тем же началом (первые два символа)
 * и близкой длиной: полный перебор 14 тыс. версий на каждый токен не нужен.
 */
export function bestMatch(token: string, dict: Dict, max = 1): OcrHit | null {
  if (dict.exact.has(token)) return { value: token, distance: 0 };
  const bucket = dict.byPrefix.get(dictKey(token));
  if (!bucket) return null;
  let best: OcrHit | null = null;
  for (const cand of bucket) {
    if (Math.abs(cand.length - token.length) > max) continue;
    const d = levenshtein(token, cand, max);
    if (d <= max && (!best || d < best.distance)) best = { value: cand, distance: d };
  }
  return best;
}

/** Что ещё подходит, чтобы интерфейс мог предложить выбор, а не только одно значение. */
function nearest(token: string, dict: Dict, n = 3, max = 2): string[] {
  const bucket = dict.byPrefix.get(dictKey(token));
  if (!bucket) return [];
  return bucket
    .map((c) => ({ c, d: levenshtein(token, c, max) }))
    .filter((x) => x.d <= max && x.d > 0)
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * Главная функция: токены → версии. Платформа — то, что начинается с «8.»,
 * остальное — версии конфигураций (1.х, 2.х, 3.х, 11.х и т.п.).
 */
export async function resolveOcr(tokens: string[]): Promise<OcrResolution> {
  const { versions, platforms } = await ocrDictionaries();
  const clean = [...new Set(tokens.map(normalizeToken).filter((t) => /^\d+(\.\d+){1,3}$/.test(t)))];

  let config: OcrHit | null = null;
  let platform: OcrHit | null = null;
  for (const t of clean) {
    if (/^8\./.test(t)) {
      const hit = bestMatch(t, platforms);
      if (hit && (!platform || hit.distance < platform.distance)) platform = hit;
    } else {
      const hit = bestMatch(t, versions);
      // точное совпадение приоритетнее любой догадки, даже если она встретилась раньше
      if (hit && (!config || hit.distance < config.distance)) config = hit;
    }
  }
  return {
    config_version: config,
    platform_version: platform,
    alternatives: {
      config: config ? nearest(config.value, versions) : [],
      platform: platform ? nearest(platform.value, platforms) : [],
    },
    tokens: clean,
  };
}

// ── События ────────────────────────────────────────────────────────────────

export type OcrEventInput = {
  engine: string;
  ms?: number;
  tokens?: string[];
  imageW?: number;
  imageH?: number;
  imageBytes?: number;
  resolution?: OcrResolution | null;
  samplePath?: string | null;
  ua?: string | null;
};

/** Одно событие = один распознанный скриншот. Возвращает id для последующей правки. */
export async function logOcrEvent(input: OcrEventInput): Promise<number> {
  const [row] = await db
    .insert(ocrEvents)
    .values({
      engine: input.engine.slice(0, 40),
      ms: Math.max(0, Math.min(600_000, Math.round(input.ms ?? 0))),
      tokens: input.tokens?.slice(0, 40) ?? null,
      imageW: input.imageW ?? null,
      imageH: input.imageH ?? null,
      imageBytes: input.imageBytes ?? null,
      versionValue: input.resolution?.config_version?.value ?? null,
      versionDistance: input.resolution?.config_version?.distance ?? null,
      platformValue: input.resolution?.platform_version?.value ?? null,
      platformDistance: input.resolution?.platform_version?.distance ?? null,
      samplePath: input.samplePath ?? null,
      ua: input.ua?.slice(0, 200) ?? null,
    })
    .returning({ id: ocrEvents.id });
  return Number(row.id);
}

/** Пользователь что-то сделал с подставленным значением: поправил, построил цепочку. */
export async function updateOcrEvent(
  id: number,
  patch: { appliedVersion?: string | null; corrected?: boolean; built?: boolean; samplePath?: string | null },
): Promise<void> {
  if (!Number.isFinite(id)) return;
  await db
    .update(ocrEvents)
    .set({
      ...(patch.appliedVersion !== undefined ? { appliedVersion: patch.appliedVersion } : {}),
      ...(patch.corrected !== undefined ? { corrected: patch.corrected } : {}),
      ...(patch.built !== undefined ? { built: patch.built } : {}),
      ...(patch.samplePath !== undefined ? { samplePath: patch.samplePath } : {}),
    })
    .where(sql`${ocrEvents.id} = ${id}`);
}

/** Агрегаты для отчётов: сколько распознаваний, какая доля точных, сколько поправили. */
export async function ocrSummary(days = 30) {
  const r = await db.execute(sql`
    SELECT
      count(*)::int                                            AS total,
      count(*) FILTER (WHERE version_value IS NOT NULL)::int   AS with_version,
      count(*) FILTER (WHERE version_distance = 0)::int        AS exact,
      count(*) FILTER (WHERE version_distance > 0)::int        AS near_miss,
      count(*) FILTER (WHERE platform_value IS NOT NULL)::int  AS with_platform,
      count(*) FILTER (WHERE corrected)::int                   AS corrected,
      count(*) FILTER (WHERE built)::int                       AS built,
      count(*) FILTER (WHERE sample_path IS NOT NULL)::int     AS samples,
      count(DISTINCT engine)::int                              AS engines,
      round(avg(ms))::int                                      AS avg_ms
    FROM ocr_events
    WHERE at >= now() - (${days} || ' days')::interval`);
  const row = ((r as any).rows ?? r)[0] ?? {};
  const total = Number(row.total ?? 0);
  return {
    days,
    total,
    with_version: Number(row.with_version ?? 0),
    exact: Number(row.exact ?? 0),
    near_miss: Number(row.near_miss ?? 0),
    with_platform: Number(row.with_platform ?? 0),
    corrected: Number(row.corrected ?? 0),
    built: Number(row.built ?? 0),
    samples: Number(row.samples ?? 0),
    avg_ms: Number(row.avg_ms ?? 0),
    // Доля скриншотов, где версия нашлась хоть как-то — главная метрика движка.
    hit_rate: total ? Number(((Number(row.with_version ?? 0) / total) * 100).toFixed(1)) : 0,
  };
}
