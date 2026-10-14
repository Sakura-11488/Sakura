import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
function compile(file) {
  return ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
}
const coversCode = compile('../lib/novel-covers.ts');
function coverHarness(fetch, timers = {}) {
  const exports = {};
  vm.runInNewContext(coversCode, { exports, fetch, AbortController, setTimeout, clearTimeout, ...timers });
  return exports;
}
const novels = Array.from({ length: 20 }, (_, i) => ({ path: `novel-${i}`, name: `Novel ${i}`, cover: `https://source.example/${i}.jpg` }));

test('cover enrichment never calls a third-party API and keeps every source cover', async () => {
  // Google Books lookups 429-ed, matched the wrong book by title and swapped
  // covers after the grid painted, so enrichment is now network-free.
  let calls = 0;
  const covers = coverHarness(async () => { calls++; throw new Error('Unexpected fetch'); });
  const result = await covers.enhanceCovers(novels);
  assert.equal(calls, 0);
  assert.equal(result.length, 20);
  assert.deepEqual(Array.from(result, (row) => row.cover), novels.map((row) => row.cover));
  assert.equal(result[0].originalCover, novels[0].cover);
  assert.equal(await covers.getHDCover('Another title'), null);
  assert.equal(calls, 0);
});

test('late enrichment preserves newer pagination and never resurrects a different result set', () => {
  const covers = coverHarness(async () => { throw new Error('Unexpected fetch'); });
  const enriched = [{ ...novels[0], cover: 'https://covers.example/hd.jpg', originalCover: novels[0].cover }];
  const paged = covers.mergeNovelCovers([novels[0], novels[1]], enriched);
  assert.equal(paged.length, 2);
  assert.equal(paged[1], novels[1]);
  const differentSearch = covers.mergeNovelCovers([novels[2]], enriched);
  assert.equal(differentSearch.length, 1);
  assert.equal(differentSearch[0], novels[2]);
});

// A small hook driver lets us trigger actual image callbacks without a native
// runtime or fetching media. It does not model the reader's virtualized rows.
const imageCode = compile('../components/reader/ReaderPageImage.tsx');
function imageHarness(initialProps = {}) {
  const slots = [], effects = [], timers = new Map();
  let cursor = 0, nextTimer = 0;
  const react = {
    __esModule: true,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect(callback, deps) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, at) => value !== old.deps[at])) {
        effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
      }
    },
  };
  const exports = {};
  vm.runInNewContext(imageCode, {
    exports,
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
      if (id === './ReaderImage') return { __esModule: true, default: 'Image' };
      if (id === 'react-native') return {
        ActivityIndicator: 'Spinner', Text: 'Text', TouchableOpacity: 'Button', View: 'View',
        StyleSheet: { create: (styles) => styles, absoluteFill: { position: 'absolute' } },
      };
      throw new Error(id);
    },
  });
  let backCalls = 0, loads = 0;
  const props = { uri: 'https://source.example/page.jpg', pageId: 'chapter-1#0', pageNumber: 1, width: 1200, height: 1800, viewportHeight: 800,
    onBack: () => { backCalls++; }, onLoad: () => { loads++; }, ...initialProps };
  return {
    timers,
    setProps(next) { Object.assign(props, next); },
    render(flushEffects = true) { cursor = 0; const tree = exports.default(props); if (flushEffects) effects.splice(0).forEach((effect) => effect()); return tree; },
    get backCalls() { return backCalls; }, get loads() { return loads; },
  };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}
function text(tree) { return nodes(tree).filter((node) => node.type === 'Text').map((node) => [node.props.children].flat().join('')).join(' '); }

