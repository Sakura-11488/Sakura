import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(new URL('../lib/hls-local-playlist.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// No require: the module must stay free of expo/React Native/platform imports.
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, atob, URL, Math });
const hls = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));

const relay = 'https://project.supabase.co/functions/v1/anime-stream';
const signed = name => `${relay}?token=${name}.sig`;
const local = name => `/app/__offline/anime/21/mal-21-1/${name}`;

test('resolveUrl keeps absolute URLs and resolves root-relative and relative ones', () => {
  const base = 'https://cdn.example/anime/a/b/index.m3u8?x=1';
  assert.equal(hls.resolveUrl(base, 'https://other.example/x.ts'), 'https://other.example/x.ts');
  assert.equal(hls.resolveUrl(base, '/root/seg.ts'), 'https://cdn.example/root/seg.ts');
  assert.equal(hls.resolveUrl(base, 'seg-1.ts'), 'https://cdn.example/anime/a/b/seg-1.ts');
  assert.equal(hls.resolveUrl(base, '  '), base);
});

test('pickMediaPlaylistUrl keeps the native choice: highest bandwidth, else the first URI', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2400000\nhigh.m3u8\n';
  assert.equal(hls.pickMediaPlaylistUrl(master, 'https://cdn.example/a/master.m3u8'), 'https://cdn.example/a/high.m3u8');
  assert.equal(hls.pickMediaPlaylistUrl('#EXTM3U\n#EXTINF:4,\nseg.ts\n', 'https://cdn.example/a/m.m3u8'), 'https://cdn.example/a/seg.ts');
});

test('planLocalPlaylist without a mapper is the native output: bare names, tags preserved, ENDLIST appended', () => {
  const media = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1.bin",IV=0x0000000000000000000000000000000a',
    '#EXTINF:9.009,', 'https://cdn.example/a/seg-1.ts',
    '#EXTINF:4.5,', 'seg-2.jpg\r',
  ].join('\n');
  const plan = hls.planLocalPlaylist(media, 'https://cdn.example/a/index.m3u8');
  assert.deepEqual(plain(plan.outLines), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="key0.key",IV=0x0000000000000000000000000000000a',
    '#EXTINF:9.009,', 'seg00000.ts',
    '#EXTINF:4.5,', 'seg00001.jpg',
    '#EXT-X-ENDLIST',
  ]);
  assert.deepEqual(plain(plan.downloads), [
    { url: 'https://keys.example/k1.bin', name: 'key0.key', kind: 'key' },
    { url: 'https://cdn.example/a/seg-1.ts', name: 'seg00000.ts', kind: 'seg' },
    { url: 'https://cdn.example/a/seg-2.jpg', name: 'seg00001.jpg', kind: 'seg' },
  ]);
});

test('relay playlists map to same-origin files: init segment, AES-128 key, byte ranges and METHOD=NONE', () => {
  const media = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${signed('init')}",BYTERANGE="720@0"`,
    `#EXT-X-KEY:METHOD=AES-128,URI="${signed('key')}"`,
    '#EXTINF:6,', '#EXT-X-BYTERANGE:1000@720', signed('file'),
    '#EXTINF:6,', '#EXT-X-BYTERANGE:1000@1720', signed('file'),
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:3.2,', signed('clear'),
    '#EXT-X-ENDLIST',
  ].join('\n');
  const plan = hls.planLocalPlaylist(media, signed('variant'), local);
  assert.deepEqual(plain(plan.downloads.map(d => [d.name, d.kind])), [
    ['init0.mp4', 'map'], ['key0.key', 'key'], ['seg00000.ts', 'seg'], ['seg00001.ts', 'seg'],
  ], 'a byte-ranged file shared by two segments is fetched once');
  assert.deepEqual(plain(plan.outLines), [
    '#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${local('init0.mp4')}",BYTERANGE="720@0"`,
    `#EXT-X-KEY:METHOD=AES-128,URI="${local('key0.key')}"`,
    '#EXTINF:6,', '#EXT-X-BYTERANGE:1000@720', local('seg00000.ts'),
    '#EXTINF:6,', '#EXT-X-BYTERANGE:1000@1720', local('seg00000.ts'),
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:3.2,', local('seg00001.ts'),
    '#EXT-X-ENDLIST',
  ]);
  assert.equal(plan.outLines.filter(line => /#EXT-X-ENDLIST/.test(line)).length, 1, 'existing ENDLIST is not duplicated');
  const summary = hls.summarizeMediaPlaylist(media);
  assert.deepEqual(plain(summary), { segmentCount: 3, durationSec: 15.2, encrypted: true, hasMap: true, hasByteRange: true, endList: true });
});

test('master parsing ignores trick-play streams, keeps quoted commas and resolves relative URIs', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframes.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4100000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    'https://cdn.example/a/1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480',
    '/root/480.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
    'audio.m3u8',
  ].join('\n');
  const variants = hls.parseMasterVariants(master, 'https://cdn.example/a/master.m3u8');
  assert.deepEqual(plain(variants.map(v => [v.url, v.height ?? null, v.codecs ?? null])), [
    ['https://cdn.example/a/1080.m3u8', 1080, 'avc1.640028,mp4a.40.2'],
    ['https://cdn.example/a/720/index.m3u8', 720, 'avc1.4d401f,mp4a.40.2'],
    ['https://cdn.example/root/480.m3u8', 480, null],
    ['https://cdn.example/a/audio.m3u8', null, 'mp4a.40.2'],
  ]);
  assert.equal(variants[0].averageBandwidth, 4100000);
  assert.equal(hls.isMasterPlaylist(master), true);
  assert.equal(hls.isMasterPlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts\n'), false);
});

