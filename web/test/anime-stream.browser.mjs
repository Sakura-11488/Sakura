import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Opt-in live verification. Calls the real provider only from a local relay,
// plays a few seconds, checks captions/resume, and closes every browser/socket.
// npm install --prefix /tmp/sakura-anime-player-tests esbuild playwright
// SAKURA_ANIME_LIVE=1 \
// SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
// node --test web/test/anime-stream.browser.mjs
// Optional: SAKURA_BROWSER_EXECUTABLE, SAKURA_ANIME_LIVE_MAL_ID,
// SAKURA_ANIME_LIVE_EPISODE, SAKURA_ANIME_LIVE_CATEGORY (sub by default).
// SAKURA_ANIME_STREAM_SCREENSHOT saves a screenshot before player teardown.
// No production credentials, signing keys, or deployments are used.
const root = fileURLToPath(new URL('../../', import.meta.url));
const live = process.env.SAKURA_ANIME_LIVE === '1';

async function serverModules(build) {
  const functionDir = resolve(root, 'sakura-mobile/supabase/functions/anime-stream');
  const bundled = await build({
    stdin: { contents: `export {createAnimeStreamHandler} from ${JSON.stringify(resolve(functionDir, 'handler.ts'))}; export {resolveEpisode} from ${JSON.stringify(resolve(functionDir, 'provider.ts'))};`, resolveDir: root },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', tsconfigRaw: { compilerOptions: {} },
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
}

async function browserBundle(build, origin, episode) {
  const player = resolve(root, 'sakura-mobile/components/anime/WebVideoPlayer.web.tsx');
  const client = resolve(root, 'sakura-mobile/lib/anime-stream-client.web.ts');
  const fixtures = {
    'react-native': `import React from 'react'; export const StyleSheet={create:value=>value}; export const View=({children})=><div style={{width:960,maxWidth:'100%',height:540,background:'#000'}}>{children}</div>;`,
    // Use the real SDK with a local-only public key; the actual handler owns the
    // request/response and relay behavior. It does not need a Supabase gateway.
    '@/lib/supabase': `import {createClient} from '@supabase/supabase-js'; export const supabase=createClient(${JSON.stringify(origin)},'local-browser-test-public-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});`,
  };
  const bundled = await build({
    stdin: { loader: 'jsx', resolveDir: root, contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import Hls from 'hls.js';
      import Player from ${JSON.stringify(player)}; import {fetchBrowserAnimeStream} from ${JSON.stringify(client)};
      // Bound this live test's traffic; do not download an episode in a test.
      Object.assign(Hls.DefaultConfig,{maxBufferLength:12,maxMaxBufferLength:16,maxBufferSize:2*1024*1024,startLevel:0,testBandwidth:false});
      window.__streamProbe={ready:0,errors:0,resumeAt:12};
      function App(){
        const [source,setSource]=React.useState(null); const [status,setStatus]=React.useState('Ready'); const player=React.useRef(null);
        window.__player=player;
        const start=async()=>{setStatus('Resolving'); const began=performance.now(); const next=await fetchBrowserAnimeStream(${JSON.stringify(episode)});
          window.__streamProbe.resolveMs=Math.round(performance.now()-began);
          if(!next){setStatus('Resolver unavailable');window.__streamProbe.resolveFailed=true;return;}
          window.__streamProbe.subtitleCount=next.subtitles?.length||0;setSource(next);setStatus('Loading media');};
        return <main><h1>Sakura live relay verification</h1><button onClick={start} disabled={status!=='Ready'}>Start playback</button><p role="status">{status}</p>
          {source&&<Player ref={player} uri={source.url} isM3U8={source.isM3U8} subtitles={source.subtitles} subtitleMode="auto" startAt={12}
            onReady={()=>{window.__streamProbe.ready++;window.__streamProbe.firstReadyPosition=document.querySelector('video').currentTime;setStatus('Media ready');}}
            onError={()=>{window.__streamProbe.errors++;setStatus('Media failed');}}/>}
        </main>;
      }
      const app=createRoot(document.getElementById('root'));window.__stopPlayer=()=>app.unmount();app.render(<App/>);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    tsconfigRaw: { compilerOptions: {} }, nodePaths: [resolve(root, 'web/node_modules')],
    define: { 'process.env.NODE_ENV': '"test"', 'process.env.EXPO_PUBLIC_SUPABASE_URL': JSON.stringify(origin) },
    plugins: [{ name: 'local-relay-browser', setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path], loader: 'jsx', resolveDir: root }));
    } }],
  });
  return bundled.outputFiles[0].text;
}

