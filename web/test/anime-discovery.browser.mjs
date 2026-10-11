import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Real discovery service + React schedule/panels; deterministic fetch, router,
// local history/library and cover pixels. No provider requests or media playback.
// SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
//   node --test web/test/anime-discovery.browser.mjs
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.env.SAKURA_BROWSER_TEST_NODE_MODULES || resolve(root, 'web/node_modules'), '__discovery_test__.cjs'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const mocks = {
  'expo-router': `import {useEffect} from 'react';const router={push:value=>window.__navigation.push(['push',value]),dismissTo:value=>window.__navigation.push(['dismissTo',value])};export const useRouter=()=>router;export const useFocusEffect=callback=>useEffect(callback,[callback]);`,
  '@/lib/storage': `export const Library={getAll:async()=>window.__library||[]};`,
  '@/lib/watch-progress': `export const getAllWatchHistory=async()=>window.__history||[];`,
  '@/components/ui/CoverImage': `import React from 'react';export default function Cover(){return <div style={{width:'100%',height:'100%',background:'#332637'}}/>;}`,
};
const network = `
window.__navigation=[];window.__requests=[];window.__pending=[];
const media=(id,title)=>({idMal:id,type:'ANIME',title:{english:title},coverImage:{large:''},format:'TV',isAdult:false});
window.fetch=async(url,init={})=>{
 const body=init.body?JSON.parse(init.body):{};
 const schedule=body.query?.includes('SakuraSchedule');
 const record={url,kind:schedule?'schedule':'title',variables:body.variables||{}};
 window.__requests.push(record);
 if(window.__networkMode==='fail')return new Response('',{status:503});
 const response=()=>{
  if(schedule){const from=(body.variables.from+1)*1000;return new Response(JSON.stringify({data:{Page:{pageInfo:{hasNextPage:false},airingSchedules:Array.from({length:7},(_,index)=>({id:100+index,episode:index+1,airingAt:(from+index*86400000+3600000)/1000,media:media(100+index,'Week '+body.variables.from+' · Day '+index)}))}}}));}
  const id=body.variables?.id||20;
  const recommendation=window.__networkMode==='filtered'?id:id+1000;
  return new Response(JSON.stringify({data:{Media:{recommendations:{nodes:[{mediaRecommendation:media(recommendation,'Suggestion '+recommendation)}]},relations:{edges:[{relationType:'SEQUEL',node:media(id+2000,'Related '+id)}]}}}}));
 };
 if(window.__networkMode==='hold')return new Promise(resolve=>window.__pending.push(()=>resolve(response())));
 return response();
};
window.__releasePending=()=>{for(const release of window.__pending.splice(0))release()};
`;
async function serve() {
  const result = await build({ stdin: { contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import Schedule from ${JSON.stringify(resolve(root, 'sakura-mobile/components/anime/AnimeSchedule.web.tsx'))};import Panels from ${JSON.stringify(resolve(root, 'sakura-mobile/components/anime/AnimeDiscoveryPanels.web.tsx'))};${network}function App(){const[screen,setScreen]=useState(window.__screen||'personal');const[id,setId]=useState('20');const[mounted,setMounted]=useState(true);window.__setAnime=setId;window.__setScreen=setScreen;window.__setMounted=setMounted;return mounted?(screen==='schedule'?<Schedule/>:<Panels mode={screen} animeId={id}/>):<p>Fixture unmounted</p>}createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [root + '/web/node_modules'], tsconfigRaw: { compilerOptions: {} }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'discovery-fixtures', setup(plugin) {
    plugin.onResolve({ filter: /^(expo-router|@\/lib\/(storage|watch-progress)|@\/components\/ui\/CoverImage)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'jsx', resolveDir: root }));
    plugin.onResolve({ filter: /^@\/lib\/anime-discovery$/ }, () => ({ path: resolve(root, 'sakura-mobile/lib/anime-discovery.ts') }));
  } }] });
  const code = result.outputFiles[0].text;
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/app.js' ? 'application/javascript' : 'text/html'); res.end(req.url === '/app.js' ? code : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;min-height:100%;background:#0c0d13}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/app.js"></script>'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const watched = [{ animeId: '20', title: 'Watched seed', updatedAt: 1, lastPlayedAt: 1, progress: .5 }];

