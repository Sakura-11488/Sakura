// Build web first. Set SAKURA_HOSTING_ROOT to the hosting checkout. Optional env: SAKURA_PLAYWRIGHT_MODULE, SAKURA_BROWSER_EXECUTABLE.
// Exercises the production bundle and service worker with deterministic source
// fixtures; no live catalogue, wallet or provider availability is required.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require(process.env.SAKURA_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
if (!process.env.SAKURA_HOSTING_ROOT) throw new Error('Set SAKURA_HOSTING_ROOT to the sakura-web checkout containing api/manga-page.js.');
const { createHandler } = require(resolve(process.env.SAKURA_HOSTING_ROOT, 'api/manga-page.js'));
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const image = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#cf6195' } }).png().toBuffer();
const mangaPage = createHandler({ fetchImpl: async () => new Response(image, { headers: { 'content-type': 'image/png', 'content-length': String(image.length) } }) });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/manga-page/') {
      req.query = Object.fromEntries(url.searchParams);
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
      await mangaPage(req, res);
      return;
    }
    if (['/api/cover-image/', '/api/media-proxy/'].includes(url.pathname)) {
      res.setHeader('content-type', 'image/png'); res.end(image); return;
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
    let file = resolve(dist, '.' + decodeURIComponent(url.pathname).replace(/^\/app(?:\/|$)/, '/'));
    if (!file.startsWith(dist + '/')) file = resolve(dist, 'index.html');
    try { if (!(await stat(file)).isFile()) file = resolve(dist, 'index.html'); }
    catch { file = resolve(dist, 'index.html'); }
    res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(await readFile(file));
  } catch { res.writeHead(500); res.end('Fixture server error'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.SAKURA_BROWSER_EXECUTABLE ? { executablePath: process.env.SAKURA_BROWSER_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
let holdSource = false;
let failSource = false; // Source requests fail outright (checked before holdSource).
let failChapters = false; // The chapter list comes back empty, as a failed source does.
const errors = [];
context.on('page', page => { page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); });
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === base) return route.continue();
  if (url.pathname.endsWith('/functions/v1/web-content-proxy')) {
    if (failSource) return route.abort();
    if (holdSource) return; // Offline title must render even if navigator.onLine is true.
    const payload = request.postDataJSON();
    let data = {};
    if (payload.path === '/api/manga/page') data = { mangaPage: { id: 'offline-fixture', title: 'Offline Test Manga', poster: { image: '/static/posters/fixture.png' }, synopsis: 'A local test title.', genres: ['Adventure'], status: 'Completed', type: 'Manga' } };
    if (payload.path === '/api/manga/allChapters' && !failChapters) data = { chapters: [1, 2].map(n => ({ id: `ch${n}`, number: n, title: `Chapter ${n}`, pageCount: 2 })) };
    if (payload.path === '/api/read/chapter') data = { readChapter: { pages: [{ image: '/static/pages/fixture/ch1/1.png' }, { image: '/static/pages/fixture/ch1/2.png' }] } };
    if (payload.source === 'manhwa') {
      if (payload.path === '/details') data = { id: 'mr:offline-fixture', title: 'Offline Test Manhwa', cover: 'https://www.mangaread.org/wp-content/uploads/fixture.png', status: 'Completed' };
      if (payload.path === '/chapters') data = { chapters: [{ id: 'chapter-one', number: 1, title: 'Manhwa Chapter 1', pages: 2 }] };
      if (payload.path === '/pages') data = { pages: ['https://www.mangaread.org/wp-content/uploads/1.png', 'https://www.mangaread.org/wp-content/uploads/2.png'] };
    }
    return route.fulfill({ json: data });
  }
  return route.abort();
});
let page = await context.newPage();
async function pollPage(predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise(done => setTimeout(done, 75));
  }
  throw new Error(`Timed out waiting for browser storage: ${predicate}`);
}
try {
  // A failed chapter list must say so and offer a Retry that really asks the
  // source again (an empty list is never cached), not settle on "No chapters yet".
  failChapters = true;
  await page.goto(`${base}/app/manga/offline-fixture`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Could not load chapters. Please try again.', { exact: true }).waitFor();
  failChapters = false;
  await page.getByRole('button', { name: 'Retry chapters', exact: true }).click();
  await page.getByRole('button', { name: 'Download Chapter 1', exact: true }).waitFor();
  console.log('PASS: failed chapter list shows Retry chapters, which refetches');
  await page.goto(`${base}/app/manga/offline-fixture`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Offline Test Manga', { exact: true }).first().waitFor();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('button', { name: 'Download Chapter 1', exact: true }).click();
  await pollPage(async () => {
    const cache = await caches.open('sakura-offline-v1');
    const response = await cache.match('/app/__offline/manga-manifest.json');
    return response && (await response.json()).chapters['offline-fixture::ch1']?.status === 'ready';
  });
  await pollPage(async () => !!(await (await caches.open('sakura-offline-v1')).match('/app/__offline/title/atsu/offline-fixture.json')));
  // Clear Cache must keep downloaded bytes, saved titles, preferences and progress.
  await page.evaluate(() => {
    localStorage.setItem('sakura-web-fs-v1', JSON.stringify([['sakura_library.json', JSON.stringify([{ id: 'saved', title: 'Keep Me', cover: '', type: 'manga', savedAt: 1 }])], ['settings.json', '{"keep":true}']]));
    localStorage.setItem('sakura_store_sakura_reader_progress.json', '{"keep":true}');
  });
  await page.goto(`${base}/app/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Clear Cache', { exact: true }).click();
  await page.waitForTimeout(300);
  assert.ok((await page.evaluate(() => localStorage.getItem('sakura-web-fs-v1'))).includes('Keep Me'));
  assert.equal(await page.evaluate(() => localStorage.getItem('sakura_store_sakura_reader_progress.json')), '{"keep":true}');
  await page.evaluate(() => localStorage.removeItem('sakura_store_sakura_api_cache.json'));
  holdSource = true;
  await page.goto(`${base}/app/manga/offline-fixture`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Offline Test Manga', { exact: true }).first().waitFor({ timeout: 5000 });
  // The downloaded copy says why it is showing and hides Download all. While
  // the live load is still out that is a check, not a failure...
  await page.getByText("Checking this title's source — showing your downloaded chapters.", { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download all', exact: true }).count(), 0);
  // ...and once the source has failed (here: Retry, answered with an error) it says so.
  failSource = true;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText("Couldn't reach this title's source — showing your downloaded chapters.", { exact: true }).waitFor();
  await page.getByText("Still can't reach this title's source", { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download all', exact: true }).count(), 0);
  failSource = false;
  console.log('PASS: saved title renders while source requests hang; Clear Cache preserves user data');
  // Close the tab to drop all module state; fresh navigations must boot from SW.
  await page.close();
  await context.setOffline(true);
  page = await context.newPage();
  await page.goto(`${base}/app/manga/offline-fixture`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Offline Test Manga', { exact: true }).first().waitFor();
  await page.getByText("You're offline — showing your downloaded chapters.", { exact: true }).waitFor();
  await page.getByText('Not downloaded · needs a connection', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await page.waitForURL('**/app/chapter/**');
  await page.waitForFunction(() => [...document.querySelectorAll('img')].some(img => img.src.includes('/__offline/atsu/') && img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: '/tmp/sakura-offline-reader.png' });
  await page.goto(`${base}/app/downloads`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Offline Test Manga', { exact: true }).waitFor();
  assert.equal(await page.locator('body').innerText().then(text => text.includes('No downloads yet')), false);
  await page.screenshot({ path: '/tmp/sakura-offline-downloads.png' });
  await page.waitForFunction(() => [...document.querySelectorAll('img')].some(img => img.src.includes('/__offline/cover/') && img.complete && img.naturalWidth > 0));
  const copyReady = page.waitForEvent('download');
  await page.getByText('Save a copy', { exact: true }).click();
  const copy = await copyReady;
  assert.ok(copy.suggestedFilename().endsWith('.cbz'));
  const savedCopy = await readFile(await copy.path());
  assert.equal(savedCopy.readUInt32LE(0), 0x04034b50, 'export is a ZIP/CBZ');
  await page.getByText('Delete', { exact: true }).click();
  await page.getByText('No downloads yet', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => !!(await (await caches.open('sakura-offline-v1')).match('/app/__offline/title/atsu/offline-fixture.json'))), false);
  holdSource = false;
  await context.setOffline(false);
  await page.goto(`${base}/app/manga/offline-fixture`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Download all', exact: true }).click();
  await pollPage(async () => {
    const response = await (await caches.open('sakura-offline-v1')).match('/app/__offline/manga-manifest.json');
    const chapters = response && (await response.json()).chapters;
    return chapters && ['ch1', 'ch2'].every(id => chapters[`offline-fixture::${id}`]?.status === 'ready');
  });
  await page.goto(`${base}/app/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Delete All Downloads', { exact: true }).click();
  await pollPage(async () => {
    const response = await (await caches.open('sakura-offline-v1')).match('/app/__offline/manga-manifest.json');
    return !response || Object.keys((await response.json()).chapters).length === 0;
  });
  await page.goto(`${base}/app/manga/mr%3Aoffline-fixture?source=manhwa`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Download Manhwa Chapter 1', exact: true }).click();
  await page.getByText('Downloaded', { exact: true }).waitFor();
  await pollPage(async () => !!(await (await caches.open('sakura-offline-v1')).match('/app/__offline/title/manhwa/mr%3Aoffline-fixture.json')));
  // Library navigation must carry a saved title's source, including after a reload.
  await page.evaluate(() => localStorage.setItem('sakura-web-fs-v1', JSON.stringify([['sakura_library.json', JSON.stringify([{ id: 'mr:offline-fixture', title: 'Offline Test Manhwa', cover: '', type: 'manga', source: 'manhwa', savedAt: Date.now() }])]])));
  await page.close();
  await context.setOffline(true);
  page = await context.newPage();
  await page.goto(`${base}/app/library`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Offline Test Manhwa', { exact: true }).click();
  await page.waitForURL('**source=manhwa');
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('img')].some(img => img.src.includes('/__offline/manhwa/') && img.complete && img.naturalWidth > 0));
  assert.deepEqual(errors, []);
  console.log('PASS: manhwa download and offline reader through source-aware Library navigation');
  console.log('PASS: offline cover, CBZ export, per-chapter deletion, Download all, Delete All Downloads');
  console.log('PASS: cold offline boot, manga detail, unavailable chapter indicator, chapter images, Downloads, zero uncaught page errors');
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), errors, text: await page.locator('body').innerText().catch(() => '') }));
  await page.screenshot({ path: '/tmp/sakura-offline-failure.png' }).catch(() => {});
  throw error;
} finally {
  await context.close(); await browser.close();
  await new Promise(done => server.close(done));
}
