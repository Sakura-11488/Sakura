import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../supabase/functions/anime-stream/handler.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function loadHandler(overrides = {}) {
  const exports = {};
  vm.runInNewContext(compiled, { exports, crypto: webcrypto, fetch, Request, Response, Headers,
    ReadableStream, AbortController, TextEncoder, TextDecoder, Uint8Array, URL, btoa, atob,
    setTimeout, clearTimeout, ...overrides });
  return exports.createAnimeStreamHandler;
}
const createHandler = loadHandler();
const scope = `/anime/${'a'.repeat(32)}/${'b'.repeat(32)}/`;
const master = `https://fetch.nexabloom.top${scope}master.m3u8`;
const variant = `https://fetch.nexabloom.top${scope}index.m3u8`;
const segment = `https://7v8gl.eclipseharbor.space${scope}seg-1.jpg`;
const caption = `https://6a8y6.broforgotsave.online${scope}subtitles/eng-2.vtt`;
const publicUrl = 'https://project.supabase.co/functions/v1/anime-stream';
const input = { malId: '21', episode: 1, category: 'sub' };
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nEnglish caption\n';
function tsBytes(length = 188 * 8) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 188) bytes[i] = 0x47;
  return bytes;
}
function payload(url) {
  return JSON.parse(Buffer.from(new URL(url).searchParams.get('token').split('.')[0], 'base64url').toString());
}
function playlistUrls(text) {
  return [...text.split('\n').filter(line => line && !line.startsWith('#')),
    ...Array.from(text.matchAll(/\bURI="([^"]+)"/g), match => match[1])];
}
function fixture(options = {}) {
  let clock = 1_800_000_000_000;
  const calls = [];
  let resolves = 0;
  const deps = {
    signingSecret: 'test-only-signing-secret-'.repeat(3), publicBaseUrl: publicUrl,
    now: () => clock,
    resolveEpisode: async () => { resolves++; return { url: master, isM3U8: true,
      embedUrl: 'https://megaplay.buzz/stream/mal/21/1/sub', category: 'sub', availableCategories: ['sub', 'dub'],
      subtitles: [{ url: caption, lang: 'en', label: 'English' }], ...options.resolved }; },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (options.fetch) return options.fetch(url, init);
      if (url === master) return new Response(options.masterText ?? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nindex.m3u8\n', {headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
      if (url === variant) return new Response(options.variantText ?? `#EXTM3U\n#EXTINF:8,\n${segment}\n#EXT-X-ENDLIST\n`);
      if (url === segment) return new Response(tsBytes(), {headers:{'Content-Type':'image/jpeg','Content-Length':String(188*8)}});
      if (url === caption) return new Response(vtt, {headers:{'Content-Type':'application/octet-stream'}});
      throw new Error(`Unexpected upstream ${url}`);
    },
    ...options.deps,
  };
  const handler = (options.createHandler ?? createHandler)(deps);
  const post = (body = input, headers = {}) => handler(new Request(publicUrl, {
    method: 'POST', headers: {'Content-Type':'application/json', ...headers}, body: JSON.stringify(body),
  }));
  return { handler, post, calls, setTime: value => {clock = value;}, get time(){return clock;}, get resolves(){return resolves;} };
}
async function resolveSource(h) {
  const response = await h.post();
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function segmentCapability(h) {
  const source = await resolveSource(h);
  const masterResponse = await h.handler(new Request(source.url));
  const child = playlistUrls(await masterResponse.text())[0];
  const variantResponse = await h.handler(new Request(child));
  return playlistUrls(await variantResponse.text())[0];
}

test('configuration fails closed; resolver accepts numeric episode inputs only and bounds JSON', async () => {
  for (const deps of [{signingSecret:''},{signingSecret:'short'},{publicBaseUrl:'/functions/v1/anime-stream'},{publicBaseUrl:'http://evil.example/relay'}]) {
    const h = fixture({deps});
    assert.equal((await h.post()).status, 503);
    assert.equal(h.resolves, 0);
  }
  const h = fixture();
  for (const body of [{...input,url:'https://evil.test'},{...input,malId:'21/path'}, {...input,episode:1.5},
    {...input,category:'other'},{...input,force:'true'}]) assert.equal((await h.post(body)).status,400);
  assert.equal((await h.post({...input,malId:'1'.repeat(2000)})).status,413);
  assert.equal((await h.handler(new Request(publicUrl,{method:'POST',body:'{}'}))).status,415);
  assert.equal(h.resolves,0);
  const preflight = await h.handler(new Request(publicUrl,{method:'OPTIONS'}));
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
  assert.match(preflight.headers.get('access-control-allow-headers'),/range/);
});

test('known provider unavailability returns a language-specific404 while unexpected failures stay502', async () => {
  for (const category of ['sub','dub']) {
    const h = fixture({deps:{resolveEpisode:async()=>{
      throw Object.assign(new Error('Private provider diagnostic must not be exposed'),{code:'EPISODE_UNAVAILABLE',category});
    }}});
    const response = await h.post({...input,category});
    assert.equal(response.status,404);
    const body = await response.json();
    assert.equal(body.code,'EPISODE_UNAVAILABLE');
    assert.match(body.error,new RegExp(`unavailable in ${category.toUpperCase()}`));
    assert.match(body.error,new RegExp(`Try ${category==='sub'?'DUB':'SUB'}`));
    assert.doesNotMatch(body.error,/Private provider/);
    assert.equal(h.calls.length,0);
  }
  const h = fixture({deps:{resolveEpisode:async()=>{throw new Error('Provider player format has changed.');}}});
  const response = await h.post();
  assert.equal(response.status,502);
  assert.equal((await response.json()).code,undefined);
});

test('signed capabilities reject forgery, missing tokens, and expiry before fetching upstream', async () => {
  const h = fixture();
  const source = await resolveSource(h);
  const signed = new URL(source.url);
  const token = signed.searchParams.get('token');
  const [body, signature] = token.split('.');
  signed.searchParams.set('token',`${body.slice(0,-1)}A.${signature}`);
  assert.equal((await h.handler(new Request(signed))).status,401);
  signed.searchParams.set('token',`${body}.${signature[0]==='A'?'B':'A'}${signature.slice(1)}`);
  assert.equal((await h.handler(new Request(signed))).status,401);
  assert.equal((await h.handler(new Request(publicUrl))).status,401);
  h.setTime(payload(source.url).e * 1000);
  assert.equal((await h.handler(new Request(source.url))).status,401);
  assert.equal(h.calls.length,0);
});

test('resolver URLs and every redirect must stay on verified HTTPS hosts within the episode scope', async () => {
  for (const url of ['https://127.0.0.1/private','http://fetch.nexabloom.top'+scope+'master.m3u8',
    'https://fetch.nexabloom.top.evil.test'+scope+'master.m3u8',
    'https://user:pass@fetch.nexabloom.top'+scope+'master.m3u8',
    'https://fetch.nexabloom.top:8443'+scope+'master.m3u8',
    'https://fetch.nexabloom.top/admin', 'https://host.unverified.space'+scope+'master.m3u8']) {
    const h = fixture({resolved:{url}});
    assert.equal((await h.post()).status,502,url);
    assert.equal(h.calls.length,0);
  }
  for (const location of ['https://169.254.169.254/latest/meta-data', 'https://evil.test'+scope+'index.m3u8',
    'https://fetch.nexabloom.top/anime/'+ 'c'.repeat(32)+'/'+ 'd'.repeat(32)+'/master.m3u8']) {
    const h = fixture({fetch:async()=>new Response(null,{status:302,headers:{Location:location}})});
    const source = await resolveSource(h);
    assert.equal((await h.handler(new Request(source.url))).status,502,location);
    assert.equal(h.calls.length,1,'blocked redirect is never fetched');
    assert.equal(h.calls[0].redirect,'manual');
  }
  const h = fixture({fetch:async(url)=> url===master
    ? new Response(null,{status:307,headers:{Location:'nested/new-master.m3u8'}})
    : new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n')});
  const source = await resolveSource(h);
  const response = await h.handler(new Request(source.url));
  assert.equal(response.status,200);
  assert.equal(payload(playlistUrls(await response.text())[0]).u,`https://fetch.nexabloom.top${scope}nested/child.m3u8`);
});

test('nested manifests, rendition playlists, keys and maps are rewritten with the original expiry', async () => {
  const masterText = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subtitles/en.m3u8"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=200,URI="iframes.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nindex.m3u8\n';
  const variantText = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:8,\nencrypted.css\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:8,\n'+segment+'\n';
  const h = fixture({masterText,variantText});
  const source = await resolveSource(h);
  const original = payload(source.url);
  h.setTime(h.time+60_000);
  const masterResponse = await h.handler(new Request(source.url));
  const children = playlistUrls(await masterResponse.text());
  assert.equal(children.length,3);
  assert.equal(payload(children[1]).k,'subtitle-playlist');
  assert.equal(payload(children[2]).k,'playlist');
  h.setTime(h.time+60_000);
  const mediaResponse = await h.handler(new Request(children[0]));
  const mediaChildren = playlistUrls(await mediaResponse.text());
  assert.deepEqual(mediaChildren.map(url=>payload(url).k),['encrypted-media','media','key','encrypted-media']);
  for (const url of [...children,...mediaChildren]) {
    const value = payload(url);
    assert.equal(value.e,original.e,'nested token must not extend the playback session');
    assert.equal(value.s,scope);
    assert.equal(new URL(url).origin,new URL(publicUrl).origin);
    assert.equal(new URL(url).pathname,new URL(publicUrl).pathname);
  }
  assert.equal(payload(source.subtitles[0].url).e,original.e);
  assert.equal(payload(source.subtitles[0].url).s,scope+'subtitles/');
});

test('trusted dub captions can use their own directory without widening media playlist scope', async () => {
  const otherScope = `/anime/${'c'.repeat(32)}/${'d'.repeat(32)}/`;
  const dubCaption = `https://6a8y6.broforgotsave.online${otherScope}subtitles/eng-2.vtt`;
  const h = fixture({resolved:{category:'dub',subtitles:[{url:dubCaption,lang:'en',label:'English'}]}});
  const source = await resolveSource(h);
  const token = payload(source.subtitles[0].url);
  assert.equal(token.k,'subtitle');
  assert.equal(token.u,dubCaption);
  assert.equal(token.s,otherScope+'subtitles/');
  assert.equal(payload(source.url).s,scope);
  const captions = fixture({fetch:async()=>new Response(vtt)});
  assert.equal(await (await captions.handler(new Request(source.subtitles[0].url))).text(),vtt);
  const badManifest = fixture({masterText:`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://fetch.nexabloom.top${otherScope}index.m3u8\n`});
  assert.equal((await badManifest.handler(new Request(source.url))).status,502);
});

test('playlist attributes cannot escape through duplicates, whitespace, malformed URI or interstitial metadata', async () => {
  const invalid = [
    '#EXT-X-MAP:URI=https://attacker.test/init.mp4',
    '#EXT-X-MAP:URI = https://attacker.test/init.mp4',
    '#EXT-X-MAP:URI="init.mp4",URI=https://attacker.test/init.mp4',
    '#EXT-X-MAP:URI="init.mp4",URI="https://attacker.test/init.mp4"',
    '#EXT-X-MAP:URI="init.mp4',
    '#EXT-X-MAP:URI="https://attacker.test/init.mp4"',
    '#EXT-X-MAP:URI="../../outside.mp4"',
    '#EXT-X-CONTENT-STEERING:SERVER-URI="https://attacker.test/list.json"',
    '#EXT-X-SESSION-DATA:DATA-ID="x",URI="https://attacker.test/data.json"',
    '#EXT-X-DEFINE:NAME="host",VALUE="evil.test"',
    '#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",X-ASSET-LIST="https://attacker.test/ad.json"',
    '#EXT-X-DATERANGE:ID="ad",X-ASSET-URI="https://attacker.test/ad.m3u8"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"',
    '#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="com.apple.streamingkeydelivery",URI="key.bin"',
  ];
  for (const line of invalid) {
    const h = fixture({masterText:'#EXTM3U\n'+line+'\n'});
    const source = await resolveSource(h);
    const result = await h.handler(new Request(source.url));
    assert.equal(result.status,502,line);
    assert.equal(h.calls.length,1);
  }
  const h = fixture({masterText:'#EXTM3U\n#EXT-X-MAP:URI = "init.mp4"\n'});
  const source = await resolveSource(h);
  const result = await h.handler(new Request(source.url));
  assert.equal(result.status,200,'quoted attributes with whitespace are safely normalized');
  assert.equal(payload(playlistUrls(await result.text())[0]).u,`https://fetch.nexabloom.top${scope}init.mp4`);
});

test('disguised TS streams preserve bytes and ignored Range status without leaking request credentials', async () => {
  const h = fixture();
  const url = await segmentCapability(h);
  const response = await h.handler(new Request(url,{headers:{Range:'bytes=0-1023',Authorization:'Bearer client-secret',Cookie:'private=1'}}));
  assert.equal(response.status,200,'ignored range must not become a fabricated 206');
  assert.equal(response.headers.get('content-type'),'video/mp2t');
  assert.equal(response.headers.get('content-range'),null);
  assert.equal(response.headers.get('accept-ranges'),null);
  assert.equal(response.headers.get('access-control-allow-origin'),'*');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),tsBytes());
  const upstream = h.calls.at(-1);
  assert.equal(upstream.headers.get('range'),'bytes=0-1023');
  assert.equal(upstream.headers.get('referer'),'https://megaplay.buzz/');
  assert.equal(upstream.headers.get('origin'),'https://megaplay.buzz');
  assert.equal(upstream.headers.get('authorization'),null);
  assert.equal(upstream.headers.get('cookie'),null);
  const before = h.calls.length;
  for (const range of ['bytes=0-1,4-5','bytes=3-1','bytes=-0','invalid']) {
    assert.equal((await h.handler(new Request(url,{headers:{Range:range}}))).status,400);
  }
  assert.equal(h.calls.length,before);
});

test('verified sub and dub segment families remain constrained to the episode hash directory', async () => {
  for (const host of ['7v8gl.eclipseharbor.space','iwlhp.stellarfrontier.space','7o819.twilightharbor.space','c6bk0.oakhorizon.space',
    'k2m9x.shadowharbor.space','qoiz0.laggedduringcutscene.site','gu3aq.questforwifi.site','4driv.onehpanddreaming.site',
    'f98cw.midnightvoyage.site','3xgg1.midnightvoyage.site','n953x.midnightvoyage.site']) {
    const h = fixture({variantText:`#EXTM3U\n#EXTINF:8,\nhttps://${host}${scope}seg-1.js\n`});
    const url = await segmentCapability(h);
    assert.equal(new URL(payload(url).u).hostname,host);
    const media = fixture({fetch:async()=>new Response(tsBytes(),{headers:{'Content-Type':'application/javascript'}})});
    const response = await media.handler(new Request(url));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'video/mp2t');
    await response.body.cancel();
  }
});

test('midnightvoyage playlist children reject lookalike hosts and paths outside the signed episode', async () => {
  const outside = `/anime/${'c'.repeat(32)}/${'d'.repeat(32)}/`;
  for (const url of [
    `https://f98cw.midnightvoyage.site.evil.test${scope}seg-f1-1.jpg`,
    `https://f98cw.evilmidnightvoyage.site${scope}seg-f1-1.jpg`,
    `https://f98cw.midnightvoyage.site/other/seg-f1-1.jpg`,
    `https://f98cw.midnightvoyage.site${outside}seg-f1-1.jpg`,
  ]) {
    const h = fixture({variantText:`#EXTM3U\n#EXTINF:8,\n${url}\n`});
    const source = await resolveSource(h);
    const masterResponse = await h.handler(new Request(source.url));
    const child = playlistUrls(await masterResponse.text())[0];
    assert.equal((await h.handler(new Request(child))).status,502,url);
    assert.equal(h.calls.length,2,'rejected segment is never fetched');
  }
});

test('valid partial captions, HEAD and 416 preserve relevant status and response headers', async () => {
  const h = fixture({fetch:async(_url,init)=> {
    if(init.headers.get('range')==='bytes=999-') return new Response('upstream error',{status:416,headers:{'Content-Range':`bytes */${vtt.length}`}});
    if(init.method==='HEAD') return new Response(null,{headers:{'Content-Length':String(vtt.length),'Accept-Ranges':'bytes'}});
    return new Response(vtt.slice(8,16),{status:206,headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes 8-15/${vtt.length}`,'Content-Length':'8','Accept-Ranges':'bytes'}});
  }});
  const source = await resolveSource(h);
  const url = source.subtitles[0].url;
  const partial = await h.handler(new Request(url,{headers:{Range:'bytes=8-15'}}));
  assert.equal(partial.status,206);
  assert.equal(partial.headers.get('content-range'),`bytes 8-15/${vtt.length}`);
  assert.match(partial.headers.get('content-type'),/^text\/vtt/);
  assert.equal(await partial.text(),vtt.slice(8,16));
  const head = await h.handler(new Request(url,{method:'HEAD'}));
  assert.equal(head.status,200);
  assert.equal(head.headers.get('content-length'),String(vtt.length));
  assert.equal(await head.text(),'');
  assert.equal(h.calls.at(-1).method,'HEAD');
  const outside = await h.handler(new Request(url,{headers:{Range:'bytes=999-'}}));
  assert.equal(outside.status,416);
  assert.equal(outside.headers.get('content-range'),`bytes */${vtt.length}`);
  assert.equal(await outside.text(),'');
});

test('actual HTML/JavaScript, invalid subtitles, oversized playlists and invalid keys fail closed', async () => {
  for (const body of ['<!doctype html><script>alert(1)</script>','const ad = window.open("https://ads.test");']) {
    const h = fixture();
    const url = await segmentCapability(h);
    const target = fixture({fetch:async()=>new Response(body,{headers:{'Content-Type':'video/mp2t'}})});
    assert.equal((await target.handler(new Request(url))).status,502);
  }
  const h = fixture();
  const source = await resolveSource(h);
  const invalidCaptions = fixture({fetch:async()=>new Response('<html>not subtitles</html>')});
  assert.equal((await invalidCaptions.handler(new Request(source.subtitles[0].url))).status,502);
  const huge = fixture({fetch:async()=>new Response('#EXTM3U\n'+'x'.repeat(512*1024))});
  assert.equal((await huge.handler(new Request(source.url))).status,413);
  const encrypted = fixture({masterText:'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:8,\nencrypted.js\n'});
  const encryptedSource = await resolveSource(encrypted);
  const manifest = await encrypted.handler(new Request(encryptedSource.url));
  const [encryptedUrl,keyUrl] = playlistUrls(await manifest.text());
  const binary = fixture({fetch:async()=>new Response(new Uint8Array(1024).fill(171),{headers:{'Content-Type':'application/javascript'}})});
  const media = await binary.handler(new Request(encryptedUrl));
  assert.equal(media.status,200);
  assert.equal(media.headers.get('content-type'),'application/octet-stream');
  assert.equal((await media.arrayBuffer()).byteLength,1024);
  const key = fixture({fetch:async()=>new Response(new Uint8Array(16).fill(42))});
  assert.equal((await (await key.handler(new Request(keyUrl))).arrayBuffer()).byteLength,16);
  const badKey = fixture({fetch:async()=>new Response('<html>fake encryption key</html>')});
  assert.equal((await badKey.handler(new Request(keyUrl))).status,502);
});

test('subtitle rendition playlists keep VTT semantics through nested signed URLs', async () => {
  const h = fixture({masterText:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subtitles/en.m3u8"\n'});
  const source = await resolveSource(h);
  const response = await h.handler(new Request(source.url));
  const child = playlistUrls(await response.text())[0];
  const rendition = fixture({fetch:async()=>new Response(`#EXTM3U\n#EXTINF:8,\n${caption}\n`)});
  const nested = await rendition.handler(new Request(child));
  const vttUrl = playlistUrls(await nested.text())[0];
  assert.equal(payload(vttUrl).k,'subtitle');
  const captions = await h.handler(new Request(vttUrl));
  assert.equal(captions.status,200);
  assert.equal(await captions.text(),vtt);
});

test('upstream timeouts and downstream cancellation abort work and release active stream slots', async () => {
  const timed = fixture({createHandler:loadHandler({setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10))}),
    fetch:async()=>new Promise(()=>{})});
  const source = await resolveSource(timed);
  const timeout = await timed.handler(new Request(source.url));
  assert.equal(timeout.status,504);
  assert.equal(timed.calls[0].signal.aborted,true);
  const h = fixture();
  const url = await segmentCapability(h);
  let cancelled = 0;
  let reads = 0;
  const relay = fixture({fetch:async()=>new Response(new ReadableStream({
    pull(destination){reads++;destination.enqueue(tsBytes());}, cancel(){cancelled++;},
  }))});
  for(let attempt=0;attempt<28;attempt++) {
    const response = await relay.handler(new Request(url));
    assert.equal(response.status,200);
    assert.ok(reads<(attempt+1)*6,'relay does not consume the full video before downstream demand');
    await response.body.cancel();
    assert.equal(relay.calls.at(-1).signal.aborted,true);
  }
  assert.equal(cancelled,28,'downstream cancellation propagates upstream and frees the 24-slot pool');
});

test('resolver rate limits are bounded and reset by time', async () => {
  const h = fixture();
  for(let i=0;i<15;i++) assert.equal((await h.post()).status,200);
  const limited = await h.post();
  assert.equal(limited.status,429);
  assert.equal(limited.headers.get('retry-after'),'60');
  h.setTime(h.time+60_000);
  assert.equal((await h.post()).status,200);
});

test('the deadline releases streams even when downstream never drains or cancels them', async () => {
  const h = fixture();
  const url = await segmentCapability(h);
  const timers = new Map();
  let nextTimer = 0;
  let cancelled = 0;
  const relay = fixture({createHandler:loadHandler({
    setTimeout:callback=>{const id=++nextTimer;timers.set(id,callback);return id;},
    clearTimeout:id=>timers.delete(id),
  }),fetch:async()=>new Response(new ReadableStream({
    pull(destination){destination.enqueue(tsBytes());},cancel(){cancelled++;},
  }))});
  for(let i=0;i<24;i++) assert.equal((await relay.handler(new Request(url))).status,200);
  assert.equal((await relay.handler(new Request(url))).status,503,'in-flight stream limit enforced');
  assert.equal(timers.size,24);
  for(const expire of [...timers.values()]) expire();
  await Promise.resolve();
  assert.equal(cancelled,24,'deadline cancels upstream even without another pull');
  assert.equal(timers.size,0);
  const recovered = await relay.handler(new Request(url));
  assert.equal(recovered.status,200,'deadline frees slots for subsequent streams');
  await recovered.body.cancel();
});

test('global rate limits survive bounded IP-bucket eviction', async () => {
  const h = fixture();
  let limited = 0;
  for(let i=0;i<2501;i++) {
    const response = await h.handler(new Request(publicUrl,{headers:{'x-forwarded-for':`fixture-ip-${i}`}}));
    assert.equal(response.status,i<2400?401:429);
    if(response.status===429) limited++;
  }
  assert.equal(limited,101);
  assert.equal(h.calls.length,0);
});

test('server-configured media host families get the same episode path and scope checks', async () => {
  const variantFor = host => `#EXTM3U\n#EXTINF:8,\nhttps://${host}${scope}seg-1.js\n`;
  const deps = {allowedMediaHosts:[' NewCDN.example ', '*.wild.example', 'space', '10.0.0.1', 'localhost', '']};
  for (const host of ['newcdn.example','a1b2c.newcdn.example','x.wild.example']) {
    const h = fixture({deps, variantText:variantFor(host)});
    const url = await segmentCapability(h);
    assert.equal(new URL(payload(url).u).hostname,host);
  }
  const outside = `/anime/${'c'.repeat(32)}/${'d'.repeat(32)}/`;
  for (const [label,variantText] of [
    ['lookalike host', variantFor('evilnewcdn.example')],
    ['bare TLD entry is ignored', variantFor('x.other.space')],
    ['IP entry is ignored', `#EXTM3U\n#EXTINF:8,\nhttps://10.0.0.1${scope}seg-1.js\n`],
    ['configured host still needs the episode path', '#EXTM3U\n#EXTINF:8,\nhttps://newcdn.example/other/seg-1.js\n'],
    ['configured host still needs the signed scope', `#EXTM3U\n#EXTINF:8,\nhttps://newcdn.example${outside}seg-1.js\n`],
  ]) {
    const h = fixture({deps, variantText});
    const source = await resolveSource(h);
    const master = await h.handler(new Request(source.url));
    const child = playlistUrls(await master.text())[0];
    assert.equal((await h.handler(new Request(child))).status,502,label);
  }
  const without = fixture({variantText:variantFor('newcdn.example')});
  const source = await resolveSource(without);
  const master = await without.handler(new Request(source.url));
  const child = playlistUrls(await master.text())[0];
  assert.equal((await without.handler(new Request(child))).status,502,'not allowed unless configured');
});
