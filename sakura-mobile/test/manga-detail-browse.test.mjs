import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

function load(path, deps = {}, globals = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    module, exports: module.exports, URL, URLSearchParams, Response, Promise, JSON, Date, Set, Math,
    process: { env: {} }, require: (name) => deps[name] || {}, ...globals,
  });
  return module.exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function mangaModule(atsuFetch) {
  return load('../lib/manga.ts', {
    'react-native': { Platform: { OS: 'web' } },
    '@/lib/content-proxy-client': { getWebMangaPageProxyUrl: (u) => u },
    '@/lib/atsu-fetch': { atsuFetch },
    '@/lib/cache': { getOrSetCached: (_k, _ttl, loader) => loader() },
  }, { fetch: () => { throw new Error('unexpected network call'); } });
}

// The shape of a live /api/manga/page answer (The Knight Only Lives Today,
// Oct 2026), trimmed to the fields the parser reads plus a few it must ignore.
const PAGE = {
  id: '3xHoW',
  released: 1704067200000,
  views: '9.5M',
  title: 'The Knight Only Lives Today',
  englishTitle: null,
  type: 'Manwha',
  status: 'Hiatus',
  avgRating: 8.54783333333334,
  synopsis: 'Is dying repeatedly a blessing?',
  poster: { image: 'posters/3Pe8.jpg', largeImage: 'posters/3Pe8-large.avif' },
  authors: [
    { name: 'Ga Nara', type: 'Author' },
    { name: 'Soulpung', type: 'Author' },
    { name: 'An Lee', type: 'Artist' },
    { name: 'Soulpung', type: 'Artist' },
  ],
  genres: [{ id: '39', name: 'Action', weight: 'Defining' }, { id: '36', name: 'Fantasy', weight: 'Defining' }],
  tags: [
    { name: 'Swordplay', weight: 'Core' },
    { name: 'Time Loop', weight: 'Defining' },
    { name: 'Gore', weight: 'Unweighted' },
    { name: 'Action', weight: 'Defining' },
  ],
  otherNames: ['오늘만 사는 기사', 'The Knight Only Lives Today', 'Eternally Regressing Knight', 'eternally regressing knight'],
  relations: [{ type: 'Sequel', manga: { id: 'OlBhf', title: 'Part Two', mediumImage: 'posters/p2-medium.avif', type: 'Manwha', mbRating: 7.69 } }],
  recommendations: [
    { id: 'Xu6g5', title: 'The Roguish Guard', mediumImage: 'posters/r-medium.avif', type: 'Manwha', mbRating: 7.008 },
    { id: 'adult1', title: 'Not For Home', isAdult: true },
    { id: 'OlBhf', title: 'Part Two (again)' },
  ],
  similarManga: [{ id: 'Xu6g5', title: 'The Roguish Guard' }, { id: 'Hu1Lp', title: 'Mercenary Plan', type: 'Manga' }],
  mangaCommenters: [{ upvotes: 1 }],
  topReviews: [{ content: 'long review text' }],
};

test('the series page keeps credits, rating, tags, relations and similar titles from the atsu payload', () => {
  const manga = mangaModule(async () => json({}));
  const d = plain(manga.parseAtsuMangaPage(PAGE, '3xHoW'));
  assert.equal(d.type, 'Manhwa', "atsu's 'Manwha' is never shown");
  assert.equal(d.rating, 8.55, 'avgRating, which the old parser never read (it looked for `rating`)');
  assert.deepEqual(d.authors, ['Ga Nara', 'Soulpung']);
  assert.deepEqual(d.artists, ['An Lee'], 'an author who also drew it is credited once');
  assert.deepEqual(d.genres, ['Action', 'Fantasy']);
  assert.deepEqual(d.tags, ['Swordplay', 'Time Loop'], 'strongest first; unweighted and genre duplicates dropped');
  assert.deepEqual(d.altTitles, ['오늘만 사는 기사', 'Eternally Regressing Knight'], 'the title itself and case duplicates dropped');
  assert.equal(d.year, 2024);
  assert.equal(d.views, '9.5M');
  assert.deepEqual(d.related.map((r) => [r.id, r.relation, r.type]), [['OlBhf', 'Sequel', 'Manhwa']]);
  assert.deepEqual(d.similar.map((r) => r.id), ['Xu6g5', 'Hu1Lp'], 'adult rows, relations and repeats are left out');
  assert.ok(d.similar[0].cover.endsWith('posters/r-medium.avif'));
  assert.equal(d.similar[0].rating, 7);
  assert.equal('topReviews' in d || 'mangaCommenters' in d, false, 'the cached entry stays small');
});

