import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCipheriv, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
function load(name) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => name === './hls-local-playlist' ? load('hls-local-playlist') : require(name),
    URL, Uint8Array, DataView, DOMException, crypto: webcrypto, location: { href: 'https://offline.test/app/' } });
  return module.exports;
}
const { writeAnimeVideo } = load('anime-video-export.web');
const base = 'https://offline.test/app/__offline/anime/test/episode/';
const episode = { status: 'ready', format: 'hls', localPlaylistUri: `${base}index.m3u8` };
const media = lines => ['#EXTM3U', ...lines, '#EXT-X-ENDLIST'].join('\n');
function cacheFor(files) {
  const calls = [];
  return { calls, async match(url) { calls.push(url); const file = files[new URL(url, base).href] ?? files[new URL(url, base).pathname.split('/').pop()]; return file === undefined ? undefined : (file instanceof Response ? file.clone() : new Response(file)); } };
}
async function exported(cache, current = episode, options) {
  const chunks = [];
  const result = await writeAnimeVideo(cache, current, async chunk => { chunks.push(Buffer.from(chunk)); }, options);
  return { result, bytes: Buffer.concat(chunks) };
}
const ftyp = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);

function durationFields(mp4) {
  const fields = [];
  function visit(start, end) {
    for (let at = start; at < end;) {
      const size = mp4.readUInt32BE(at);
      assert.ok(size >= 8 && at + size <= end);
      const type = mp4.toString('ascii', at + 4, at + 8);
      if (['moov', 'trak', 'mdia'].includes(type)) visit(at + 8, at + size);
      if (['mvhd', 'tkhd', 'mdhd'].includes(type)) {
        const version = mp4[at + 8];
        const offset = at + 8 + (type === 'tkhd' ? 20 : 16) + (version === 1 ? 8 : 0);
        fields.push({ type, offset, version, value: version === 1 ? mp4.readBigUInt64BE(offset) : BigInt(mp4.readUInt32BE(offset)) });
      }
      at += size;
    }
  }
  visit(0, mp4.length);
  return fields;
}

function useVersionOneDurationHeaders(mp4) {
  const parts = [];
  for (let at = 0; at < mp4.length;) {
    const size = mp4.readUInt32BE(at), type = mp4.toString('ascii', at + 4, at + 8);
    let payload = mp4.subarray(at + 8, at + size);
    if (['moov', 'trak', 'mdia'].includes(type)) payload = useVersionOneDurationHeaders(payload);
    else if (['mvhd', 'tkhd', 'mdhd'].includes(type)) {
      assert.equal(payload[0], 0);
      const durationOffset = type === 'tkhd' ? 20 : 16;
      const flags = Buffer.from(payload.subarray(0, 4)); flags[0] = 1;
      payload = Buffer.concat([flags, Buffer.alloc(4), payload.subarray(4, 8), Buffer.alloc(4), payload.subarray(8, durationOffset), Buffer.alloc(8, 255), payload.subarray(durationOffset + 4)]);
    }
    const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4);
    parts.push(header, payload); at += size;
  }
  return Buffer.concat(parts);
}

test('copies progressive video byte-exactly, awaits the sink, and reports its real MIME', async () => {
  const source = Buffer.concat([ftyp, Buffer.alloc(150_000, 71)]);
  const cache = cacheFor({ video: new Response(source, { headers: { 'content-type': 'video/quicktime', 'content-length': String(source.length) } }) });
  let active = 0, count = 0;
  const chunks = [];
  const result = await writeAnimeVideo(cache, { status: 'ready', format: 'mp4', localPlaylistUri: `${base}video` }, async bytes => {
    assert.equal(active++, 0); await new Promise(resolve => setTimeout(resolve, 1)); chunks.push(Buffer.from(bytes)); active--; count++;
  });
  assert.equal(result.mimeType, 'video/quicktime'); assert.equal(result.extension, 'mov'); assert.equal(result.bytes, source.length);
  assert.ok(count); assert.deepEqual(Buffer.concat(chunks), source);
});

