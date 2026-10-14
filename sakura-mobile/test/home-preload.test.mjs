import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/home-preload.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ os = 'web', pathname = '/app/home/' } = {}) {
  const calls = [];
  const clock = { now: 1_000 };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Promise,
    Date: { now: () => clock.now },
    window: { location: { pathname } },
    require: name => {
      if (name === 'react-native') return { Platform: { OS: os } };
      if (name === '@/lib/manga') return {
        fetchTrendingManga: limit => { calls.push(`trending:${limit}`); return Promise.resolve([{ id: 't' }]); },
        fetchPopularManga: limit => { calls.push(`popular:${limit}`); return Promise.resolve([{ id: 'p' }]); },
      };
      throw new Error(`unexpected import ${name}`);
    },
  });
  return { api: module.exports, calls, clock };
}

test('opening home or the app root starts both lists once, with the limits home asks for', async () => {
  for (const pathname of ['/app', '/app/', '/app/home', '/app/home/']) {
    const { api, calls } = harness({ pathname });
    api.startHomeListsPreload();
    api.startHomeListsPreload();
    assert.deepEqual(calls, [`trending:${api.HOME_TRENDING_LIMIT}`, `popular:${api.HOME_POPULAR_LIMIT}`], pathname);
    const lists = api.takeHomeListsPreload();
    assert.equal((await lists.trending)[0].id, 't');
    assert.equal((await lists.popular)[0].id, 'p');
    assert.equal(api.takeHomeListsPreload(), null, 'taken once');
  }
});

test('deep links and native start nothing', () => {
  for (const pathname of ['/app/manga/abc', '/app/chapter/a~b', '/app/browse/', '/app/welcome']) {
    const { api, calls } = harness({ pathname });
    api.startHomeListsPreload();
    assert.deepEqual(calls, [], pathname);
    assert.equal(api.takeHomeListsPreload(), null);
  }
  const native = harness({ os: 'android' });
  native.api.startHomeListsPreload();
  assert.deepEqual(native.calls, []);
});

test('a preload left unclaimed for a minute is not reused', () => {
  const { api, clock } = harness();
  api.startHomeListsPreload();
  clock.now += 60_001;
  assert.equal(api.takeHomeListsPreload(), null);
});

test('an early failure is not an unhandled rejection, and home still sees it', async () => {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Promise, Date,
    window: { location: { pathname: '/app/home' } },
    require: name => name === 'react-native' ? { Platform: { OS: 'web' } } : {
      fetchTrendingManga: () => Promise.reject(new Error('blocked')),
      fetchPopularManga: () => Promise.resolve([]),
    },
  });
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  module.exports.startHomeListsPreload();
  await new Promise(resolve => setImmediate(resolve));
  const lists = module.exports.takeHomeListsPreload();
  await assert.rejects(lists.trending, /blocked/);
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0);
});
