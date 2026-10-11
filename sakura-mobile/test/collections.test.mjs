import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/collections.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const anime = { type: 'anime', id: '21' };
const manga = { type: 'manga', id: '21' };
const novel = { type: 'novel', id: '/provider/story?edition=one' };
const record = (changes = {}) => ({ id: 'test', name: 'Weekend', items: [anime], createdAt: 1, updatedAt: 2, ...changes });
function lockManager() {
  let queue = Promise.resolve();
  return { request: (_name, operation) => { const result = queue.then(operation); queue = result.catch(() => {}); return result; } };
}
function harness({ raw = null, web = true, backing = { raw }, locks = lockManager(), failRead = false, failWrite = false, delayWrite = false } = {}) {
  const module = { exports: {} }; const writes = []; const events = new Map();
  let writing = 0; let maxWriting = 0; let failingWrite = failWrite;
  vm.runInNewContext(source, {
    module, exports: module.exports,
    navigator: { locks }, window: { addEventListener: (name, fn) => events.set(name, fn) },
    localStorage: {
      getItem: () => { if (failRead) { const error = new Error('blocked'); error.name = 'SecurityError'; throw error; } return backing.raw; },
      setItem: (_key, value) => { if (failingWrite) throw new Error('quota'); backing.raw = value; writes.push(JSON.parse(value)); },
    },
    require: id => {
      assert.equal(id, 'expo-file-system/legacy');
      return {
        documentDirectory: web ? 'sakura-web://documents/' : 'test://',
        getInfoAsync: async () => ({ exists: backing.raw !== null }),
        readAsStringAsync: async () => backing.raw,
        writeAsStringAsync: async (_file, value) => {
          writing++; maxWriting = Math.max(maxWriting, writing);
          try { if (delayWrite) await new Promise(resolve => setTimeout(resolve, 4)); if (failingWrite) throw new Error('disk full'); backing.raw = value; writes.push(JSON.parse(value)); }
          finally { writing--; }
        },
      };
    },
  });
  return { api: module.exports, backing, writes, events, get maxWriting() { return maxWriting; }, recover() { failingWrite = false; } };
}

test('CRUD persists named ordered collections and deletion never writes the saved Library', async () => {
  const h = harness();
  const collection = await h.api.createCollection('  Weekend   stories  ');
  assert.equal(collection.name, 'Weekend stories');
  await h.api.addCollectionItem(collection.id, anime);
  await h.api.addCollectionItem(collection.id, manga);
  await h.api.addCollectionItem(collection.id, novel);
  await h.api.addCollectionItem(collection.id, anime);
  assert.deepEqual(plain((await h.api.getCollections())[0].items), [anime, manga, novel]);
  await h.api.moveCollectionItem(collection.id, novel, -1);
  assert.deepEqual(plain((await h.api.getCollections())[0].items), [anime, novel, manga]);
  await h.api.moveCollectionItem(collection.id, anime, -1);
  await h.api.moveCollectionItem(collection.id, manga, 1);
  assert.deepEqual(plain((await h.api.getCollections())[0].items), [anime, novel, manga]);
  await h.api.removeCollectionItem(collection.id, anime);
  await h.api.renameCollection(collection.id, '  Next up ');
  assert.equal((await h.api.getCollections())[0].name, 'Next up');
  const reloaded = harness({ backing: h.backing });
  assert.deepEqual(plain((await reloaded.api.getCollections())[0].items), [novel, manga]);
  await h.api.deleteCollection(collection.id);
  assert.deepEqual(plain(await h.api.getCollections()), []);
  assert.deepEqual(Object.keys(h.writes.at(-1)), ['version', 'collections']);
});

test('title identity separates media types and preserves source URLs without delimiter collisions', () => {
  const { api } = harness();
  assert.notEqual(api.collectionItemKey(anime), api.collectionItemKey(manga));
  assert.notEqual(api.collectionItemKey({ type: 'novel', id: 'a:b' }), api.collectionItemKey({ type: 'novel', id: 'a' }));
  assert.equal(JSON.parse(api.collectionItemKey(novel))[1], novel.id);
});

test('validated legacy snapshots migrate on edit and malformed members cannot poison valid data', async () => {
  const h = harness({ raw: JSON.stringify({ version: 0, collections: [record({ name: ' Old   favorites ', items: [anime, anime, manga, null, { type: 'film', id: '1' }, { type: 'novel', id: '' }] }), record({ id: 'test', name: 'duplicate' }), { id: 'bad', name: '' }, { id: '__proto__', name: 'Safe identifier', items: [novel] }] }) });
  const values = await h.api.getCollections();
  assert.equal(values.length, 2);
  assert.equal(values[0].name, 'Old favorites');
  assert.deepEqual(plain(values[0].items), [anime, manga]);
  assert.equal(values[1].id, '__proto__');
  await h.api.renameCollection('test', 'Migrated');
  assert.equal(JSON.parse(h.backing.raw).version, 1);
  assert.equal(JSON.parse(h.backing.raw).collections[1].items[0].id, novel.id);
});

