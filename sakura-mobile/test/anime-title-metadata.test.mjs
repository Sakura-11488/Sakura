import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const lib = new URL('../lib/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadTs(name, mocks = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(new URL(name, lib), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, console, URL, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimeout,
    require: (id) => {
      if (id in mocks) return mocks[id];
      if (id === './anime-network') return loadTs('anime-network.ts', mocks, globals);
      throw new Error(`Unexpected dependency: ${id}`);
    },
    ...globals,
  });
  return module.exports;
}

const FRIEREN = {
  idMal: 52991, isAdult: false, status: 'FINISHED', episodes: 28, duration: 24, format: 'TV', seasonYear: 2023,
  averageScore: 91, genres: ['Adventure', 'Drama', 'Fantasy'],
  title: { english: 'Frieren: Beyond Journey’s End', romaji: 'Sousou no Frieren', native: '葬送のフリーレン' },
  synonyms: ['Frieren at the Funeral', '장송의 프리렌'],
  description: 'The adventure is over &amp; life goes on.\n<br><br>\n<i>(Source: Crunchyroll)</i>',
  coverImage: { extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587.jpg', large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587.jpg' },
  bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587.jpg',
  nextAiringEpisode: null,
  streamingEpisodes: [
    { title: 'Episode 1 - The Journey\'s End', thumbnail: 'https://img1.ak.crunchyroll.com/ep1.jpg' },
    { title: 'Episode 2 - It Didn\'t Have to Be Magic...', thumbnail: 'https://img1.ak.crunchyroll.com/ep2.jpg' },
    { title: 'Episode 3', thumbnail: 'javascript:alert(1)' },
  ],
  studios: { nodes: [{ name: 'Madhouse' }] },
  recommendations: { nodes: [] }, relations: { edges: [] },
};

function harness({ media = FRIEREN, anilist, jikan, meta, consu, now } = {}) {
  const requests = { anilist: 0, jikan: 0, consu: [], primed: [] };
  const cache = new Map();
  const fetch = async (url, options) => {
    if (url === 'https://graphql.anilist.co') {
      requests.anilist++;
      if (anilist) return anilist(JSON.parse(options.body), requests.anilist);
      return { ok: true, status: 200, json: async () => ({ data: { Media: media } }) };
    }
    requests.jikan++;
    if (jikan) return jikan(url);
    return new Promise(() => {}); // Jikan never answers (the measured outage)
  };
  const globals = { fetch };
  if (now) globals.Date = class extends Date { static now() { return now.value; } };
  const anime = loadTs('anime.ts', {
    '@/lib/cache': {
      getCachedValue: async (key) => cache.get(key) ?? null,
      setCachedValue: async (key, value) => { cache.set(key, value); },
    },
    '@/lib/consumet-client': {
      consuGet: async (path) => {
        requests.consu.push(path);
        if (consu) return consu(path);
        if (meta && path.startsWith('/api/meta/')) return meta;
        throw new Error('Provider extraction is unavailable.');
      },
      consumetCandidates: () => ['https://example.test'],
      getActiveConsumetUrl: () => 'https://example.test',
      setActiveConsumetUrl: () => {},
    },
    '@/lib/anime-upstream': { HIANIME_BASE: 'https://hianime.dk', fetchUpstreamText: async () => '', fetchUpstreamJson: async () => ({}) },
    './sakura-originals': { isSakuraOriginal: () => false, resolveSakuraOriginalStreamUrl: async () => null },
    './anime-stream-client': { usesBrowserAnimeStream: false, fetchBrowserAnimeStream: async () => null, prewarmBrowserAnimeStream: () => {} },
    './anime-discovery': { primeAnimeDiscovery: (id, payload) => requests.primed.push({ id, payload }) },
  }, globals);
  return { anime, requests, cache };
}

