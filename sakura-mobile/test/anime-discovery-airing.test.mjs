import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const source = require('typescript').transpileModule(readFileSync(new URL('../lib/anime-discovery.ts', import.meta.url), 'utf8'), { compilerOptions: { target: 9, module: 1 } }).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));
function load() { const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, URL, AbortController, setTimeout, clearTimeout }); return module.exports; }
const media = (id, extra = {}) => ({ idMal: id, type: 'ANIME', title: { english: `Series ${id}` }, coverImage: { large: `https://example.com/${id}.jpg` }, averageScore: 80, seasonYear: 2025, format: 'TV', ...extra });

test('the title page answer primes the related shelves so they make no request of their own', async () => {
  const api = load();
  api.primeAnimeDiscovery('52991', { data: { Media: {
    recommendations: { nodes: [{ mediaRecommendation: media(1) }] },
    relations: { edges: [{ relationType: 'SEQUEL', node: media(2) }] },
  } } });
  let calls = 0;
  const result = await api.fetchAnimeDiscovery('52991', { fetch: async () => { calls++; throw new Error('should be cached'); } });
  assert.equal(calls, 0);
  assert.deepEqual(plain(result.recommendations.map((row) => row.id)), ['1']);
  assert.deepEqual(plain(result.relations.map((row) => [row.id, row.relation])), [['2', 'Sequel']]);
  api.primeAnimeDiscovery('52991x', { data: { Media: {} } });
  api.primeAnimeDiscovery('20', { data: { Media: { title: 'no shelves here' } } });
  await assert.rejects(api.fetchAnimeDiscovery('20', { fetch: async () => { throw new Error('network'); } }));
});

test('airing status is parsed defensively and fetched once per id set for 15 minutes', async () => {
  const api = load();
  const payload = { data: { Page: { media: [
    { idMal: 21, status: 'RELEASING', episodes: null, title: { english: 'One Piece' }, coverImage: { large: 'https://x.test/op.jpg' }, nextAiringEpisode: { episode: 1181, airingAt: 1_800_000_000 } },
    { idMal: 52991, status: 'FINISHED', episodes: 28, title: { romaji: 'Sousou no Frieren' }, coverImage: { large: 'javascript:1' }, nextAiringEpisode: null },
    { idMal: 'x', status: 'RELEASING' },
  ] } } };
  assert.deepEqual(plain(api.parseAiringStatus(payload)), [
    { id: '21', status: 'RELEASING', episodes: null, nextEpisode: 1181, nextAiringAt: 1_800_000_000_000, title: 'One Piece', image: 'https://x.test/op.jpg' },
    { id: '52991', status: 'FINISHED', episodes: 28, nextEpisode: null, nextAiringAt: null, title: 'Sousou no Frieren', image: '' },
  ]);
  let calls = 0, variables;
  const fetch = async (_url, init) => { calls++; variables = JSON.parse(init.body).variables; return new Response(JSON.stringify(payload)); };
  await api.fetchAnimeAiringStatus(['52991', '21', '21', 'mal-3'], { fetch });
  await api.fetchAnimeAiringStatus(['21', '52991'], { fetch });
  assert.equal(calls, 1, 'order and duplicates do not defeat the cache');
  assert.deepEqual(plain(variables.ids), [21, 52991]);
  assert.deepEqual(plain(await api.fetchAnimeAiringStatus([], { fetch })), []);
  assert.equal(calls, 1);
});