test('rejects a progressive file whose cached Content-Length does not match its bytes', async () => {
  await assert.rejects(exported(cacheFor({ video: new Response(ftyp, { headers: { 'content-length': String(ftyp.length + 10) } }) }), { status: 'ready', format: 'mp4', localPlaylistUri: `${base}video` }), /incomplete/);
});

test('aborted export stops reading and never reports success', async () => {
  const controller = new AbortController();
  const cache = cacheFor({ video: Buffer.alloc(200_000) });
  let writes = 0;
  await assert.rejects(writeAnimeVideo(cache, { status: 'ready', format: 'mp4', localPlaylistUri: `${base}video` }, async () => { writes++; controller.abort(); }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(writes, 1);
  await assert.rejects(exported(cache, episode, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(cache.calls.length, 1);
});

test('refuses incomplete episodes, missing cached media and network references', async () => {
  await assert.rejects(exported(cacheFor({}), { ...episode, status: 'downloading' }), /Finish downloading/);
  await assert.rejects(exported(cacheFor({})), /missing/);
  await assert.rejects(exported(cacheFor({ 'index.m3u8': media(['#EXTINF:2,', 'missing.ts']) })), /missing/);
  const cache = cacheFor({ 'index.m3u8': media(['#EXTINF:2,', 'https://media.example/remote.ts']) });
  await assert.rejects(exported(cache), /not saved locally/);
  assert.equal(cache.calls.length, 1, 'a remote URL is not looked up or fetched');
});

test('rejects master, unfinished, unsupported encryption and invalid byte-range playlists', async () => {
  const cases = [
    ['#EXTM3U\n#EXTINF:2,\na.ts', /incomplete/],
    [media(['#EXT-X-STREAM-INF:BANDWIDTH=1', 'variant.m3u8']), /separate renditions/],
    [media(['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"', '#EXTINF:2,', 'a.ts']), /encryption format/],
    [media(['#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="drm",URI="key"', '#EXTINF:2,', 'a.ts']), /encryption format/],
    [media(['#EXT-X-KEY:METHOD=AES-128,URI="key",IV=invalid', '#EXTINF:2,', 'a.ts']), /invalid encryption IV/],
    [media(['#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXT-X-MAP:URI="init"', '#EXTINF:2,', 'a.ts']), /explicit IV/],
    [media(['#EXT-X-BYTERANGE:100', '#EXTINF:2,', 'a.ts']), /incomplete byte range/],
    [media(['#EXTINF:NaN,', 'a.ts']), /invalid segment duration/],
    [media(['#EXT-X-GAP', '#EXTINF:2,', 'a.ts']), /missing media/],
  ];
  for (const [playlist, pattern] of cases) await assert.rejects(exported(cacheFor({ 'index.m3u8': playlist })), pattern);
});

test('rejects truncated cached ranges and invalid AES keys before remuxing', async () => {
  await assert.rejects(exported(cacheFor({ 'index.m3u8': media(['#EXTINF:2,', '#EXT-X-BYTERANGE:100@1', 'a.ts']), 'a.ts': new Uint8Array(100) })), /byte range is incomplete/);
  await assert.rejects(exported(cacheFor({ 'index.m3u8': media(['#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXTINF:2,', 'a.ts']), 'a.ts': new Uint8Array(16), key: new Uint8Array(15) })), /invalid AES-128 key/);
});

// Reproducible real-codec integration tests; no checked-in copyrighted media and no network.
// FFMPEG=/path/to/ffmpeg node --test test/anime-video-export.test.mjs
const ffmpeg = process.env.SAKURA_FFMPEG || process.env.FFMPEG;
test('real H.264/AAC TS, fMP4, AES, ranges, and timestamp resets export into independently decodable MP4', { skip: !ffmpeg }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sakura-video-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const kind of ['ts', 'fmp4']) mkdirSync(path.join(dir, kind));
  const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  run(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'ts', 'seg%d.ts'), path.join(dir, 'ts', 'media.m3u8')]);
  run(['-i', path.join(dir, 'ts', 'media.m3u8'), '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'fmp4', 'seg%d.m4s'), path.join(dir, 'fmp4', 'media.m3u8')]);
  const source = [0, 1, 2, 3].map(i => readFileSync(path.join(dir, 'ts', `seg${i}.ts`)));
  const plainFiles = { 'index.m3u8': readFileSync(path.join(dir, 'ts', 'media.m3u8'), 'utf8'), ...Object.fromEntries(source.map((b, i) => [`seg${i}.ts`, b])) };
  const baseline = (await exported(cacheFor(plainFiles))).bytes;
  const durations = durationFields(baseline);
  assert.equal(durations.length, 5, 'movie and both audio/video track/media duration fields are inspected');
  assert.ok(durations.every(field => field.value === 0n), 'Safari must infer the real duration instead of interpreting mux.js unknown duration as 24.8 hours');
  const verify = (name, bytes, expectedFrames = 192) => {
    const file = path.join(dir, `${name}.mp4`); writeFileSync(file, bytes);
    const info = execFileSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    const hashes = run(['-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']);
    const frames = hashes.split('\n').filter(line => line && !line.startsWith('#'));
    assert.equal(frames.length, expectedFrames, name);
    const [, numerator, denominator] = /#tb 0: (\d+)\/(\d+)/.exec(hashes);
    const lastTime = Number(frames.at(-1).split(',')[2]) * Number(numerator) / Number(denominator);
    assert.ok(lastTime > 7.8 && lastTime < 8.3, `${name} retains an eight-second timeline: ${lastTime}`);
    assert.ok(run(['-i', file, '-map', '0:a:0', '-f', 'framemd5', '-']).includes('0,'), `${name} contains decodable audio`);
    return info;
  };
  verify('ts', baseline);
  for (const explicit of [true, false]) {
    const keys = [Buffer.alloc(16, 17), Buffer.alloc(16, 29)];
    const files = { key0: keys[0], key1: keys[1] };
    const lines = ['#EXT-X-MEDIA-SEQUENCE:37'];
    source.forEach((bytes, i) => {
      const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(explicit ? 1 : 37 + i), 8);
      if (i % 2 === 0) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key${i / 2}"${explicit ? ',IV=0x1' : ''}`);
      const cipher = createCipheriv('aes-128-cbc', keys[Math.floor(i / 2)], iv);
      files[`seg${i}`] = Buffer.concat([cipher.update(bytes), cipher.final()]);
      lines.push('#EXTINF:2,', `seg${i}`);
    });
    files['index.m3u8'] = media(lines);
    assert.deepEqual((await exported(cacheFor(files))).bytes, baseline, `${explicit ? 'explicit' : 'sequence'} IV and key rotation are byte exact`);
  }
  const lines = []; let offset = 0;
  source.forEach((bytes, i) => { lines.push('#EXTINF:2,', `#EXT-X-BYTERANGE:${bytes.length}${i ? '' : '@0'}`, 'shared.ts'); offset += bytes.length; });
  assert.deepEqual((await exported(cacheFor({ 'index.m3u8': media(lines), 'shared.ts': Buffer.concat(source) }))).bytes, baseline, 'implicit and explicit ranges select only each segment');
  const fmp4 = { 'index.m3u8': readFileSync(path.join(dir, 'fmp4', 'media.m3u8'), 'utf8'), 'init.mp4': readFileSync(path.join(dir, 'fmp4', 'init.mp4')) };
  for (let i = 0; i < 4; i++) fmp4[`seg${i}.m4s`] = readFileSync(path.join(dir, 'fmp4', `seg${i}.m4s`));
  const fmp4Baseline = (await exported(cacheFor(fmp4))).bytes;
  verify('fmp4', fmp4Baseline);
  const versionOne = (await exported(cacheFor({ ...fmp4, 'init.mp4': useVersionOneDurationHeaders(fmp4['init.mp4']) }))).bytes;
  assert.ok(durationFields(versionOne).every(field => field.version === 1 && field.value === 0n), '64-bit unknown duration sentinels are also normalized');
  verify('fmp4-version-one', versionOne);
  const finiteInit = Buffer.from(fmp4['init.mp4']);
  for (const field of durationFields(finiteInit)) finiteInit.writeUInt32BE(123, field.offset);
  const finite = (await exported(cacheFor({ ...fmp4, 'init.mp4': finiteInit }))).bytes;
  assert.ok(durationFields(finite).every(field => field.value === 123n), 'finite source duration metadata is preserved');
  const sharedParts = [fmp4['init.mp4'], ...[0, 1, 2, 3].map(i => fmp4[`seg${i}.m4s`])];
  const sharedLines = [`#EXT-X-MAP:URI="shared.mp4",BYTERANGE="${sharedParts[0].length}@0"`];
  sharedParts.slice(1).forEach((part, i) => sharedLines.push('#EXTINF:2,', `#EXT-X-BYTERANGE:${part.length}${i === 0 ? `@${sharedParts[0].length}` : ''}`, 'shared.mp4'));
  assert.deepEqual((await exported(cacheFor({ 'index.m3u8': media(sharedLines), 'shared.mp4': Buffer.concat(sharedParts) }))).bytes, fmp4Baseline, 'map and media ranges sharing a single file export correctly');
  const encryptedMp4 = { key: Buffer.alloc(16, 39) };
  const encryptedLines = ['#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x2', '#EXT-X-MAP:URI="init.mp4"'];
  for (const [name, bytes] of Object.entries(fmp4).filter(([name]) => name !== 'index.m3u8')) {
    const iv = Buffer.alloc(16); iv[15] = 2;
    const cipher = createCipheriv('aes-128-cbc', encryptedMp4.key, iv);
    encryptedMp4[name] = Buffer.concat([cipher.update(bytes), cipher.final()]);
    if (name !== 'init.mp4') encryptedLines.push('#EXTINF:2,', name);
  }
  encryptedMp4['index.m3u8'] = media(encryptedLines);
  assert.deepEqual((await exported(cacheFor(encryptedMp4))).bytes, fmp4Baseline, 'encrypted fMP4 initialization and fragments decrypt correctly');
  for (const kind of ['ts', 'fmp4']) {
    const files = kind === 'ts' ? plainFiles : fmp4;
    const ext = kind === 'ts' ? 'ts' : 'm4s';
    const reset = kind === 'fmp4' ? ['#EXT-X-MAP:URI="init.mp4"'] : [];
    reset.push('#EXTINF:2,', `seg0.${ext}`, '#EXTINF:2,', `seg1.${ext}`, '#EXT-X-DISCONTINUITY', '#EXTINF:2,', `seg0.${ext}`, '#EXTINF:2,', `seg1.${ext}`);
    verify(`${kind}-discontinuity`, (await exported(cacheFor({ ...files, 'index.m3u8': media(reset) }))).bytes);
  }
  const corrupt = Buffer.from(source[0]);
  // PMT stream type 0x0f (AAC) replaced by AC-3: fail rather than save a silent video.
  for (let at = 0; at < corrupt.length; at += 188) {
    const pid = ((corrupt[at + 1] & 31) << 8) | corrupt[at + 2];
    if (pid !== 4096) continue;
    const begin = at + 5;
    for (let p = begin + 12 + (((corrupt[begin + 10] & 15) << 8) | corrupt[begin + 11]); p < at + 188 && corrupt[p] !== 255; p += 5 + (((corrupt[p + 3] & 15) << 8) | corrupt[p + 4])) if (corrupt[p] === 15) corrupt[p] = 0x81;
  }
  await assert.rejects(exported(cacheFor({ ...plainFiles, 'seg0.ts': corrupt })), /codecs other than H.264 and AAC/);
});
