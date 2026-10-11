// Build web first. Requires Playwright and ffmpeg (or pre-generated fixture dir).
// SAKURA_PLAYWRIGHT_MODULE, SAKURA_BROWSER_EXECUTABLE, SAKURA_FFMPEG,
// SAKURA_ANIME_FIXTURE_DIR may override tool/fixture discovery.
// Generates an original 8-second test pattern with audio; no provider media is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require(process.env.SAKURA_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const generated = !process.env.SAKURA_ANIME_FIXTURE_DIR;
const fixture = process.env.SAKURA_ANIME_FIXTURE_DIR || await mkdtemp(join(tmpdir(), 'sakura-anime-fixture-'));
if (generated) execFileSync(process.env.SAKURA_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(fixture, 'seg%d.ts'), join(fixture, 'media.m3u8')]);
const media = await readFile(join(fixture, 'media.m3u8'), 'utf8');
const image = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#c65ca3' } }).png().toBuffer();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/fixture/cover.png') { res.setHeader('content-type', 'image/png'); res.end(image); return; }
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
const errors = [];
const relayRequests = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.addInitScript(({ base }) => {
  if (location.origin !== base) return;
  if (localStorage.getItem('anime-fixture-initialized')) return;
  localStorage.setItem('anime-fixture-initialized', '1');
  localStorage.setItem('sakura_store_sakura_api_cache.json', JSON.stringify({ 'anime:info2_21': { exp: Date.now() + 3600000, value: {
    id: '21', title: 'Offline Anime Fixture', image: `${base}/fixture/cover.png`, cover: `${base}/fixture/cover.png`,
    status: 'Finished', episodes: [{ id: 'mal-21-1', number: 1, title: 'Synthetic episode', thumbnail: `${base}/fixture/cover.png` }],
  } } }));
}, { base });
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === base) return route.continue();
  if (url.pathname.endsWith('/functions/v1/anime-stream')) {
    relayRequests.push({ method: request.method(), url: url.href });
    const endpoint = `${url.origin}${url.pathname}`;
    const signed = name => `${endpoint}?token=${Buffer.from(JSON.stringify({ u: `https://cdn.fixture/anime/encode/${name}` })).toString('base64url')}.fixture`;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() === 'POST') return route.fulfill({ headers, json: {
      url: signed('master'), isM3U8: true, category: 'sub', availableCategories: ['sub'],
      subtitles: [{ url: signed('captions'), lang: 'en', label: 'English' }], intro: { start: 1, end: 2 },
    } });
    const name = JSON.parse(Buffer.from(url.searchParams.get('token').split('.')[0], 'base64url').toString()).u.split('/').pop();
    if (name === 'master') return route.fulfill({ headers, contentType: 'application/vnd.apple.mpegurl', body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180\n${signed('media')}\n` });
    if (name === 'media') return route.fulfill({ headers, contentType: 'application/vnd.apple.mpegurl', body: media.replace(/seg\d+\.ts/g, name => signed(name)) });
    if (name === 'captions') return route.fulfill({ headers, contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 00:00:08.000\nOffline captions are working.\n' });
    if (/^seg\d+\.ts$/.test(name)) return route.fulfill({ headers, contentType: 'video/mp2t', body: await readFile(join(fixture, name)) });
  }
  return route.abort();
});
let page = await context.newPage();
async function waitForCache(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(check)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for downloaded anime manifest.');
}
try {
  await page.goto(`${base}/app/anime/21`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Offline Anime Fixture', { exact: true }).first().waitFor();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('button', { name: 'Download episode: episode 1', exact: true }).click();
  await waitForCache(async () => {
    const response = await (await caches.open('sakura-offline-v1')).match('/app/__offline/anime-manifest.json');
    return response && (await response.json()).episodes['21::mal-21-1']?.status === 'ready';
  });
  assert.equal(relayRequests.filter(request => request.method === 'POST').length, 1);
  await page.evaluate(() => localStorage.removeItem('sakura_store_sakura_api_cache.json'));
  await page.close();
  await context.setOffline(true);
  page = await context.newPage();
  await page.goto(`${base}/app/anime/21`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Offline Anime Fixture', { exact: true }).first().waitFor();
  await page.getByText('Showing the episodes on this device. Reconnect to see the full series.', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Watch episode 1: Synthetic episode/ }).click();
  await page.waitForURL('**/app/anime/watch?**');
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && video.duration >= 8; });
  await page.evaluate(async () => { const video = document.querySelector('video'); video.muted = true; await video.play(); });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.5);
  await page.evaluate(() => { document.querySelector('video').currentTime = 5; });
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video.currentTime >= 5 && !video.seeking && video.readyState >= 2; });
  await page.waitForFunction(() => [...document.querySelector('video').textTracks].some(track => track.cues?.length && track.mode === 'showing'));
  await page.evaluate(() => document.querySelector('video').pause());
  const screenshot = await page.screenshot({ path: '/tmp/sakura-anime-offline-player.png' });
  // Native captions can have white computed styles while a player overlay
  // paints black above them. Inspect actual pixels in the fixture's caption
  // band, between the left and right controls, to catch that regression.
  const pixels = await sharp(screenshot).extract({ left: 300, top: 855, width: 500, height: 38 }).removeAlpha().raw().toBuffer();
  let brightCaptionPixels = 0;
  for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) brightCaptionPixels++;
  assert.ok(brightCaptionPixels > 200, `Captions must stay readable with controls visible (${brightCaptionPixels} bright pixels).`);
  assert.deepEqual(errors, []);
  console.log('PASS: regular anime UI download, cold offline detail/watch, actual H.264/AAC playback, seek, local captions, zero uncaught page errors');
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), errors, requests: relayRequests.length, text: await page.locator('body').innerText().catch(() => '') }));
  await page.screenshot({ path: '/tmp/sakura-anime-offline-failure.png' }).catch(() => {});
  throw error;
} finally {
  await context.close(); await browser.close();
  await new Promise(done => server.close(done));
  if (generated) await rm(fixture, { recursive: true, force: true });
}
