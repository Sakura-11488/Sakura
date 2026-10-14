import type { AnimeResult } from './anime';

export type RelatedAnime = AnimeResult & { relation: string };
export type ScheduledEpisode = AnimeResult & { scheduleId: string; episode: number; airingAt: number };
export type ScheduleWeek = { episodes: ScheduledEpisode[]; partial: boolean };
export type DiscoveryOptions = { signal?: AbortSignal; force?: boolean; fetch?: typeof fetch };
type TitleDiscovery = { recommendations: AnimeResult[]; relations: RelatedAnime[] };
type Json = Record<string, any>;
const ENDPOINT = 'https://graphql.anilist.co';
const FIELDS = 'idMal type isAdult title{english romaji} coverImage{large} format averageScore seasonYear';
const TITLE_QUERY = `query SakuraDiscovery($id:Int){Media(idMal:$id,type:ANIME){recommendations(sort:RATING_DESC,perPage:25){nodes{rating mediaRecommendation{${FIELDS}}}}relations{edges{relationType node{${FIELDS}}}}}}`;
const SCHEDULE_QUERY = `query SakuraSchedule($from:Int,$to:Int,$page:Int){Page(page:$page,perPage:50){pageInfo{hasNextPage}airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){id episode airingAt media{${FIELDS}}}}}`;
const cache = new Map<string, { value: unknown; expires: number }>();
const validId = (id: unknown): boolean => typeof id === 'string' && /^[1-9]\d{0,8}$/.test(id);
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown, max = 240): string => typeof value === 'string' ? value.slice(0, max).trim() : '';
function cover(value: unknown): string {
  try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}
function mediaResult(value: unknown): AnimeResult | null {
  const media = object(value), id = String(media.idMal ?? '');
  const title = text(object(media.title).english) || text(object(media.title).romaji);
  if (!validId(id) || !title || media.isAdult === true || media.type && media.type !== 'ANIME') return null;
  return { id, title, image: cover(object(media.coverImage).large), type: text(media.format, 30).replaceAll('_', ' '),
    score: typeof media.averageScore === 'number' && media.averageScore > 0 && media.averageScore <= 100 ? media.averageScore / 10 : null,
    year: Number.isInteger(media.seasonYear) ? media.seasonYear : null };
}
const RELATIONS: Record<string, string> = { PREQUEL: 'Prequel', SEQUEL: 'Sequel', PARENT: 'Parent story', SIDE_STORY: 'Side story', SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative version', SUMMARY: 'Recap' };

export function parseAnimeDiscovery(payload: unknown): TitleDiscovery {
  const media = object(object(object(payload).data).Media);
  const recommendations = new Map<string, AnimeResult>();
  for (const row of array(object(media.recommendations).nodes)) {
    const item = mediaResult(object(row).mediaRecommendation);
    if (item) recommendations.set(item.id, item);
  }
  const relations = new Map<string, RelatedAnime>();
  for (const row of array(object(media.relations).edges)) {
    const edge = object(row), item = mediaResult(edge.node), relation = RELATIONS[edge.relationType];
    if (item && relation) relations.set(item.id, { ...item, relation });
  }
  const order = ['Prequel', 'Sequel', 'Parent story', 'Side story', 'Spin-off', 'Alternative version', 'Recap'];
  return { recommendations: [...recommendations.values()], relations: [...relations.values()].sort((a, b) => order.indexOf(a.relation) - order.indexOf(b.relation)) };
}

async function request(url: string, init: RequestInit, options: DiscoveryOptions): Promise<Json> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new Error('Discovery request cancelled.')); };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error('Discovery is taking too long. Please try again.')); }, 8000);
  });
  const operation = async () => {
    if (controller.signal.aborted) throw new Error('Discovery request cancelled.');
    const response = await (options.fetch ?? fetch)(url, { ...init, signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new Error(response.status === 429 ? 'Discovery is busy. Please try again shortly.' : 'Discovery is unavailable. Please try again.');
    const body = await response.text();
    if (body.length > 1_000_000) throw new Error('Discovery returned too much data.');
    const result = object(JSON.parse(body));
    if (array(result.errors).length) throw new Error('Discovery is unavailable. Please try again.');
    return result;
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort); }
}
const graphql = (query: string, variables: Json, options: DiscoveryOptions) => request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) }, options);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function cached<T>(key: string, options: DiscoveryOptions, operation: () => Promise<T>, ttl = 60 * 60 * 1000): Promise<T> {
  if (options.signal?.aborted) throw new Error('Discovery request cancelled.');
  const hit = cache.get(key);
  if (!options.force && hit && hit.expires > Date.now()) return clone(hit.value as T);
  const value = await operation();
  if (options.signal?.aborted) throw new Error('Discovery request cancelled.');
  cache.delete(key);
  cache.set(key, { value: clone(value), expires: Date.now() + ttl });
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
  return clone(value);
}

