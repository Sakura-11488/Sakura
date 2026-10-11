import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Real React + browser regression for the watch screen. Media/network/native
// adapters are fixtures; playback-choice logic is the actual application code.
// Setup without changing app dependencies:
// npm install --prefix /tmp/sakura-anime-player-tests esbuild playwright
// SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
//   node --test web/test/anime-player.browser.mjs
// Uses installed Chrome on macOS; set SAKURA_BROWSER_EXECUTABLE elsewhere or
// install Playwright Chromium. No third-party player or paid service is called.
const root = fileURLToPath(new URL('../../', import.meta.url));
const dependencyRoot = process.env.SAKURA_BROWSER_TEST_NODE_MODULES || resolve(root, 'web/node_modules');
const dependencies = createRequire(resolve(dependencyRoot, '__browser_test__.cjs'));
const { build } = dependencies('esbuild');
const { chromium } = dependencies('playwright');

const nativeFixture = `
import React from 'react';
const flatten = value => Array.isArray(value) ? Object.assign({}, ...value.map(flatten)) : value || {};
function css(value) {
  const result = {...flatten(value)};
  for (const [key, target] of Object.entries({paddingHorizontal:['paddingLeft','paddingRight'], paddingVertical:['paddingTop','paddingBottom'], marginHorizontal:['marginLeft','marginRight']})) {
    if (key in result) { for (const side of target) result[side] = result[key]; delete result[key]; }
  }
  if (result.lineHeight) result.lineHeight = result.lineHeight + 'px';
  return result;
}
export const Platform = {OS:'web'};
export const StyleSheet = {create: value => value, absoluteFill:{position:'absolute',inset:0}};
export const View = ({children,style,onTouchStart}) => <div style={{display:'flex',flexDirection:'column',position:'relative',minHeight:0,...css(style)}} onPointerDown={onTouchStart}>{children}</div>;
export const Text = ({children,style}) => <span style={css(style)}>{children}</span>;
export const TouchableOpacity = ({children,style,onPress,accessibilityLabel}) => <button aria-label={accessibilityLabel} style={{cursor:'pointer',borderStyle:'solid',borderWidth:0,...css(style)}} onClick={onPress}>{children}</button>;
export const ActivityIndicator = () => <span role="progressbar">Loading</span>;
export const StatusBar = Object.assign(() => null, {setHidden(){}});
`;

