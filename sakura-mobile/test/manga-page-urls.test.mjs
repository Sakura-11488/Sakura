import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const code = ts.transpileModule(readFileSync(new URL('../lib/manga.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(atsuFetch = async () => { throw new Error('Unexpected request'); }) {
  const exports = {};
  vm.runInNewContext(code, { exports, URL, require: (name) => name === '@/lib/atsu-fetch' ? { atsuFetch } : {} });
  return exports;
}

test('relative and legacy absolute chapter images use the live public CDN', () => {
  const { toPageUrl } = load();
  const path = 'pages/sVC2A/9L82jefe/0.webp';
  for (const input of [path, `/static/${path}`, `static/${path}`, `https://atsu.moe/static/${path}`, `//atsu.moe/static/${path}`]) {
    assert.equal(toPageUrl(input), `https://cdn.atsu.moe/static/${path}`);
  }
});

test('keeps full-resolution file names and leaves other image providers unchanged', () => {
  const { toPageUrl } = load();
  for (const input of ['https://cdn.atsu.moe/static/pages/a/b/0.webp', 'https://example.org/data/hash/001.jpg', 'https://atsu.moe/static/posters/a.avif']) {
    assert.equal(toPageUrl(input), input);
  }
  assert.equal(toPageUrl('pages/a/b/1.webp?v=2'), 'https://cdn.atsu.moe/static/pages/a/b/1.webp?v=2');
  assert.equal(toPageUrl(''), '');
});

test('chapter API maps both page objects and strings in reading order', async () => {
  const manga = load(async (path) => {
    assert.equal(path, '/api/read/chapter?mangaId=sVC2A&chapterId=9L82jefe');
    return { ok: true, json: async () => ({ readChapter: { pages: [
      { image: 'pages/sVC2A/9L82jefe/0.webp' },
      '/static/pages/sVC2A/9L82jefe/1.webp',
      { image: 'https://atsu.moe/static/pages/sVC2A/9L82jefe/2.webp' },
      { image: null },
    ] } }) };
  });
  assert.deepEqual(Array.from(await manga.fetchMangaChapterPages('sVC2A', '9L82jefe')), [0, 1, 2].map((page) =>
    `https://cdn.atsu.moe/static/pages/sVC2A/9L82jefe/${page}.webp`));
});
