import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

// Real detail/Continue components, React Native Web, progress store and web
// localStorage adapter. Only routing, artwork and unrelated discovery are fixtures.
// npm install --prefix /tmp/sakura-anime-player-tests esbuild playwright
// SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
//   node --test web/test/anime-history.browser.mjs
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.env.SAKURA_BROWSER_TEST_NODE_MODULES || resolve(root, 'web/node_modules'), '__history_test__.cjs'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const fixtures = {
  'expo-image': `import React from 'react';export const Image=({style})=><div style={{...style,background:'linear-gradient(145deg,#513d59,#191623)'}}/>;`,
  'expo-linear-gradient': `import React from 'react';export const LinearGradient=({children})=><div>{children}</div>;`,
  '@expo/vector-icons/AntDesign': `import React from 'react';export default function Icon({name}){return <span aria-hidden="true">{name==='close'?'×':'▶'}</span>}`,
  'expo-haptics': 'export const ImpactFeedbackStyle={Light:0};export const impactAsync=async()=>{};',
  'expo-router': 'export const useRouter=()=>({push:value=>window.__routes.push(value)});',
  '@/lib/sound': 'export const playTap=()=>{};',
  '@/lib/theme': `export const useTheme=()=>({colors:{white:'#17151d',border:'#37313f',text:'#f3eff7',textSecondary:'#aaa3b8',primary:'#ff626b',surfaceSecondary:'#25202e'}});`,
  '@/components/ui/SectionHeader': `import React from 'react';export default function Header({title}){return <h2>{title}</h2>}`,
  './AnimeDiscoveryPanels': `import React from 'react';export default function Panel(){return <aside aria-label="Related titles fixture"/>}`,
};
async function serve() {
  const bundle = await build({ outfile: 'app.js', stdin: { resolveDir: root, loader: 'jsx', contents: `
import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';
import Detail from ${JSON.stringify(resolve(root, 'sakura-mobile/components/anime/AnimeDetailWeb.web.tsx'))};
import Continue from ${JSON.stringify(resolve(root, 'sakura-mobile/components/ui/ContinueWatchingRow.tsx'))};
import * as history from ${JSON.stringify(resolve(root, 'sakura-mobile/lib/watch-progress.ts'))};
const episodes=[1,2,3].map(number=>({id:'mal-21-'+number,number,title:['Departure','A familiar face','The next journey'][number-1]}));
const anime={id:'21',title:'One Piece',episodes,genres:['Adventure'],year:1999,type:'TV',status:'Currently Airing',description:'A test title with durable episode history.'};
const entry=(number,extra={})=>({animeId:'21',title:anime.title,cover:'',episodeId:'mal-21-'+number,episodeNumber:number,episodeTitle:episodes[number-1].title,progress:0,updatedAt:Date.now(),...extra});
window.__routes=[];window.__plays=[];window.__history=history;
window.__play=(number,seconds)=>history.setAnimeWatchProgressWithAdvance(entry(number,{progress:seconds/1440,positionSeconds:seconds,durationSeconds:1440,completed:false}),episodes);
async function boot(){if(!(await history.getAnimeWatchProgress('21'))){await history.setAnimeWatchProgressWithAdvance(entry(1,{progress:1,positionSeconds:1440,durationSeconds:1440,completed:true}),episodes);await window.__play(2,7.25);}}
function App(){const[progress,setProgress]=useState(null);const[items,setItems]=useState([]);const[ready,setReady]=useState(false);useEffect(()=>{const refresh=()=>Promise.all([history.getAnimeWatchProgress('21'),history.getContinueWatching()]).then(([p,i])=>{setProgress(p);setItems(i);setReady(true)});const stop=history.subscribeWatchProgress(refresh);boot().then(refresh);return stop},[]);if(!ready)return null;return <><section aria-label="Continue shelf"><Continue items={items}/></section><Detail anime={anime} progress={progress} saved={false} offline={{}} downloadable={false} onBack={()=>{}} onSave={()=>{}} onShare={()=>{}} onPlay={(episode,restart)=>window.__plays.push({number:episode.number,restart})} onDownload={()=>{}} onMarkWatched={(episode,watched)=>history.setAnimeEpisodeWatched(entry(episode.number),watched,episodes)} discussion={<div>Discussion fixture</div>}/></>};createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', tsconfigRaw: { compilerOptions: {} }, nodePaths: [resolve(root, 'web/node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixtures', setup(p) {
    p.onResolve({ filter: /.*/ }, args => {
      if (Object.hasOwn(fixtures, args.path)) return { path: args.path, namespace: 'fixture' };
      if (args.path === 'react-native') return { path: resolve(root, 'web/node_modules/react-native-web/dist/index.js') };
      if (args.path === 'expo-file-system/legacy') return { path: resolve(root, 'web/shims/expo-file-system-legacy.ts') };
      if (args.path.startsWith('@/')) return { path: resolve(root, 'sakura-mobile', args.path.slice(2) + '.ts') };
    });
    p.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path], loader: 'jsx', resolveDir: root }));
  } }] });
  const code = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'application/javascript' : req.url === '/app.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/app.js' ? code : req.url === '/app.css' ? css : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:#0b0b0f;color:#eee;font-family:system-ui}section[aria-label="Continue shelf"]{padding:20px}</style><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('episode watched state, filter, resume and Continue dismissal persist through real browser reloads', { timeout: 30000 }, async t => {
  const { server, url } = await serve();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SAKURA_BROWSER_EXECUTABLE || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(4000);
    await page.goto(url); await page.getByRole('button', { name: 'Mark episode 1 as unwatched', exact: true }).waitFor();
    assert.match(await page.locator('[data-episode="2"]').textContent(), /Resume at 0:07/);
    await page.getByRole('button', { name: 'Continue episode 2: A familiar face', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__plays), [{ number: 2, restart: false }]);
    await page.getByRole('button', { name: 'Replay episode 1: Departure', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__plays.at(-1)), { number: 1, restart: true });
    await page.getByRole('combobox', { name: 'Episode status' }).selectOption('unwatched');
    assert.equal(await page.locator('[data-episode]').count(), 2);
    assert.equal(await page.locator('[data-episode="1"]').count(), 0);
    await page.getByRole('button', { name: 'Mark episode 2 as watched', exact: true }).click();
    await page.locator('[data-episode="2"]').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Mark episode 3 as watched', exact: true }).click();
    await page.getByText('You’re all caught up', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Episode status' }).selectOption('all');
    const unwatched = page.getByRole('button', { name: 'Mark episode 2 as unwatched', exact: true });
    await unwatched.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Mark episode 2 as watched', exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => window.__history.getAnimeViewingStatus(await window.__history.getAnimeWatchProgress('21'))), 'started');
    await page.reload(); await page.getByRole('button', { name: 'Mark episode 2 as watched', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark episode 1 as unwatched', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Mark episode 3 as unwatched', exact: true }).count(), 1);
    await page.evaluate(() => window.__play(2, 8));
    const remove = page.getByRole('button', { name: 'Remove One Piece from Continue Watching', exact: true });
    await remove.waitFor(); await remove.focus(); await page.keyboard.press('Space');
    await remove.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.__routes), [], 'remove must not trigger navigation');
    await page.reload(); await page.locator('[data-anime-detail]').waitFor();
    assert.equal(await remove.count(), 0);
    assert.equal(await page.evaluate(async () => (await window.__history.getAnimeWatchProgress('21', 'mal-21-2', 2)).positionSeconds), 8);
    await page.evaluate(() => window.__play(2, 9)); await remove.waitFor();
    assert.equal(await page.evaluate(async () => window.__history.isEpisodeWatched(await window.__history.getAnimeWatchProgress('21'), 'mal-21-1')), true);
    const desktop = resolve(tmpdir(), 'sakura-history-desktop.png'); await page.screenshot({ path: desktop, fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByRole('combobox', { name: 'Episode status' }).selectOption('unwatched');
    const bounds = await page.locator('.sd-filters,.sd-watched').evaluateAll(elements => elements.map(el => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth }; }));
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= rect.width), JSON.stringify(bounds));
    const phone = resolve(tmpdir(), 'sakura-history-phone.png'); await page.screenshot({ path: phone, fullPage: true });
    assert.deepEqual(errors, []);
    t.diagnostic(JSON.stringify({ screenshots: [desktop, phone], checks: 'Real components + storage: per-episode replay/resume, All/Unwatched, watched/unwatched keyboard actions, reload, known-series status, remove without navigation/history loss, fresh playback reappears, 320px controls fit.' }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
