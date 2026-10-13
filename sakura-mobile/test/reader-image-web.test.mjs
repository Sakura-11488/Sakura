import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

// web/node_modules has no DOM renderer (no react-test-renderer, no jsdom), so
// components are called as plain functions. mount() is the smallest harness
// that keeps useState slots between those calls and re-renders on setState,
// which is all the reader image's one-step fallback needs.
let rendering = null;
function useState(initial) {
  const harness = rendering;
  if (!harness) throw new Error('useState outside mount()');
  const slot = harness.cursor++;
  if (!(slot in harness.slots)) harness.slots[slot] = typeof initial === 'function' ? initial() : initial;
  return [harness.slots[slot], (next) => {
    harness.slots[slot] = typeof next === 'function' ? next(harness.slots[slot]) : next;
    harness.render();
  }];
}
function mount(Component, props) {
  const harness = {
    slots: [], cursor: 0, props, element: null,
    render() {
      harness.cursor = 0;
      rendering = harness;
      try { harness.element = Component(harness.props); } finally { rendering = null; }
      return harness.element;
    },
    rerender(next) { harness.props = next; return harness.render(); },
  };
  harness.render();
  return harness;
}

// The renderer's clock, so tests can tell two mounts of the same retry apart.
let clock = 1_700_000_000_000;
const ReaderDate = class extends Date { static now() { return clock; } };

