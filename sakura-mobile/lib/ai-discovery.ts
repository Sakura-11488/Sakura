import {
  searchAnime,
  fetchAnimeInfo,
  fetchAnimeByGenre,
  ANIME_GENRES,
  type AnimeResult,
} from './anime';
import { searchManga, fetchPopularManga, type AtsuItem } from './manga';
import { searchNovels, type AllNovelItem } from './allnovel';

export type DiscoveryKind = 'anime' | 'manga' | 'novel';

export interface DiscoveryCard {
  kind: DiscoveryKind;
  id: string;
  title: string;
  image?: string;
  year?: number | null;
  score?: number | null;
  route: string;
}

export interface DiscoveryResult {
  reference?: string;
  header: string;
  cards: DiscoveryCard[];
}

const MAX_CARDS = 8;

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function animeCard(r: AnimeResult): DiscoveryCard {
  return {
    kind: 'anime',
    id: String(r.id),
    title: r.title,
    image: r.image,
    year: r.year ?? null,
    score: r.score ?? null,
    route: `/anime/${encodeURIComponent(r.id)}`,
  };
}

function mangaCard(m: AtsuItem): DiscoveryCard {
  return {
    kind: 'manga',
    id: m.id,
    title: m.title,
    image: m.image || m.largeImage || m.mediumImage,
    route: `/manga/${encodeURIComponent(m.id)}`,
  };
}

function novelCard(n: AllNovelItem): DiscoveryCard {
  return {
    kind: 'novel',
    id: encodeURIComponent(n.path),
    title: n.name,
    image: n.cover || n.originalCover,
    route: `/novel/${encodeURIComponent(n.path)}`,
  };
}

function pickGenre(names: string[]): { id: number; name: string } | null {
  for (const name of names) {
    const hit = ANIME_GENRES.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export async function findSimilarAnime(reference: string): Promise<DiscoveryResult> {
  const query = (reference || '').trim();
  if (!query) return { header: 'No results', cards: [] };

  try {
    const hits = await searchAnime(query);
    if (!hits.length) return { reference: query, header: `Nothing found for "${query}"`, cards: [] };

    const top = hits[0];
    const info = await fetchAnimeInfo(top.id).catch(() => null);
    const genreNames = info?.genres || [];
    const genre = pickGenre(genreNames);

    const cards: DiscoveryCard[] = [];

    if (genre) {
      const byGenre = await fetchAnimeByGenre(genre.id).catch(() => [] as AnimeResult[]);
      for (const a of byGenre) {
        if (String(a.id) === String(top.id)) continue;
        if (cards.length >= MAX_CARDS) break;
        cards.push(animeCard(a));
      }
    }

    if (cards.length === 0) {
      for (const a of hits.slice(1)) {
        if (cards.length >= MAX_CARDS) break;
        cards.push(animeCard(a));
      }
    }

    const header = genre ? `Similar to ${top.title} · ${genre.name}` : `Similar to ${top.title}`;
    return { reference: query, header, cards: uniqueById(cards).slice(0, MAX_CARDS) };
  } catch (e: any) {
    console.warn('[ai-discovery] findSimilarAnime:', e?.message);
    return { reference: query, header: `Couldn't search for "${query}"`, cards: [] };
  }
}

export async function findSimilarManga(reference: string): Promise<DiscoveryResult> {
  const query = (reference || '').trim();
  if (!query) return { header: 'No results', cards: [] };

  try {
    const hits = await searchManga(query, 10);
    if (!hits.length) return { reference: query, header: `Nothing found for "${query}"`, cards: [] };

    const top = hits[0];
    const cards = hits.slice(1, MAX_CARDS + 1).map(mangaCard);
    return { reference: query, header: `Similar to ${top.title}`, cards: uniqueById(cards) };
  } catch (e: any) {
    console.warn('[ai-discovery] findSimilarManga:', e?.message);
    return { reference: query, header: `Couldn't search for "${query}"`, cards: [] };
  }
}

export async function findSimilarNovels(reference: string): Promise<DiscoveryResult> {
  const query = (reference || '').trim();
  if (!query) return { header: 'No results', cards: [] };

  try {
    const hits = await searchNovels(query);
    if (!hits.length) return { reference: query, header: `Nothing found for "${query}"`, cards: [] };
    const top = hits[0];
    const cards = hits.slice(1, MAX_CARDS + 1).map(novelCard);
    if (cards.length === 0) cards.push(...hits.slice(0, MAX_CARDS).map(novelCard));
    return { reference: query, header: `Novels like ${top.name}`, cards: uniqueById(cards) };
  } catch (e: any) {
    console.warn('[ai-discovery] findSimilarNovels:', e?.message);
    return { reference: query, header: `Couldn't search for "${query}"`, cards: [] };
  }
}

// ─── Mood pick ────────────────────────────────────────────────────────────────

const MOOD_TO_GENRES: Record<string, string[]> = {
  cozy: ['Slice of Life', 'Romance', 'Comedy'],
  wholesome: ['Slice of Life', 'Comedy'],
  funny: ['Comedy'],
  romantic: ['Romance'],
  dark: ['Horror', 'Mystery', 'Drama'],
  scary: ['Horror'],
  intense: ['Action', 'Drama', 'Supernatural'],
  epic: ['Action', 'Adventure', 'Fantasy'],
  cerebral: ['Mystery', 'Sci-Fi', 'Drama'],
  sad: ['Drama'],
  feel_good: ['Comedy', 'Slice of Life'],
  fantasy: ['Fantasy'],
  adventure: ['Adventure'],
  action: ['Action'],
  mystery: ['Mystery'],
  thriller: ['Mystery', 'Horror'],
  supernatural: ['Supernatural'],
  sports: ['Sports'],
  'sci-fi': ['Sci-Fi'],
};

function tagsToGenres(tags: string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const normalised = tag.toLowerCase().replace(/[^a-z-]/g, '_');
    const mapped = MOOD_TO_GENRES[normalised] || MOOD_TO_GENRES[tag.toLowerCase()] || [];
    for (const g of mapped) {
      if (!out.includes(g)) out.push(g);
    }
  }
  return out;
}

export async function moodPick(
  tags: string[],
  kind: 'anime' | 'manga' | 'both' = 'both',
): Promise<DiscoveryResult> {
  const genres = tagsToGenres(tags);
  const firstAnimeGenre = genres.length ? pickGenre(genres) : null;
  const moodLabel = tags.join(', ');
  const header = `${moodLabel.charAt(0).toUpperCase()}${moodLabel.slice(1)} picks for you`;

  const cards: DiscoveryCard[] = [];

  if (kind !== 'manga' && firstAnimeGenre) {
    try {
      const limit = kind === 'both' ? 4 : MAX_CARDS;
      const hits = await fetchAnimeByGenre(firstAnimeGenre.id);
      for (const a of hits) {
        if (cards.filter((c) => c.kind === 'anime').length >= limit) break;
        cards.push(animeCard(a));
      }
    } catch {}
  }

  if (kind !== 'anime') {
    try {
      const mangaQuery = genres[0] || tags[0] || '';
      const limit = kind === 'both' ? 4 : MAX_CARDS;
      const hits = mangaQuery
        ? await searchManga(mangaQuery, limit + 2)
        : await fetchPopularManga(limit + 2);
      for (const m of hits) {
        if (cards.filter((c) => c.kind === 'manga').length >= limit) break;
        cards.push(mangaCard(m));
      }
    } catch {}
  }

  return { header, cards: uniqueById(cards).slice(0, MAX_CARDS) };
}
