import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const compile = name => ts.transpileModule(readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const sources = { keys: compile('offline-cache-keys.ts'), store: compile('novel-offline.web.ts') };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const chapter = path => ({ novelPath: 'book', chapterPath: path, chapterNumber: 1, chapterTitle: path, title: 'Book', cover: '' });

function world(parseChapterContent) {
  const bytes = new Map();
  const url = input => new URL(typeof input === 'string' ? input : input.url, 'https://sakura.test').href;
  const cache = {
    putHook: null,
    async put(key, response) {
      await cache.putHook?.(url(key));
      bytes.set(url(key), new Response(await response.arrayBuffer(), { headers: response.headers }));
    },
    async match(key) { return bytes.get(url(key))?.clone(); },
    async delete(key) { return bytes.delete(url(key)); },
    async keys() { return [...bytes.keys()].map(url => ({ url })); },
  };
  const keys = {};
  const env = {
    Response, URL, TextEncoder, DOMException, console,
    caches: { open: async () => cache },
    navigator: { storage: { persisted: async () => true } },
  };
  vm.runInNewContext(sources.keys, { ...env, exports: keys });
  const api = {};
  vm.runInNewContext(sources.store, { ...env, exports: api, require: id => {
    if (id === '@/lib/allnovel') return { parseChapterContent };
    if (id === '@/lib/offline-cache-keys') return keys;
    throw new Error(`Unexpected import ${id}`);
  } });
  return { api, cache, keys, bytes };
}

test('clear cancels a pending batch without waiting on network or starting later chapters', async () => {
  const started = deferred();
  const fetch = deferred();
  let calls = 0;
  const w = world(() => { calls++; started.resolve(); return fetch.promise; });
  const batch = w.api.downloadAllNovelChapters({ novelPath: 'book', title: 'Book', cover: '', chapters: [
    { path: 'one', chapterNumber: 1, name: 'One' }, { path: 'two', chapterNumber: 2, name: 'Two' },
  ] });
  await started.promise;
  await w.api.clearAllOfflineNovel();
  assert.equal(w.api.getNovelBatchState('book'), null);
  fetch.resolve('Late chapter');
  const result = await batch;
  assert.equal(result.ok, 0, 'cancelled work must not count as a saved chapter');
  assert.equal(calls, 1);
  assert.equal((await w.api.listOfflineNovelChapters()).length, 0);
  assert.equal(await w.cache.match(w.keys.offlineNovelUrl('book', 'one')), undefined);
  assert.deepEqual((await (await w.cache.match(w.keys.NOVEL_MANIFEST_URL)).json()).chapters, {});
});

test('deleting an in-flight chapter prevents its late failure removing a replacement download', async () => {
  const started = deferred();
  const fetch = deferred();
  let calls = 0;
  const w = world(() => { calls++; started.resolve(); return calls === 1 ? fetch.promise : 'Replacement'; });
  const old = w.api.downloadNovelChapter(chapter('one'));
  await started.promise;
  await w.api.deleteOfflineNovelChapter('book', 'one');
  await w.api.downloadNovelChapter(chapter('one'));
  fetch.reject(new Error('Old request failed'));
  await old;
  assert.equal(await w.api.getOfflineNovelChapterContent('book', 'one'), 'Replacement');
});

test('clear waits for an already-started cache write and then removes the body', async () => {
  const writing = deferred();
  const finishWrite = deferred();
  const w = world(async () => 'Chapter text');
  w.cache.putHook = async url => {
    if (url.includes('/novel/')) { writing.resolve(); await finishWrite.promise; }
  };
  const download = w.api.downloadNovelChapter(chapter('one'));
  await writing.promise;
  const cleared = w.api.clearAllOfflineNovel();
  finishWrite.resolve();
  await Promise.all([download, cleared]);
  assert.equal((await w.api.listOfflineNovelChapters()).length, 0);
  assert.equal(await w.cache.match(w.keys.offlineNovelUrl('book', 'one')), undefined);
});

test('clear removes orphaned novel bodies while preserving other offline media', async () => {
  const w = world(async () => 'Chapter');
  const orphan = w.keys.offlineNovelUrl('lost', 'orphan');
  const image = '/app/__offline/atsu/book/chapter/0000';
  await w.cache.put(orphan, new Response('Orphan'));
  await w.cache.put(image, new Response('Image'));
  await w.api.clearAllOfflineNovel();
  assert.equal(await w.cache.match(orphan), undefined);
  assert.equal(await (await w.cache.match(image)).text(), 'Image');
});

test('concurrent requests for one chapter share the active job before storage opens', async () => {
  let calls = 0;
  const w = world(async () => { calls++; return 'Chapter'; });
  await Promise.all([w.api.downloadNovelChapter(chapter('one')), w.api.downloadNovelChapter(chapter('one'))]);
  assert.equal(calls, 1);
  assert.equal(await w.api.getOfflineNovelChapterContent('book', 'one'), 'Chapter');
});
