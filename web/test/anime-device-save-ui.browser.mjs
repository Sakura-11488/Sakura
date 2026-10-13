import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.env.SAKURA_BROWSER_TEST_NODE_MODULES || resolve(root, 'web/node_modules'), '__device_save_ui_test__.cjs'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const fixture = `
export const CAN_SAVE_ANIME_VIDEO = true;
const listeners = new Set(); let snapshot = null;
export const getAnimeDeviceSaveSnapshot = () => snapshot;
export const subscribeAnimeDeviceSave = fn => { listeners.add(fn); return () => listeners.delete(fn); };
window.__setSave = value => { snapshot = value; listeners.forEach(fn => fn()); };
export const dismissAnimeDeviceSave = () => { window.__dismissals++; window.__setSave(null); };
export const retryAnimeDeviceSave = () => { window.__retries++; window.__setSave({...snapshot, status:'preparing', error:undefined}); };
export const startAnimeDeviceDownload = () => { window.__downloads++; };
export const shareAnimeDeviceVideo = () => { window.__shares++; window.__shareActivation = navigator.userActivation.isActive; return Promise.reject(new DOMException('Canceled', 'AbortError')); };
window.__dismissals = window.__retries = window.__downloads = window.__shares = window.__episodeActions = 0;
`;

test('Anime device save controls preserve ready episodes and handle progress, retry, cancellation and mobile layout', { timeout: 60000 }, async () => {
  const built = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import Banner from ${JSON.stringify(resolve(root, 'sakura-mobile/components/AnimeDeviceSaveBanner.web.tsx'))};
        import Detail from ${JSON.stringify(resolve(root, 'sakura-mobile/components/anime/AnimeDetailWeb.web.tsx'))};
        createRoot(document.getElementById('root')).render(<><button onClick={()=>window.__backgroundClicks=(window.__backgroundClicks||0)+1}>Background action</button><Detail anime={{id:'fixture',title:'Synthetic video',episodes:[{id:'one',number:1,title:'Saved episode'},{id:'two',number:2,title:'New episode'}]}} progress={null} saved={false} offline={{one:{status:'ready',quality:'720p',progress:1}}} downloadable downloadsNeedHls onBack={()=>{}} onSave={()=>{}} onShare={()=>{}} onPlay={()=>{}} onDownload={()=>window.__episodeActions++} discussion={null}/><Banner/></>);`,
      resolveDir: root, loader: 'jsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    tsconfigRaw: { compilerOptions: {} }, nodePaths: [resolve(root, 'web/node_modules')],
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'device-save-fixture', setup(builder) {
      builder.onResolve({ filter: /^(@\/lib\/anime-device-save|@\/lib\/watch-progress|\.\/AnimeDiscoveryPanels|expo-image|hls.js)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', contents:
        args.path === '@/lib/anime-device-save' ? fixture :
        args.path === '@/lib/watch-progress' ? 'export const canResumeWatchProgress=()=>false;export const isWatchProgressComplete=()=>false;export const resumePosition=()=>0;export const getEpisodeWatchProgress=()=>null;export const isEpisodeWatched=()=>false;' :
        args.path === './AnimeDiscoveryPanels' ? 'export default function Panel(){return null}' :
        args.path === 'expo-image' ? 'export const Image=()=>null;' :
        'export default class Hls { static isSupported(){ return false; } }',
      }));
    } }],
  });
  const server = createServer((req, res) => {
    if (req.url === '/test.js') { res.setHeader('content-type', 'text/javascript'); res.end(built.outputFiles[0].text); }
    else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script src="/test.js"></script></body></html>'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SAKURA_BROWSER_EXECUTABLE || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const save = page.getByRole('button', { name: 'Save video: episode 1', exact: true });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    assert.equal(await page.evaluate(() => window.__episodeActions), 1);
    // MSE unavailable must not hide downloads: files play outside the HLS cache.
    assert.equal(await page.getByRole('button', { name: 'Download episode: episode 2', exact: true }).isVisible(), true);
    assert.ok(await page.getByText('Saved in Sakura · 720p', { exact: true }).isVisible());
    const base = { key: 'fixture::one', title: 'Synthetic video · Episode 1', filename: 'Synthetic video.mp4', progress: 0.47, status: 'preparing', canShare: false, downloadStarted: false, queued: 0 };
    await page.evaluate(value => window.__setSave(value), base);
    const banner = page.getByRole('region', { name: 'Video file download', exact: true });
    await banner.getByRole('heading', { name: 'Preparing video file' }).waitFor();
    assert.equal(await banner.getByRole('progressbar').getAttribute('value'), '47');
    await page.getByRole('button', { name: 'Background action', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__backgroundClicks), 1);
    await banner.getByRole('button', { name: 'Cancel video preparation' }).click();
    await banner.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__dismissals), 1);
    await page.evaluate(value => window.__setSave(value), { ...base, status: 'error', error: 'Synthetic conversion failure' });
    await banner.getByText('Synthetic conversion failure').waitFor();
    await banner.getByRole('button', { name: 'Retry video save' }).click();
    await banner.getByRole('heading', { name: 'Preparing video file' }).waitFor();
    assert.equal(await page.evaluate(() => window.__retries), 1);
    await page.evaluate(value => window.__setSave(value), { ...base, status: 'ready', progress: 1, canShare: true, downloadStarted: true, queued: 1, subtitle: { url: 'data:text/vtt,WEBVTT', filename: 'episode.en.vtt', label: 'English' } });
    await banner.getByRole('heading', { name: 'Video download started' }).waitFor();
    await banner.getByRole('button', { name: 'Download MP4', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__downloads), 1);
    await banner.getByRole('button', { name: 'Save / share', exact: true }).click();
    await banner.getByRole('button', { name: 'Save / share', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__shareActivation), true);
    assert.equal(await banner.getByRole('alert').count(), 0);
    assert.equal(await banner.getByRole('link', { name: 'Download subtitles (English)' }).getAttribute('download'), 'episode.en.vtt');
    await page.setViewportSize({ width: 320, height: 568 });
    const fits = await banner.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth; });
    assert.equal(fits, true);
    await page.screenshot({ path: '/tmp/sakura-video-save-mobile.png' });
    await page.evaluate(value => window.__setSave(value), { ...base, status: 'ready', progress: 1, error: 'Sharing did not open', downloadStarted: true });
    await banner.getByRole('alert').filter({ hasText: 'Sharing did not open' }).waitFor();
    assert.equal(await banner.getByRole('button', { name: 'Save / share', exact: true }).count(), 0);
    await banner.getByRole('button', { name: 'Dismiss video download' }).click();
    await banner.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(done => server.close(done));
  }
});
