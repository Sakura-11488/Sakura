import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../components/reader/reader-layout.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(source, {
  module, exports: module.exports, Math, Number, Array,
  require: (id) => { throw new Error(`reader-layout must stay import-free, imported ${id}`); },
});
const L = module.exports;

test('the reading column is capped on wide windows and full width on phones', () => {
  assert.equal(L.columnWidth(1440, 720, 1600), 720);
  assert.equal(L.columnWidth(390, 720, 1600), 390);
  assert.equal(L.columnWidth(2560, 1600, 1600), 2560, 'the slider maximum means no cap');
  assert.equal(L.columnWidth(0, 720, 1600), 1, 'never zero (layout divides by it)');
});

test('fit width draws a 690x13915 strip at the column, not the window', () => {
  const ratio = 13915 / 690;
  const box = L.webtoonPageBox({ ratio, naturalWidth: 690, fit: 'width', columnW: 720, windowW: 1440, windowH: 900 });
  assert.equal(box.width, 720);
  assert.equal(box.height, Math.round(720 * ratio));
});

test('fit height shows a whole manga page, but leaves long strips at the column width', () => {
  const page = L.webtoonPageBox({ ratio: 1.46, fit: 'height', columnW: 720, windowW: 1440, windowH: 900 });
  assert.ok(Math.abs(page.height - 900) <= 1, `a whole page on screen (${page.height})`);
  assert.equal(page.width, Math.round(900 / 1.46));
  const strip = L.webtoonPageBox({ ratio: 8, fit: 'height', columnW: 720, windowW: 1440, windowH: 900 });
  assert.equal(strip.width, 720);
});

test('original uses the natural width when known, never wider than the window', () => {
  assert.equal(L.webtoonPageBox({ ratio: 2, naturalWidth: 500, fit: 'original', columnW: 720, windowW: 1440, windowH: 900 }).width, 500);
  assert.equal(L.webtoonPageBox({ ratio: 2, naturalWidth: 1600, fit: 'original', columnW: 720, windowW: 1440, windowH: 900 }).width, 1440);
  assert.equal(L.webtoonPageBox({ ratio: 2, fit: 'original', columnW: 720, windowW: 1440, windowH: 900 }).width, 720, 'unknown: the column');
});

test('unmeasured pages borrow the chapter median, then the session median, then 1.5', () => {
  assert.equal(L.medianRatio([3, undefined, 1, 2, NaN, -1]), 2);
  assert.equal(L.medianRatio([1, 2, 3, 4]), 2.5);
  assert.equal(L.medianRatio([]), null);
  assert.equal(L.estimatedRatio(4, 2, 3), 4);
  assert.equal(L.estimatedRatio(undefined, 2, 3), 2);
  assert.equal(L.estimatedRatio(undefined, null, 3), 3);
  assert.equal(L.estimatedRatio(undefined, null, null), 1.5);
});

test('list layout offsets start after the header and find rows by offset', () => {
  const layout = L.buildListLayout([100, 64, 300], 48);
  assert.deepEqual([...layout.offsets], [48, 148, 212]);
  assert.equal(layout.total, 512);
  assert.equal(L.rowAtOffset(layout, 0), 0);
  assert.equal(L.rowAtOffset(layout, 150), 1);
  assert.equal(L.rowAtOffset(layout, 211), 1);
  assert.equal(L.rowAtOffset(layout, 212), 2);
  assert.equal(L.rowAtOffset(layout, 9999), 2);
  assert.equal(L.rowAtOffset(L.buildListLayout([]), 10), -1);
});

test('a re-layout keeps the reader on the same spot of the same page', () => {
  // Mid-way down a 4000 px strip at 720 px wide; the window narrows to 600,
  // so every row scales by 600/720. Landing at the row's new offset plus the
  // same fraction is the same panel, not the top of the strip.
  const before = L.buildListLayout([4000, 4000, 4000]);
  const at = L.layoutAnchor(before, 4000 + 1500);
  assert.equal(at.index, 1);
  assert.equal(at.fraction, 1500 / 4000);
  const scale = 600 / 720;
  const after = L.buildListLayout([4000 * scale, 4000 * scale, 4000 * scale]);
  const landed = after.offsets[at.index] + at.fraction * after.lengths[at.index];
  assert.ok(Math.abs(landed - 5500 * scale) < 1e-6);
  // Inside the header is the first row's top; past the end stays inside the last row.
  assert.deepEqual({ ...L.layoutAnchor(L.buildListLayout([100, 100], 48), 10) }, { index: 0, fraction: 0 });
  assert.ok(L.layoutAnchor(before, 99999).fraction < 1);
  assert.equal(L.layoutAnchor(L.buildListLayout([]), 0), null);
});