function loadRenderer(filename) {
  const source = readFileSync(new URL(`../components/reader/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    Date: ReaderDate,
    require(id) {
      if (id === 'expo-image') return { Image: 'ExpoImage' };
      if (id === '@/lib/content-proxy-client') return urlExports;
      if (id === 'react') return { ...require('react'), useState };
      if (id === 'react/jsx-runtime') return require(id);
      throw new Error(`Unexpected runtime dependency: ${id}`);
    },
  });
  return exports.default;
}

function loadModule(path, deps) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, URL, URLSearchParams, process: { env: {} }, window: {}, require: (id) => deps[id] || {} });
  return module.exports;
}
// The real URL helpers, as the browser build sees them (`window` selects the
// same-origin /api/media-proxy/ route for the fallback).
const urlExports = loadModule('../lib/content-proxy-client.ts', {
  'react-native': { Platform: { OS: 'web' } },
  './content-hosts': loadModule('../lib/content-hosts.ts', {}),
});
const readerImageUrl = urlExports.getWebMangaPageProxyUrl;
const ReaderImage = loadRenderer('ReaderImage.web.tsx');
const NativeReaderImage = loadRenderer('ReaderImage.tsx');
const render = (p) => mount(ReaderImage, p).element;
const props = {
  source: { uri: 'https://cdn.example.test/pages/page-1.webp' },
  isVisible: true,
  retryAttempt: 0,
  style: { position: 'absolute', inset: 0 },
  contentFit: 'contain',
  transition: 0,
  recyclingKey: 'chapter-1:page-1:0',
  accessibilityLabel: 'Page 1',
};

test('visible reader pages use eager high-priority browser loads without changing URLs', () => {
  const image = render(props);
  assert.equal(image.type, 'img');
  assert.equal(image.props.src, props.source.uri);
  assert.equal(image.props.alt, 'Page 1');
  assert.equal(image.props.loading, 'eager');
  assert.equal(image.props.fetchPriority, 'high');
  assert.equal(image.props.decoding, 'async');
  assert.equal(image.props.draggable, false);
  assert.equal(image.props.style.objectFit, 'contain');
});

test('offscreen pages stay lazy and become eager when made visible', () => {
  const hidden = render({ ...props, isVisible: false });
  assert.equal(hidden.props.loading, 'lazy');
  assert.equal(hidden.props.fetchPriority, 'low');
  const visible = render({ ...props, isVisible: true });
  assert.equal(visible.props.loading, 'eager');
  assert.equal(visible.props.src, hidden.props.src);
  assert.equal(visible.type, hidden.type);
  assert.equal(visible.key, hidden.key);
});

test('manual retry is eager even before viewability updates', () => {
  const retry = render({ ...props, isVisible: false, retryAttempt: 1 });
  assert.equal(retry.props.loading, 'eager');
  assert.equal(retry.props.fetchPriority, 'high');
});

test('browser natural dimensions are forwarded for tall-page layout', () => {
  let loaded;
  const image = render({ ...props, onLoad: (event) => { loaded = event; } });
  image.props.onLoad({ currentTarget: { currentSrc: props.source.uri, naturalWidth: 1200, naturalHeight: 6400 } });
  assert.equal(loaded.source.url, props.source.uri);
  assert.equal(loaded.source.width, 1200);
  assert.equal(loaded.source.height, 6400);
  assert.equal(loaded.cacheType, 'none');
});

test('an error reports failure without discarding the browser image element', () => {
  let errors = 0;
  const reader = mount(ReaderImage, { ...props, onError: () => { errors++; } });
  const image = reader.element;
  image.props.onError();
  assert.equal(errors, 1);
  const after = reader.render();
  assert.equal(after.type, 'img');
  assert.equal(after.props.src, props.source.uri);
  assert.equal(after.key, image.key);
});

test('offline blob and same-origin page URLs remain intact', () => {
  for (const uri of ['blob:https://sakuraonseeker.com/offline-page', '/app/__offline/manga/book/chapter/0000']) {
    assert.equal(render({ ...props, source: { uri } }).props.src, uri);
  }
});

test('ATSU reader pages use full-resolution same-origin delivery without proxying other URLs', () => {
  const uri = 'https://cdn.atsu.moe/static/pages/sVC2A/9L82jefe/0.webp';
  const image = render({ ...props, source: { uri } });
  const proxy = new URL(image.props.src, 'https://sakuraonseeker.com');
  assert.equal(proxy.pathname, '/api/manga-page/');
  assert.equal(proxy.searchParams.get('u'), uri);
  assert.equal(readerImageUrl(image.props.src), image.props.src);
  for (const source of ['https://cdn.atsu.moe/static/posters/a.webp', 'https://example.test/page.webp',
    'https://user:pass@cdn.atsu.moe/static/pages/a/b/1.webp']) {
    assert.equal(readerImageUrl(source), source);
  }
});

const site = (src) => new URL(src, 'https://sakuraonseeker.com');
// Both page-path shapes atsu returns; the second is common on Manwha-typed titles.
const ATSU_PAGES = [
  'https://cdn.atsu.moe/static/pages/sVC2A/9L82jefe/0.webp',
  'https://cdn.atsu.moe/static/pages/9L82jefe/0.webp',
];

test('an atsu page that fails on /api/manga-page/ switches once to the droplet route before reporting', () => {
  for (const uri of ATSU_PAGES) {
    let errors = 0;
    const reader = mount(ReaderImage, { ...props, source: { uri }, onError: () => { errors++; } });
    assert.equal(site(reader.element.props.src).pathname, '/api/manga-page/');
    reader.element.props.onError();
    assert.equal(errors, 0, 'the first failure is not reported');
    const fallback = site(reader.element.props.src);
    assert.equal(fallback.pathname, '/api/media-proxy/');
    assert.equal(fallback.searchParams.get('path'), `/manhwa/v1/img?u=${encodeURIComponent(uri)}`);
    assert.deepEqual([...fallback.searchParams.keys()], ['path'], 'no cache-buster on a first attempt');
    assert.equal(reader.element.type, 'img');
    reader.element.props.onError();
    assert.equal(errors, 1, 'the fallback failing is reported');
    assert.equal(site(reader.element.props.src).pathname, '/api/media-proxy/', 'no loop back to the primary');
  }
});

test('a page that loads from the fallback reports its real dimensions', () => {
  let loaded;
  const reader = mount(ReaderImage, { ...props, source: { uri: ATSU_PAGES[0] }, onLoad: (event) => { loaded = event; } });
  reader.element.props.onError();
  const src = reader.element.props.src;
  reader.element.props.onLoad({ currentTarget: { currentSrc: src, naturalWidth: 800, naturalHeight: 12000 } });
  assert.equal(loaded.source.url, src);
  assert.equal(loaded.source.width, 800);
  assert.equal(loaded.source.height, 12000);
});

test('a retry starts again from the primary, and only media-proxy URLs carry the cache-buster', () => {
  const uri = ATSU_PAGES[0];
  let errors = 0;
  const reader = mount(ReaderImage, { ...props, source: { uri }, onError: () => { errors++; } });
  reader.element.props.onError();
  reader.element.props.onError();
  assert.equal(errors, 1);

  // Same element, next attempt (the reader also remounts by key; this must hold either way).
  const retried = site(reader.rerender({ ...reader.props, retryAttempt: 1 }).props.src);
  assert.equal(retried.pathname, '/api/manga-page/');
  // api/manga-page.js 400s any parameter but `u`, and never caches an error.
  assert.deepEqual([...retried.searchParams.keys()], ['u']);
  reader.element.props.onError();
  assert.equal(errors, 1, 'the retry gets its own fallback step');
  const fallback = site(reader.element.props.src);
  assert.equal(fallback.pathname, '/api/media-proxy/');
  assert.equal(fallback.searchParams.get('path'), `/manhwa/v1/img?u=${encodeURIComponent(uri)}`);
  assert.match(fallback.searchParams.get('r'), /^1\.[0-9a-z]+$/);
  reader.element.props.onError();
  assert.equal(errors, 2);

  // A fresh mount (how ReaderPageImage actually retries, via its key) is on the primary too.
  assert.equal(site(render({ ...props, source: { uri }, retryAttempt: 2 }).props.src).pathname, '/api/manga-page/');
});

test('retries of manhwa, comics and 18+ pages bypass an edge-cached failure without touching path', () => {
  const page = `/api/media-proxy/?path=${encodeURIComponent('/manhwa/v1/img?u=https://cdn.example.test/ch-1/001.jpg')}`;
  assert.equal(render({ ...props, source: { uri: page } }).props.src, page, 'attempt 0 shares the cached URL');
  for (const retryAttempt of [1, 2]) {
    const src = site(render({ ...props, source: { uri: page }, retryAttempt }).props.src);
    assert.equal(src.pathname, '/api/media-proxy/');
    assert.equal(src.searchParams.get('path'), '/manhwa/v1/img?u=https://cdn.example.test/ch-1/001.jpg');
    assert.match(src.searchParams.get('r'), new RegExp(`^${retryAttempt}\\.[0-9a-z]+$`));
  }
  // The edge cache is shared and the browser's outlives the reader, so the same
  // attempt number on a later mount (another reader, or this one an hour ago)
  // must not reuse a URL whose failure may be cached. One mount keeps its URL.
  const first = mount(ReaderImage, { ...props, source: { uri: page }, retryAttempt: 1 });
  const firstSrc = first.element.props.src;
  clock += 1;
  assert.notEqual(render({ ...props, source: { uri: page }, retryAttempt: 1 }).props.src, firstSrc);
  assert.equal(first.render().props.src, firstSrc);
  // A media-proxy page has no second route: its first failure is reported.
  let errors = 0;
  render({ ...props, source: { uri: page }, onError: () => { errors++; } }).props.onError();
  assert.equal(errors, 1);
  // Nothing else is rewritten on retry.
  for (const uri of [props.source.uri, 'blob:https://sakuraonseeker.com/offline-page', '/app/__offline/manga/book/chapter/0000']) {
    assert.equal(render({ ...props, source: { uri }, retryAttempt: 3 }).props.src, uri);
  }
});

test('native keeps existing Expo props and strips web scheduling flags', () => {
  const native = NativeReaderImage(props);
  assert.equal(native.type, 'ExpoImage');
  assert.equal(native.props.source, props.source);
  assert.equal(native.props.style, props.style);
  assert.equal(native.props.recyclingKey, props.recyclingKey);
  assert.equal(native.props.transition, 0);
  assert.equal(native.props.contentFit, 'contain');
  assert.equal('isVisible' in native.props, false);
  assert.equal('retryAttempt' in native.props, false);
});