test('AniList is the primary title source: no Jikan wait, English title, clean synopsis, real genres and episode details', async () => {
  const h = harness();
  const info = await h.anime.fetchAnimeInfo('52991');
  assert.equal(h.requests.jikan, 0, 'a dead Jikan is never on the critical path');
  assert.equal(h.requests.anilist, 1);
  assert.deepEqual(h.requests.consu, []);
  assert.equal(info.title, 'Frieren: Beyond Journey’s End');
  assert.equal(info.titleRomaji, 'Sousou no Frieren');
  assert.equal(info.description, 'The adventure is over & life goes on.\n\n(Source: Crunchyroll)');
  assert.deepEqual(plain(info.genres), ['Adventure', 'Drama', 'Fantasy']);
  assert.equal(info.status, 'Finished Airing');
  assert.equal(info.score, 9.1);
  assert.equal(info.metaSource, 'anilist');
  assert.equal(info.image, FRIEREN.coverImage.extraLarge, 'the detail hero keeps the large artwork');
  assert.deepEqual(plain(info.studios), ['Madhouse']);
  assert.equal(info.episodes.length, 28);
  assert.deepEqual(plain(info.episodes[0]), { id: 'mal-52991-1', number: 1, title: "The Journey's End", thumbnail: 'https://img1.ak.crunchyroll.com/ep1.jpg' });
  assert.equal(info.episodes[2].title, 'Episode 3', 'a bare number keeps the generic title');
  assert.equal(info.episodes[2].thumbnail, undefined, 'unsafe still URLs are dropped');
  assert.equal(h.requests.primed.length, 1, 'related shelves are primed from the same answer');
  assert.ok(h.cache.has('anime:info3_52991'));
  await h.anime.fetchAnimeInfo('52991');
  assert.equal(h.requests.anilist, 1, 'the record is reused from cache');
});

test('concurrent detail and watch loads share one AniList request', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.anime.fetchAnimeInfo('52991'), h.anime.fetchAnimeInfo('52991')]);
  assert.equal(h.requests.anilist, 1);
  assert.equal(a.title, b.title);
});

test('an airing show lists only aired episodes and expires at the next broadcast', async () => {
  const now = { value: 1_800_000_000_000 };
  const airingAt = Math.floor(now.value / 1000) + 3 * 3600;
  const h = harness({ now, media: { ...FRIEREN, idMal: 21, streamingEpisodes: [], status: 'RELEASING', episodes: null, nextAiringEpisode: { episode: 1181, airingAt } } });
  const info = await h.anime.fetchAnimeInfo('21');
  assert.equal(info.episodes.length, 1180);
  assert.equal(info.status, 'Currently Airing');
  assert.deepEqual(plain(info.nextAiringEpisode), { episode: 1181, airingAt: airingAt * 1000 });
  assert.equal(h.anime.animeInfoTtl(info, now.value), 3 * 3_600_000);
  assert.deepEqual(h.requests.consu, [], 'no provider matching for a known aired count');
});

test('an unaired show says so instead of listing planned episodes, and is not retried as broken', async () => {
  const now = { value: 1_800_000_000_000 };
  const h = harness({ now, media: { ...FRIEREN, idMal: 61323, status: 'NOT_YET_RELEASED', episodes: 12, nextAiringEpisode: { episode: 1, airingAt: Math.floor(now.value / 1000) + 86400 } } });
  const info = await h.anime.fetchAnimeInfo('61323');
  assert.equal(info.episodes.length, 0);
  assert.equal(info.episodeLoadError, 'The first episode has not aired yet.');
  await h.anime.fetchAnimeInfo('61323');
  assert.equal(h.requests.anilist, 1, 'the explained empty record is cacheable');
});