test('corrupt and future snapshots are reported without overwriting them', async () => {
  for (const raw of ['{broken', 'null', '{}', JSON.stringify({ version: 2, collections: [record()] })]) {
    const h = harness({ raw });
    await assert.rejects(h.api.getCollections(), /read|newer app/);
    await assert.rejects(h.api.createCollection('Should not overwrite'), /read|newer app/);
    assert.equal(h.backing.raw, raw);
    assert.equal(h.writes.length, 0);
  }
});

test('concurrent local CRUD is serialized and callers cannot mutate returned snapshots', async () => {
  const h = harness({ web: false, delayWrite: true });
  const [first, second] = await Promise.all([h.api.createCollection('A'), h.api.createCollection('B')]);
  await Promise.all([h.api.addCollectionItem(first.id, anime), h.api.addCollectionItem(first.id, manga), h.api.addCollectionItem(first.id, novel), h.api.renameCollection(second.id, 'Renamed')]);
  assert.equal(h.maxWriting, 1);
  const result = await h.api.getCollections();
  assert.equal(result.length, 2);
  assert.deepEqual(plain(result[0].items), [anime, manga, novel]);
  result[0].items.length = 0; first.name = 'Mutated';
  assert.equal((await h.api.getCollections())[0].items.length, 3);
  assert.equal((await h.api.getCollections())[0].name, 'A');
});

test('independent browser tabs sharing Web Locks retain concurrent changes', async () => {
  const backing = { raw: null }; const locks = lockManager();
  const one = harness({ backing, locks }); const two = harness({ backing, locks });
  const [first] = await Promise.all([one.api.createCollection('From first tab'), two.api.createCollection('From second tab')]);
  await Promise.all([one.api.addCollectionItem(first.id, anime), two.api.addCollectionItem(first.id, manga)]);
  assert.equal((await one.api.getCollections()).length, 2);
  assert.deepEqual(plain((await two.api.getCollections())[0].items), [anime, manga]);
});

test('failed writes reject visibly, leave the prior snapshot intact, and do not poison the write queue', async () => {
  for (const web of [false, true]) {
    const raw = JSON.stringify({ version: 1, collections: [record()] });
    const h = harness({ web, raw, failWrite: true });
    await assert.rejects(h.api.renameCollection('test', 'Lost edit'), /could not be saved/);
    assert.equal(h.backing.raw, raw);
    h.recover();
    await h.api.renameCollection('test', 'Recovered');
    assert.equal((await h.api.getCollections())[0].name, 'Recovered');
  }
});

test('blocked browser reads are explicit and successful writes notify despite a broken subscriber', async () => {
  const blocked = harness({ failRead: true });
  await assert.rejects(blocked.api.getCollections(), /storage is unavailable/);
  const h = harness(); let notifications = 0;
  h.api.subscribeCollections(() => { throw new Error('bad view'); });
  const unsubscribe = h.api.subscribeCollections(() => { notifications++; });
  await h.api.createCollection('Local');
  assert.equal(notifications, 1);
  h.events.get('storage')({ key: h.api.COLLECTIONS_STORAGE_KEY });
  assert.equal(notifications, 2);
  h.events.get('storage')({ key: 'unrelated' });
  assert.equal(notifications, 2);
  unsubscribe();
  await h.api.createCollection('Another');
  assert.equal(notifications, 2);
});

test('invalid names/membership, deleted collections and bounded data return actionable errors', async () => {
  const h = harness();
  assert.throws(() => h.api.createCollection('  '), /between 1 and 60/);
  assert.throws(() => h.api.createCollection('x'.repeat(61)), /between 1 and 60/);
  await assert.rejects(h.api.addCollectionItem('absent', { type: 'movie', id: '1' }), /cannot be added/);
  await assert.rejects(h.api.addCollectionItem('absent', anime), /no longer exists/);
  const full = harness({ raw: JSON.stringify({ version: 1, collections: Array.from({ length: 100 }, (_, index) => record({ id: String(index) })) }) });
  await assert.rejects(full.api.createCollection('Over limit'), /100 collections/);
  await assert.rejects(harness({ raw: ' '.repeat(2_000_001) }).api.getCollections(), /too large/);
});


test('reordering skips references no longer saved in the visible Library while preserving them', async () => {
  const h = harness({ raw: JSON.stringify({ version: 1, collections: [record({ items: [anime, manga, novel] })] }) });
  await h.api.moveCollectionItem('test', novel, -1, [anime, novel]);
  assert.deepEqual(plain((await h.api.getCollections())[0].items), [novel, manga, anime]);
  await h.api.moveCollectionItem('test', novel, -1, [anime, novel]);
  assert.deepEqual(plain((await h.api.getCollections())[0].items), [novel, manga, anime]);
});
