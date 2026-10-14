import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const htmlparser = require('htmlparser2');
const code = ts.transpileModule(readFileSync(new URL('../lib/allnovel.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// allnovel.ts strips the source's boilerplate with lib/novel-text.ts; run the real module.
const novelTextCode = ts.transpileModule(readFileSync(new URL('../lib/novel-text.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function novelText() {
  const exports = {};
  vm.runInNewContext(novelTextCode, { exports });
  return exports;
}

async function parse(html, method = 'parseNovelDetail') {
  const exports = {};
  vm.runInNewContext(code, {
    exports, URL, console,
    require(name) {
      if (name === 'htmlparser2') return htmlparser;
      if (name === '@/lib/cache') return { getOrSetCached: (_key, _ttl, producer) => producer() };
      if (name === '@/lib/sakura-novels') return { fetchSakuraNovelDetail: async () => null, fetchSakuraChapterContent: async () => null };
      if (name === '@/lib/allnovel-html') return { fetchNovelHtml: async () => html };
      if (name === './novel-covers') return {};
      if (name === '@/lib/novel-text') return novelText();
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports[method]('sample-novel.html');
}

test('novel heading replaces the identical cover title instead of duplicating it', async () => {
  const title = 'Reincarnation Of The Strongest Sword God';
  const result = await parse(`<div class="books"><img src="/cover.jpg" title="${title}"><h3 class="title">${title}</h3><div class="desc-text">Summary.</div></div>`);
  assert.equal(result.name, title);
  assert.equal(result.cover, 'https://novelfull.com/cover.jpg');
  assert.equal(result.summary, 'Summary.');
});

test('responsive headings are not concatenated and inline title spacing is preserved', async () => {
  const result = await parse('<div class="books"><img title="Fallback title"><h3><span>Sword</span> <em>&amp; Shield</em></h3><h3>Sword &amp; Shield</h3></div>');
  assert.equal(result.name, 'Sword & Shield');
});

test('cover title still works when the source has no nonempty heading', async () => {
  const result = await parse('<div class="books"><img title="Cover title"><h3>  </h3></div>');
  assert.equal(result.name, 'Cover title');
});

test('chapter headings, paragraphs and line breaks remain readable without splitting inline emphasis', async () => {
  const content = await parse('<div id="chapter-content"><h3>Chapter 1: Starting Over</h3><p>Translator: Example</p><p>In the city. Shi Feng was <em>unwilling</em>.</p><p>He stood up.<br>Then he stopped.</p></div><p>Outside chapter.</p>', 'parseChapterContent');
  assert.equal(content, 'Chapter 1: Starting Over\n\nTranslator: Example\n\nIn the city. Shi Feng was unwilling.\n\nHe stood up.\nThen he stopped.');
});

test('paragraph formatting retains repeated prose while excluding existing hidden advertisement blocks', async () => {
  const content = await parse('<div id="chr-content"><p>Again.</p><div class="ads"><div>Advertisement</div></div><p>Again.</p></div>', 'parseChapterContent');
  assert.equal(content, 'Again.\n\nAgain.');
});