test('one failed mounted page shows retry and back without waiting for other chapter pages', () => {
  const h = imageHarness();
  let tree = h.render();
  assert.equal(nodes(tree).find((node) => node.type === 'Image').props.accessibilityLabel, 'Page 1');
  nodes(tree).find((node) => node.type === 'Image').props.onError();
  tree = h.render();
  assert.match(text(tree), /Page 1 could not load/);
  const message = nodes(tree).find((node) => node.props.accessibilityLiveRegion === 'polite');
  assert.equal(message.props.style[1].height, 800, 'error is visible within the viewport even for a tall page');
  nodes(tree).find((node) => node.type === 'Button' && text(node) === 'Back to chapters').props.onPress();
  assert.equal(h.backCalls, 1);
});

test('retry remounts only that page and ignores callbacks from the previous request', () => {
  const h = imageHarness();
  let tree = h.render();
  const oldImage = nodes(tree).find((node) => node.type === 'Image');
  oldImage.props.onError();
  tree = h.render();
  nodes(tree).find((node) => node.type === 'Button' && text(node) === 'Retry page').props.onPress();
  tree = h.render();
  const newImage = nodes(tree).find((node) => node.type === 'Image');
  assert.notEqual(oldImage.key, newImage.key);
  assert.equal(oldImage.props.retryAttempt, 0);
  assert.equal(newImage.props.retryAttempt, 1);
  oldImage.props.onLoad({ source: { width: 500, height: 800 } });
  assert.equal(h.loads, 0);
  newImage.props.onLoad({ source: { width: 500, height: 800 } });
  tree = h.render();
  assert.equal(h.loads, 1);
  assert.doesNotMatch(text(tree), /could not load|Loading page/);
});

test('a stalled image exposes recovery after 15 seconds without retrying automatically', () => {
  const h = imageHarness();
  const firstImage = nodes(h.render()).find((node) => node.type === 'Image');
  const timer = [...h.timers.values()][0];
  assert.equal(timer.ms, 15000);
  timer.callback();
  const tree = h.render();
  assert.match(text(tree), /Page 1 could not load/);
  assert.equal(nodes(tree).filter((node) => node.type === 'Image').length, 1);
  assert.equal(nodes(tree).find((node) => node.type === 'Image').key, firstImage.key);
  assert.equal(nodes(tree).find((node) => node.type === 'Image').props.retryAttempt, 0);
  firstImage.props.onLoad({ source: { width: 1200, height: 1800 } });
  assert.doesNotMatch(text(h.render()), /could not load|Loading page/);
});

test('an immediately cached image stays ready when its loading effect runs later', () => {
  const h = imageHarness();
  const initial = h.render(false);
  nodes(initial).find((node) => node.type === 'Image').props.onLoad({ source: { width: 500, height: 800 } });
  h.render();
  const tree = h.render();
  assert.doesNotMatch(text(tree), /Loading page|could not load/);
  for (const timer of h.timers.values()) timer.callback();
  assert.doesNotMatch(text(h.render()), /Loading page|could not load/);
});

test('mounted offscreen lazy pages do not time out before a request is needed', () => {
  const h = imageHarness({ isVisible: false });
  h.render();
  assert.equal(h.timers.size, 0);
  assert.doesNotMatch(text(h.render()), /could not load/);
  h.setProps({ isVisible: true });
  h.render();
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.values()][0];
  assert.equal(timer.ms, 15000);
  timer.callback();
  assert.match(text(h.render()), /Page 1 could not load/);
});

test('leaving the viewport cancels the deadline and returning grants a fresh loading window', () => {
  const h = imageHarness({ isVisible: true });
  h.render();
  const previous = [...h.timers.values()][0];
  h.setProps({ isVisible: false });
  h.render();
  assert.equal(h.timers.size, 0);
  previous.callback();
  assert.doesNotMatch(text(h.render()), /could not load/);
  h.setProps({ isVisible: true });
  let tree = h.render();
  assert.equal(h.timers.size, 1);
  assert.notEqual([...h.timers.values()][0], previous);
  nodes(tree).find((node) => node.type === 'Image').props.onLoad({ source: { width: 1200, height: 1639 } });
  tree = h.render();
  assert.equal(h.timers.size, 0);
  assert.doesNotMatch(text(tree), /Loading page|could not load/);
});