test('chooseVariant prefers about 720p, then the closest below, then the lowest; never audio-only', () => {
  const v = (height, bandwidth, codecs) => ({ url: `${height}-${bandwidth}`, bandwidth, height, codecs });
  assert.equal(hls.chooseVariant([v(1080, 5e6), v(720, 2.8e6), v(480, 1.2e6)]).url, '720-2800000');
  assert.equal(hls.chooseVariant([v(1080, 5e6), v(540, 1.6e6), v(360, 8e5)]).url, '540-1600000');
  assert.equal(hls.chooseVariant([v(1440, 9e6), v(1080, 5e6)]).url, '1080-5000000', 'all above target: the lowest');
  assert.equal(hls.chooseVariant([v(1080, 5e6)]).url, '1080-5000000', 'the provider usually offers one rendition');
  assert.equal(hls.chooseVariant([v(undefined, 64000, 'mp4a.40.2'), v(1080, 5e6, 'avc1.640028,mp4a.40.2')]).url, '1080-5000000');
  const unlabelled = [{ url: 'a', bandwidth: 6e6 }, { url: 'b', bandwidth: 2.5e6 }, { url: 'c', bandwidth: 9e5 }];
  assert.equal(hls.chooseVariant(unlabelled).url, 'b');
  assert.equal(hls.chooseVariant([{ url: 'x', bandwidth: 8e6 }, { url: 'y', bandwidth: 6e6 }]).url, 'y');
  assert.equal(hls.chooseVariant([]), null);
  assert.equal(hls.variantLabel(v(720, 2.8e6)), '720p');
  assert.equal(hls.variantLabel({ url: 'x', bandwidth: 2_800_000 }), '2800 kbps');
});

test('separate audio renditions are detected only when the chosen group has a URI', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",URI="audio/ja.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="muxed",NAME="Japanese"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="aud"', 'a.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="muxed"', 'b.m3u8',
  ].join('\n');
  const [separate, muxed] = hls.parseMasterVariants(master, 'https://cdn.example/m.m3u8');
  assert.equal(hls.hasSeparateAudio(master, separate), true);
  assert.equal(hls.hasSeparateAudio(master, muxed), false);
  assert.equal(hls.hasSeparateAudio(master, { url: 'c', bandwidth: 1 }), false);
});

test('fingerprints ignore signed URLs but change with the encode', () => {
  const media = token => `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${relay}?token=${token}k"\n#EXTINF:6.006,\n${relay}?token=${token}1\n#EXTINF:4,\n${relay}?token=${token}2\n#EXT-X-ENDLIST\n`;
  assert.equal(hls.mediaPlaylistFingerprint(media('a')), hls.mediaPlaylistFingerprint(media('b')));
  assert.match(hls.mediaPlaylistFingerprint(media('a')), /^2:[0-9a-f]{8}$/);
  assert.notEqual(hls.mediaPlaylistFingerprint(media('a')), hls.mediaPlaylistFingerprint(media('a').replace('4,', '4.5,')));
  assert.notEqual(hls.mediaPlaylistFingerprint(media('a')), hls.mediaPlaylistFingerprint(media('a').replace('#EXT-X-ENDLIST', `#EXTINF:1,\n${relay}?token=a3\n#EXT-X-ENDLIST`)));
  assert.notEqual(hls.mediaPlaylistFingerprint(media('a')), hls.mediaPlaylistFingerprint(media('a').replace('METHOD=AES-128', 'METHOD=NONE')));
});

test('size estimates use average bandwidth when present', () => {
  assert.equal(hls.estimateRenditionBytes({ url: 'x', bandwidth: 8e6, averageBandwidth: 2e6 }, 1440), 360_000_000);
  assert.equal(hls.estimateRenditionBytes({ url: 'x', bandwidth: 2e6 }, 1440), 360_000_000);
  assert.equal(hls.estimateRenditionBytes(null, 1000), 312_500_000, 'no master: a 2.5 Mbps guess');
  assert.equal(hls.estimateRenditionBytes(null, 0), 0);
});

