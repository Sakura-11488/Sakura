import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require=createRequire(new URL('../../web/package.json',import.meta.url)),ts=require('typescript');
function load(name,globals={}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../components/anime/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,...globals});return exports;}
const {preferredSubtitleIndex,qualityLimit,applyQualityPreference}=load('player-media-preferences');
test('language matching handles regional codes, ISO aliases, labels and fallback without changing the preference',()=>{
 const tracks=[{language:'fr',label:'French'},{language:'en',label:'English'},{language:'spa',label:'Spanish'}];
 assert.equal(preferredSubtitleIndex(tracks,{code:'es-MX',label:'Español'}),2);
 assert.equal(preferredSubtitleIndex([{label:'Deutsch'},{label:'Español (Latinoamérica)'}],{code:'es'}),1);
 assert.equal(preferredSubtitleIndex(tracks,{code:'ja'}),1);
 assert.equal(preferredSubtitleIndex([{language:'fr'},{language:'de'}],{code:'ja'}),0);
 assert.equal(preferredSubtitleIndex([{language:'en',label:'English'},{language:'en',label:'English SDH'}],{code:'en',label:'English SDH'}),1);
 assert.equal(preferredSubtitleIndex([], {code:'en'}),-1);
});
test('quality limits handle sparse, unknown and nonstandard ordered renditions conservatively',()=>{
 assert.equal(qualityLimit([{height:360},{height:1080}],'balanced').index,0);
 assert.equal(qualityLimit([{height:360},{height:480},{height:720}],'data-saver').index,1);
 assert.equal(qualityLimit([{height:1080}],'data-saver').index,0);
 assert.equal(qualityLimit([{bitrate:800},{bitrate:400}],'data-saver').index,1);
 assert.equal(qualityLimit([{height:1080},{height:480}],'data-saver').pinned,true);
 assert.equal(qualityLimit([{height:480},{height:1080},{height:720}],'balanced').index,0,'never let an earlier1080p level through a later720p index cap');
 const hls={levels:[{height:360},{height:720},{height:1080}],startLevel:2,autoLevelEnabled:true};
 applyQualityPreference(hls,'balanced',true);assert.equal(hls.startLevel,1);assert.equal(hls.autoLevelCapping,1);
 applyQualityPreference(hls,'auto',false,true);assert.equal(hls.autoLevelCapping,-1);assert.equal(hls.loadLevel,-1);
});
test('legacy and malformed preferences migrate safely while updates retain other viewing choices',()=>{
 let data=JSON.stringify({captions:'off',subtitleLanguage:{code:'es-MX',label:'Español'},volume:.3,autoplayNext:false,audio:'dub'});
 const prefs=load('player-preferences',{localStorage:{getItem:()=>data,setItem:(_key,value)=>data=value}});
 assert.equal(prefs.readPlayerPreferences().qualityPreference,'auto');assert.equal(prefs.readPlayerPreferences().captionSize,'medium');
 prefs.savePlayerPreferences({captionSize:'large',captionBackground:'solid',qualityPreference:'data-saver'});
 const saved=prefs.readPlayerPreferences();assert.equal(saved.captions,'off');assert.equal(saved.subtitleLanguage.code,'es-MX');assert.equal(saved.audio,'dub');assert.equal(saved.autoplayNext,false);assert.equal(saved.volume,.3);assert.equal(saved.captionSize,'large');assert.equal(saved.qualityPreference,'data-saver');
 data=JSON.stringify({captionSize:'giant',captionBackground:'url(https://example.com)',qualityPreference:'4k',subtitleLanguage:{code:12,label:{}}});
 assert.equal(prefs.readPlayerPreferences().captionSize,'medium');assert.equal(prefs.readPlayerPreferences().captionBackground,'soft');assert.equal(prefs.readPlayerPreferences().subtitleLanguage,undefined);
 data='null';assert.equal(prefs.readPlayerPreferences().qualityPreference,'auto');
});
