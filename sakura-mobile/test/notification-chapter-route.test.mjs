import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(new URL('../components/notifications/NotificationBridge.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

// Only the routing is under test; the bridge's native modules are stubs.
const exports = {};
vm.runInNewContext(compiled, {
  exports, Number, String,
  require: (id) => {
    if (id === 'react') return { useEffect() {}, useRef: () => ({ current: false }) };
    if (id === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
    if (id === 'expo-notifications') return {};
    if (id === 'expo-router') return { useRouter: () => ({}) };
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
    return {};
  },
});

function route(data) {
  const pushed = [];
  exports.routeFromNotificationData({ push: (target) => pushed.push(JSON.parse(JSON.stringify(target))) }, data);
  return pushed;
}

test('a new-chapter push opens that chapter of that series, not an empty reader', () => {
  // The payload push-manga-updates sends.
  const pushed = route({ type: 'manga', id: 'v8Kbg', chapterId: 'h8cWsGUI', chapter: 178, pushKind: 'manga_update' });
  assert.deepEqual(pushed, [{
    pathname: '/chapter/[id]',
    params: { id: 'v8Kbg~h8cWsGUI', chapter: 'Chapter 178' },
  }]);
});

test('title, page and source are carried when the payload has them', () => {
  const [target] = route({ type: 'manga', id: 'mr:solo', chapterId: 'ch-281', chapter: '281', title: 'Solo Max-Level Newbie', source: 'manhwa', page: 3 });
  assert.deepEqual(target.params, {
    id: 'mr:solo~ch-281', chapter: 'Chapter 281', title: 'Solo Max-Level Newbie', p: '3', source: 'manhwa',
  });
});

test('a manga push without a chapter opens the series page', () => {
  assert.deepEqual(route({ type: 'manga', id: 'v8Kbg' }), [{ pathname: '/manga/[id]', params: { id: 'v8Kbg' } }]);
  assert.deepEqual(route({ type: 'manga', id: 'mr:x', source: 'manhwa' }), [{ pathname: '/manga/[id]', params: { id: 'mr:x', source: 'manhwa' } }]);
});

test("'chapter' pushes accept a full reader id or a series + chapter pair, and ignore a bare chapter id", () => {
  assert.deepEqual(route({ type: 'chapter', id: 'v8Kbg~c1', page: 5 })[0].params, { id: 'v8Kbg~c1', p: '5' });
  assert.deepEqual(route({ type: 'chapter', id: 'c1', mangaId: 'v8Kbg' })[0].params, { id: 'v8Kbg~c1' });
  assert.deepEqual(route({ type: 'chapter', id: 'c1' }), [], 'no series: opening it could only show an empty reader');
});

test('other pushes are untouched', () => {
  assert.deepEqual(route({ type: 'anime', id: '21' }), [{ pathname: '/anime/[id]', params: { id: '21' } }]);
  assert.deepEqual(route({ type: 'new_releases' }), ['/new-releases']);
  assert.deepEqual(route(undefined), []);
  assert.equal(exports.chapterRouteFromPush({ type: 'anime', id: '1', chapterId: '2' }), null);
});
