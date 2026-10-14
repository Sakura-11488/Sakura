import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

function loadStorage() {
  const files = new Map();
  const fs = {
    documentDirectory: 'file:///docs/',
    getInfoAsync: async (path) => ({ exists: files.has(path) }),
    readAsStringAsync: async (path) => files.get(path),
    writeAsStringAsync: async (path, value) => { files.set(path, value); },
  };
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(new URL('../lib/storage.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    module, exports: module.exports, JSON, Date, Map, Number, Promise,
    require: (name) => { assert.equal(name, 'expo-file-system/legacy'); return fs; },
  });
  return module.exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const item = (id, extra = {}) => ({ id, title: id, cover: '', type: 'manga', savedAt: 100, ...extra });

test('a reading status is set and cleared without reordering the library', async () => {
  const { Library } = loadStorage();
  await Library.save(item('a'));
  await Library.save(item('b'));
  const before = plain(await Library.getAll()).map((i) => i.id);
  await Library.setStatus('a', 'manga', 'on-hold');
  let all = plain(await Library.getAll());
  assert.deepEqual(all.map((i) => i.id), before);
  assert.equal(all.find((i) => i.id === 'a').status, 'on-hold');
  assert.equal(typeof all.find((i) => i.id === 'a').statusAt, 'number');
  await Library.setStatus('a', 'manga', 'bogus');
  assert.equal(plain(await Library.getAll()).find((i) => i.id === 'a').status, 'on-hold', 'unknown statuses are refused');
  await Library.setStatus('a', 'manga', null);
  all = plain(await Library.getAll());
  assert.equal(all.find((i) => i.id === 'a').status, undefined);
  await Library.setStatus('missing', 'manga', 'reading');
  assert.equal(plain(await Library.getAll()).length, 2, 'never adds an item');
});

test('merging keeps the newest status choice even when the other copy wins on savedAt', () => {
  const { mergeLibraryItems } = loadStorage();
  const cloud = [item('a', { savedAt: 200, status: 'reading', statusAt: 10 })];
  const local = [item('a', { savedAt: 100, status: 'dropped', statusAt: 20, source: 'manhwa' })];
  const [merged] = plain(mergeLibraryItems(cloud, local));
  assert.equal(merged.savedAt, 200);
  assert.equal(merged.status, 'dropped');
  assert.equal(merged.statusAt, 20);
  assert.equal(merged.source, 'manhwa', 'the source survives as before');
  const [cleared] = plain(mergeLibraryItems([item('a', { statusAt: 30 })], local));
  assert.equal(cleared.status, undefined, 'a newer "cleared" choice wins too');
  const [junk] = plain(mergeLibraryItems([item('a', { status: '<script>', statusAt: 99 })], []));
  assert.equal(junk.status, undefined, 'bad synced values are dropped');
});

test('the effective status falls back to reading once started, plan to read otherwise', () => {
  const { effectiveReadingStatus } = loadStorage();
  assert.equal(effectiveReadingStatus({}, true), 'reading');
  assert.equal(effectiveReadingStatus({}, false), 'plan');
  assert.equal(effectiveReadingStatus({ status: 'completed' }, true), 'completed');
});
