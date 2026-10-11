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
Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{get(){return get(this).time},set(value){get(this).time=value;this.dispatchEvent(new Event('timeupdate'));this.dispatchEvent(new Event('seeked'));},configurable:true});
Object.defineProperty(HTMLMediaElement.prototype,'buffered',{get(){return {length:1,start(){return 0},end(){return 400}}},configurable:true});
HTMLMediaElement.prototype.play=function(){window.__plays++;get(this).paused=false;this.dispatchEvent(new Event('play'));this.dispatchEvent(new Event('playing'));return Promise.resolve()};
HTMLMediaElement.prototype.pause=function(){window.__pauses++;get(this).paused=true;this.dispatchEvent(new Event('pause'));};
HTMLMediaElement.prototype.load=function(){};
window.__plays=0;window.__pauses=0;window.__checkpoints=[];window.__backs=0;window.__next=0;window.__category=0;
window.__loadMedia=v=>{get(v).ready=4; if(!v.textTracks.length)v.addTextTrack('subtitles','English','en');v.dispatchEvent(new Event('loadedmetadata'));};
window.__time=t=>{const v=document.querySelector('video');v.currentTime=t;};
`;
const hlsFixture=`export default class Hls{static Events={SUBTITLE_TRACKS_UPDATED:'subtitles',ERROR:'error'};static ErrorTypes={MEDIA_ERROR:'media'};static isSupported(){return true} levels=[{height:720,bitrate:1000000},{height:1080,bitrate:2000000}];currentLevel=-1;get autoLevelEnabled(){return this.currentLevel<0};subtitleDisplay=false;constructor(){window.__hls=this}on(){}loadSource(){}attachMedia(v){queueMicrotask(()=>window.__loadMedia(v))}destroy(){}recoverMediaError(){}}`;
const nativeFixture=`import React from 'react';const flatten=v=>Array.isArray(v)?Object.assign({},...v.map(flatten)):v||{};export const StyleSheet={create:v=>v};export const View=({children,style})=><div style={{display:'flex',minHeight:0,...flatten(style)}}>{children}</div>;`;
test('custom web controls preserve playback, preferences, keyboard access, and rotated phone geometry', {timeout:30000}, async t => {
const result=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Player from ${JSON.stringify(resolve(root,'sakura-mobile/components/anime/WebVideoPlayer.web.tsx'))};import Viewport from ${JSON.stringify(resolve(root,'sakura-mobile/components/anime/WatchViewport.web.tsx'))};${mediaFixture}function App(){const[uri,setUri]=useState('fixture://episode1.m3u8');window.__changeSource=()=>setUri('fixture://episode2.m3u8');return <Viewport><Player uri={uri} isM3U8 startAt={63} subtitleMode="off" onCheckpoint={(...p)=>window.__checkpoints.push(p)} chrome={{title:'Demon Slayer: Kimetsu no Yaiba — Infinity Castle',episodeLabel:'Episode 1 · The beginning',episodeNumber:1,category:'sub',availableCategories:['sub','dub'],onToggleCategory:()=>window.__category++,onBack:()=>window.__backs++,intro:{start:60,end:90},outro:{start:1400,end:1470},nextEpisode:{label:'Episode 2',onPlay:()=>window.__next++}}}/></Viewport>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfigRaw:{compilerOptions:{}},nodePaths:[root+'/web/node_modules'],define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'fixtures',setup(p){p.onResolve({filter:/^(react-native|hls\.js)$/},a=>({path:a.path,namespace:'fixture'}));p.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='hls.js'?hlsFixture:nativeFixture,loader:'jsx',resolveDir:root}))}}]});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?result.outputFiles[0].text:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;background:#000}</style><div id="root"></div><script src="/app.js"></script>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
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
