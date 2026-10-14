import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

function load() {
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(new URL('../lib/chapter-progress.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, Date, Set, Math, Number });
  return module.exports;
}

const cp = load();
const chapters = [0, 1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, number: n, title: `Chapter ${n}` }));
const progressOn = (id, page, total, extra = {}) => ({ chapterId: id, page, totalPages: total, progress: page / total, ...extra });
const ids = (list) => list.map((c) => c.id);
// Arrays made inside the vm context have their own prototype; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('nothing read: start at the first chapter', () => {
  const r = cp.resolveResume(chapters, new Set(), null);
  assert.equal(r.kind, 'start');
  assert.equal(r.chapter.id, 'c0');
  assert.equal(cp.resolveResume([], new Set(), null).chapter, null);
});

test('a part-read chapter continues on its page', () => {
  const r = cp.resolveResume(chapters, new Set(['c0', 'c1']), progressOn('c2', 7, 20));
  assert.deepEqual([r.kind, r.chapter.id, r.page], ['continue', 'c2', 7]);
});

test('finishing a chapter moves on to the next unread one, not back to the start', () => {
  // Older builds saved a finished chapter as progress 1.0 with no mark.
  const r = cp.resolveResume(chapters, new Set(), progressOn('c2', 20, 20));
  assert.deepEqual([r.kind, r.chapter.id, r.page], ['next', 'c3', 1]);
  // Newer reader rows: finished / caughtUp flags with progress held under 0.98.
  const flagged = cp.resolveResume(chapters, new Set(), { ...progressOn('c2', 20, 20), progress: 0.97, finished: true });
  assert.equal(flagged.chapter.id, 'c3');
});

test("the reader's Up next row opens the next chapter from page 1 and counts the finished one as read", () => {
  const row = { chapterId: 'c3', page: 1, totalPages: 1, progress: 0.01, upNext: true, finishedChapterId: 'c2' };
  const r = cp.resolveResume(chapters, new Set(), row);
  assert.deepEqual([r.kind, r.chapter.id, r.page], ['next', 'c3', 1]);
  assert.ok(cp.effectiveReadIds(chapters, new Set(), row).has('c2'));
  assert.equal(cp.chapterReadPercent(chapters[3], row), null, 'not started, so no percentage');
});

test('resume is the next unread chapter after the LAST read one', () => {
  const r = cp.resolveResume(chapters, new Set(['c0', 'c1', 'c3']), null);
  assert.deepEqual([r.kind, r.chapter.id], ['next', 'c4']);
});

test('a part-read chapter behind chapters marked later does not drag you back', () => {
  const r = cp.resolveResume(chapters, new Set(['c0', 'c1', 'c2', 'c3']), progressOn('c1', 3, 20));
  // c1 is marked read, so the part-read row is ignored.
  assert.equal(r.chapter.id, 'c4');
  const behind = cp.resolveResume(chapters, new Set(['c3']), progressOn('c1', 3, 20));
  assert.deepEqual([behind.kind, behind.chapter.id], ['next', 'c4']);
});

test('everything read: caught up, offering the newest chapter', () => {
  const r = cp.resolveResume(chapters, new Set(ids(chapters)), null);
  assert.deepEqual([r.kind, r.chapter.id], ['caught-up', 'c5']);
  const viaCaughtUpRow = cp.resolveResume(chapters, new Set(ids(chapters.slice(0, 5))), { ...progressOn('c5', 9, 9), progress: 0.97, caughtUp: true });
  assert.equal(viaCaughtUpRow.kind, 'caught-up');
});

test('the progress chapter is found by number when atsu replaced its id', () => {
  const r = cp.resolveResume(chapters, new Set(), { chapterId: 'gone', chapterNumber: 4, page: 2, totalPages: 10, progress: 0.2 });
  assert.deepEqual([r.kind, r.chapter.id, r.page], ['continue', 'c4', 2]);
});

test('seeding marks from progress covers the chapters before it, and it once finished', () => {
  assert.deepEqual(plain(cp.seedReadIdsFromProgress(chapters, progressOn('c3', 2, 10))), ['c0', 'c1', 'c2']);
  assert.deepEqual(plain(cp.seedReadIdsFromProgress(chapters, progressOn('c3', 10, 10))), ['c0', 'c1', 'c2', 'c3']);
  assert.deepEqual(plain(cp.seedReadIdsFromProgress(chapters, null)), []);
  assert.deepEqual(plain(cp.seedReadIdsFromProgress(chapters, progressOn('missing', 1, 2))), []);
});

test('mark previous as read excludes the chapter itself', () => {
  assert.deepEqual(plain(cp.previousChapterIds(chapters, 'c3')), ['c0', 'c1', 'c2']);
  assert.deepEqual(plain(cp.previousChapterIds(chapters, 'c0')), []);
  assert.deepEqual(plain(cp.previousChapterIds(chapters, 'nope')), []);
});

test('unread counts and the in-progress percentage', () => {
  assert.equal(cp.countUnread(chapters, new Set(['c0', 'c1', 'x'])), 4);
  assert.equal(cp.chapterReadPercent(chapters[2], progressOn('c2', 5, 20)), 25);
  assert.equal(cp.chapterReadPercent(chapters[1], progressOn('c2', 5, 20)), null);
  assert.equal(cp.chapterReadPercent(chapters[2], progressOn('c2', 20, 20)), null, 'finished is shown as read, not 100%');
});

test('chapter dates: atsu ms numbers, numeric strings and ISO strings; NEW within a week', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(cp.chapterTime(1791950759234), 1791950759234);
  assert.equal(cp.chapterTime('1791950759234'), 1791950759234);
  assert.equal(cp.chapterTime('2026-10-11T04:14:40.954Z'), Date.parse('2026-10-11T04:14:40.954Z'));
  assert.equal(cp.chapterTime(''), 0);
  assert.equal(cp.chapterTime('garbage'), 0);
  assert.equal(cp.isNewChapter({ id: 'a', number: 1, createdAt: '2026-10-11T04:14:40.954Z' }, now), true);
  assert.equal(cp.isNewChapter({ id: 'a', number: 1, createdAt: '2026-09-01T00:00:00Z' }, now), false);
  assert.equal(cp.isNewChapter({ id: 'a', number: 1 }, now), false);
});

test("atsu's 'Manwha' is displayed as 'Manhwa'", () => {
  assert.equal(cp.displayMangaType('Manwha'), 'Manhwa');
  assert.equal(cp.displayMangaType('Manga'), 'Manga');
  assert.equal(cp.displayMangaType(undefined), '');
});
