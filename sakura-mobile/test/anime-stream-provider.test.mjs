import assert from 'node:assert/strict';
import { createCipheriv, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../supabase/functions/anime-stream/provider.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const ORIGIN = 'https://megaplay.buzz';
const INPUT = { malId: '21', episode: 1, category: 'sub' };
const EMBED = `${ORIGIN}/stream/mal/21/1/sub`;
const JSON_URL = `${ORIGIN}/stream/getSourcesNew?id=36396`;
const OLD_JSON_URL = `${ORIGIN}/stream/getSources?id=36396`;
const SCRIPT = `${ORIGIN}/lib/app.main.js?v=fixture&test=1`;
const MASTER = 'https://fetch.nexabloom.top/anime/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/master.m3u8';
const CAPTION = 'https://6a8y6.broforgotsave.online/anime/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/subtitles/eng-2.vtt';
const HTML = '<div data-id="36396"></div><script src="/lib/app.main.js?v=fixture&amp;test=1"></script>';
const KEY = 'fixture-"key';
const IV = "fixture-IV'123456";

function padded(value, size) {
  const bytes = Buffer.alloc(size);
  Buffer.from(value).copy(bytes, 0, 0, size);
  return bytes;
}

function encrypted(value, key = KEY, iv = IV) {
  const cipher = createCipheriv('aes-256-cbc', padded(key, 32), padded(iv, 16));
  return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64url');
}

function script(key = KEY, iv = IV) {
  return `const DOMAINS_ENC_KEY=${JSON.stringify(key)},DOMAINS_ENC_IV=${JSON.stringify(iv)};`;
}

function loadProvider() {
  const exports = {};
  vm.runInNewContext(source, {
    exports, URL, TextEncoder, TextDecoder, AbortSignal, atob, crypto: webcrypto,
    fetch: () => { throw new Error('An unmocked network request escaped the test.'); },
  });
  return exports;
}

function fixture(overrides = {}, provider = loadProvider()) {
  const requests = [];
  const routes = new Map([
    [EMBED, () => new Response(HTML)],
    [JSON_URL, () => Response.json({ sources: { file: MASTER } })],
    [SCRIPT, () => new Response(script())],
    ...Object.entries(overrides),
  ]);
  const fetch = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.redirect, 'manual', 'provider redirects must be checked before following');
    assert.ok(init.signal instanceof AbortSignal, 'every request includes a timeout/abort signal');
    const response = routes.get(url);
    assert.ok(response, `Unexpected request: ${url}`);
    return response(url, init);
  };
  return { ...provider, fetch, requests, routes, resolve: (input = INPUT, options = {}) => provider.resolveEpisode(input, { fetch, ...options }) };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('plaintext sources preserve metadata and only fetch provider HTML and JSON', async () => {
  const f = fixture({
    [JSON_URL]: () => Response.json({
      data: { sources: [{ file: MASTER }], intro: { start: 0, end: 90 }, outro: { start: -1, end: 20 } },
      tracks: [
        { kind: 'captions', file: CAPTION, label: 'English' },
        { kind: 'subtitles', url: CAPTION, label: '日本語', srclang: 'ja' },
        { kind: 'thumbnails', file: CAPTION, label: 'Preview' },
        { kind: 'captions', file: 'http://insecure.test/track.vtt' },
        null,
      ],
    }),
  });
  const result = await f.resolve();
  assert.equal(result.url, MASTER);
  assert.equal(result.isM3U8, true);
  assert.equal(result.embedUrl, EMBED);
  assert.equal(result.category, 'sub');
  assert.deepEqual(plain(result.intro), { start: 0, end: 90 });
  assert.equal(result.outro, undefined);
  assert.deepEqual(plain(result.subtitles), [
    { url: CAPTION, lang: 'en', label: 'English' },
    { url: CAPTION, lang: 'ja', label: '日本語' },
  ]);
  assert.deepEqual(f.requests.map((r) => r.url), [EMBED, JSON_URL]);
  assert.equal(f.requests[0].init.headers.Referer, 'https://hianime.dk/');
  assert.equal(f.requests[1].init.headers.Referer, EMBED);
});