test('checkMediaBytes accepts real segments and catches truncation, HTML and bad keys', () => {
  const ts = (packets, offset = 0) => {
    const bytes = new Uint8Array(offset + packets * 188);
    for (let i = 0; i < packets; i++) bytes[offset + i * 188] = 0x47;
    return bytes;
  };
  assert.equal(hls.checkMediaBytes(ts(8), 'seg', 'video/mp2t'), 'ok');
  assert.equal(hls.checkMediaBytes(ts(1), 'seg', 'video/mp2t'), 'ok');
  assert.equal(hls.checkMediaBytes(ts(8, 4), 'seg', 'video/mp2t'), 'ok', 'a provider prefix before the first sync byte is fine');
  assert.equal(hls.checkMediaBytes(ts(8).subarray(0, 188 * 7 + 50), 'seg', 'video/mp2t'), 'misaligned');
  assert.equal(hls.checkMediaBytes(new TextEncoder().encode('<!doctype html><p>blocked</p>'), 'seg', 'video/mp2t'), 'invalid');
  assert.equal(hls.checkMediaBytes(new Uint8Array(), 'seg', 'video/mp2t'), 'invalid');
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
  assert.equal(hls.checkMediaBytes(mp4, 'map', 'video/mp4'), 'ok');
  assert.equal(hls.checkMediaBytes(new TextEncoder().encode('{"error":"x"}'), 'seg', null), 'invalid');
  assert.equal(hls.checkMediaBytes(new TextEncoder().encode('<anything>'), 'seg', 'application/octet-stream'), 'ok',
    'encrypted bytes are opaque; the relay already rejects HTML for them');
  assert.equal(hls.checkMediaBytes(new Uint8Array(16), 'key', 'application/octet-stream'), 'ok');
  assert.equal(hls.checkMediaBytes(new Uint8Array(32), 'key', null), 'invalid');
  assert.equal(hls.checkMediaBytes(new Uint8Array(10), 'seg', 'text/html'), 'invalid');
});

test('parseAttributeList handles quoted commas, unquoted values and odd spacing', () => {
  assert.deepEqual(plain(hls.parseAttributeList('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="a,b",RESOLUTION=1x2')),
    { BANDWIDTH: '1', CODECS: 'a,b', RESOLUTION: '1x2' });
  assert.deepEqual(plain(hls.parseAttributeList('#EXT-X-MAP:URI = "init.mp4"')), { URI: 'init.mp4' });
});

test('URL resolution handles parent directories, scheme-relative hosts and query-only references', () => {
  const base = 'https://cdn.example/a/b/index.m3u8?old=1';
  assert.equal(hls.resolveUrl(base, '../seg.ts'), 'https://cdn.example/a/seg.ts');
  assert.equal(hls.resolveUrl(base, '//other.example/seg.ts'), 'https://other.example/seg.ts');
  assert.equal(hls.resolveUrl(base, '?part=1'), 'https://cdn.example/a/b/index.m3u8?part=1');
});

test('fingerprints include resource identity, encryption IV, map ranges and media sequence', () => {
  const media = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST';
  const fingerprint = hls.mediaPlaylistFingerprint(media);
  for (const [from, to] of [['IV=0x01', 'IV=0x02'], ['100@0', '100@100'], ['SEQUENCE:5', 'SEQUENCE:6'], ['a.ts', 'b.ts'], ['key.bin', 'key2.bin']]) {
    assert.notEqual(hls.mediaPlaylistFingerprint(media.replace(from, to)), fingerprint, from);
  }
});

test('saved playlists strip live preload resources and rewrite spaced URI attributes', () => {
  const plan = hls.planLocalPlaylist('#EXTM3U\n#EXT-X-MAP:URI = "init.mp4"\n#EXT-X-PART:URI="part.ts",DURATION=1\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.ts"\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST', 'https://cdn.example/media.m3u8');
  assert.match(plan.outLines.join('\n'), /URI="init0.mp4"/);
  assert.doesNotMatch(plan.outLines.join('\n'), /part.ts|next.ts/);
});

test('relay capability renewal keeps identity but a different encode with identical durations does not', () => {
  const capability = (path, expiry) => `${relay}?token=${Buffer.from(JSON.stringify({ u: `https://cdn.example/anime/${path}`, e: expiry })).toString('base64url')}.signature`;
  const media = (path, expiry) => `#EXTM3U\n#EXTINF:6,\n${capability(path, expiry)}\n#EXT-X-ENDLIST`;
  assert.equal(hls.mediaPlaylistFingerprint(media('encode1/seg.ts', 1)), hls.mediaPlaylistFingerprint(media('encode1/seg.ts', 2)));
  assert.notEqual(hls.mediaPlaylistFingerprint(media('encode1/seg.ts', 1)), hls.mediaPlaylistFingerprint(media('encode2/seg.ts', 2)));
});
