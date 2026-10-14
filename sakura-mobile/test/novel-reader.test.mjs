import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

// Same harness as the other novel tests: transpile the real TypeScript module
// and run it with stubbed imports, so nothing here needs React Native.
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const htmlparser = require('htmlparser2');

function compile(file) {
  return ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
function load(file, modules = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(compile(file), {
    exports, URL, console, setTimeout, clearTimeout, ...globals,
    require(name) {
      if (name in modules) return modules[name];
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports;
}

const text = load('../lib/novel-text.ts');
const pos = load('../lib/novel-reader-position.ts');
const nav = load('../lib/novel-navigation.ts');

// ─── Text cleaning ───────────────────────────────────────────────────────────

const NOTICE = 'If you find any errors ( Ads popup, ads redirect, broken links, non-standard content, etc.. ), Please let us know < report chapter > so we can fix it as soon as possible.';

test('source notice, duplicated heading and credits are removed from the prose', () => {
  const raw = `Chapter 1: Starting Over\n\nTranslator: Hellscythe_\n\nEditor:Hellscythe_\n\nIn the dead of night.\n\nHe stood up.\nThen he stopped.\n\n${NOTICE}`;
  const clean = text.cleanChapterText(raw, 'Chapter 1 - Starting Over');
  assert.equal(clean.heading, 'Chapter 1: Starting Over');
  assert.deepEqual(Array.from(clean.credits), ['Translator: Hellscythe_', 'Editor: Hellscythe_']);
  assert.deepEqual(Array.from(clean.paragraphs), ['In the dead of night.', 'He stood up.\nThen he stopped.']);
});

test('prose that merely mentions errors or editors is never stripped', () => {
  const raw = 'The editor: a man of few words, said nothing.\n\nIf you find any errors in my plan, report them to the chapter house.\n\nShe left.';
  const clean = text.cleanChapterText(raw, 'Chapter 9 - Plans');
  // The first line is not a credit (it is a sentence), so nothing is removed.
  assert.equal(clean.paragraphs.length, 3);
  assert.equal(clean.heading, undefined);
});

test('a chapter that is only front matter still renders its text', () => {
  const clean = text.cleanChapterText('Chapter 3', 'Chapter 3');
  assert.deepEqual(Array.from(clean.paragraphs), ['Chapter 3']);
});

test('without a known title only an unmistakable heading line is taken', () => {
  assert.equal(text.cleanChapterText('Chapter 12: The Return\n\nRain fell.').heading, 'Chapter 12: The Return');
  assert.equal(text.cleanChapterText('Chapter 12 was the worst day of his life.\n\nRain fell.').heading, undefined);
});

test('fallback titles from the URL never end in ".Html"', () => {
  assert.equal(text.chapterTitleFromPath('reincarnation/chapter-1-starting-over.html'), 'Chapter 1 – Starting Over');
  assert.equal(text.chapterTitleFromPath('novel/chapter-12.html'), 'Chapter 12');
  assert.equal(text.chapterTitleFromPath('humour-me/chapter/3f2a9c1e-1111-2222-3333-444455556666'), '');
  assert.equal(text.chapterTitleFromPath('novel/prologue.html'), 'Prologue');
});

test('word counts and text direction', () => {
  assert.equal(text.countWords("Shi Feng's sword, unwilling — gone."), 5);
  assert.equal(text.detectTextDirection('In the dead of night.'), 'ltr');
  assert.equal(text.detectTextDirection('«مرحبا بالعالم»'), 'rtl');
});

test('read-aloud chunks stay under the Chrome utterance limit without losing text', () => {
  const sentence = 'Shi Feng held a folder of documents as he sat silently on the leather sofa. ';
  const para = sentence.repeat(9) + 'A'.repeat(500);
  const chunks = text.chunkForSpeech(para, 220);
  assert.ok(chunks.every((c) => c.length <= 220), 'every chunk fits');
  // Nothing dropped (a word longer than the limit is cut mid-word, so compare without spaces).
  assert.equal(chunks.join('').replace(/\s+/g, ''), para.replace(/\s+/g, ''));
  // Sentences are not split when they fit.
  assert.ok(chunks[0].endsWith('sofa.'));
  assert.deepEqual(Array.from(text.chunkForSpeech('Short line.')), ['Short line.']);
  assert.deepEqual(Array.from(text.chunkForSpeech('   ')), []);
});

// ─── Position model ──────────────────────────────────────────────────────────

test('paragraph anchors survive a font-size change', () => {
  const lengths = [100, 300, 200, 400];
  // Layout A: 20 px per 100 chars, 10 px gaps, 100 px of header above.
  const hA = lengths.map((l) => l / 5);
  const topsA = pos.paragraphTops(hA, 10, 100);
  const anchor = pos.anchorAtY(topsA[2] + hA[2] / 2, topsA, hA);
  assert.deepEqual({ ...anchor }, { index: 2, offset: 0.5 });
  // Layout B: everything 1.5x taller; the same anchor maps to the same text.
  const hB = hA.map((h) => h * 1.5);
  const topsB = pos.paragraphTops(hB, 15, 120);
  const y = pos.yForAnchor(anchor, topsB, hB);
  assert.equal(y, topsB[2] + hB[2] / 2);
  assert.deepEqual({ ...pos.anchorAtY(y, topsB, hB) }, { index: 2, offset: 0.5 });
});

test('reading line runs from the top of the chapter to its end and inverts exactly', () => {
  const V = 800, C = 10_800; // maxScroll 10,000
  assert.equal(pos.readingLineY(0, V, C), 0);
  assert.equal(pos.readingLineY(10_000, V, C), C);
  const line = pos.readingLineY(3_000, V, C);
  assert.equal(Math.round(pos.scrollYForLine(line, V, C)), 3_000);
  // Legacy scroll fraction == line fraction of the content: old entries migrate as-is.
  assert.equal(line / C, 3_000 / 10_000);
  // A chapter shorter than the screen is entirely in view.
  assert.equal(pos.readingLineY(0, 900, 600), 600);
});

test('text progress and anchors convert both ways', () => {
  const lengths = [100, 300, 200, 400];
  const anchor = pos.anchorForProgress(0.25, lengths); // 250 of 1000 chars
  assert.equal(anchor.index, 1);
  assert.ok(Math.abs(anchor.offset - 0.5) < 1e-9);
  assert.ok(Math.abs(pos.progressForAnchor(anchor, lengths) - 0.25) < 1e-9);
  assert.deepEqual({ ...pos.anchorForProgress(1, lengths) }, { index: 3, offset: 1 });
  assert.deepEqual({ ...pos.anchorForProgress(0, lengths) }, { index: 0, offset: 0 });
});

test('time left counts only the words after the anchor', () => {
  const words = [100, 200, 300];
  assert.equal(pos.wordsRemaining({ index: 1, offset: 0.5 }, words), 400);
  assert.equal(pos.formatTimeLeft(400, 200), '2 min left');
  assert.equal(pos.formatTimeLeft(50, 230), '< 1 min left');
  assert.equal(pos.formatTimeLeft(230 * 75, 230), '1 h 15 min left');
  assert.equal(pos.formatTimeLeft(0, 230), '');
});

test('reading speed is learned only from real, active reading', () => {
  assert.equal(pos.nextReadingSpeed(230, 600, 2 * 60_000), Math.round(230 * 0.7 + 300 * 0.3));
  assert.equal(pos.nextReadingSpeed(230, 100, 2 * 60_000), null, 'too few words');
  assert.equal(pos.nextReadingSpeed(230, 3000, 30_000), null, 'too short');
  assert.equal(pos.nextReadingSpeed(230, 5000, 60_000), null, 'skimming is not reading');
  assert.equal(pos.nextReadingSpeed(590, 890, 60_000), 600, 'clamped');
});

test('resume: a legacy pixel offset in the URL no longer opens the end of the chapter', () => {
  const lengths = [100, 100, 100, 100];
  // reading-history passes o=3000 (pixels). It used to be clamped to 1.
  const target = pos.resolveResumeTarget({ param: '3000', persisted: { progress: 0.3, updatedAt: 1000 }, stored: null, paragraphCount: 4, lengths });
  assert.equal(target.kind, 'anchor');
  assert.equal(target.source, 'progress');
  assert.ok(Math.abs(pos.progressForAnchor(target.anchor, lengths) - 0.3) < 1e-9);
});

test('resume: the local paragraph anchor wins unless the text or a newer device disagrees', () => {
  const lengths = [100, 100, 100, 100];
  const stored = { index: 2, offset: 0.25, count: 4, progress: 0.5625, savedAt: 2000 };
  const same = pos.resolveResumeTarget({ param: '0.56', persisted: { progress: 0.5625, updatedAt: 2000 }, stored, paragraphCount: 4, lengths });
  assert.equal(same.source, 'anchor');
  assert.deepEqual({ ...same.anchor }, { index: 2, offset: 0.25 });
  // Paragraph count changed (source edited the chapter): fall back to progress.
  const edited = pos.resolveResumeTarget({ param: null, persisted: { progress: 0.5, updatedAt: 2000 }, stored, paragraphCount: 5, lengths: [100, 100, 100, 100, 100] });
  assert.equal(edited.source, 'progress');
  // Another device synced a newer position.
  const newer = pos.resolveResumeTarget({ param: null, persisted: { progress: 0.1, updatedAt: 60_000 }, stored, paragraphCount: 4, lengths });
  assert.equal(newer.source, 'progress');
  // Finished chapters reopen at the top.
  assert.equal(pos.resolveResumeTarget({ param: '1', persisted: { progress: 1, updatedAt: 1 }, stored: null, paragraphCount: 4, lengths }).kind, 'top');
  assert.equal(pos.resolveResumeTarget({ param: null, persisted: null, stored: null, paragraphCount: 4, lengths }).kind, 'top');
});

// ─── Navigation helpers ─────────────────────────────────────────────────────

const chapters = Array.from({ length: 10 }, (_, i) => ({ path: `n/chapter-${i + 1}.html`, name: `Chapter ${i + 1}`, chapterNumber: i + 1 }));

test('neighbours are found by path', () => {
  const n = nav.findChapterNeighbours(chapters, 'n/chapter-1.html');
  assert.equal(n.index, 0);
  assert.equal(n.prev, null);
  assert.equal(n.next.path, 'n/chapter-2.html');
  const last = nav.findChapterNeighbours(chapters, 'n/chapter-10.html');
  assert.equal(last.next, null);
  assert.equal(nav.findChapterNeighbours(chapters, 'other.html').index, -1);
});

test('series path is derived for novelfull and Sakura chapter paths', () => {
  assert.equal(nav.seriesPathFromChapterPath('martial-god-asura/chapter-500.html'), 'martial-god-asura.html');
  assert.equal(nav.seriesPathFromChapterPath('humour-me/chapter/42'), 'humour-me');
});

test('"Download next N" starts at the chapter being read and skips downloaded ones', () => {
  const finished = new Set(['n/chapter-1.html', 'n/chapter-2.html', 'n/chapter-3.html']);
  assert.equal(nav.downloadStartIndex(chapters, { resumePath: 'n/chapter-5.html', finished }), 4);
  assert.equal(nav.downloadStartIndex(chapters, { resumePath: null, finished }), 3);
  assert.equal(nav.downloadStartIndex(chapters, {}), 0);
  const plan = nav.planNextDownloads(chapters, 4, 3, (p) => p === 'n/chapter-6.html');
  assert.deepEqual(Array.from(plan, (c) => c.chapterNumber), [5, 7, 8]);
});

test('read marks split finished and partial chapters of one series', () => {
  const rows = [
    { path: 'n/chapter-1.html', progress: 1, novelSeriesPath: 'n.html' },
    { path: 'n/chapter-2.html', progress: 0.4, novelSeriesPath: 'n.html' },
    { path: 'x/chapter-1.html', progress: 1, novelSeriesPath: 'x.html' },
  ];
  const state = nav.buildChapterReadState(rows, (r) => r.novelSeriesPath === 'n.html');
  assert.deepEqual(Array.from(state.finished), ['n/chapter-1.html']);
  assert.equal(state.partial.get('n/chapter-2.html'), 0.4);
});

// ─── Preferences ─────────────────────────────────────────────────────────────

function loadPrefs(os = 'web', storage = new Map()) {
  const localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const writes = [];
  const prefs = load('../lib/novel-reader-prefs.ts', {
    'react-native': { Platform: { OS: os } },
    '@/lib/kv-store': { readStore: async (n) => storage.get(`sakura_store_${n}`) ?? null, writeStore: async (n, v) => { writes.push([n, v]); storage.set(`sakura_store_${n}`, v); return true; } },
  }, { localStorage });
  return { prefs, writes, storage };
}

test('preferences are clamped and unknown values fall back to defaults', () => {
  const { prefs } = loadPrefs();
  const p = prefs.normalizeNovelReaderPrefs({ fontSize: 99, lineHeight: 0.4, theme: 'neon', font: 'sans', justify: 'yes', tapZones: false });
  assert.equal(p.fontSize, 30);
  assert.equal(p.lineHeight, 1.3);
  assert.equal(p.theme, 'auto');
  assert.equal(p.font, 'sans');
  assert.equal(p.justify, false);
  assert.equal(p.tapZones, false);
});

test('"follow app theme" picks dark or light; OLED black is true black', () => {
  const { prefs } = loadPrefs();
  assert.equal(prefs.resolveNovelReaderPalette('auto', true).id, 'dark');
  assert.equal(prefs.resolveNovelReaderPalette('auto', false).id, 'light');
  assert.equal(prefs.resolveNovelReaderPalette('black', false).bg, '#000000');
});

test('saved preferences are read synchronously on web for the first frame', async () => {
  const storage = new Map([['sakura_store_sakura_novel_reader_prefs.json', JSON.stringify({ theme: 'sepia', fontSize: 22 })]]);
  const { prefs } = loadPrefs('web', storage);
  const snap = prefs.getNovelReaderPrefsSnapshot();
  assert.equal(snap.theme, 'sepia');
  assert.equal(snap.fontSize, 22);
});

test('a burst of preference changes is written once', async () => {
  const { prefs, writes } = loadPrefs('web');
  prefs.updateNovelReaderPrefs({ fontSize: 20 });
  prefs.updateNovelReaderPrefs({ fontSize: 21 });
  prefs.updateNovelReaderPrefs({ fontSize: 22 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0][1]).fontSize, 22);
});

// ─── Scraper: chapter page and detail ────────────────────────────────────────

function loadScraper(responses, calls = []) {
  return load('../lib/allnovel.ts', {
    htmlparser2: htmlparser,
    '@/lib/cache': { getOrSetCached: (_k, _t, producer) => producer(), getCachedValue: async () => null },
    '@/lib/sakura-novels': { fetchSakuraNovelDetail: async () => null, fetchSakuraChapterContent: async () => null },
    '@/lib/allnovel-html': { fetchNovelHtml: async (url) => { calls.push(url); await new Promise((r) => setTimeout(r, 5)); if (!(url in responses)) throw new Error(`404 ${url}`); return responses[url]; } },
    '@/lib/novel-text': text,
    './novel-covers': {},
  });
}

// Synthetic page with novelfull's structure (not its prose).
const CHAPTER_PAGE = `<div id="chapter"><a class="truyen-title" href="/sample-novel.html" title="Sample Novel">Sample Novel</a>
<h2><a class="chapter-title" href="/sample-novel/chapter-2-the-road.html" title="Chapter 2 - The Road"><span class="chapter-text">Chapter 2 - The Road</span></a></h2>
<div class="chapter-nav"><a class="btn btn-success" href="/sample-novel/chapter-1-start.html" title="Chapter 1" id="prev_chap">Prev</a>
<button class="chapter_jump" id="chapter-jump-top" data-novel-id="237"></button>
<a class="btn btn-success" href="/sample-novel/chapter-3-end.html" title="Chapter 3" id="next_chap">Next</a></div>
<div id="chapter-content"><div align="center"><iframe title="Advertisement"></iframe></div><p></p><p>Chapter 2: The Road</p><p>A road ran north.</p><script>window.ads=1</script><p>It was long.</p>
<div align="left">${NOTICE.replace('<', '&lt;').replace('>', '&gt;')}</div></div>
<div class="chapter-nav"><a class="btn btn-success disabled" disabled id="prev_chap">Prev</a></div></div>`;

test('a chapter page yields clean text plus its neighbours, series and novel id', async () => {
  const scraper = loadScraper({});
  const page = scraper.parseChapterPageHtml(CHAPTER_PAGE, 'sample-novel/chapter-2-the-road.html');
  assert.equal(page.title, 'Chapter 2 - The Road');
  assert.equal(page.novelPath, 'sample-novel.html');
  assert.equal(page.novelTitle, 'Sample Novel');
  assert.equal(page.prevPath, 'sample-novel/chapter-1-start.html');
  assert.equal(page.nextPath, 'sample-novel/chapter-3-end.html');
  assert.equal(page.novelId, '237');
  assert.equal(page.text, 'Chapter 2: The Road\n\nA road ran north.\n\nIt was long.');
});

test('the detail page rating is parsed', () => {
  const scraper = loadScraper({});
  const detail = scraper.parseNovelDetailHtml('<div class="books"><img src="/c.jpg" title="T"></div><div class="rate"><input type="hidden" id="rateVal" value="8.7"><div id="rating" data-novel-id="55"></div></div>', 'sample-novel.html');
  assert.equal(detail.rating, 8.7);
  assert.equal(detail.novelId, '55');
});

test('a prefetch and the real open share one request, and the page is then instant', async () => {
  const calls = [];
  const scraper = loadScraper({ 'https://novelfull.com/sample-novel/chapter-2-the-road.html': CHAPTER_PAGE }, calls);
  scraper.prefetchNovelChapterPage('sample-novel/chapter-2-the-road.html');
  const page = await scraper.fetchNovelChapterPage('sample-novel/chapter-2-the-road.html');
  assert.equal(calls.length, 1);
  assert.equal(page.nextPath, 'sample-novel/chapter-3-end.html');
  assert.equal(scraper.peekNovelChapterPage('sample-novel/chapter-2-the-road.html').text, page.text);
});

test('the detail header does not wait for the chapter list, and the list is compact-cached', async () => {
  const calls = [];
  const options = Array.from({ length: 3 }, (_, i) => `<option value="/sample-novel/chapter-${i + 1}.html">Chapter ${i + 1}</option>`).join('');
  const scraper = loadScraper({
    'https://novelfull.com/sample-novel.html': '<div class="books"><img title="Sample"><h3>Sample</h3></div><div id="rating" data-novel-id="237"></div>',
    'https://novelfull.com/ajax-chapter-option?novelId=237': `<select>${options}</select>`,
  }, calls);
  const header = await scraper.fetchNovelDetailHeader('sample-novel.html');
  assert.equal(header.name, 'Sample');
  assert.equal(header.chapters.length, 0);
  assert.equal(calls.length, 1);
  const list = await scraper.fetchNovelChapterList(header.novelId, 'sample-novel.html');
  assert.deepEqual(Array.from(list, (c) => c.path), ['sample-novel/chapter-1.html', 'sample-novel/chapter-2.html', 'sample-novel/chapter-3.html']);
  assert.equal(list[2].chapterNumber, 3);
  assert.equal(scraper.peekNovelChapterList('sample-novel.html').length, 3);
});

test('an empty (bot-check) chapter page is an error, not an empty chapter', async () => {
  const scraper = loadScraper({ 'https://novelfull.com/a/chapter-1.html': '<title>Just a moment...</title>' });
  await assert.rejects(scraper.fetchNovelChapterPage('a/chapter-1.html'), /no readable text/);
});

test('batch downloads read chapters without filling the shared API cache', async () => {
  const calls = [];
  const stored = [];
  const fresh = new Map([['novel:page:v1:sample-novel/chapter-9.html', { path: 'sample-novel/chapter-9.html', text: 'Cached prose.' }]]);
  const scraper = load('../lib/allnovel.ts', {
    htmlparser2: htmlparser,
    '@/lib/cache': {
      getOrSetCached: async (key, _ttl, producer) => { stored.push(key); return producer(); },
      getCachedValue: async (key) => fresh.get(key) ?? null,
    },
    '@/lib/sakura-novels': { fetchSakuraNovelDetail: async () => null, fetchSakuraChapterContent: async () => null },
    '@/lib/allnovel-html': { fetchNovelHtml: async (url) => { calls.push(url); return CHAPTER_PAGE; } },
    '@/lib/novel-text': text,
    './novel-covers': {},
  });
  const text2 = await scraper.parseChapterContent('sample-novel/chapter-2-the-road.html', { persist: false });
  assert.match(text2, /A road ran north/);
  assert.equal(calls.length, 1);
  assert.deepEqual(stored, [], 'nothing is written to lib/cache');
  // Not remembered for the reader either: a 100-chapter batch must not push out its prefetched next chapter.
  assert.equal(scraper.peekNovelChapterPage('sample-novel/chapter-2-the-road.html'), null);
  // A chapter that is already cached (just read) costs no request.
  assert.equal(await scraper.parseChapterContent('sample-novel/chapter-9.html', { persist: false }), 'Cached prose.');
  assert.equal(calls.length, 1);
  // The reader's own path still caches.
  await scraper.fetchNovelChapterPage('sample-novel/chapter-2-the-road.html');
  assert.deepEqual(stored, ['novel:page:v1:sample-novel/chapter-2-the-road.html']);
});

test('a card prefetch warms only the detail page unless the card is pressed', async () => {
  const calls = [];
  const options = '<option value="/sample-novel/chapter-1.html">Chapter 1</option>';
  const scraper = loadScraper({
    'https://novelfull.com/sample-novel.html': '<div class="books"><img title="Sample"><h3>Sample</h3></div><div id="rating" data-novel-id="237"></div>',
    'https://novelfull.com/ajax-chapter-option?novelId=237': `<select>${options}</select>`,
  }, calls);
  scraper.prefetchNovelDetail('sample-novel.html');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, ['https://novelfull.com/sample-novel.html'], 'hover / press-in: no chapter list');
  scraper.prefetchNovelDetail('sample-novel.html', { chapters: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(calls.includes('https://novelfull.com/ajax-chapter-option?novelId=237'), 'a press also starts the chapter list');
  assert.equal(scraper.peekNovelChapterList('sample-novel.html').length, 1);
});

test('detail and list pages are cached parsed, never as raw HTML', async () => {
  const stored = new Map();
  const scraper = load('../lib/allnovel.ts', {
    htmlparser2: htmlparser,
    '@/lib/cache': {
      getOrSetCached: async (key, _ttl, producer) => { const v = await producer(); stored.set(key, v); return v; },
      getCachedValue: async () => null,
    },
    '@/lib/sakura-novels': { fetchSakuraNovelDetail: async () => null, fetchSakuraChapterContent: async () => null },
    '@/lib/allnovel-html': {
      fetchNovelHtml: async (url) => {
        if (/sample-novel\.html$/.test(url)) return `<div class="books"><img title="Sample"><h3>Sample</h3></div><div id="rating" data-novel-id="237"></div>${'<p>filler</p>'.repeat(2000)}`;
        if (/most-popular/.test(url)) return '<div class="list"></div>';
        return '<title>Just a moment...</title>';
      },
    },
    '@/lib/novel-text': text,
    './novel-covers': {},
  });
  const header = await scraper.fetchNovelDetailHeader('sample-novel.html');
  assert.equal(header.name, 'Sample');
  await scraper.fetchPopularNovels(1);
  const keys = [...stored.keys()];
  assert.deepEqual(keys.filter((k) => k.startsWith('novel:html:')), [], 'no raw pages in lib/cache');
  assert.ok(keys.includes('novel:detail:v1:sample-novel.html'));
  assert.ok(keys.some((k) => k.startsWith('novel:list:v1:')));
  assert.ok(JSON.stringify(stored.get('novel:detail:v1:sample-novel.html')).length < 1000, 'the parsed header is small');
  // A challenge page (no title) is an error, so it is never cached as the novel.
  await assert.rejects(scraper.fetchNovelDetailHeader('blocked.html'), /title is not available/);
  assert.ok(!stored.has('novel:detail:v1:blocked.html'));
});
