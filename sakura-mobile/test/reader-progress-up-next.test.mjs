import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/reader-progress.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function loadModule() {
  const files = new Map();
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Date, JSON, Math, Object, Promise, Number, Set,
    encodeURIComponent, decodeURIComponent,
    require: (id) => {
      assert.equal(id, '@/lib/kv-store');
      return {
        readStore: async (name) => files.get(name) ?? null,
        writeStore: async (name, value) => { files.set(name, value); return true; },
      };
    },
  });
  return module.exports;
}

const NOW = 1_760_000_000_000;
const base = { mangaId: 'solo', title: 'Solo Leveling', cover: 'c.jpg', chapterLabel: 'Chapter 1', chapterId: 'c1', totalPages: 22 };

test('mid-chapter positions stay inside the bounds the title page treats as "Continue"', () => {
  const { buildMangaProgressRecord, isActiveReadingProgress } = loadModule();
  // Page 1 of a 138-page chapter used to be 0.007: the title page said "Start reading".
  const early = buildMangaProgressRecord({ ...base, page: 1, totalPages: 138 }, undefined, NOW);
  assert.equal(early.progress, 0.01);
  assert.ok(isActiveReadingProgress(early.progress));
  // Page 49 of 50 used to be 0.98 and dropped out one page early.
  const late = buildMangaProgressRecord({ ...base, page: 49, totalPages: 50 }, undefined, NOW);
  assert.ok(isActiveReadingProgress(late.progress));
  assert.equal(late.page, 49);
  assert.equal(late.upNext, undefined);
  const mid = buildMangaProgressRecord({ ...base, page: 11 }, undefined, NOW);
  assert.equal(mid.progress, 0.5);
});

test('finishing a chapter points the series at the next one, at page 1', () => {
  const { buildMangaProgressRecord, isActiveReadingProgress } = loadModule();
  const row = buildMangaProgressRecord(
    { ...base, page: 22, next: { chapterId: 'c2', chapterLabel: 'Chapter 2', chapterNumber: 2, totalPages: 19 } },
    undefined,
    NOW,
  );
  assert.equal(row.chapterId, 'c2');
  assert.equal(row.chapterLabel, 'Chapter 2');
  assert.equal(row.chapterNumber, 2);
  assert.equal(row.page, 1);
  assert.equal(row.totalPages, 19);
  assert.equal(row.upNext, true);
  assert.equal(row.finishedChapterId, 'c1');
  assert.equal(row.finishedChapterLabel, 'Chapter 1');
  // The title page's check (isActiveReadingProgress) keeps "Continue" for it.
  assert.ok(isActiveReadingProgress(row.progress));
});

test('an explicit finished flag counts even before the last page index (end card on screen)', () => {
  const { buildMangaProgressRecord } = loadModule();
  const row = buildMangaProgressRecord({ ...base, page: 21, finished: true, next: { chapterId: 'c2' } }, undefined, NOW);
  assert.equal(row.chapterId, 'c2');
  assert.equal(row.chapterLabel, 'Chapter c2', 'falls back to a label when the next has none');
  assert.equal(row.totalPages, 1, 'unknown next length is never 0');
});

test('the newest chapter finished is "caught up", still active for the title page', () => {
  const { buildMangaProgressRecord, isActiveReadingProgress } = loadModule();
  const row = buildMangaProgressRecord({ ...base, page: 22, next: null }, undefined, NOW);
  assert.equal(row.chapterId, 'c1');
  assert.equal(row.page, 22);
  assert.equal(row.caughtUp, true);
  assert.equal(row.finished, undefined);
  assert.ok(isActiveReadingProgress(row.progress), 'never 1.0, which meant "Start reading" from chapter 0');
});

test('a finished chapter with no chapter list yet is kept as finished', () => {
  const { buildMangaProgressRecord, isActiveReadingProgress } = loadModule();
  const row = buildMangaProgressRecord({ ...base, page: 22 }, undefined, NOW);
  assert.equal(row.finished, true);
  assert.equal(row.caughtUp, undefined);
  assert.ok(isActiveReadingProgress(row.progress));
});

test('a missing title or cover keeps what was stored', () => {
  const { buildMangaProgressRecord } = loadModule();
  const prev = buildMangaProgressRecord({ ...base, page: 3 }, undefined, NOW);
  const row = buildMangaProgressRecord({ ...base, title: '', cover: undefined, page: 4, source: undefined }, { ...prev, source: 'manhwa' }, NOW + 1);
  assert.equal(row.title, 'Solo Leveling');
  assert.equal(row.cover, 'c.jpg');
  assert.equal(row.source, 'manhwa');
});

test('Continue Reading keeps finished series: Up next, caught up, and the label first', async () => {
  const api = loadModule();
  await api.setMangaReadProgress({ ...base, page: 22, next: { chapterId: 'c2', chapterLabel: 'Chapter 2', totalPages: 19 } });
  await api.setMangaReadProgress({ ...base, mangaId: 'other', title: 'Other', page: 30, totalPages: 30, next: null });
  await api.setMangaReadProgress({ ...base, mangaId: 'mid', title: 'Mid', page: 5, totalPages: 20 });
  const items = await api.getContinueReading(10);
  const byId = Object.fromEntries(items.map((item) => [item.mangaId, item]));
  assert.equal(items.length, 3);
  assert.equal(byId.solo.chapterId, 'c2');
  assert.equal(byId.solo.page, 1);
  assert.equal(byId.solo.subtitle, 'Chapter 2 · Up next');
  assert.equal(byId.solo.subtitle.split(' · ')[0], 'Chapter 2', 'ContinueReadingRow reads the label from here');
  assert.equal(byId.solo.progress, 0);
  assert.equal(byId.solo.mangaState, 'up-next');
  assert.equal(byId.other.subtitle, 'Chapter 1 · Caught up');
  assert.equal(byId.other.progress, 1);
  assert.equal(byId.other.mangaState, 'caught-up');
  assert.equal(byId.mid.subtitle, 'Chapter 1 · p.5/20');
  assert.equal(byId.mid.mangaState, undefined);
});

test('reading on from an Up next row replaces it with an ordinary position', async () => {
  const api = loadModule();
  await api.setMangaReadProgress({ ...base, page: 22, next: { chapterId: 'c2', chapterLabel: 'Chapter 2', totalPages: 19 } });
  await api.setMangaReadProgress({ ...base, chapterId: 'c2', chapterLabel: 'Chapter 2', page: 3, totalPages: 19 });
  const row = await api.getMangaReadProgress('solo');
  assert.equal(row.upNext, undefined);
  assert.equal(row.finishedChapterId, undefined);
  assert.equal(row.page, 3);
});
