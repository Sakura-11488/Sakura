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
    module, exports: module.exports, URL, URLSearchParams, Promise, JSON, Date,
    process: { env: {} }, require: (name) => deps[name] || {}, ...globals,
  });
  return module.exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadManhwa(answer) {
  const calls = [];
  const manhwa = load('../lib/manhwa.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '@/lib/cache': { getOrSetCached: (_k, _ttl, loader) => loader() },
    '@/lib/manhwa-proxy-fetch': { manhwaProxyFetch: async (path) => { calls.push(path); return answer(path); } },
    '@/lib/content-proxy-client': { getWebMediaProxyUrl: (u) => u },
    '@/lib/content-hosts': { MANHWA_PROXY_DEFAULT: 'http://droplet.test/manhwa/v1' },
  });
  return { manhwa, calls };
}

// /details as the live scraper answers for a mangaread manhua (Oct 2026).
const MARTIAL_PEAK = {
  manga: {
    id: 'mr:martial-peak',
    title: 'Martial Peak',
    cover: 'https://www.mangaread.org/wp-content/uploads/2019/12/555.jpg',
    description: 'A brief description of the manhua Martial Peak: The path to the heights of martial arts is a long and lonely test.',
    author: 'Momo (II)',
    authors: ['Momo (II)'],
    tags: ['Action', 'Adventure', 'Fantasy', 'Historical', 'Manhua', 'Martial Arts'],
    status: 'OnGoing',
    year: 2018,
  },
};

test('manhwa detail: real status, clean synopsis, the format split out of the genres, authors kept', async () => {
  const { manhwa } = loadManhwa(async () => MARTIAL_PEAK);
  const d = plain(await manhwa.fetchManhwaDetail('mr:martial-peak'));
  assert.equal(d.status, 'Ongoing');
  assert.equal(d.description, 'The path to the heights of martial arts is a long and lonely test.');
  assert.equal(d.type, 'Manhua', 'Martial Peak is a manhua, not "Manhwa · Momo (II)"');
  assert.deepEqual(d.genres, ['Action', 'Adventure', 'Fantasy', 'Historical', 'Martial Arts']);
  assert.deepEqual(d.authors, ['Momo (II)']);
  assert.equal(d.year, 2018);
});

test('status and tag helpers', () => {
  const { manhwa } = loadManhwa(async () => ({}));
  assert.equal(manhwa.normalizeManhwaStatus('OnGoing'), 'Ongoing');
  assert.equal(manhwa.normalizeManhwaStatus('Completed'), 'Completed');
  assert.equal(manhwa.normalizeManhwaStatus('On Hold'), 'Hiatus');
  assert.equal(manhwa.normalizeManhwaStatus(''), '');
  assert.equal(manhwa.normalizeManhwaStatus('Mystery'), 'Mystery', 'unknown values pass through');
  assert.equal(manhwa.cleanManhwaSynopsis('A brief description of the manga One Piece: Wealth, power and glory.'), 'Wealth, power and glory.');
  assert.equal(manhwa.cleanManhwaSynopsis('Plain synopsis: with a colon.'), 'Plain synopsis: with a colon.');
  assert.deepEqual(plain(manhwa.splitManhwaTags(['Webtoon', 'Action', 'Manga'])), { type: 'Manga', genres: ['Action'] });
  assert.deepEqual(plain(manhwa.splitManhwaTags([])), { type: 'Manhwa', genres: [] }, 'the source default');
});

test('trending stops after /popular when it already has enough titles', async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `mr:p-${i}`, title: `P ${i}` }));
  const { manhwa, calls } = loadManhwa(async (path) => {
    if (path.startsWith('/popular')) return { items };
    throw new Error(`unexpected ${path}`);
  });
  const list = await manhwa.fetchTrendingManhwa(40);
  assert.equal(list.length, 40);
  assert.equal(calls.length, 1, 'no discovery searches on a cold Manhwa tab');
});