test('fetchMangaDetail uses the new parser through the cache', async () => {
  const manga = mangaModule(async (path) => {
    assert.match(path, /^\/api\/manga\/page\?id=3xHoW$/);
    return json({ mangaPage: PAGE });
  });
  const d = await manga.fetchMangaDetail('3xHoW');
  assert.equal(d.title, 'The Knight Only Lives Today');
  assert.equal(d.related.length, 1);
});

test('genre browse filters by a core or defining genre, excludes adult genres and light novels', () => {
  const manga = mangaModule(async () => json({}));
  const filter = manga.mangaBrowseFilter({ genreId: '9', status: 'Completed' });
  assert.match(filter, /isAdult:=false/);
  assert.match(filter, /medium:=Comic/);
  assert.match(filter, /genreIds:!=\[10,41,46\]/);
  // atsu's two strongest weights; "core" titles (Lookism for Martial Arts) belong on the shelf too.
  assert.match(filter, /genreWeightKeys:=\[`9:core`,`9:defining`\]/);
  assert.match(filter, /status:=Completed/);
  const unknown = manga.mangaBrowseFilter({ genreId: '10', status: 'Weird' });
  assert.doesNotMatch(unknown, /genreWeightKeys/, 'only known, safe genres');
  assert.doesNotMatch(unknown, /status:=/);
  assert.equal(manga.atsuGenreId('slice of life'), '7');
  assert.equal(manga.atsuGenreId('Hentai'), null);
});

test('browseManga pages through Typesense and reports whether more remain', async () => {
  const calls = [];
  const manga = mangaModule(async (path) => {
    calls.push(path);
    const q = new URL(path, 'https://atsu.moe').searchParams;
    assert.equal(q.get('q'), '*');
    assert.equal(q.get('sort_by'), 'mbRating:desc');
    return json({ found: 45, hits: [{ document: { id: 'a', title: 'A', poster: '/static/posters/a.jpg', type: 'Manwha', mbRating: 8.1 } }] });
  });
  const page = await manga.browseManga({ genreId: '39', sort: 'rating' }, 1, 30);
  assert.equal(new URL(calls[0], 'https://atsu.moe').searchParams.get('page'), '2', 'Typesense pages are 1-based');
  assert.equal(page.found, 45);
  assert.equal(page.hasMore, false, '60 >= 45');
  assert.equal(page.items[0].mbRating, 8.1);
  const item = manga.toContentItem(page.items[0]);
  assert.equal(item.score, 8.1, 'cards get the score');
});

test('recently updated asks atsu for comics only and drops adult rows', async () => {
  const manga = mangaModule(async (path) => {
    const url = new URL(path, 'https://atsu.moe');
    assert.equal(url.pathname, '/api/home2/recentlyUpdated');
    assert.equal(url.searchParams.get('mediums'), 'Comic');
    assert.equal(url.searchParams.get('offset'), '40');
    return json({ items: [{ id: 'x', title: 'X', updatedAt: 5 }, { id: 'y', title: 'Y', isAdult: true }] });
  });
  const rows = plain(await manga.fetchRecentlyUpdatedManga(1, 40));
  assert.deepEqual(rows.map((r) => r.id), ['x']);
});

test('chapter counts for many titles come from one Typesense request per 50 ids', async () => {
  const calls = [];
  const manga = mangaModule(async (path) => {
    calls.push(path);
    const filter = new URL(path, 'https://atsu.moe').searchParams.get('filter_by');
    const ids = filter.slice('id:=['.length, -1).split(',');
    return json({ hits: ids.map((id, i) => ({ document: { id, chapterCount: i } })) });
  });
  const ids = Array.from({ length: 60 }, (_, i) => `id${i}`).concat(['bad id!', 'id0']);
  const counts = plain(await manga.fetchAtsuChapterCounts(ids));
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(counts).length, 60, 'invalid and repeated ids are dropped');
  assert.equal(counts.id51, 1);
});