test('look-ahead: a few pages ahead, one under data saver, skipping dividers into the next chapter', () => {
  assert.equal(L.lookAheadCount('scroll', false), 5);
  assert.equal(L.lookAheadCount('page', false), 3);
  assert.equal(L.lookAheadCount('scroll', true), 1);
  const rows = [
    { kind: 'page', url: 'a' }, { kind: 'page', url: 'b' }, { kind: 'marker' }, { kind: 'page', url: 'c' }, { kind: 'page', url: 'd' },
  ];
  assert.deepEqual([...L.lookAheadUrls(rows, 0, 2)], ['b', 'c']);
  assert.deepEqual([...L.lookAheadUrls(rows, 3, 5)], ['d']);
  assert.deepEqual([...L.lookAheadUrls(rows, -1, 1)], ['a']);
});

test('tap zones: outer thirds turn pages, following the reading direction unless inverted', () => {
  assert.equal(L.tapZoneAction(10, 900, false, 'auto'), 'prev');
  assert.equal(L.tapZoneAction(890, 900, false, 'auto'), 'next');
  assert.equal(L.tapZoneAction(450, 900, false, 'auto'), 'center');
  assert.equal(L.tapZoneAction(10, 900, true, 'auto'), 'next', 'right-to-left: the next page is on the left');
  assert.equal(L.tapZoneAction(890, 900, true, 'auto'), 'prev');
  assert.equal(L.tapZoneAction(10, 900, false, 'inverted'), 'next');
  assert.equal(L.tapZoneAction(10, 900, true, 'inverted'), 'prev');
  assert.equal(L.tapZoneAction(10, 900, false, 'off'), 'center');
  assert.equal(L.tapZoneAction(10, 0, false, 'auto'), 'center');
});

test('keyboard: arrows turn pages in paged mode (mirrored for RTL) and change chapters in webtoon', () => {
  const k = (key, mode, rtl = false, extra = {}) => L.readerKeyAction({ key, ...extra }, mode, rtl);
  assert.equal(k('ArrowRight', 'page'), 'next-page');
  assert.equal(k('ArrowLeft', 'page'), 'prev-page');
  assert.equal(k('ArrowRight', 'page', true), 'prev-page');
  assert.equal(k('ArrowLeft', 'page', true), 'next-page');
  assert.equal(k('d', 'page'), 'next-page');
  assert.equal(k('A', 'page'), 'prev-page');
  assert.equal(k('ArrowRight', 'scroll'), 'next-chapter');
  assert.equal(k('a', 'scroll'), 'prev-chapter');
  assert.equal(k('ArrowDown', 'scroll'), 'line-down');
  assert.equal(k('ArrowUp', 'scroll'), 'line-up');
  assert.equal(k(' ', 'scroll'), 'screen-down');
  assert.equal(k(' ', 'scroll', false, { shiftKey: true }), 'screen-up');
  assert.equal(k('PageDown', 'scroll'), 'screen-down');
  assert.equal(k('PageUp', 'page'), 'prev-page');
  assert.equal(k(' ', 'page'), 'next-page');
  assert.equal(k('Home', 'scroll'), 'first-page');
  assert.equal(k('End', 'page'), 'last-page');
  assert.equal(k('n', 'page'), 'next-chapter');
  assert.equal(k('P', 'scroll'), 'prev-chapter');
  assert.equal(k('f', 'scroll'), 'fullscreen');
  assert.equal(k('Escape', 'scroll'), 'escape');
  assert.equal(k('x', 'scroll'), null);
});

test('keyboard leaves browser shortcuts alone', () => {
  assert.equal(L.readerKeyAction({ key: 'ArrowLeft', metaKey: true }, 'page', false), null);
  assert.equal(L.readerKeyAction({ key: 'f', ctrlKey: true }, 'scroll', false), null);
  assert.equal(L.readerKeyAction({ key: 'n', altKey: true }, 'scroll', false), null);
});

test('auto-scroll speeds are clamped to the five levels', () => {
  assert.equal(L.autoScrollPxPerSecond(1), 40);
  assert.equal(L.autoScrollPxPerSecond(5), 240);
  assert.equal(L.autoScrollPxPerSecond(99), 240);
  assert.equal(L.autoScrollPxPerSecond(0), 40);
});
