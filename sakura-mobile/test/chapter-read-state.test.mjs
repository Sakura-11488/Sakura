import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const transpile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function loadModule(initial = null) {
  const files = new Map(initial ? [['sakura_chapter_read_state.json', initial]] : []);
  const writes = [];
  const module = { exports: {} };
  vm.runInNewContext(transpile('../lib/chapter-read-state.ts'), {
    module, exports: module.exports, Date, JSON, Set, Object, Promise,
    require: (id) => {
      assert.equal(id, '@/lib/kv-store');
      return {
        readStore: async (name) => files.get(name) ?? null,
        writeStore: async (name, value) => { files.set(name, value); writes.push(JSON.parse(value)); return true; },
      };
    },
  });
  return { api: module.exports, files, writes };
}

test('marks persist per series and source, and survive a reload', async () => {
  const { api, files } = loadModule();
  await api.markChapterRead(undefined, 'v8Kbg', 'c1');
  await api.setChaptersRead('manhwa', 'mr:solo-leveling', ['chapter-1', 'chapter-2']);
  assert.deepEqual([...await api.getReadChapterIds('manga', 'v8Kbg')], ['c1'], "absent source and 'manga' are the same series");
  assert.deepEqual([...await api.getReadChapterIds('manhwa', 'mr:solo-leveling')].sort(), ['chapter-1', 'chapter-2']);
  assert.equal((await api.getReadChapterIds('comics', 'v8Kbg')).size, 0, 'sources do not share marks');

  const reloaded = loadModule(files.get('sakura_chapter_read_state.json'));
  assert.deepEqual([...await reloaded.api.getReadChapterIds(undefined, 'v8Kbg')], ['c1']);
});

test('unmarking works, unchanged calls do not write, and subscribers hear real changes only', async () => {
  const { api, writes } = loadModule();
  let heard = 0;
  const off = api.subscribeChapterReadState(() => { heard++; });
  await api.setChaptersRead('manga', 's', ['a', 'b', 'c']);
  await api.setChaptersRead('manga', 's', ['a', 'b']);
  assert.equal(writes.length, 1, 'marking already-read chapters is a no-op');
  await api.setChaptersRead('manga', 's', ['b'], false);
  assert.deepEqual([...await api.getReadChapterIds('manga', 's')].sort(), ['a', 'c']);
  assert.equal(heard, 2);
  off();
  await api.setChaptersRead('manga', 's', ['a', 'c'], false);
  assert.equal(heard, 2);
  assert.deepEqual(writes.at(-1), {}, 'an emptied series is removed');
});

test('the 18+ source leaves no trace', async () => {
  const { api, writes } = loadModule();
  await api.markChapterRead('hentai', '123', 'gallery');
  assert.equal(writes.length, 0);
  assert.equal((await api.getReadChapterIds('hentai', '123')).size, 0);
});

test('a corrupt store starts empty, and bad rows are dropped', async () => {
  assert.equal((await loadModule('{not json').api.getReadChapterIds('manga', 'x')).size, 0);
  const { api } = loadModule(JSON.stringify({ 'manga:ok': { read: ['1', 2, ''], updatedAt: 1 }, 'manga:bad': { read: 'x' }, junk: null }));
  assert.deepEqual([...await api.getReadChapterIds('manga', 'ok')], ['1']);
  assert.equal((await api.getReadChapterIds('manga', 'bad')).size, 0);
});
