export function isMetadataCacheFresh(
  checkedAt: Date | string | null | undefined,
  cacheDays: number,
  forceRefresh = false,
  now = Date.now(),
): boolean {
  if (forceRefresh || !checkedAt || !Number.isFinite(cacheDays) || cacheDays <= 0) return false;
  const timestamp = new Date(checkedAt).getTime();
  return Number.isFinite(timestamp) && timestamp >= now - cacheDays * 86_400_000;
}