test('real AES-CBC fixture decrypts using parsed JSON literals without executing the public script', async () => {
  const f = fixture({
    [JSON_URL]: () => Response.json({ enc: encrypted({ file: MASTER }), intro: { start: 10, end: 20 } }),
    [SCRIPT]: () => new Response(`${script()}\nthrow new Error('Public script must never execute');`),
  });
  const result = await f.resolve();
  assert.equal(result.url, MASTER);
  assert.deepEqual(plain(result.intro), { start: 10, end: 20 });
  assert.deepEqual(f.requests.map((r) => r.url), [EMBED, JSON_URL, SCRIPT]);
});

test('encoding cache honors expiry, forced refresh, and fetcher isolation', async () => {
  const provider = loadProvider();
  let key = KEY;
  const f = fixture({
    [JSON_URL]: () => Response.json({ enc: encrypted({ file: MASTER }, key) }),
    [SCRIPT]: () => new Response(script(key)),
  }, provider);
  const countScripts = () => f.requests.filter((r) => r.url === SCRIPT).length;
  await f.resolve(INPUT, { now: () => 1_000 });
  await f.resolve(INPUT, { now: () => 2_000 });
  assert.equal(countScripts(), 1);
  key = 'rotated-fixture-key';
  await f.resolve({ ...INPUT, force: true }, { now: () => 3_000 });
  assert.equal(countScripts(), 2);
  await f.resolve(INPUT, { now: () => 603_000 });
  assert.equal(countScripts(), 3, 'encoding expires after ten minutes');
  const isolated = fixture({ [JSON_URL]: () => Response.json({ enc: encrypted({ file: MASTER }) }) }, provider);
  await isolated.resolve(INPUT, { now: () => 4_000 });
  assert.ok(isolated.requests.some((r) => r.url === SCRIPT), 'another fetcher cannot reuse this encoding cache');
});

test('source endpoint fallback and same-origin player iframe resolve successfully', async () => {
  const child = `${ORIGIN}/stream/s-2/36396/sub`;
  const f = fixture({
    [EMBED]: () => new Response('<iframe src="/stream/s-2/36396/sub"></iframe>'),
    [child]: () => new Response(HTML),
    [JSON_URL]: () => new Response('Unavailable', { status: 503 }),
    [OLD_JSON_URL]: () => Response.json({ result: { sources: [{ file: MASTER }] } }),
  });
  assert.equal((await f.resolve()).url, MASTER);
  assert.deepEqual(f.requests.map((r) => r.url), [EMBED, child, JSON_URL, OLD_JSON_URL]);
  assert.equal(f.requests[2].init.headers.Referer, child);
});

test('same-origin redirects are followed and redirect loops are bounded', async () => {
  const child = `${ORIGIN}/stream/s-2/36396/sub`;
  const f = fixture({
    [EMBED]: () => new Response(null, { status: 302, headers: { Location: child } }),
    [child]: () => new Response(HTML),
  });
  assert.equal((await f.resolve()).url, MASTER);
  const loop = fixture({ [EMBED]: () => new Response(null, { status: 302, headers: { Location: EMBED } }) });
  await assert.rejects(loop.resolve(), /Too many provider redirects/);
  assert.equal(loop.requests.length, 4);
});

for (const target of [
  'https://attacker.test/stream/s-2/36396/sub',
  'https://megaplay.buzz.attacker.test/stream/s-2/36396/sub',
  'https://name:secret@megaplay.buzz/stream/s-2/36396/sub',
  'http://megaplay.buzz/stream/s-2/36396/sub',
  'https://megaplay.buzz:8443/stream/s-2/36396/sub',
  'https://megaplay.buzz/stream/s-2/36396/sub#fragment',
]) {
  test(`untrusted iframe and redirect are never fetched: ${target}`, async () => {
    const frame = fixture({ [EMBED]: () => new Response(`<iframe src="${target}"></iframe>`) });
    await assert.rejects(frame.resolve(), /Unsupported provider URL/);
    assert.deepEqual(frame.requests.map((r) => r.url), [EMBED]);
    const redirect = fixture({ [EMBED]: () => new Response(null, { status: 302, headers: { Location: target } }) });
    await assert.rejects(redirect.resolve(), /Unsupported provider URL/);
    assert.deepEqual(redirect.requests.map((r) => r.url), [EMBED]);
  });
}

test('external script URLs never reach fetch even when their path matches app.main.js', async () => {
  const f = fixture({
    [EMBED]: () => new Response('<div data-id="36396"></div><script src="https://attacker.test/lib/app.main.js"></script>'),
    [JSON_URL]: () => Response.json({ enc: encrypted({ file: MASTER }) }),
  });
  await assert.rejects(f.resolve(), /Unsupported provider URL/);
  assert.deepEqual(f.requests.map((r) => r.url), [EMBED, JSON_URL]);
});