test('live server relay plays inside Sakura with resume, captions, and no provider browser requests', {
  skip: live ? false : 'Set SAKURA_ANIME_LIVE=1 to run the opt-in live provider/browser check.',
  timeout: 120_000,
}, async t => {
  const dependencyRoot = process.env.SAKURA_BROWSER_TEST_NODE_MODULES || resolve(root, 'web/node_modules');
  const dependencies = createRequire(resolve(dependencyRoot, '__stream_browser_test__.cjs'));
  const { build } = dependencies('esbuild');
  const { chromium } = dependencies('playwright');
  const { createAnimeStreamHandler, resolveEpisode } = await serverModules(build);
  const episode = {
    malId: process.env.SAKURA_ANIME_LIVE_MAL_ID || '21',
    episode: Number(process.env.SAKURA_ANIME_LIVE_EPISODE || 1),
    category: process.env.SAKURA_ANIME_LIVE_CATEGORY || 'sub',
  };
  const metrics = { providerFetches: 0, relayFetches: 0, relayGets: 0, relayedBytes: 0, resolverStatus: 0, contentTypes: {}, relayHosts: [], relayErrors: [] };
  const bridgeErrors = [];
  let origin, handler, code;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, origin).pathname;
      if (pathname === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(code); return; }
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (pathname !== '/functions/v1/anime-stream') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8"><title>Sakura relay verification</title><style>body{background:#110e1d;color:#fff;font:16px system-ui;margin:24px}button{padding:12px}video{width:100%;height:100%}</style><div id="root"></div><script src="/app.js"></script>');
        return;
      }
      if (req.method === 'GET') metrics.relayGets++;
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      const request = new Request(`${origin}${req.url}`, {
        method: req.method, headers: req.headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await handler(request);
      if (req.method === 'POST') {
        metrics.resolverStatus = response.status;
        if (!response.ok) metrics.resolverError = (await response.clone().json()).error;
      }
      const type = response.headers.get('content-type')?.split(';')[0] || 'none';
      if (req.method === 'GET') metrics.contentTypes[type] = (metrics.contentTypes[type] || 0) + 1;
      if (req.method === 'GET' && !response.ok && type === 'application/json') metrics.relayErrors.push({ status: response.status, error: (await response.clone().json()).error });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { res.end(); return; }
      const body = Readable.fromWeb(response.body);
      body.on('data', chunk => { if (req.method === 'GET') metrics.relayedBytes += chunk.length; });
      body.on('error', () => res.destroy());
      res.on('close', () => { if (!body.destroyed) body.destroy(); });
      body.pipe(res);
    } catch (error) {
      if (!res.destroyed) {
        bridgeErrors.push(error instanceof Error ? error.message : String(error));
        res.writeHead(500); res.end('Local verification bridge failed.');
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  handler = createAnimeStreamHandler({
    signingSecret: randomBytes(48).toString('base64url'),
    publicBaseUrl: `${origin}/functions/v1/anime-stream`,
    resolveEpisode: (input, options) => resolveEpisode(input, { ...options, fetch: (url, init) => { metrics.providerFetches++; return fetch(url, init); } }),
    fetch: (url, init) => {
      metrics.relayFetches++;
      const host = new URL(url).hostname;
      if (!metrics.relayHosts.includes(host)) metrics.relayHosts.push(host);
      return fetch(url, init);
    },
  });
  let browser;
  try {
    code = await browserBundle(build, origin, episode);
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
      ...(process.env.SAKURA_BROWSER_EXECUTABLE ? { executablePath: process.env.SAKURA_BROWSER_EXECUTABLE }
        : existsSync(macChrome) ? { executablePath: macChrome } : {}) });
    const context = await browser.newContext({ viewport: { width: 1080, height: 740 } });
    const page = await context.newPage();
    const browserRequests = [], pageErrors = [];
    page.on('request', request => browserRequests.push(request.url()));
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.getByRole('button', { name: 'Start playback' }).click();
    await page.waitForFunction(() => window.__streamProbe.resolveFailed || window.__streamProbe.errors || window.__streamProbe.ready, null, { timeout: 60_000 });
    const initial = await page.evaluate(() => ({ ...window.__streamProbe }));
    assert.equal(initial.resolveFailed, undefined, `Resolver failed (HTTP ${metrics.resolverStatus}, ${metrics.resolverError || 'unknown error'}); provider calls=${metrics.providerFetches}`);
    assert.equal(initial.errors, 0, `the real HLS engine should not report a fatal error: ${JSON.stringify(metrics.relayErrors)}`);
    assert.equal(initial.ready, 1);
    assert.ok(initial.firstReadyPosition >= 11.9 && initial.firstReadyPosition < 13, 'loadedmetadata restores the requested resume time');
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && video.currentTime >= 14.5 && video.readyState >= 2 && video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 2;
    }, null, { timeout: 30_000 });
    const first = await page.evaluate(() => {
      const video = document.querySelector('video');
      return { currentTime: video.currentTime, duration: video.duration, frames: video.getVideoPlaybackQuality().totalVideoFrames };
    });
    await page.evaluate(() => window.__player.current.seekTo(20));
    await page.waitForFunction(() => document.querySelector('video')?.currentTime >= 22.5, null, { timeout: 20_000 });
    if (episode.category === 'sub') {
      assert.ok(initial.subtitleCount > 0, 'the sub source should expose a subtitle track');
      await page.waitForFunction(() => [...document.querySelectorAll('track')].some(track => track.readyState === 2 && track.track.mode === 'showing' && track.track.cues?.length > 0), null, { timeout: 15_000 });
    }
    assert.equal(await page.locator('iframe').count(), 0);
    if (process.env.SAKURA_ANIME_STREAM_SCREENSHOT) await page.screenshot({ path: process.env.SAKURA_ANIME_STREAM_SCREENSHOT });
    const final = await page.evaluate(() => {
      const video = document.querySelector('video');
      const data = { currentTime: video.currentTime, duration: video.duration, width: video.videoWidth, frames: video.getVideoPlaybackQuality().totalVideoFrames,
        captions: [...video.textTracks].filter(track => track.mode === 'showing').map(track => ({ language: track.language, cues: track.cues?.length || 0 })),
        readyCalls: window.__streamProbe.ready, errorCalls: window.__streamProbe.errors };
      window.__stopPlayer(); return data;
    });
    assert.ok(final.frames > first.frames, 'decoded frame count advances after seeking');
    assert.equal(final.readyCalls, 1);
    assert.equal(final.errorCalls, 0);
    assert.equal(await page.locator('iframe').count(), 0);
    assert.equal(context.pages().length, 1);
    assert.deepEqual(browserRequests.filter(url => !url.startsWith('blob:') && new URL(url).origin !== origin), [], 'the browser must never contact a provider or ad host');
    assert.ok(browserRequests.some(url => new URL(url).pathname === '/functions/v1/anime-stream'));
    assert.ok(browserRequests.filter(url => !url.startsWith('blob:')).every(url => ['/', '/app.js', '/favicon.ico', '/functions/v1/anime-stream'].includes(new URL(url).pathname)), 'all media requests must use the local signed relay');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(bridgeErrors, []);
    assert.ok(metrics.contentTypes['application/vnd.apple.mpegurl'] >= 1);
    assert.ok(metrics.contentTypes['video/mp2t'] >= 1 || metrics.contentTypes['video/mp4'] >= 1);
    if (episode.category === 'sub') assert.ok(metrics.contentTypes['text/vtt'] >= 1);
    t.diagnostic(JSON.stringify({ episode, first, final, metrics, browserRequests: browserRequests.length, externalBrowserRequests: 0, testBufferCapSeconds: 16 }));
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
