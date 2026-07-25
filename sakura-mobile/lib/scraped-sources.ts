import type { ContentItem } from '@/components/ui/ContentCard';
import type { MangaDetail, MangaChapter } from '@/lib/manga';

import {
  fetchTrendingComics,
  searchComics,
  fetchComicDetail,
  fetchComicChapters,
  fetchComicPages,
  proxyComicImage,
} from '@/lib/comics';
import {
  fetchTrendingHentai,
  searchHentai,
  fetchHentaiDetail,
  fetchHentaiChapters,
  fetchHentaiPages,
  proxyHentaiImage,
} from '@/lib/hentai';
import {
  fetchTrendingManhwa,
  searchManhwa,
  fetchManhwaDetail,
  fetchManhwaChapters,
  fetchManhwaPages,
  proxyManhwaImage,
} from '@/lib/manhwa';

/**
 * Registry of the scraped content sources — everything served by a droplet
 * scraper rather than by atsu.moe.
 *
 * This exists because the screens used to branch with
 * `isHentai ? … : isComics ? … : <manga>` in a dozen places, and `source`
 * arrives from `useLocalSearchParams<{ source?: string }>()` as a plain string.
 * A chain missing an arm therefore does NOT fail to compile — it falls through
 * and calls the wrong backend, e.g. handing a manhwa id to the comics scraper,
 * which 404s and renders an empty reader with no error at all. Keying a
 * `Record` on a closed union turns each of those into a compile error instead.
 *
 * It also disentangles a conflation: at most of its call sites `isHentai` did
 * not mean "hentai", it meant "is adult, so keep this out of the library,
 * reading history and lock-screen activity". Manhwa is SFW and must stay in
 * those, so that intent gets its own flag rather than being re-derived
 * correctly seven times.
 *
 * Scope is deliberately narrow: data access, the adult flag, and display
 * labels. Presentation, badges and the search-chip taxonomy stay in the
 * screens.
 *
 * IMPORT DIRECTION: this module imports comics/hentai/manhwa, so none of those
 * three may import it back. `lib/scraped-offline.ts` consumes the registry and
 * re-exports `ScrapedSource` for compatibility.
 */

export type ScrapedSource = 'comics' | 'hentai' | 'manhwa';

export interface ScrapedSourceAdapter {
  key: ScrapedSource;
  /** Shown on tabs, download sections and search chips. */
  label: string;
  /**
   * Suppress library saves, reading history and lock-screen activity.
   * Reading an adult title must leave no trace in shared surfaces.
   */
  adult: boolean;
  /** Suffix used in `MangaDetail.type`, e.g. "Comic · Alan Moore". */
  detailKind: string;
  trending(limit?: number): Promise<ContentItem[]>;
  search(query: string, limit?: number): Promise<ContentItem[]>;
  detail(id: string): Promise<MangaDetail | null>;
  chapters(id: string): Promise<MangaChapter[]>;
  pages(contentId: string, chapterId: string): Promise<string[]>;
  proxyImage(url?: string | null): string;
  /** Fixed four-slot genre shelf for the home tab. */
  homeRows: { title: string; query: string }[];
}

/**
 * Insertion order here is the order sources appear in the UI (home tabs,
 * downloads sections), so keep 18+ last.
 */
export const SCRAPED_SOURCES: Record<ScrapedSource, ScrapedSourceAdapter> = {
  comics: {
    key: 'comics',
    label: 'Comics',
    adult: false,
    detailKind: 'Comic',
    trending: fetchTrendingComics,
    search: searchComics,
    detail: fetchComicDetail,
    chapters: fetchComicChapters,
    pages: fetchComicPages,
    proxyImage: proxyComicImage,
    // Verbatim from the ternaries these replaced in app/(tabs)/home.tsx — the
    // shelves must look exactly as they did before the registry landed.
    homeRows: [
      { title: 'Action Packed', query: 'action' },
      { title: 'Superheroes', query: 'superhero' },
      { title: 'Sci-Fi & Space', query: 'sci-fi' },
      { title: 'Horror & Thriller', query: 'horror' },
    ],
  },
  manhwa: {
    key: 'manhwa',
    label: 'Manhwa',
    adult: false,
    detailKind: 'Manhwa',
    trending: fetchTrendingManhwa,
    search: searchManhwa,
    detail: fetchManhwaDetail,
    chapters: fetchManhwaChapters,
    pages: fetchManhwaPages,
    proxyImage: proxyManhwaImage,
    // These are title searches, not genre filters — both upstreams match on
    // series name — so the queries are words that actually appear in manhwa
    // titles. A genre word like "action" would return almost nothing.
    homeRows: [
      { title: 'Martial Arts', query: 'martial' },
      { title: 'Leveling Up', query: 'level' },
      { title: 'Return & Regression', query: 'return' },
      { title: 'Hunters', query: 'hunter' },
    ],
  },
  hentai: {
    key: 'hentai',
    label: '18+',
    adult: true,
    detailKind: 'Doujin',
    trending: fetchTrendingHentai,
    search: searchHentai,
    detail: fetchHentaiDetail,
    chapters: fetchHentaiChapters,
    pages: fetchHentaiPages,
    proxyImage: proxyHentaiImage,
    homeRows: [
      { title: 'Vanilla', query: 'vanilla' },
      { title: 'Romance', query: 'romance' },
      { title: 'Full Color', query: 'full color' },
      { title: 'Yuri', query: 'yuri' },
    ],
  },
};

export const SCRAPED_SOURCE_KEYS = Object.keys(SCRAPED_SOURCES) as ScrapedSource[];

/** Narrow an untrusted route param to a known source, or null for atsu manga. */
export function asScrapedSource(value: unknown): ScrapedSource | null {
  return typeof value === 'string' && value in SCRAPED_SOURCES
    ? (value as ScrapedSource)
    : null;
}

/** Adapter for a route param, or null when this is ordinary atsu-backed manga. */
export function getScrapedAdapter(value: unknown): ScrapedSourceAdapter | null {
  const key = asScrapedSource(value);
  return key ? SCRAPED_SOURCES[key] : null;
}

/** Sources offered in the UI; adult ones only when the user has opted in. */
export function visibleScrapedSources(allowAdult: boolean): ScrapedSourceAdapter[] {
  return SCRAPED_SOURCE_KEYS.map((k) => SCRAPED_SOURCES[k]).filter(
    (a) => allowAdult || !a.adult,
  );
}
