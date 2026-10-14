import { searchManga, toContentItem } from '@/lib/manga';
import { searchManhwa } from '@/lib/manhwa';
import { searchComics } from '@/lib/comics';
import { searchNovels } from '@/lib/allnovel';
import { searchHentai } from '@/lib/hentai';
import { searchUsersByUsername } from '@/lib/creator';
import { userDisplayLabel } from '@/lib/user-chat-nav';
import { searchAnime } from '@/lib/anime';
import {
  atsuMatchKey,
  formatLabel,
  titleMatchKey,
  uniqueResults,
  type SearchResult,
  type SearchSourceKey,
  type SourceAnswer,
} from '@/lib/search-core';

/**
 * Each search source as one function of (query, signal) → SourceAnswer, so
 * the screen can start them together and draw each section as it answers.
 *
 * The signal is how a superseded query is dropped. None of the libs below
 * take one yet (the content proxy, AniList and Supabase calls have no
 * cancellation hook), so a superseded request runs to completion and is
 * simply not shown — its answer still lands in that lib's own cache, which
 * makes a backspace to it instant.
 *
 * Adult titles: atsu filters `isAdult:=false`, manhwa, comics and novels are
 * SFW catalogues, and lib/anime.ts asks AniList with `isAdult:false` (Jikan
 * fallback with `sfw=true`). The 18+ source only runs behind its opt-in.
 */

/**
 * How many to ask each source for. The All overview shows the first few per
 * section; a chip shows the whole answer, so ask for a full screen of it.
 */
export const SEARCH_LIMITS: Record<SearchSourceKey, number> = {
  manga: 24,
  // Manhwa titles live only in the scraper, not in the atsu catalogue, so this
  // list is the only way to find most of them; it used to be cut to 10, which
  // hid series users searched for by name. A full answer also offers "See
  // all", the browse screen paging the same query.
  manhwa: 24,
  anime: 20,
  novel: 20,
  comics: 24,
  users: 12,
  hentai: 12,
};

/**
 * Sources whose library answers [] when every upstream failed, so an empty
 * answer cannot be told apart from an outage: lib/anime.ts cachedCatalog
 * swallows AniList and Jikan errors (Jikan is often unreachable, and AniList
 * allows ~30 requests a minute per IP). The screen caches such an answer as
 * already stale — shown at once, but asked again on a repeat or Enter rather
 * than reading "no anime" for a whole minute after a hiccup.
 */
export const EMPTY_MAY_MEAN_DOWN: ReadonlySet<SearchSourceKey> = new Set<SearchSourceKey>(['anime']);

type SourceFn = (query: string, signal: AbortSignal) => Promise<SourceAnswer>;

export const SEARCH_SOURCES: Record<SearchSourceKey, SourceFn> = {
  async manga(q) {
    const hits = await searchManga(q, SEARCH_LIMITS.manga);
    const items = hits.map((item): SearchResult => ({
      key: `manga-${item.id}`,
      title: item.title,
      cover: toContentItem(item).cover,
      type: 'manga',
      source: 'manga',
      meta: formatLabel(item.type),
      navTarget: `/manga/${encodeURIComponent(item.id)}`,
      matchKey: atsuMatchKey(item.title, item.type),
    }));
    return { items: uniqueResults(items), full: hits.length >= SEARCH_LIMITS.manga };
  },

  async manhwa(q) {
    // Unconditional: manhwa is SFW, and it carries titles the atsu catalogue
    // doesn't have at all.
    const hits = await searchManhwa(q, SEARCH_LIMITS.manhwa);
    const items = hits.slice(0, SEARCH_LIMITS.manhwa).map((item): SearchResult => ({
      key: `manhwa-${item.id}`,
      title: item.title,
      cover: item.cover,
      type: 'manga',
      source: 'manhwa',
      meta: 'Manhwa',
      // Ids carry an `mr:`/`cz:` prefix, so encode before interpolating.
      navTarget: `/manga/${encodeURIComponent(item.id)}?source=manhwa`,
      matchKey: titleMatchKey(item.title) || undefined,
    }));
    // Less than a full answer is everything the scraper has for this query,
    // so only a full one is worth a "See all".
    return { items: uniqueResults(items), full: hits.length >= SEARCH_LIMITS.manhwa };
  },

  async anime(q) {
    const hits = await searchAnime(q);
    const items = hits.slice(0, SEARCH_LIMITS.anime).map((item): SearchResult => ({
      key: `anime-${item.id}`,
      title: item.title,
      cover: item.image,
      type: 'anime',
      source: 'anime',
      meta: [item.type || 'Anime', item.year ? String(item.year) : null].filter(Boolean).join(' · '),
      navTarget: `/anime/${item.id}`,
    }));
    return { items: uniqueResults(items), full: false };
  },

  async novel(q) {
    const hits = await searchNovels(q);
    const items = hits.slice(0, SEARCH_LIMITS.novel).map((item): SearchResult => ({
      key: `novel-${item.path}`,
      title: item.name,
      cover: item.cover || item.originalCover || '',
      type: 'novel',
      source: 'novel',
      meta: 'Novel',
      navTarget: `/novel/ext?path=${encodeURIComponent(item.path)}`,
    }));
    return { items: uniqueResults(items), full: false };
  },

  async comics(q) {
    const hits = await searchComics(q, SEARCH_LIMITS.comics);
    const items = hits.map((item): SearchResult => ({
      key: `comics-${item.id}`,
      title: item.title,
      cover: item.cover,
      type: 'manga',
      source: 'comics',
      meta: 'Comic',
      navTarget: `/manga/${encodeURIComponent(item.id)}?source=comics`,
    }));
    return { items: uniqueResults(items), full: hits.length >= SEARCH_LIMITS.comics };
  },

  async users(q) {
    const users = await searchUsersByUsername(q, SEARCH_LIMITS.users);
    const items = users.map((user): SearchResult => ({
      key: `user-${user.wallet_address}`,
      title: userDisplayLabel(user),
      cover: user.avatar_url ?? '',
      type: 'user',
      source: 'users',
      meta: `@${user.username}`,
      user,
    }));
    return { items: uniqueResults(items), full: false };
  },

  // The 18+ source is unchanged: same call, same routes, and the screen only
  // runs it when the adult opt-in is on and only shows it under its own chip.
  async hentai(q) {
    const hits = await searchHentai(q, SEARCH_LIMITS.hentai);
    const items = hits.slice(0, 10).map((item): SearchResult => ({
      key: `hentai-${item.id}`,
      title: item.title,
      cover: item.cover,
      type: 'hentai',
      source: 'hentai',
      meta: '18+',
      navTarget: `/manga/${item.id}?source=hentai`,
    }));
    return { items: uniqueResults(items), full: false };
  },
};
