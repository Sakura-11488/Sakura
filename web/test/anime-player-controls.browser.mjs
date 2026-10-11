import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import test from 'node:test';

// Actual React player, controls, and WatchViewport with deterministic media/HLS
// adapters. No network video is downloaded and no third-party player is loaded.
// Setup: npm install --prefix /tmp/sakura-anime-player-tests esbuild playwright
// SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
//   node --test web/test/anime-player-controls.browser.mjs
const root=fileURLToPath(new URL('../../',import.meta.url));
const dependencyRoot=process.env.SAKURA_BROWSER_TEST_NODE_MODULES || resolve(root,'web/node_modules');
const require=createRequire(resolve(dependencyRoot,'__controls_test__.cjs'));
const screenshotPath=name=>resolve(tmpdir(),`sakura-premium-player-${name}.png`);
const {build}=require('esbuild');
const {chromium}=require('playwright');
const mediaFixture=`
const state=new WeakMap(); const get=v=>{if(!state.has(v))state.set(v,{time:0,duration:1478,paused:true,ready:0,ended:false});return state.get(v)};
for(const [prop,key] of Object.entries({duration:'duration',paused:'paused',readyState:'ready',ended:'ended'}))Object.defineProperty(HTMLMediaElement.prototype,prop,{get(){return get(this)[key]},configurable:true});
Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{get(){return get(this).time},set(value){get(this).time=value;get(this).ended=false;this.dispatchEvent(new Event('seeking'));this.dispatchEvent(new Event('timeupdate'));this.dispatchEvent(new Event('seeked'));},configurable:true});
Object.defineProperty(HTMLMediaElement.prototype,'buffered',{get(){return {length:1,start(){return 0},end(){return 400}}},configurable:true});
HTMLMediaElement.prototype.play=function(){window.__plays++;if(get(this).ended)get(this).time=0;get(this).ended=false;get(this).paused=false;this.dispatchEvent(new Event('play'));this.dispatchEvent(new Event('playing'));return Promise.resolve()};
HTMLMediaElement.prototype.pause=function(){window.__pauses++;get(this).paused=true;this.dispatchEvent(new Event('pause'));};
HTMLMediaElement.prototype.load=function(){get(this).ended=false;get(this).paused=true;get(this).time=0;get(this).ready=0;};
window.__plays=0;window.__pauses=0;window.__checkpoints=[];window.__backs=0;window.__next=0;window.__category=0;
window.__loadMedia=v=>{get(v).ready=4; if(!v.textTracks.length)v.addTextTrack('subtitles','English','en');v.dispatchEvent(new Event('loadedmetadata'));};
window.__time=t=>{const v=document.querySelector('video');v.currentTime=t;};
window.__end=()=>{const v=document.querySelector('video');Object.assign(get(v),{time:get(v).duration,paused:true,ended:true});for(const event of ['timeupdate','pause','ended'])v.dispatchEvent(new Event(event));};
window.__repeatEnd=()=>document.querySelector('video').dispatchEvent(new Event('ended'));
let visibility='visible';
Object.defineProperty(document,'visibilityState',{get:()=>visibility,configurable:true});
Object.defineProperty(document,'hidden',{get:()=>visibility==='hidden',configurable:true});
window.__visibility=value=>{visibility=value;document.dispatchEvent(new Event('visibilitychange'));};
`;
const hlsFixture=`export default class Hls{static Events={SUBTITLE_TRACKS_UPDATED:'subtitles',ERROR:'error'};static ErrorTypes={MEDIA_ERROR:'media'};static isSupported(){return true} levels=[{height:720,bitrate:1000000},{height:1080,bitrate:2000000}];currentLevel=-1;get autoLevelEnabled(){return this.currentLevel<0};subtitleDisplay=false;constructor(){window.__hls=this}on(){}loadSource(){}attachMedia(v){queueMicrotask(()=>window.__loadMedia(v))}destroy(){}recoverMediaError(){}}`;
const nativeFixture=`import React from 'react';const flatten=v=>Array.isArray(v)?Object.assign({},...v.map(flatten)):v||{};export const StyleSheet={create:v=>v};export const View=({children,style})=><div style={{display:'flex',minHeight:0,...flatten(style)}}>{children}</div>;`;
async function bundlePlayer(){
const result=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Player from ${JSON.stringify(resolve(root,'sakura-mobile/components/anime/WebVideoPlayer.web.tsx'))};import Viewport from ${JSON.stringify(resolve(root,'sakura-mobile/components/anime/WatchViewport.web.tsx'))};${mediaFixture}function App(){const[uri,setUri]=useState('fixture://episode1.m3u8');const[hasNext,setHasNext]=useState(true);const[mounted,setMounted]=useState(true);const[,renderAgain]=useState(0);window.__rerender=()=>renderAgain(value=>value+1);window.__changeSource=()=>setUri(previous=>previous==='fixture://episode1.m3u8'?'fixture://episode2.m3u8':'fixture://episode1.m3u8');window.__setNext=setHasNext;window.__unmount=()=>setMounted(false);return <Viewport>{mounted&&<Player uri={uri} isM3U8 startAt={63} subtitleMode="off" onCheckpoint={(...p)=>window.__checkpoints.push(p)} chrome={{title:'Demon Slayer: Kimetsu no Yaiba — Infinity Castle',episodeLabel:'Episode 1 · The beginning',episodeNumber:1,category:'sub',availableCategories:['sub','dub'],onToggleCategory:()=>window.__category++,onBack:()=>window.__backs++,intro:{start:60,end:90},outro:{start:1400,end:1470},nextEpisode:hasNext?{label:'Episode 2',number:2,title:'The next journey',onPlay:()=>window.__next++}:undefined}}/>}</Viewport>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfigRaw:{compilerOptions:{}},nodePaths:[root+'/web/node_modules'],define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'fixtures',setup(p){p.onResolve({filter:/^(react-native|hls\.js)$/},a=>({path:a.path,namespace:'fixture'}));p.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='hls.js'?hlsFixture:nativeFixture,loader:'jsx',resolveDir:root}))}}]});
return result.outputFiles[0].text;
}
async function servePlayer(){
const code=await bundlePlayer();
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?code:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;background:#000}</style><div id="root"></div><script src="/app.js"></script>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
return {server,url:`http://127.0.0.1:${server.address().port}`};
}
test('custom web controls preserve playback, preferences, keyboard access, and rotated phone geometry', {timeout:30000}, async t => {
const {server,url}=await servePlayer();
let browser; const reports=[];
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.SAKURA_BROWSER_EXECUTABLE || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
 const context=await browser.newContext({viewport:{width:1280,height:720}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForSelector('[data-sakura-player]');await page.waitForFunction(()=>document.querySelector('video').currentTime===63);
 await page.getByRole('button',{name:'Skip Opening',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').currentTime),90);
 await page.getByRole('button',{name:'Restart',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').currentTime),0);assert.ok(await page.evaluate(()=>window.__checkpoints.some(c=>c[0]===0)));
 await page.getByRole('button',{name:'Seek forward 10 seconds',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').currentTime),10);
 await page.getByRole('button',{name:'Seek backward 10 seconds',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').currentTime),0);
 const toggle=page.locator('.sc-main-play');await toggle.focus();const before=await page.evaluate(()=>({plays:window.__plays,pauses:window.__pauses}));await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.__pauses),before.pauses+1);assert.equal(await page.evaluate(()=>window.__plays),before.plays);await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.__plays),before.plays+1);
 const timeline=page.getByRole('slider',{name:'Playback position'});await timeline.focus();await page.keyboard.press('ArrowRight');assert.ok(Math.abs(await page.evaluate(()=>document.querySelector('video').currentTime)-.1)<.01);
 await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('ArrowRight');assert.ok(Math.abs(await page.evaluate(()=>document.querySelector('video').currentTime)-10.1)<.01);
 await page.getByRole('button',{name:'Playback speed',exact:true}).click();await page.getByRole('button',{name:'1.5×',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').playbackRate),1.5);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Playback speed');await page.getByRole('button',{name:'Playback settings',exact:true}).click();
 await page.getByRole('button',{name:'Quality',exact:true}).click();await page.getByRole('button',{name:'1080p',exact:true}).click();assert.equal(await page.evaluate(()=>window.__hls.currentLevel),1);
 await page.getByRole('button',{name:'Captions',exact:true}).last().click();await page.getByRole('button',{name:'English',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').textTracks[0].mode),'showing');
 await page.getByRole('button',{name:'Close playback settings',exact:true}).click();await page.getByRole('button',{name:'Mute',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').muted),true);
 await page.getByRole('button',{name:'Fullscreen',exact:true}).click();await page.waitForFunction(()=>document.fullscreenElement?.hasAttribute('data-watch-viewport'));await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();await page.waitForFunction(()=>!document.fullscreenElement);
 await page.evaluate(()=>window.__time(1420));await page.getByRole('button',{name:'Skip Ending',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('video').currentTime),1470);
 await page.getByRole('button',{name:'Next episode: Episode 2',exact:true}).click();await page.getByRole('button',{name:'Audio: SUB. Switch to DUB',exact:true}).click();assert.deepEqual(await page.evaluate(()=>[window.__next,window.__category]),[1,1]);
 await page.evaluate(()=>window.__changeSource());await page.waitForFunction(()=>document.querySelector('video').currentTime===63);assert.deepEqual(await page.evaluate(()=>{const v=document.querySelector('video');return[v.playbackRate,v.muted,v.textTracks[0].mode]}),[1.5,true,'showing']);assert.equal(await page.locator('.sc-resume span').textContent(),'Resumed at 1:03');
 await page.evaluate(()=>{document.activeElement.blur();document.querySelector('video').play()});await page.waitForFunction(()=>document.querySelector('[data-sakura-player]').dataset.chromeVisible==='false',{},{timeout:5000});
 await page.mouse.move(100,100);await page.waitForFunction(()=>document.querySelector('[data-sakura-player]').dataset.chromeVisible==='true');await page.screenshot({path:screenshotPath('desktop')});reports.push('Desktop: skip markers, restart checkpoint0, ±10 seek, input/document keyboard isolation, speed, captions, quality, mute, fullscreen wrapper, episode/category actions, persisted preferences and auto-hide passed.');
 assert.deepEqual(errors,[]);await context.close();
 const mobile=await browser.newContext({viewport:{width:320,height:568},isMobile:true,hasTouch:true,deviceScaleFactor:1});const phone=await mobile.newPage();await phone.goto(url);await phone.waitForSelector('[data-sakura-player]');await phone.waitForFunction(()=>document.querySelector('[data-watch-viewport]')?.dataset.rotated==='true');await phone.screenshot({path:screenshotPath('phone')});
 const bounds=await phone.evaluate(()=>{const host=document.querySelector('[data-watch-viewport]').getBoundingClientRect();return [...document.querySelectorAll('.sc-top button,.sc-center button,.sc-footer button,.sc-skip,.sc-resume')].filter(e=>getComputedStyle(e).display!=='none').map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label')||e.textContent.trim(),inside:r.left>=host.left-.1&&r.right<=host.right+.1&&r.top>=host.top-.1&&r.bottom<=host.bottom+.1,width:r.width,height:r.height}})});assert.ok(bounds.every(b=>b.inside),JSON.stringify(bounds));
 await phone.getByRole('button',{name:'Playback settings',exact:true}).click();await phone.screenshot({path:screenshotPath('phone-settings')});const menuFits=await phone.locator('.sc-menu').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+.1&&r.bottom<=innerHeight+.1});assert.equal(menuFits,true);await phone.getByRole('button',{name:'Close playback settings',exact:true}).click();
 const seekBounds=await phone.getByRole('slider',{name:'Playback position'}).boundingBox();await phone.mouse.click(seekBounds.x+seekBounds.width/2,seekBounds.y+seekBounds.height/2);assert.ok(Math.abs(await phone.evaluate(()=>document.querySelector('video').currentTime)-739)<3);
 await phone.mouse.move(seekBounds.x+seekBounds.width/2,seekBounds.y+seekBounds.height/2);await phone.mouse.down();await phone.mouse.move(seekBounds.x+seekBounds.width/2,seekBounds.y+seekBounds.height*.8,{steps:8});await phone.mouse.up();const dragged=await phone.evaluate(()=>document.querySelector('video').currentTime);assert.ok(dragged>1150&&dragged<1220);await phone.getByRole('slider',{name:'Playback position'}).focus();const element=await phone.locator('video').elementHandle();await phone.setViewportSize({width:568,height:320});await phone.waitForFunction(()=>document.querySelector('[data-watch-viewport]').dataset.rotated==='false');assert.equal(await phone.evaluate(v=>v===document.querySelector('video'),element),true);assert.equal(await phone.evaluate(()=>document.querySelector('video').currentTime),dragged);
 await phone.getByRole('button',{name:'Fullscreen',exact:true}).click();await phone.waitForFunction(()=>document.fullscreenElement?.hasAttribute('data-watch-viewport'));await phone.getByRole('button',{name:'Exit fullscreen',exact:true}).click();await phone.waitForFunction(()=>!document.fullscreenElement);
 reports.push('320×568 touch portrait: rotated 568×320 shell, all primary controls/settings fit; rotated scrubber click/drag map correctly, focused-slider phone rotation keeps video/time, small fullscreen targets wrapper.');
 await mobile.close();t.diagnostic(JSON.stringify({reports,screenshots:[screenshotPath('desktop'),screenshotPath('phone'),screenshotPath('phone-settings')]},null,2));
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}

});

test('Up next autoplay honors real completion, user choice, visibility and source lifecycle', {timeout:60000}, async t => {
  const {server,url}=await servePlayer();
  const browser=await chromium.launch({headless:true,executablePath:process.env.SAKURA_BROWSER_EXECUTABLE || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
  try {
    const run=async(name,body,{mobile=false}={})=>t.test(name,{timeout:15000},async()=>{
      const context=await browser.newContext(mobile?{viewport:{width:320,height:568},isMobile:true,hasTouch:true}:{viewport:{width:1280,height:720}});
      const page=await context.newPage();
      page.setDefaultTimeout(4000);
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      // Freeze a real browser clock so countdown boundaries are deterministic;
      // React, DOM events and the actual player/control components still run.
      const now=new Date('2026-10-11T12:00:00Z');
      // Installation briefly runs the clock. Start a minute before the target
      // (longer than this case's deadline), then pause while still on about:blank.
      // No application timers exist yet and navigation latency cannot overtake it.
      await page.clock.install({time:new Date(now.getTime()-60_000)});
      await page.clock.pauseAt(now);
      try {
        await page.goto(url);
        await page.waitForFunction(()=>document.querySelector('video')?.currentTime===63);
        const card=page.getByRole('region',{name:'Up next',exact:true});
        const end=async()=>{await page.evaluate(()=>window.__end());await card.waitFor({state:'visible'});};
        await body({page,card,end});
        assert.deepEqual(errors,[]);
      } finally {await context.close();}
    });

    await run('only actual ended starts five seconds; repeated end events navigate exactly once',async({page,card,end})=>{
      await page.evaluate(()=>{window.__time(1477.9);window.__repeatEnd();});await page.clock.runFor(6000);
      assert.equal(await card.count(),0,'credits/near-complete progress never starts autoplay');
      assert.equal(await page.evaluate(()=>window.__next),0);
      await end();await page.getByText('Playing in 5 seconds',{exact:true}).waitFor();
      assert.ok(await page.evaluate(()=>window.__checkpoints.some(point=>point[0]===1478&&point[2]===true)),'real ended checkpoint remains available to watch progress');
      await page.clock.runFor(4900);assert.equal(await page.evaluate(()=>window.__next),0);
      await page.clock.runFor(200);assert.equal(await page.evaluate(()=>window.__next),1);
      await page.evaluate(()=>window.__repeatEnd());await page.clock.runFor(6000);
      assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('Play now works by keyboard and cannot race the pending timer',async({page,card,end})=>{
      await end();await page.clock.runFor(1000);
      const play=card.getByRole('button',{name:'Play now',exact:true});await play.focus();await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>window.__next),1);
      await page.clock.runFor(10000);await page.evaluate(()=>window.__repeatEnd());
      assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('Cancel dismisses and suppresses autoplay for the current source while manual Next remains available',async({page,card,end})=>{
      await end();const cancel=card.getByRole('button',{name:'Cancel autoplay',exact:true});await cancel.focus();await page.keyboard.press('Space');
      await card.waitFor({state:'hidden'});await page.evaluate(()=>window.__repeatEnd());await page.clock.runFor(6000);
      assert.equal(await card.count(),0);assert.equal(await page.evaluate(()=>window.__next),0);
      await page.getByRole('button',{name:'Next episode: Episode 2',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('autoplay off persists through reload and keeps Play now manual',async({page,card,end})=>{
      await page.getByRole('button',{name:'Playback settings',exact:true}).click();
      const toggle=page.getByRole('switch',{name:'Autoplay next episode',exact:true});
      assert.equal(await toggle.getAttribute('aria-checked'),'true');await toggle.click();
      assert.equal(await toggle.getAttribute('aria-checked'),'false');
      await page.reload();await page.waitForFunction(()=>document.querySelector('video')?.currentTime===63);
      await page.getByRole('button',{name:'Playback settings',exact:true}).click();
      assert.equal(await toggle.getAttribute('aria-checked'),'false');
      await page.getByRole('button',{name:'Close playback settings',exact:true}).click();
      await end();await card.getByText('Autoplay is off',{exact:true}).waitFor();
      assert.equal(await card.getByRole('button',{name:'Cancel autoplay',exact:true}).count(),0);
      await page.clock.runFor(10000);assert.equal(await page.evaluate(()=>window.__next),0);
      await card.getByRole('button',{name:'Play now',exact:true}).click();assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('hidden tabs pause the remaining countdown instead of navigating in the background',async({page,end})=>{
      await end();await page.clock.runFor(1000);
      await page.evaluate(()=>window.__visibility('hidden'));await page.clock.runFor(20000);
      assert.equal(await page.evaluate(()=>window.__next),0);
      await page.evaluate(()=>window.__visibility('visible'));await page.clock.runFor(3900);
      assert.equal(await page.evaluate(()=>window.__next),0);
      await page.clock.runFor(200);assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('turning autoplay off cancels the active timer and re-enabling starts a fresh five seconds',async({page,card,end})=>{
      await end();await page.clock.runFor(2000);
      await page.getByRole('button',{name:'Playback settings',exact:true}).click();
      const toggle=page.getByRole('switch',{name:'Autoplay next episode',exact:true});await toggle.click();
      await card.getByText('Autoplay is off',{exact:true}).waitFor();await page.clock.runFor(6000);
      assert.equal(await page.evaluate(()=>window.__next),0);
      await toggle.click();await page.getByText('Playing in 5 seconds',{exact:true}).waitFor();
      await page.clock.runFor(4900);assert.equal(await page.evaluate(()=>window.__next),0);
      await page.clock.runFor(200);assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('a new callback for the same source does not restart or duplicate the countdown',async({page,end})=>{
      await end();await page.clock.runFor(2000);await page.evaluate(()=>window.__rerender());
      await page.clock.runFor(2900);assert.equal(await page.evaluate(()=>window.__next),0);
      await page.clock.runFor(200);assert.equal(await page.evaluate(()=>window.__next),1);
      await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('seek and replay cancel pending autoplay; another real end may start a new countdown',async({page,card,end})=>{
      await end();await page.clock.runFor(1000);await page.evaluate(()=>window.__time(1300));
      await card.waitFor({state:'hidden'});await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>window.__next),0);
      await end();await page.getByRole('button',{name:'Replay',exact:true}).click();
      await card.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>document.querySelector('video').currentTime),0);
      await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>window.__next),0);
      await end();await page.clock.runFor(5100);assert.equal(await page.evaluate(()=>window.__next),1);
    });

    await run('source replacement and unmount cancel callbacks from the ended source',async({page,card,end})=>{
      await end();await page.clock.runFor(1000);await page.evaluate(()=>window.__changeSource());
      await page.waitForFunction(()=>document.querySelector('video')?.currentTime===63);await card.waitFor({state:'hidden'});
      await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>window.__next),0);
      await end();await page.evaluate(()=>window.__unmount());await page.locator('video').waitFor({state:'detached'});
      await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>window.__next),0);
    });

    await run('the final episode and a removed next target never schedule navigation',async({page,card,end})=>{
      await end();await page.clock.runFor(1000);await page.evaluate(()=>window.__setNext(false));
      await card.waitFor({state:'hidden'});await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>window.__next),0);
      await page.evaluate(()=>{window.__time(1300);window.__end();});await page.clock.runFor(6000);
      assert.equal(await card.count(),0);assert.equal(await page.evaluate(()=>window.__next),0);
      assert.equal(await page.getByRole('button',{name:'Next episode: Episode 2',exact:true}).count(),0);
    });

    await run('Up next stays inside a small rotated phone and its action is touch accessible',async({page,card,end})=>{
      await page.waitForFunction(()=>document.querySelector('[data-watch-viewport]')?.dataset.rotated==='true');await end();
      const bounds=await card.evaluate(element=>{
        const host=element.closest('[data-watch-viewport]').getBoundingClientRect();
        return [element,...element.querySelectorAll('button')].map(node=>{const rect=node.getBoundingClientRect();return {label:node.getAttribute('aria-label')||node.textContent.trim(),inside:rect.left>=host.left-.1&&rect.top>=host.top-.1&&rect.right<=host.right+.1&&rect.bottom<=host.bottom+.1,width:rect.width,height:rect.height};});
      });
      await page.screenshot({path:screenshotPath('phone-up-next')});
      assert.ok(bounds.every(bound=>bound.inside),JSON.stringify(bounds));
      assert.ok(bounds.slice(1).every(bound=>Math.min(bound.width,bound.height)>=36),JSON.stringify(bounds));
      const replay=page.getByRole('button',{name:'Replay',exact:true});
      assert.equal(await replay.evaluate(element=>{const rect=element.getBoundingClientRect();return element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));}),true,'Up next must not cover the Replay button');
      await card.getByRole('button',{name:'Play now',exact:true}).tap();assert.equal(await page.evaluate(()=>window.__next),1);
    },{mobile:true});
    t.diagnostic('Autoplay coverage uses actual React/DOM controls with deterministic media and clock fixtures; it does not contact a streaming provider.');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
