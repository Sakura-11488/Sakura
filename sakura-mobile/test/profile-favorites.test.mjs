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
    module, exports: module.exports, URL, URLSearchParams, Promise, JSON, Error, Array, Object,
    encodeURIComponent, decodeURIComponent, process: { env: {} },
    require: (name) => deps[name] || {}, ...globals,
  });
  return module.exports;
}

/**
 * A stand-in for the supabase-js query builder: records every call on every
 * table and resolves `favorites` to `favoriteRows`, the other tables to empty.
 */
function fakeSupabase(favoriteRows) {
  const queries = [];
  return {
    queries,
    client: {
      from(table) {
        const q = { table, calls: [] };
        queries.push(q);
        const result = () => (table === 'favorites' ? { data: favoriteRows, error: null } : { data: null, count: 0, error: null });
        const builder = {
          then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
          maybeSingle: async () => ({ data: null, error: null }),
        };
        for (const name of ['select', 'eq', 'in', 'order', 'limit']) {
          builder[name] = (...args) => { q.calls.push([name, ...args]); return builder; };
        }
        return builder;
      },
    },
  };
}

function profileStats(supabase) {
  return load('../lib/profile-stats.ts', { './supabase': { supabase } });
}

const { toProfileFavorites, PROFILE_FAVORITES_SELECT } = profileStats(fakeSupabase([]).client);