test('an unknown aired count reports metadata first, then asks the provider', async () => {
  const media = { ...FRIEREN, status: 'RELEASING', episodes: null, nextAiringEpisode: null };
  const h = harness({ media, consu: async (path) => {
    if (path.startsWith('/api/search')) return { results: [{ id: 'frieren-18542', name: 'Frieren: Beyond Journey’s End', animeId: '18542' }] };
    if (path.startsWith('/api/info/')) return { animeId: '18542', name: 'Frieren: Beyond Journey’s End' };
    if (path.startsWith('/api/episodes/')) return { episodes: [{ number: 1, title: 'Episode 1' }, { number: 2, title: 'Provider title' }] };
    throw new Error(`unexpected ${path}`);
  } });
  const seen = [];
  const info = await h.anime.fetchAnimeInfo('52991', { onMetadata: (partial) => seen.push(plain(partial)) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, 'Frieren: Beyond Journey’s End');
  assert.deepEqual(seen[0].episodes, []);
  assert.deepEqual(plain(info.episodes.map((episode) => [episode.id, episode.title])), [['hi-18542-1', "The Journey's End"], ['hi-18542-2', 'Provider title']]);
});

test('a failing AniList falls back to the offline index at once, and that record is short-lived', async () => {
  const h = harness({
    anilist: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    meta: { malId: 52991, title: 'Sousou no Frieren', status: 'FINISHED', episodes: 28, image: 'https://cdn.example/frieren.jpg', genres: ['adoption', 'adventure'] },
  });
  const info = await h.anime.fetchAnimeInfo('52991');
  assert.equal(info.metaSource, 'index');
  assert.equal(info.episodes.length, 28);
  assert.equal(h.anime.animeInfoTtl(info), 30 * 60_000, 'degraded metadata is never kept for a day');
  assert.equal(h.anime.animeInfoTtl({ ...info, metaSource: 'anilist', status: 'Finished Airing' }), 24 * 3_600_000);
});

test('one Jikan timeout opens a host-wide breaker that is remembered across titles', async () => {
  const h = harness({
    anilist: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    meta: { malId: 20, title: 'Naruto', status: 'FINISHED', episodes: 220 },
  });
  await h.anime.fetchAnimeInfo('20');
  // The index answered first; Jikan's own (short) budget runs out a moment later.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const firstJikan = h.requests.jikan;
  assert.ok(firstJikan >= 1);
  assert.ok(h.cache.get('anime:jikan_host_down_until') > Date.now(), 'the outage is persisted for the next app start');
  await h.anime.fetchAnimeInfo('1535');
  assert.equal(h.requests.jikan, firstJikan, 'a second title does not wait on Jikan again');
});

test('pure helpers: synopsis cleanup, streaming episode parsing and offsets, aired counts, card covers', () => {
  const { anime } = harness();
  assert.equal(anime.cleanAnimeDescription('A<br>B &#8212; &quot;C&quot;<i>!</i>'), 'A\nB — "C"!');
  assert.equal(anime.cleanAnimeDescription(null), '');
  const offset = anime.parseStreamingEpisodes([
    { title: 'Episode 25 - Return', thumbnail: 'https://x.test/25.jpg' }, { title: 'Episode 26: Again', thumbnail: '' },
  ], 12);
  assert.deepEqual(plain([...offset]), [[1, { title: 'Return', thumbnail: 'https://x.test/25.jpg' }], [2, { title: 'Again' }]]);
  const inRange = anime.parseStreamingEpisodes([{ title: 'Episode 3 – Three' }, { title: 'Episode 3 - Duplicate' }, { title: 'Trailer' }], 12);
  assert.deepEqual(plain([...inRange]), [[3, { title: 'Three' }]]);
  const now = 1_800_000_000_000;
  assert.equal(anime.airedEpisodeCount({ status: 'FINISHED', episodes: 12 }, now), 12);
  assert.equal(anime.airedEpisodeCount({ status: 'RELEASING', nextAiringEpisode: { episode: 5, airingAt: now / 1000 + 60 } }, now), 4);
  assert.equal(anime.airedEpisodeCount({ status: 'RELEASING', nextAiringEpisode: { episode: 5, airingAt: now / 1000 - 60 } }, now), null, 'a stale schedule is not trusted');
  assert.equal(anime.airedEpisodeCount({ status: 'NOT_YET_RELEASED', episodes: 12 }, now), 0);
  assert.equal(anime.airedEpisodeCount({ status: 'HIATUS', episodes: 24 }, now), null);
  assert.equal(anime.cardCoverUrl('https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.png'), 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1.png');
  assert.equal(anime.cardCoverUrl('https://cdn.myanimelist.net/images/anime/large/1.jpg'), 'https://cdn.myanimelist.net/images/anime/large/1.jpg');
});

test('catalog lists use card-sized covers, rewrite cached extraLarge URLs, and remember previews', async () => {
  const card = (id) => ({ idMal: id, title: { english: `Show ${id}` }, coverImage: { large: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx${id}.jpg` }, averageScore: 80, format: 'TV', seasonYear: 2024 });
  let body;
  const h = harness({ anilist: async (request) => { body = request.query; return { ok: true, status: 200, json: async () => ({ data: { Page: { media: [card(1), card(2)] } } }) }; } });
  const popular = await h.anime.fetchPopularAnime();
  assert.match(body, /isAdult:false/);
  assert.doesNotMatch(body, /extraLarge/);
  assert.equal(popular[0].image, 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1.jpg');
  assert.equal(h.anime.getAnimePreview('2').title, 'Show 2');
  h.cache.set('anime:trending', [{ id: '9', title: 'Old', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9.jpg' }]);
  const trending = await h.anime.fetchAiringAnime();
  assert.equal(trending[0].image, 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx9.jpg');
});