const fixtures = {
  'react-native': nativeFixture,
  'react-native-webview': `export const WebView = () => null;`,
  'expo-video': `import {useMemo} from 'react'; export function useVideoPlayer(_source, setup) { return useMemo(() => { const p={duration:0,currentTime:0,addListener(){return {remove(){}}}}; setup(p); return p; }, []); } export const VideoView=()=>null;`,
  'expo-navigation-bar': `export const setVisibilityAsync=async()=>{};`,
  'expo-screen-orientation': `export const OrientationLock={LANDSCAPE:1,PORTRAIT_UP:2}; export const lockAsync=async()=>{};`,
  'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  'react-native-svg': `import React from 'react'; export default function Svg(p){return <svg {...p}/>}; export const Path=p=><path {...p}/>;`,
  'expo-file-system/legacy': `
    export const documentDirectory='fixture://';
    export const getInfoAsync=async()=>({exists:!!window.__progressDisk});
    export const readAsStringAsync=async()=>window.__progressDisk;
    export const writeAsStringAsync=async(_path,text)=>{window.__progressDisk=text; window.__progressWrites.push(JSON.parse(text));};
  `,
  'expo-router': `
    import {useEffect,useState} from 'react';
    export function useLocalSearchParams(){const [params,setParams]=useState(window.__params); useEffect(()=>{const update=()=>setParams(window.__params); window.addEventListener('fixture-route',update); return ()=>window.removeEventListener('fixture-route',update);},[]); return params;}
    const router={setParams(params){window.__setParamsCalls=(window.__setParamsCalls||0)+1;window.__navigate(params);},back(){window.__backCalls++;}, dismissTo(destination){window.__backCalls++;window.__detailDestination=destination;}, replace({params}){window.__navigate(params);}};
    export const useRouter=()=>router;
  `,
  '@/constants/theme': `export const Fonts={body:'sans-serif',bodyBold:'sans-serif'}; export const FontSize={xs:12,sm:14,md:16,lg:20}; export const Radius={full:999};`,
  '@/lib/anime': `
    export const getAnimeStreamUserAgent=()=> 'Sakura-test';
    export const fetchAnimeInfo=async()=>({id:'20',title:'Fixture Anime',episodes:[{id:'mal-20-1',number:1,title:'Episode 1'},{id:'mal-20-2',number:2,title:'Episode 2'}]});
    export async function fetchEpisodeSources(ep,category,id,options){
      window.__sourceCalls.push({ep,category,id,options});
      const embedUrl=window.__providerOrigin+'/player?episode='+encodeURIComponent(ep)+'&category='+category;
      if(window.__mode==='none') return null;
      if(window.__mode==='unavailable') return {url:'',isM3U8:false,unavailableCategory:category,availableCategories:[category==='sub'?'dub':'sub']};
      if(window.__mode==='direct'||window.__mode==='progress') {
        const suffix=window.__mode==='progress'?'?episode='+ep+'&category='+category+'&attempt='+window.__sourceCalls.length:'';
        const primary='https://media.example/primary.m3u8'+suffix,alternate='https://media.example/alternate.m3u8'+suffix;
        return {url:primary,isM3U8:true,embedUrl,availableCategories:['sub','dub'],allSources:[{url:primary,isM3U8:true},{url:alternate,isM3U8:true}]};
      }
      return {url:'',isM3U8:false,embedUrl,availableCategories:['sub','dub']};
    }
  `,
  '@/lib/anime-playback-overrides': `export const getEpisodePlaybackHint=()=>null; export const shouldPreferDirectPlayback=(_hint,isWeb)=>isWeb;`,
  '@/lib/anime-player-shield': `export const buildAnimePlayerShieldScript=()=>''; export const shouldAllowAnimePlayerNavigation=()=>true;`,
  '@/lib/anime-media-session': `export const buildAnimeMediaSessionScript=()=>'';`,
  '@/lib/sound': `export const playTap=()=>{}; export const onTap=callback=>callback;`,
  '@/lib/anime-skip-times': `export const fetchAnimeSkipTimes=async()=>({}); export const mergeAnimeSkipMarkers=(primary)=>primary;`,
  '@/lib/anime-offline': `export const getOfflinePlaybackUri=async()=>null;`,
  '@/lib/sakura-originals': `
    export const isSakuraOriginal=()=>window.__mode==='original';
    export const fetchSakuraOriginalInfo=async()=>({id:'original-fixture',title:'Fixture Original',episodes:[{id:'original-1',number:1,title:'Episode 1'}]});
    export const resolveSakuraOriginalStreamUrl=async()=>null;
    export const getSakuraOriginalEmbedUrl=ep=>window.__providerOrigin+'/original?episode='+encodeURIComponent(ep);
  `,
  '@/components/anime/WebVideoPlayer': `
    import React from 'react';
    export default React.forwardRef(function FixtureVideo({uri,startAt,onError,onReady,onTimeUpdate,onCheckpoint,chrome},ref){
      const [position,setPosition]=React.useState(startAt||0);
      React.useImperativeHandle(ref,()=>({seekTo(seconds){setPosition(seconds);onTimeUpdate?.(seconds,1478);}}));
      React.useEffect(()=>{setPosition(startAt||0);onReady?.();},[uri]);
      const advance=(seconds,checkpoint=false,ended=false)=>{setPosition(seconds);onTimeUpdate?.(seconds,1478);if(checkpoint)onCheckpoint?.(seconds,1478,ended);};
      return <div data-direct-stream={uri} data-position={position}><span>Direct stream: {uri}</span>{chrome?.nextEpisode&&<button onClick={chrome.nextEpisode.onPlay}>Play next episode</button>}<button onClick={chrome?.onToggleCategory}>{chrome?.category?.toUpperCase()}</button><button onClick={chrome?.onBack}>Back to series</button><button onClick={()=>advance(5,true)}>Pause at 5 seconds</button><button onClick={()=>advance(0,true)}>Restart episode</button><button onClick={()=>advance(1470,true)}>Pause during credits</button><button onClick={()=>advance(1478,true,true)}>Finish episode</button><button onClick={onError}>Fail direct stream</button><button onClick={()=>advance(60)}>Set playback to 60 seconds</button><button onClick={()=>advance(63)}>Set playback to 63 seconds</button></div>;
    });
  `,
};