export async function fetchAnimeDiscovery(id: string, options: DiscoveryOptions = {}): Promise<TitleDiscovery> {
  if (!validId(id)) return { recommendations: [], relations: [] };
  return cached(`title:${id}`, options, async () => {
    try { return parseAnimeDiscovery(await graphql(TITLE_QUERY, { id: Number(id) }, options)); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      // Recommendations remain useful when AniList is temporarily unavailable.
      // Jikan does not include complete relation metadata here, so do not guess it.
      const response = await request(`https://api.jikan.moe/v4/anime/${id}/recommendations`, {}, options);
      const recommendations = new Map<string, AnimeResult>();
      for (const row of array(response.data)) {
        const entry = object(object(row).entry), entryId = String(entry.mal_id ?? ''), title = text(entry.title);
        if (validId(entryId) && title) recommendations.set(entryId, { id: entryId, title, image: cover(object(object(entry.images).webp).large_image_url || object(object(entry.images).jpg).large_image_url) });
      }
      return { recommendations: [...recommendations.values()].slice(0, 25), relations: [] };
    }
  });
}
/**
 * Seed the title shelves from the title page's own AniList answer, which
 * carries the same recommendations and relations. The "Seasons & related" and
 * "More like this" rows then render without a second request against
 * AniList's 30-per-minute limit.
 */
export function primeAnimeDiscovery(id: string, payload: unknown): void {
  if (!validId(id)) return;
  const media = object(object(object(payload).data).Media);
  if (!('recommendations' in media) && !('relations' in media)) return;
  const key = `title:${id}`;
  cache.delete(key);
  cache.set(key, { value: clone(parseAnimeDiscovery(payload)), expires: Date.now() + 60 * 60 * 1000 });
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
}

export type AiringStatus = { id: string; status: string; episodes: number | null; nextEpisode: number | null; nextAiringAt: number | null; title: string; image: string };
const AIRING_QUERY = `query SakuraAiring($ids:[Int]){Page(perPage:50){media(idMal_in:$ids,type:ANIME){idMal status episodes title{english romaji} coverImage{large} nextAiringEpisode{episode airingAt}}}}`;

export function parseAiringStatus(payload: unknown): AiringStatus[] {
  const rows: AiringStatus[] = [];
  for (const value of array(object(object(object(payload).data).Page).media)) {
    const media = object(value), id = String(media.idMal ?? '');
    if (!validId(id)) continue;
    const next = object(media.nextAiringEpisode);
    const nextEpisode = Number.isSafeInteger(next.episode) && next.episode > 0 ? next.episode as number : null;
    const nextAiringAt = Number.isSafeInteger(next.airingAt) && next.airingAt > 0 ? (next.airingAt as number) * 1000 : null;
    rows.push({ id, status: text(media.status, 30), episodes: Number.isSafeInteger(media.episodes) && media.episodes > 0 ? media.episodes : null,
      nextEpisode, nextAiringAt, title: text(object(media.title).english) || text(object(media.title).romaji), image: cover(object(media.coverImage).large) });
  }
  return rows;
}

/**
 * Airing state for the titles a viewer follows, in one request (50 per page).
 * Cached for 15 minutes, keyed by the id set, so the Anime tab can refresh its
 * "New episodes" shelf on every visit without spending AniList's rate limit.
 */