test('removed episodes and HTTP failure stop without looking up a source', async () => {
  for (const response of [() => new Response('<h1>Removed</h1>'), () => new Response('Gone', { status: 410 })]) {
    const f = fixture({ [EMBED]: response });
    await assert.rejects(f.resolve(), /unavailable|HTTP 410/);
    assert.deepEqual(f.requests.map((r) => r.url), [EMBED]);
  }
});

test('encoding format changes and malformed ciphertext fail without evaluating provider code', async () => {
  for (const text of [
    "const DOMAINS_ENC_KEY='single-quoted',DOMAINS_ENC_IV='changed-format';",
    'const DOMAINS_ENC_KEY="",DOMAINS_ENC_IV="iv";',
    'globalThis.DO_NOT_RUN = true;',
  ]) {
    const f = fixture({ [JSON_URL]: () => Response.json({ enc: encrypted({ file: MASTER }) }), [SCRIPT]: () => new Response(text) });
    await assert.rejects(f.resolve(), /encoding|Invalid provider/);
  }
  for (const enc of ['not valid base64!', 'a', 'AAAA']) {
    const f = fixture({ [JSON_URL]: () => Response.json({ enc }) });
    await assert.rejects(f.resolve());
    assert.ok(f.requests.every((r) => r.url.startsWith(ORIGIN + '/')));
  }
});

test('decrypted primitives and non-HLS sources are rejected', async () => {
  for (const value of [null, ['not-an-object'], { file: MASTER.replace('.m3u8', '.html') }]) {
    const f = fixture({ [JSON_URL]: () => Response.json({ enc: encrypted(value) }) });
    await assert.rejects(f.resolve(), /Invalid provider source|no supported HLS/);
  }
});

test('text limits count streamed bytes, cancel oversized bodies, and apply to scripts and JSON too', async () => {
  let canceled = 0;
  const oversized = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('界'.repeat(180_000))); },
    cancel() { canceled++; },
  }));
  const page = fixture({ [EMBED]: oversized });
  await assert.rejects(page.resolve(), /too large/);
  assert.equal(canceled, 1);
  const js = fixture({ [JSON_URL]: () => Response.json({ enc: encrypted({ file: MASTER }) }), [SCRIPT]: oversized });
  await assert.rejects(js.resolve(), /too large/);
  assert.equal(canceled, 2);
  const json = fixture({ [JSON_URL]: oversized, [OLD_JSON_URL]: oversized });
  await assert.rejects(json.resolve(), /could not be resolved/);
  assert.equal(canceled, 4);
});

test('invalid episode inputs cause no network requests', async () => {
  const f = fixture();
  for (const input of [
    { ...INPUT, malId: '0' }, { ...INPUT, malId: '123456789' }, { ...INPUT, malId: '../21' },
    { ...INPUT, episode: 0 }, { ...INPUT, episode: 1.5 }, { ...INPUT, episode: 100_001 },
    { ...INPUT, episode: NaN }, { ...INPUT, category: 'raw' },
  ]) await assert.rejects(f.resolve(input), /Invalid episode/);
  assert.equal(f.requests.length, 0);
});

test('caller cancellation is propagated instead of retrying the legacy endpoint', async () => {
  const controller = new AbortController();
  const f = fixture({ [JSON_URL]: (_url, init) => {
    controller.abort(new Error('Viewer changed episodes'));
    init.signal.throwIfAborted();
  } });
  await assert.rejects(f.resolve(INPUT, { signal: controller.signal }), /Viewer changed episodes/);
  assert.deepEqual(f.requests.map((r) => r.url), [EMBED, JSON_URL]);
});

test('caption and marker output is bounded and invalid ranges are omitted', async () => {
  const f = fixture({ [JSON_URL]: () => Response.json({
    sources: { file: MASTER }, intro: { start: 30, end: 30 }, outro: { start: 50, end: 40 },
    data: { tracks: Array.from({ length: 80 }, () => ({ kind: 'captions', file: CAPTION, label: 'L'.repeat(100), srclang: 'z'.repeat(30) })) },
  }) });
  const result = await f.resolve();
  assert.equal(result.intro, undefined);
  assert.equal(result.outro, undefined);
  assert.equal(result.subtitles.length, 40);
  assert.ok(result.subtitles.every((track) => track.label.length === 80 && track.lang.length === 20));
});