/** Column names of `CREATE TABLE … public.favorites` in the schema migration. */
function favoritesColumns() {
  const sql = readFileSync(new URL('../../supabase/migrations/20250408120000_sakura_schema.sql', import.meta.url), 'utf8');
  const body = sql.match(/CREATE TABLE IF NOT EXISTS public\.favorites \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(body, 'favorites table definition not found in the schema migration');
  return body
    .split('\n')
    .map((line) => line.trim().match(/^([a-z_]+)\s+[a-z]/)?.[1])
    .filter((name) => name && name !== 'PRIMARY');
}

/** The covers the 18+ source really produces, from lib/hentai.ts itself. */
function hentaiCovers() {
  const hosts = load('../lib/content-hosts.ts');
  const proxyFor = (platform, globals) => {
    const proxyClient = load('../lib/content-proxy-client.ts', {
      'react-native': { Platform: { OS: platform } },
      './content-hosts': hosts,
    }, { ...globals, process: { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://aofzomovaozcwcozokll.supabase.co' } } });
    return load('../lib/hentai.ts', {
      'react-native': { Platform: { OS: platform } },
      '@/lib/content-hosts': hosts,
      '@/lib/content-proxy-client': proxyClient,
      '@/lib/cache': { getOrSetCached: async (_k, _t, fn) => fn() },
      '@/lib/hentai-proxy-fetch': { hentaiProxyFetch: async () => ({}) },
    }).proxyHentaiImage;
  };
  const upstream = '//i3.hentaifox.com/006/1234567/cover.jpg';
  return {
    native: proxyFor('ios', {})(upstream),
    webSameOrigin: proxyFor('web', { window: {} })(upstream),
    webFunction: proxyFor('web', {})(upstream),
    upstream,
    upstreamHttps: `https:${upstream}`,
  };
}

test('the favorites select names only columns the favorites table has', () => {
  const columns = favoritesColumns();
  assert.deepEqual(columns, ['wallet_address', 'manga_id', 'title', 'cover_url', 'created_at']);
  for (const column of PROFILE_FAVORITES_SELECT.split(',').map((c) => c.trim())) {
    assert.ok(columns.includes(column), `${column} is not a favorites column`);
  }
  // The live 400 was "column favorites.content_id does not exist".
  assert.doesNotMatch(PROFILE_FAVORITES_SELECT, /content_id|content_type/);
});

test('getPublicProfile reads favorites by real columns and maps them for the shelf', async () => {
  const rows = [
    { manga_id: 'a2c3-uuid', title: 'Frieren', cover_url: 'https://uploads.mangadex.org/covers/a/b.jpg' },
    { manga_id: 'b7', title: 'Dandadan', cover_url: 'https://cdn.atsu.moe/static/posters/b7.webp' },
  ];
  const fake = fakeSupabase(rows);
  const { getPublicProfile } = profileStats(fake.client);
  const { favorites, stats } = await getPublicProfile('Wallet111');

  const fav = fake.queries.find((q) => q.table === 'favorites');
  assert.deepEqual(JSON.parse(JSON.stringify(fav.calls)), [
    ['select', 'manga_id, title, cover_url'],
    ['eq', 'wallet_address', 'Wallet111'],
    ['order', 'created_at', { ascending: false }],
    ['limit', 20],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(favorites)), [
    { content_id: 'a2c3-uuid', content_type: 'manga', title: 'Frieren', cover_url: 'https://uploads.mangadex.org/covers/a/b.jpg' },
    { content_id: 'b7', content_type: 'manga', title: 'Dandadan', cover_url: 'https://cdn.atsu.moe/static/posters/b7.webp' },
  ]);
  assert.equal(stats.favoritesCount, 2);
});

test('a failed favorites read leaves an empty shelf, not a crash', async () => {
  // supabase-js returns { data: null, error } on a 400; it does not throw.
  const { getPublicProfile } = profileStats(fakeSupabase(null).client);
  const { favorites, stats } = await getPublicProfile('Wallet111');
  assert.equal(favorites.length, 0);
  assert.equal(stats.favoritesCount, 0);
});

test('rows without a usable id or title are dropped; non-array input is empty', () => {
  assert.equal(toProfileFavorites(null).length, 0);
  assert.equal(toProfileFavorites({ manga_id: 'x', title: 'y' }).length, 0);
  const out = toProfileFavorites([
    null,
    'row',
    { manga_id: '', title: 'No id' },
    { manga_id: 42, title: 'Numeric id' },
    { manga_id: 'x'.repeat(512), title: 'Oversized id' },
    { manga_id: 'ok-1', title: '   ' },
    { manga_id: 'ok-2' },
    { content_id: 'old-shape', content_type: 'manga', title: 'Expo shape' },
    { manga_id: '  ok-3  ', title: '  Kept  ', cover_url: null },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [
    { content_id: 'ok-3', content_type: 'manga', title: 'Kept', cover_url: '' },
  ]);
});

test('ids that only differ by whitespace collapse to one card, newest first', () => {
  // The shelf keys cards on content_id; two cards with one key confuse React.
  const out = toProfileFavorites([
    { manga_id: 'dup', title: 'Newest', cover_url: '' },
    { manga_id: ' dup ', title: 'Older', cover_url: '' },
    { manga_id: 'other', title: 'Other', cover_url: '' },
  ]);
  assert.deepEqual([...out].map((f) => [f.content_id, f.title]), [['dup', 'Newest'], ['other', 'Other']]);
});

test('a cover that is not an absolute http(s) URL becomes the placeholder', () => {
  const covers = ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', '/relative/cover.jpg', 'ftp://x/y.jpg', 42];
  const out = toProfileFavorites(covers.map((cover_url, i) => ({ manga_id: `m${i}`, title: `T${i}`, cover_url })));
  assert.equal(out.length, covers.length);
  for (const f of out) assert.equal(f.cover_url, '');
  assert.equal(toProfileFavorites([{ manga_id: 'm', title: 't', cover_url: 'HTTP://a.example/c.jpg' }])[0].cover_url, 'HTTP://a.example/c.jpg');
});

test('18+ titles never reach a public profile, in any cover form the hentai source emits', () => {
  const covers = hentaiCovers();
  // Sanity: the forms differ, so each path through the filter is exercised.
  assert.match(covers.native, /^http:\/\/165\.232\.83\.159\/hentai\/v1\/img\?u=/);
  assert.match(covers.webSameOrigin, /^\/api\/media-proxy\/\?path=%2Fhentai%2Fv1%2Fimg/);
  assert.match(covers.webFunction, /\/functions\/v1\/web-media-proxy\?path=%2Fhentai%2Fv1%2Fimg/);

  const rows = Object.entries(covers).map(([form, cover_url]) => ({ manga_id: '1234567', title: `Adult ${form}`, cover_url }));
  rows.push({ manga_id: 'sfw', title: 'Safe', cover_url: 'https://uploads.mangadex.org/covers/x/y.jpg' });
  const out = toProfileFavorites(rows);
  assert.deepEqual([...out].map((f) => f.title), ['Safe']);
});

test('the 18+ filter does not catch the SFW scraped sources', () => {
  const sfw = [
    'http://165.232.83.159/manhwa/v1/img?u=https%3A%2F%2Fexample.com%2Fa.jpg',
    '/api/media-proxy/?path=%2Fcomics%2Fv1%2Fimg%3Fu%3Dhttps%253A%252F%252Fxoxo.example%252Fc.jpg',
    'https://uploads.mangadex.org/covers/x/y.jpg',
  ];
  const out = toProfileFavorites(sfw.map((cover_url, i) => ({ manga_id: `s${i}`, title: `Safe ${i}`, cover_url })));
  assert.equal(out.length, 3);
  // A malformed escape must not throw or hide the row.
  assert.equal(toProfileFavorites([{ manga_id: 'm', title: 't', cover_url: 'https://a.example/%E0%A4%A.jpg' }]).length, 1);
});