async function bundleScreen() {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Watch from ${JSON.stringify(process.env.SAKURA_WATCH_TEST_SOURCE || resolve(root, 'sakura-mobile/app/anime/watch.tsx'))}; import * as progress from '@/lib/watch-progress'; window.__progress=progress; createRoot(document.getElementById('root')).render(<Watch/>);`,
      loader: 'jsx', resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfigRaw: {compilerOptions: {}},
    nodePaths: [resolve(root, 'web/node_modules')], define: {'process.env.NODE_ENV':'"test"'},
    plugins: [{name:'watch-fixtures', setup(plugin) {
      plugin.onResolve({filter:/.*/}, args => {
        if (args.path in fixtures) return {path:args.path,namespace:'fixture'};
        if (args.path === '@/components/anime/EmbedPlayer') return {path:resolve(root,'sakura-mobile/components/anime/EmbedPlayer.web.tsx')};
        if (args.path === '@/components/anime/WatchViewport') return {path:resolve(root,'sakura-mobile/components/anime/WatchViewport.web.tsx')};
        if (args.path === '@/components/anime/player-preferences') return {path:resolve(root,'sakura-mobile/components/anime/player-preferences.ts')};
        if (args.path === '@/lib/watch-progress') return {path:resolve(root,'sakura-mobile/lib/watch-progress.ts')};
        return undefined;
      });
      plugin.onLoad({filter:/.*/,namespace:'fixture'}, args => ({contents:fixtures[args.path],loader:'jsx',resolveDir:root}));
    }}],
  });
  return result.outputFiles[0].text;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server,origin:`http://127.0.0.1:${server.address().port}`};
}