test('discovery browser recovery and stale-response guards', { timeout: 40000 }, async t => {
  const { server, url } = await serve(); let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SAKURA_BROWSER_EXECUTABLE || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
    const run = async (name, options, body) => t.test(name, async () => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, timezoneId: 'UTC' });
      const page = await context.newPage(); page.setDefaultTimeout(4000); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(settings => { window.__screen = settings.screen; window.__networkMode = settings.mode; window.__history = settings.history || []; window.__library = settings.library || []; }, options);
      try { await page.goto(url); await body(page); assert.deepEqual(errors, []); }
      finally { await context.close(); }
    });

    await run('schedule failure then retry restores actual dates and detail/back navigation', { screen: 'schedule', mode: 'fail' }, async page => {
      await page.getByText('Discovery is unavailable. Please try again.', { exact: true }).waitFor();
      await page.evaluate(() => { window.__networkMode = 'success'; });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.locator('.as-card').waitFor();
      assert.equal(await page.locator('.as-card').count(), 1);
      await page.locator('.as-card').click();
      assert.equal(await page.evaluate(() => window.__navigation[0][1].pathname), '/anime/[id]');
      assert.match(await page.evaluate(() => window.__navigation[0][1].params.id), /^10[0-6]$/);
      await page.getByRole('button', { name: 'Back to anime', exact: false }).click();
      assert.deepEqual(await page.evaluate(() => window.__navigation.at(-1)), ['dismissTo', '/anime']);
      assert.equal(await page.evaluate(() => window.__requests.length), 2);
    });

    await run('late previous-week response cannot replace the selected next week', { screen: 'schedule', mode: 'hold' }, async page => {
      await page.waitForFunction(() => window.__pending.length === 1);
      const firstFrom = await page.evaluate(() => window.__requests[0].variables.from);
      await page.evaluate(() => { window.__networkMode = 'success'; });
      await page.getByRole('button', { name: 'Next week', exact: true }).click();
      await page.locator('.as-card').waitFor();
      const nextFrom = await page.evaluate(() => window.__requests[1].variables.from);
      assert.equal(nextFrom - firstFrom, 7 * 86400);
      assert.match(await page.locator('.as-card strong').textContent(), new RegExp(`Week ${nextFrom}`));
      await page.evaluate(async () => { window.__releasePending(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      assert.match(await page.locator('.as-card strong').textContent(), new RegExp(`Week ${nextFrom}`));
      assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    });

    await run('seeded recommendation failure and retry recover with title navigation', { screen: 'personal', mode: 'fail', history: watched }, async page => {
      await page.getByText('Recommendations are unavailable right now.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__requests.length), 2, 'AniList and real service fallback both failed');
      await page.evaluate(() => { window.__networkMode = 'success'; });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByRole('heading', { name: 'Because you watched Watched seed', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Suggestion 1020', exact: false }).click();
      assert.deepEqual(await page.evaluate(() => window.__navigation.at(-1)), ['push', { pathname: '/anime/[id]', params: { id: '1020' } }]);
    });

    await run('no viewing/saved seeds hides the optional shelf without network requests', { screen: 'personal', mode: 'success' }, async page => {
      await page.waitForFunction(() => typeof window.__setScreen === 'function');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('.anime-discovery-panels').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.__requests.length), 0);
      assert.equal(await page.locator('.ad-shelf').count(), 0);
    });

    await run('already watched or saved recommendations hide the filtered shelf', { screen: 'personal', mode: 'filtered', history: watched }, async page => {
      await page.waitForFunction(() => window.__requests.length === 1);
      await page.locator('.anime-discovery-panels').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.ad-shelf').count(), 0);
      assert.equal(await page.evaluate(() => window.__requests.length), 1);
    });

    await run('related title changes and unmounts discard pending responses', { screen: 'related', mode: 'hold' }, async page => {
      await page.waitForFunction(() => window.__pending.length === 1);
      await page.evaluate(() => { window.__networkMode = 'success'; window.__setAnime('21'); });
      await page.getByRole('button', { name: 'Related 21', exact: false }).waitFor();
      await page.evaluate(async () => { window.__releasePending(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      assert.equal(await page.getByRole('button', { name: 'Related 20', exact: false }).count(), 0);
      await page.evaluate(() => { window.__networkMode = 'hold'; window.__setAnime('22'); });
      await page.waitForFunction(() => window.__pending.length === 1);
      await page.evaluate(() => window.__setMounted(false));
      await page.getByText('Fixture unmounted', { exact: true }).waitFor();
      await page.evaluate(async () => { window.__releasePending(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      assert.equal(await page.locator('.anime-discovery-panels').count(), 0);
    });
  } finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
});
