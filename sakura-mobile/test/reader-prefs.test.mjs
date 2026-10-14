import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/reader-prefs.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function loadModule(initial = null) {
  const files = new Map(initial == null ? [] : [['sakura_reader_prefs.json', initial]]);
  const writes = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, JSON, Math, Number, Object, Promise, Set,
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

test('defaults: a 720 px reading column, black, screen kept on', async () => {
  const { api } = loadModule();
  assert.equal(api.readerPrefsLoaded(), false);
  assert.equal(api.getReaderPrefsSnapshot().maxWidth, 720);
  const prefs = await api.loadReaderPrefs();
  assert.equal(api.readerPrefsLoaded(), true);
  assert.deepEqual({ ...prefs }, {
    pageFit: 'width', maxWidth: 720, background: 'black', pageGap: false,
    brightness: 1, keepAwake: true, autoScrollSpeed: 2, tapZones: 'auto',
  });
});

test('stored values are validated, clamped and snapped; junk falls back to defaults', async () => {
  const { api } = loadModule(JSON.stringify({
    pageFit: 'zoom', maxWidth: 9999, background: 'white', pageGap: 'yes',
    brightness: 0.01, keepAwake: false, autoScrollSpeed: 3.6, tapZones: 'inverted', extra: 1,
  }));
  const prefs = await api.loadReaderPrefs();
  assert.equal(prefs.pageFit, 'width');
  assert.equal(prefs.maxWidth, 1600);
  assert.equal(prefs.background, 'white');
  assert.equal(prefs.pageGap, false);
  assert.equal(prefs.brightness, 0.3);
  assert.equal(prefs.keepAwake, false);
  assert.equal(prefs.autoScrollSpeed, 4);
  assert.equal(prefs.tapZones, 'inverted');
  assert.equal('extra' in prefs, false);
  assert.equal(api.sanitizeReaderPrefs({ maxWidth: 733 }).maxWidth, 720, 'snapped to the 40 px step');
});

test('a corrupt record still opens the reader with defaults', async () => {
  const { api } = loadModule('{nope');
  assert.equal((await api.loadReaderPrefs()).background, 'black');
});

test('updates reach listeners at once and persist in order', async () => {
  const { api, files, writes } = loadModule();
  const heard = [];
  const off = api.subscribeReaderPrefs((p) => heard.push(p.maxWidth));
  await Promise.all([api.updateReaderPrefs({ maxWidth: 800 }), api.updateReaderPrefs({ maxWidth: 840 })]);
  assert.deepEqual(heard, [800, 840]);
  assert.equal(writes.at(-1).maxWidth, 840);
  assert.equal(JSON.parse(files.get('sakura_reader_prefs.json')).maxWidth, 840);
  off();
  await api.updateReaderPrefs({ pageGap: true });
  assert.deepEqual(heard, [800, 840]);
  assert.equal(api.getReaderPrefsSnapshot().pageGap, true);
  assert.equal(api.getReaderPrefsSnapshot().maxWidth, 840, 'a patch keeps the other prefs');
});