test('web watch only leaves Sakura after an explicit external-player choice', {timeout:60_000}, async t => {
  const code = await bundleScreen();
  const providerRequests = [];
  const provider = await listen((req,res) => {
    providerRequests.push(req.url);
    res.setHeader('Content-Type','text/html');
    res.end('<!doctype html><title>Fixture provider</title><p>External player fixture</p>');
  });
  const app = await listen((req,res) => {
    if(req.url === '/app.js') { res.setHeader('Content-Type','text/javascript'); res.end(code); return; }
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><title>Sakura watch fixture</title><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}button{font:inherit}</style><div id="root"></div><script>
      window.__mode=new URLSearchParams(location.search).get('mode')||'embed';
      window.__providerOrigin=${JSON.stringify(provider.origin)};
      window.__params={id:window.__mode==='original'?'original-fixture':'20',ep:window.__mode==='original'?'original-1':'mal-20-1'};
      window.__sourceCalls=[]; window.__backCalls=0; window.__progressWrites=[];
      window.__navigate=params=>{window.__params={...window.__params,...params};window.dispatchEvent(new Event('fixture-route'));};
      </script><script src="/app.js"></script>`);
  });
  t.after(async () => {
    await Promise.all([new Promise(resolve=>app.server.close(resolve)),new Promise(resolve=>provider.server.close(resolve))]);
  });
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({headless:true,
    ...(process.env.SAKURA_BROWSER_EXECUTABLE ? {executablePath:process.env.SAKURA_BROWSER_EXECUTABLE} : existsSync(macChrome) ? {executablePath:macChrome} : {})});

  async function openCase(mode) {
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    const page=await context.newPage();
    const pageErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(`${app.origin}/?mode=${mode}`);
    return {context,page,pageErrors};
  }
  async function assertNoProvider(context,page,before) {
    assert.equal(await page.locator('iframe').count(),0,'no third-party iframe is mounted');
    assert.equal(context.pages().length,1,'no external tab opens without a click');
    assert.equal(providerRequests.length,before,'no provider request occurs before user choice');
  }
  async function openExternal(context,page,path) {
    const previousUrl=page.url();
    const popupPromise=context.waitForEvent('page');
    await page.getByRole('button',{name:'Open external player',exact:true}).click();
    const popup=await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(),`${provider.origin}${path}`);
    assert.equal(await popup.evaluate(()=>window.opener),null,'provider must have no opener to redirect Sakura');
    assert.equal(page.url(),previousUrl,'Sakura watch remains open');
    assert.equal(await page.locator('iframe').count(),0,'external choice never embeds a player');
    await popup.close();
  }

  try {
    await t.test('embed-only episodes wait for a click; retry, language and episode changes stay inside Sakura',async()=>{
      const before=providerRequests.length;
      const {context,page,pageErrors}=await openCase('embed');
      try {
        await page.getByRole('button',{name:'Open external player',exact:true}).waitFor();
        await assertNoProvider(context,page,before);
        if(process.env.SAKURA_ANIME_PLAYER_SCREENSHOT) await page.screenshot({path:process.env.SAKURA_ANIME_PLAYER_SCREENSHOT});
        await openExternal(context,page,'/player?episode=mal-20-1&category=sub');
        const afterChoice=providerRequests.length;
        await page.getByRole('button',{name:'Retry',exact:true}).click();
        await page.waitForFunction(()=>window.__sourceCalls.length===2);
        await page.getByRole('button',{name:'Open external player',exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.__sourceCalls.at(-1).options.force),true);
        await assertNoProvider(context,page,afterChoice);
        await page.getByRole('button',{name:'Try DUB',exact:true}).click();
        await page.waitForFunction(()=>window.__sourceCalls.at(-1)?.category==='dub');
        await page.getByRole('button',{name:'Try SUB',exact:true}).waitFor();
        await assertNoProvider(context,page,afterChoice);
        await page.evaluate(()=>window.__navigate({ep:'mal-20-2'}));
        await page.waitForFunction(()=>window.__sourceCalls.at(-1)?.ep==='mal-20-2');
        await page.getByRole('button',{name:'Open external player',exact:true}).waitFor();
        await assertNoProvider(context,page,afterChoice);
        await openExternal(context,page,'/player?episode=mal-20-2&category=dub');
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('direct streams exhaust their alternatives before offering the external player',async()=>{
      const before=providerRequests.length;
      const {context,page,pageErrors}=await openCase('direct');
      try {
        await page.locator('[data-direct-stream="https://media.example/primary.m3u8"]').waitFor();
        assert.equal(await page.getByRole('button',{name:'Open external player',exact:true}).count(),0);
        await assertNoProvider(context,page,before);
        await page.getByRole('button',{name:'Fail direct stream'}).click();
        await page.locator('[data-direct-stream="https://media.example/alternate.m3u8"]').waitFor();
        await assertNoProvider(context,page,before);
        await page.getByRole('button',{name:'Fail direct stream'}).click();
        await page.getByRole('button',{name:'Open external player',exact:true}).waitFor();
        assert.equal(await page.locator('[data-direct-stream]').count(),0);
        await assertNoProvider(context,page,before);
        await openExternal(context,page,'/player?episode=mal-20-1&category=sub');
        const afterChoice=providerRequests.length;
        await page.getByRole('button',{name:'Retry',exact:true}).click();
        await page.locator('[data-direct-stream="https://media.example/primary.m3u8"]').waitFor();
        await assertNoProvider(context,page,afterChoice);
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('category changes, source alternatives and Retry retain the latest measured playback position',async()=>{
      const {context,page,pageErrors}=await openCase('progress');
      const waitPosition=seconds=>page.waitForFunction(value=>Number(document.querySelector('[data-direct-stream]')?.getAttribute('data-position'))===value,seconds);
      try {
        await page.locator('[data-direct-stream]').waitFor();
        await page.getByRole('button',{name:'Set playback to 60 seconds',exact:true}).click();
        await page.waitForFunction(()=>window.__progressWrites.some(store=>store.anime['20']?.positionSeconds===60));
        await page.getByRole('button',{name:'Set playback to 63 seconds',exact:true}).click();
        // Three seconds is below the persistence threshold for a 1,478-second
        // episode. Switching immediately must use the in-memory clock, not 60s.
        await page.getByRole('button',{name:'SUB',exact:true}).click();
        await page.waitForFunction(()=>window.__sourceCalls.at(-1)?.category==='dub');
        await page.locator('[data-direct-stream*="category=dub"]').waitFor();
        await waitPosition(63);
        // Let the actual 400ms progress debounce complete. A ready-state
        // estimate used to overwrite the stored record without positionSeconds.
        await page.waitForTimeout(450);
        assert.ok((await page.evaluate(()=>window.__progress.getAnimeWatchProgress('20'))).positionSeconds>=60);
        assert.ok(await page.evaluate(()=>window.__progressWrites.every(store=>typeof store.anime['20']?.positionSeconds==='number')),
          'direct-source readiness must not erase the measured clock with an estimate');

        await page.getByRole('button',{name:'Fail direct stream',exact:true}).click();
        await page.locator('[data-direct-stream^="https://media.example/alternate.m3u8"]').waitFor();
        await waitPosition(63);
        await page.getByRole('button',{name:'Fail direct stream',exact:true}).click();
        await page.getByRole('button',{name:'Retry',exact:true}).click();
        await page.waitForFunction(()=>window.__sourceCalls.length===3);
        await page.locator('[data-direct-stream^="https://media.example/primary.m3u8"]').waitFor();
        await waitPosition(63);
        assert.equal(await page.evaluate(()=>window.__sourceCalls.at(-1).options.force),true);

        await page.evaluate(()=>window.__navigate({ep:'mal-20-2'}));
        await page.locator('[data-direct-stream*="episode=mal-20-2"]').waitFor();
        await waitPosition(0);
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('a different episode resumes only its own matching saved bookmark',async()=>{
      const {context,page,pageErrors}=await openCase('progress');
      try {
        await page.locator('[data-direct-stream]').waitFor();
        await page.evaluate(async()=>{
          await window.__progress.setAnimeWatchProgress({animeId:'20',title:'Fixture Anime',cover:'',episodeId:'mal-20-2',episodeNumber:2,episodeTitle:'Episode 2',progress:82/1478,positionSeconds:82,updatedAt:Date.now()});
          window.__navigate({ep:'mal-20-2'});
        });
        await page.locator('[data-direct-stream*="episode=mal-20-2"]').waitFor();
        await page.waitForFunction(()=>document.querySelector('[data-direct-stream]')?.getAttribute('data-position')==='82');
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('exact early bookmarks resume, restart clears position, and only the actual end advances',async()=>{
      const {context,page,pageErrors}=await openCase('progress');
      try {
        await page.locator('[data-direct-stream]').waitFor();
        await page.getByRole('button',{name:'Pause at 5 seconds',exact:true}).click();
        const early=await page.evaluate(()=>window.__progress.getAnimeWatchProgress('20'));
        assert.equal(early.positionSeconds,5);
        assert.equal(early.durationSeconds,1478);
        assert.equal(early.completed,false);
        await page.evaluate(()=>window.__navigate({ep:'mal-20-2'}));
        await page.locator('[data-direct-stream*="episode=mal-20-2"]').waitFor();
        await page.evaluate(()=>window.__navigate({ep:'mal-20-1'}));
        await page.waitForFunction(()=>document.querySelector('[data-direct-stream]')?.getAttribute('data-position')==='5');
        await page.getByRole('button',{name:'Restart episode',exact:true}).click();
        assert.equal((await page.evaluate(()=>window.__progress.getAnimeWatchProgress('20'))).positionSeconds,0);
        await page.getByRole('button',{name:'Pause during credits',exact:true}).click();
        const credits=await page.evaluate(()=>window.__progress.getAnimeWatchProgress('20'));
        assert.equal(credits.episodeId,'mal-20-1');
        assert.equal(credits.positionSeconds,1470);
        assert.equal(await page.evaluate(()=>window.__progress.canResumeWatchProgress(window.__progressWrites.at(-1).anime['20'])),true);
        await page.getByRole('button',{name:'Finish episode',exact:true}).click();
        const finished=await page.evaluate(()=>window.__progress.getAnimeWatchProgress('20'));
        assert.equal(finished.episodeId,'mal-20-2');
        assert.equal(finished.progress,0);
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('next episode keeps the viewport and audio choice, including alternate catalog IDs',async()=>{
      const {context,page,pageErrors}=await openCase('progress');
      try {
        await page.locator('[data-direct-stream]').waitFor();
        await page.getByRole('button',{name:'Pause at 5 seconds',exact:true}).click();
        await page.evaluate(()=>window.__navigate({ep:'hi-99-1'}));
        await page.locator('[data-direct-stream*="episode=hi-99-1"]').waitFor();
        await page.waitForFunction(()=>document.querySelector('[data-direct-stream]')?.getAttribute('data-position')==='5');
        await page.getByRole('button',{name:'SUB',exact:true}).click();
        await page.locator('[data-direct-stream*="category=dub"]').waitFor();
        await page.evaluate(()=>{window.__viewportBeforeNext=document.querySelector('[data-watch-viewport]');});
        await page.getByRole('button',{name:'Finish episode',exact:true}).click();
        await page.getByRole('button',{name:'Play next episode',exact:true}).click();
        await page.locator('[data-direct-stream*="episode=mal-20-2"]').waitFor();
        assert.equal(await page.evaluate(()=>window.__viewportBeforeNext===document.querySelector('[data-watch-viewport]')),true);
        assert.equal(await page.evaluate(()=>window.__sourceCalls.at(-1).category),'dub');
        assert.equal(await page.evaluate(()=>window.__setParamsCalls),1);
        assert.equal(await page.locator('[data-direct-stream]').getAttribute('data-position'),'0');
        assert.equal(await page.getByRole('button',{name:'Play next episode',exact:true}).count(),0,'final episode must not loop');
        const queued=await page.evaluate(()=>window.__progress.getAnimeWatchProgress('20'));
        assert.equal(queued.episodeId,'mal-20-2');
        assert.equal(queued.progress,0);
        assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sakura.player.preferences.v1')).audio),'dub');
        await page.reload();
        await page.locator('[data-direct-stream*="category=dub"]').waitFor();
        assert.equal(await page.evaluate(()=>window.__sourceCalls[0].category),'dub','new sessions use the saved audio choice');
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('an unavailable language stays explicit and never offers or loads the external player',async()=>{
      const before=providerRequests.length;
      const {context,page,pageErrors}=await openCase('unavailable');
      try {
        await page.getByText('Episode 1 is not available in SUB from the current source. Try DUB.',{exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.__sourceCalls.length),1,'unavailability must not silently fetch another category');
        assert.equal(await page.getByRole('button',{name:'Open external player',exact:true}).count(),0);
        await assertNoProvider(context,page,before);
        await page.getByRole('button',{name:'Try DUB',exact:true}).click();
        await page.getByText('Episode 1 is not available in DUB from the current source. Try SUB.',{exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.__sourceCalls.at(-1).category),'dub');
        assert.equal(await page.evaluate(()=>window.__sourceCalls.length),2);
        await page.getByRole('button',{name:'Retry',exact:true}).click();
        await page.waitForFunction(()=>window.__sourceCalls.length===3);
        assert.equal(await page.evaluate(()=>window.__sourceCalls.at(-1).options.force),true);
        assert.equal(await page.getByRole('button',{name:'Open external player',exact:true}).count(),0);
        await assertNoProvider(context,page,before);
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('embed-only Originals also require explicit external navigation',async()=>{
      const before=providerRequests.length;
      const {context,page,pageErrors}=await openCase('original');
      try {
        await page.getByRole('button',{name:'Open external player',exact:true}).waitFor();
        await assertNoProvider(context,page,before);
        await openExternal(context,page,'/original?episode=original-1');
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });

    await t.test('missing sources retain recovery controls without an external destination',async()=>{
      const before=providerRequests.length;
      const {context,page,pageErrors}=await openCase('none');
      try {
        await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
        assert.equal(await page.getByRole('button',{name:'Open external player',exact:true}).count(),0);
        await assertNoProvider(context,page,before);
        await page.getByRole('button',{name:'Go Back',exact:true}).click();
        assert.equal(await page.evaluate(()=>window.__backCalls),1);
        assert.deepEqual(await page.evaluate(()=>window.__detailDestination),{pathname:'/anime/[id]',params:{id:'20'}});
        assert.deepEqual(pageErrors,[]);
      } finally {await context.close();}
    });
  } finally {
    await browser.close();
  }
});
