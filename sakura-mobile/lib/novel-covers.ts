import type { AllNovelItem } from './allnovel';

const COVER_TIMEOUT_MS = 2_500;
const MAX_LOOKUPS_PER_BATCH = 4;
const COVER_CONCURRENCY = 2;
const coverCache = new Map<string, string | null>();
let retryAfter = 0;

/** Optional decoration: a slow or quota-limited cover service must never gate reading. */
export async function getHDCover(title: string): Promise<string | null> {
  const key = title.toLowerCase().trim();
  if (coverCache.has(key)) return coverCache.get(key) ?? null;
  if (Date.now() < retryAfter) return null;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = (async () => {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&maxResults=1`;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        // The public Books API may exhaust its quota. Keep source covers and
        // stop the remaining background calls instead of amplifying the 429s.
        if (response.status === 429 || response.status === 403) retryAfter = Date.now() + 30 * 60_000;
        return null;
      }
      const data = await response.json();
      const links = data.items?.[0]?.volumeInfo?.imageLinks;
      const raw = links?.extraLarge || links?.large || links?.medium || links?.thumbnail || links?.smallThumbnail;
      return typeof raw === 'string' && raw
        ? raw.replace('http://', 'https://').replace('&edge=curl', '').replace(/zoom=\d+/, 'zoom=5')
        : null;
    })();
    const expired = new Promise<null>((resolve) => {
      timeout = setTimeout(() => { controller.abort(); resolve(null); }, COVER_TIMEOUT_MS);
    });
    // Race covers response-body stalls and runtimes that do not honor abort.
    const cover = await Promise.race([lookup, expired]);
    coverCache.set(key, cover);
    return cover;
  } catch {
    coverCache.set(key, null);
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function enhanceCovers(items: AllNovelItem[]): Promise<AllNovelItem[]> {
  const result = items.map((item) => ({ ...item, originalCover: item.originalCover || item.cover }));
  let next = 0;
  let lookups = 0;
  await Promise.all(Array.from({ length: COVER_CONCURRENCY }, async () => {
    while (next < result.length) {
      const index = next++;
      const item = result[index];
      const cached = coverCache.has(item.name.toLowerCase().trim());
      if (!cached && lookups >= MAX_LOOKUPS_PER_BATCH) continue;
      if (!cached) lookups++;
      const cover = await getHDCover(item.name);
      if (cover) result[index] = { ...item, cover };
    }
  }));
  return result;
}

/** Background results can change covers without replacing newer list pages. */
export function mergeNovelCovers(current: AllNovelItem[], enhanced: AllNovelItem[]): AllNovelItem[] {
  const byPath = new Map(enhanced.map((item) => [item.path, item]));
  return current.map((item) => {
    const cover = byPath.get(item.path);
    return cover ? { ...item, cover: cover.cover, originalCover: cover.originalCover } : item;
  });
}