export async function fetchAnimeAiringStatus(ids: string[], options: DiscoveryOptions = {}): Promise<AiringStatus[]> {
  const unique = [...new Set(ids.filter(validId))].sort((a, b) => Number(a) - Number(b)).slice(0, 50);
  if (!unique.length) return [];
  return cached(`airing:${unique.join(',')}`, options, async () => parseAiringStatus(await graphql(AIRING_QUERY, { ids: unique.map(Number) }, options)), 15 * 60 * 1000);
}

export async function fetchAnimeRecommendations(id: string, options: DiscoveryOptions = {}) { return (await fetchAnimeDiscovery(id, options)).recommendations; }
export async function fetchAnimeRelations(id: string, options: DiscoveryOptions = {}) { return (await fetchAnimeDiscovery(id, options)).relations; }

/** Local calendar arithmetic keeps weeks correct across daylight-saving changes. */
export function startOfScheduleWeek(time = Date.now()): number {
  const day = new Date(time); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (day.getDay() + 6) % 7); return day.getTime();
}
export function shiftScheduleDays(time: number, days: number): number {
  const date = new Date(time); date.setDate(date.getDate() + days); return date.getTime();
}
export function parseSchedulePage(payload: unknown, start: number, end: number): ScheduleWeek {
  const page = object(object(object(payload).data).Page), episodes = new Map<string, ScheduledEpisode>();
  for (const row of array(page.airingSchedules)) {
    const raw = object(row), media = mediaResult(raw.media), airingAt = raw.airingAt * 1000;
    if (!media || !Number.isInteger(raw.id) || !Number.isInteger(raw.episode) || raw.episode <= 0 || !Number.isFinite(airingAt) || airingAt < start || airingAt >= end) continue;
    const scheduleId = String(raw.id);
    episodes.set(scheduleId, { ...media, scheduleId, episode: raw.episode, airingAt });
  }
  return { episodes: [...episodes.values()].sort((a, b) => a.airingAt - b.airingAt), partial: object(page.pageInfo).hasNextPage === true };
}
export async function fetchAnimeScheduleWeek(start: number, options: DiscoveryOptions = {}): Promise<ScheduleWeek> {
  if (!Number.isFinite(start) || start < 0) throw new Error('Choose a valid week.');
  const end = shiftScheduleDays(start, 7);
  return cached(`week:${start}`, options, async () => {
    const episodes = new Map<string, ScheduledEpisode>();
    let partial = false;
    for (let page = 1; page <= 6; page++) {
      const result = parseSchedulePage(await graphql(SCHEDULE_QUERY, { from: Math.floor(start / 1000) - 1, to: Math.floor(end / 1000), page }, options), start, end);
      for (const episode of result.episodes) episodes.set(episode.scheduleId, episode);
      partial = result.partial;
      if (!partial) break;
    }
    return { episodes: [...episodes.values()].sort((a, b) => a.airingAt - b.airingAt), partial };
  }, 15 * 60 * 1000);
}

export type DiscoverySeed = { id: string; title: string; reason: 'watched' | 'saved' };
/** Use actual viewing, then saved titles for a cold start; never relabel trending. */
export function chooseDiscoverySeeds(history: Array<{ animeId: string; title: string; updatedAt: number; lastPlayedAt?: number; progress: number; positionSeconds?: number; completed?: boolean; episodeHistory?: Record<string, unknown> }>, library: Array<{ id: string; title: string; type: string; savedAt: number }>, limit = 2): DiscoverySeed[] {
  const seeds = new Map<string, DiscoverySeed>();
  for (const item of [...history].sort((a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt))) {
    const viewedEpisode = Object.values(item.episodeHistory ?? {}).some(value => {
      const episode = object(value);
      return episode.watched === true || episode.progress > 0 || episode.positionSeconds > 0;
    });
    if (validId(item.animeId) && (item.progress > 0 || (item.positionSeconds ?? 0) > 0 || item.completed || viewedEpisode)) seeds.set(item.animeId, { id: item.animeId, title: item.title, reason: 'watched' });
    if (seeds.size >= limit) break;
  }
  for (const item of [...library].sort((a, b) => b.savedAt - a.savedAt)) {
    if (seeds.size >= limit) break;
    if (item.type === 'anime' && validId(item.id) && !seeds.has(item.id)) seeds.set(item.id, { id: item.id, title: item.title, reason: 'saved' });
  }
  return [...seeds.values()];
}
