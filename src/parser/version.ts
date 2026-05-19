/**
 * version.ts
 *
 * 1C configuration version model.
 *
 * Product decision (confirmed): chains are built ONLY by the first 4-segment
 * token. For layered configs like "1.3.93.1/3.1.46.23" we use "1.3.93.1" and
 * the part after the slash ("3.1.46.23") is NOT used and NOT stored anywhere.
 * The record itself still lives in the graph - only its version is the core.
 *
 * This also fixes the latent 1C bug: СравнитьВерсии did Число() over
 * "1.3.93.1/3.1.46.23".split(".") -> throws on "1/3" -> returned 0
 * ("incomparable"), silently breaking chain-building for every layered config.
 * Here `core` is always a clean numeric tuple, so comparison is sound.
 */

export interface ParsedVersion {
  /** Canonical version: the first 4-segment numeric token (e.g. "1.3.93.1"). */
  core: string;
  /** Numeric segments of `core` (e.g. [1,3,93,1]). */
  segments: number[];
}

const FOUR_SEG = /\d{1,}\.\d{1,}\.\d{1,}\.\d{1,}/;

/**
 * Parse a (possibly compound) 1C version string down to its canonical core.
 * "1.3.93.1/3.1.46.23" -> { core: "1.3.93.1", segments: [1,3,93,1] }
 * Anything after the first 4-segment match is discarded and never retained.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = raw.trim().match(FOUR_SEG);
  if (!m) return null;
  const core = m[0];
  return { core, segments: core.split(".").map(Number) };
}

/**
 * Canonicalize a version string to its core, or null if it has no
 * 4-segment token. Use this everywhere a version enters the pipeline.
 */
export function toCore(raw: string): string | null {
  const m = raw.trim().match(FOUR_SEG);
  return m ? m[0] : null;
}

/**
 * Compare two version strings by their canonical core.
 * Negative / 0 / positive (same contract as 1C СравнитьВерсии), without the
 * layered-config bug. Unparseable sorts below parseable; two unparseable = 0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const n = Math.max(pa.segments.length, pb.segments.length);
  for (let i = 0; i < n; i++) {
    const da = pa.segments[i] ?? 0;
    const db = pb.segments[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/**
 * Same-edition test (mirror of СовпадаютРедакции): first segment of `core`
 * must match. Used as an edge-validity filter when building the chain graph.
 */
export function sameEdition(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  return pa.segments[0] === pb.segments[0];
}
