import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

function loadRenderer(filename) {
  const source = readFileSync(new URL(`../components/reader/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(id) {
      if (id === 'expo-image') return { Image: 'ExpoImage' };
      if (id === '@/lib/reader-image-url') return { readerImageUrl };
      if (id === 'react' || id === 'react/jsx-runtime') return require(id);
      throw new Error(`Unexpected runtime dependency: ${id}`);
    },
  });
  return exports.default;
}

const urlExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/reader-image-url.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: urlExports, URL, URLSearchParams });
const { readerImageUrl } = urlExports;
const ReaderImage = loadRenderer('ReaderImage.web.tsx');
const NativeReaderImage = loadRenderer('ReaderImage.tsx');
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
  const image = ReaderImage(props);
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
  const hidden = ReaderImage({ ...props, isVisible: false });
  assert.equal(hidden.props.loading, 'lazy');
  assert.equal(hidden.props.fetchPriority, 'low');
  const visible = ReaderImage({ ...props, isVisible: true });
  assert.equal(visible.props.loading, 'eager');
  assert.equal(visible.props.src, hidden.props.src);
  assert.equal(visible.type, hidden.type);
  assert.equal(visible.key, hidden.key);
});

test('manual retry is eager even before viewability updates', () => {
  const retry = ReaderImage({ ...props, isVisible: false, retryAttempt: 1 });
  assert.equal(retry.props.loading, 'eager');
  assert.equal(retry.props.fetchPriority, 'high');
});

test('browser natural dimensions are forwarded for tall-page layout', () => {
  let loaded;
  const image = ReaderImage({ ...props, onLoad: (event) => { loaded = event; } });
  image.props.onLoad({ currentTarget: { currentSrc: props.source.uri, naturalWidth: 1200, naturalHeight: 6400 } });
  assert.equal(loaded.source.url, props.source.uri);
  assert.equal(loaded.source.width, 1200);
  assert.equal(loaded.source.height, 6400);
  assert.equal(loaded.cacheType, 'none');
});

test('an error reports failure without discarding the browser image element', () => {
  let errors = 0;
  const callbacks = { ...props, onError: () => { errors++; } };
  const image = ReaderImage(callbacks);
  image.props.onError();
  assert.equal(errors, 1);
  const after = ReaderImage(callbacks);
  assert.equal(after.type, 'img');
  assert.equal(after.props.src, props.source.uri);
  assert.equal(after.key, image.key);
});

test('offline blob and same-origin page URLs remain intact', () => {
  for (const uri of ['blob:https://sakuraonseeker.com/offline-page', '/app/__offline/manga/book/chapter/0000']) {
    assert.equal(ReaderImage({ ...props, source: { uri } }).props.src, uri);
  }
});

test('ATSU reader pages use full-resolution same-origin delivery without proxying other URLs', () => {
  const uri = 'https://cdn.atsu.moe/static/pages/sVC2A/9L82jefe/0.webp';
  const image = ReaderImage({ ...props, source: { uri } });
  const proxy = new URL(image.props.src, 'https://sakuraonseeker.com');
  assert.equal(proxy.pathname, '/api/reader-image/');
  assert.equal(proxy.searchParams.get('url'), uri);
  for (const source of ['https://cdn.atsu.moe/static/posters/a.webp', 'https://example.test/page.webp',
    'https://cdn.atsu.moe/static/pages/a/b/1.webp?token=x', 'https://user:pass@cdn.atsu.moe/static/pages/a/b/1.webp']) {
    assert.equal(readerImageUrl(source), source);
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
