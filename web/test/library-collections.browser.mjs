import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

// Actual Library web component, collection storage and episode-history helpers.
// Only cover pixels are replaced. No provider APIs or playback are involved.
// SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
//   node --test web/test/library-collections.browser.mjs
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.env.SAKURA_BROWSER_TEST_NODE_MODULES || resolve(root, 'web/node_modules'), '__library_test__.cjs'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const items = [
  { id: '21', type: 'anime', title: 'One Piece', cover: '', savedAt: 5 },
  { id: '5114', type: 'anime', title: 'Fullmetal Alchemist: Brotherhood', cover: '', savedAt: 4 },
  { id: '9253', type: 'anime', title: 'Steins;Gate', cover: '', savedAt: 3 },
  { id: '21', type: 'manga', title: 'One Piece Manga', cover: '', savedAt: 2 },
  { id: '/stories/long-road', type: 'novel', title: 'The Long Road', cover: '', savedAt: 1 },
];
const history = (animeId, completed) => ({ animeId, title: 'Fixture', cover: '', episodeId: `ep-${animeId}`, episodeNumber: 1, episodeTitle: 'One', progress: completed ? 1 : .25, positionSeconds: completed ? 1200 : 300, durationSeconds: 1200, completed, updatedAt: 10, knownEpisodes: [{ id: `ep-${animeId}`, number: 1 }], episodeHistory: { [`ep-${animeId}`]: { episodeId: `ep-${animeId}`, episodeNumber: 1, episodeTitle: 'One', progress: completed ? 1 : .25, positionSeconds: completed ? 1200 : 300, durationSeconds: 1200, completed, watched: completed, watchedUpdatedAt: 10, updatedAt: 10 } } });
async function serve() {
  const result = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Library from ${JSON.stringify(resolve(root, 'sakura-mobile/components/ui/LibraryWeb.web.tsx'))};window.__opened=[];createRoot(document.getElementById('root')).render(<Library items={${JSON.stringify(items)}} refreshing={false} onRefresh={()=>{}} onOpen={item=>window.__opened.push(item.id)} onBrowse={()=>{window.__browse=true}} onSchedule={()=>{window.__schedule=true}}/>);`, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [root + '/web/node_modules'], tsconfigRaw: { compilerOptions: {} }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'library-fixture', setup(plugin) {
    plugin.onResolve({ filter: /^@\/components\/ui\/CoverImage$/ }, () => ({ path: 'cover', namespace: 'fixture' }));
    plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import React from 'react';export default function Cover(){return <div style={{width:'100%',height:'100%',background:'linear-gradient(135deg,#51405e,#251c32)'}}/>}`, loader: 'jsx', resolveDir: root }));
    plugin.onResolve({ filter: /^expo-file-system\/legacy$/ }, () => ({ path: resolve(root, 'web/shims/expo-file-system-legacy.ts') }));
    plugin.onResolve({ filter: /^@\/lib\// }, args => ({ path: resolve(root, 'sakura-mobile', args.path.slice(2) + '.ts') }));
  } }] });
  const code = result.outputFiles[0].text;
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/app.js' ? 'application/javascript' : 'text/html'); res.end(req.url === '/app.js' ? code : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}#root{flex-direction:column}</style><div id="root"></div><script src="/app.js"></script>'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('Library collections, keyboard ordering, persistence, viewing filters and responsive bounds', { timeout: 45000 }, async t => {
  const { server, url } = await serve(); let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SAKURA_BROWSER_EXECUTABLE || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ started, completed }) => { localStorage.setItem('sakura-web-fs-v1', JSON.stringify([['sakura_watch_progress.json', JSON.stringify({ anime: { 21: started, 5114: completed } })]])); }, { started: history('21', false), completed: history('5114', true) });
    const page = await context.newPage(); page.setDefaultTimeout(5000); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByText('5 titles', { exact: true }).waitFor();
    assert.equal(await page.locator('.sl-card').count(), 5);
    for (const [status, title] of [['started', 'One Piece'], ['completed', 'Fullmetal Alchemist: Brotherhood'], ['not-started', 'Steins;Gate']]) {
      await page.getByRole('combobox', { name: 'Anime viewing status' }).selectOption(status);
      assert.equal(await page.locator('.sl-card').count(), 1);
      assert.equal(await page.locator('.sl-card-title').textContent(), title);
    }
    await page.getByRole('button', { name: 'Manga', exact: true }).click();
    assert.equal(await page.locator('.sl-card-title').textContent(), 'One Piece Manga');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search saved titles' }).fill('does-not-exist');
    await page.getByRole('heading', { name: 'No titles match' }).waitFor();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('button', { name: 'New collection', exact: false }).click();
    await page.getByRole('textbox', { name: 'New collection', exact: true }).fill('Weekend');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('heading', { name: 'Weekend', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add saved titles', exact: true }).click();
    for (const title of ['One Piece', 'One Piece Manga', 'The Long Road']) {
      await page.locator('.sl-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: 'Add title', exact: false }).click();
      await page.getByRole('status').getByText(`${title} added to Weekend.`, { exact: true }).waitFor();
    }
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert.deepEqual(await page.locator('.sl-card-title').allTextContents(), ['One Piece', 'One Piece Manga', 'The Long Road']);
    await page.getByRole('button', { name: 'Move The Long Road earlier', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('status').getByText('The Long Road moved earlier.', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.sl-card-title').allTextContents(), ['One Piece', 'The Long Road', 'One Piece Manga']);
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Rename collection', exact: true }).fill('Comfort stories');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page.getByRole('heading', { name: 'Comfort stories', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Comfort stories 3', exact: true }).click();
    assert.deepEqual(await page.locator('.sl-card-title').allTextContents(), ['One Piece', 'The Long Road', 'One Piece Manga']);
    await page.screenshot({ path: resolve(tmpdir(), 'sakura-collections-desktop.png') });
    await page.setViewportSize({ width: 320, height: 700 });
    const bounds = await page.locator('.sl-card').evaluateAll(cards => cards.map(card => { const rect = card.getBoundingClientRect(); return { width: rect.width, left: rect.left, right: rect.right }; }));
    assert.ok(bounds.every(rect => rect.width > 100 && rect.left >= 0 && rect.right <= 320), JSON.stringify(bounds));
    assert.equal(await page.locator('.sl-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 2);
    assert.equal(await page.locator('.sakura-library').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: resolve(tmpdir(), 'sakura-collections-phone.png') });
    await page.getByRole('button', { name: 'Organize One Piece in collections', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Comfort stories', exact: true }).click();
    await page.getByRole('status').getByText('One Piece removed from Comfort stories.', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.sl-card-title').allTextContents(), ['The Long Road', 'One Piece Manga']);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByText('Your saved titles and progress will stay in Library.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Delete collection', exact: true }).click();
    await page.getByRole('heading', { name: 'Saved titles', exact: true }).waitFor();
    assert.equal(await page.locator('.sl-card').count(), 5);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sakura-collections-v1')).collections), []);
    assert.deepEqual(errors, []);
    await context.close();
    t.diagnostic(`Actual component passed create/add/remove/rename/delete, keyboard reorder, reload persistence, measured-history filters, empty search and 320px two-column bounds. Screenshots: ${resolve(tmpdir(), 'sakura-collections-desktop.png')}, ${resolve(tmpdir(), 'sakura-collections-phone.png')}`);
  } finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
});
