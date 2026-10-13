import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const compile = name => ts.transpileModule(readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const source = compile('anime-device-save.web.ts');
const downloads = compile('web-download.ts');
const base = { animeId: '21', episodeId: 'ep1', episodeNumber: 1, title: '呪術 / Test', category: 'sub', quality: '720p', status: 'ready' };

function setup(options = {}) {
  const rows = new Map([['ep1', { ...base }], ['ep2', { ...base, episodeId: 'ep2', episodeNumber: 2 }]]);
  const events = { clicks: [], writes: [], shares: [], urls: new Map(), revoked: [], timers: [], calls: 0 };
  let storeListener;
  const context = {
    Blob, File, Error, DOMException, AbortController, TextEncoder, Uint8Array,
    location: { origin: 'https://sakura.test' },
    setTimeout(fn) { events.timers.push(fn); },
    URL: class extends URL {
      static createObjectURL(blob) { const url = `blob:video-${events.urls.size}`; events.urls.set(url, blob); return url; }
      static revokeObjectURL(url) { events.revoked.push(url); }
    },
    navigator: { canShare: () => true, share: async value => { events.shares.push(value); } },
    document: {
      body: { appendChild() {} },
      createElement() { return { style: {}, click() { events.clicks.push({ href: this.href, filename: this.download }); }, remove() {} }; },
    },
  };
  const load = code => {
    const module = { exports: {} };
    vm.runInNewContext(code, { ...context, require: resolve, exports: module.exports, module });
    return module.exports;
  };
  const resolve = name => {
    if (name === '@/lib/anime-offline') return {
      async downloadAnimeEpisode() { await options.download?.(rows); },
      async getOfflineEpisode(_animeId, episodeId) { return rows.get(episodeId); },
      subscribeOfflineEpisodes(fn) { storeListener = fn; return () => {}; },
    };
    if (name === '@/lib/offline-cache-keys') return {
      async openOfflineLibrary() { return { async match() { return new Response('WEBVTT\n'); } }; },
      offlineEpisodeUrl: (a, e) => `/app/__offline/anime/${a}/${e}`,
    };
    if (name === '@/lib/web-download') return load(downloads);
    if (name === './anime-video-export.web') return {
      async writeAnimeVideo(cache, episode, write, settings) {
        events.calls++;
        if (options.convert) return options.convert({ cache, episode, write, settings, events });
        await write(new Uint8Array([1, 2]));
        settings.onProgress(0.5);
        await write(new Uint8Array([3, 4]));
        return { mimeType: 'video/mp4', extension: 'mp4', bytes: 4 };
      },
    };
    throw new Error(name);
  };
  return { api: load(source), rows, events, context, changed: () => storeListener?.() };
}

async function until(check) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Timed out');
}

test('a completed episode produces an actual video download and keeps its offline row', async () => {
  const { api, events, rows } = setup();
  await api.downloadAnimeEpisodeWithDeviceCopy(base);
  await until(() => api.getAnimeDeviceSaveSnapshot()?.downloadStarted);
  assert.equal(events.clicks.length, 1);
  assert.equal(events.clicks[0].filename, '呪術 Test - Episode 1 - Sub - 720p.mp4');
  const file = events.urls.get(events.clicks[0].href);
  assert.equal(file.type, 'video/mp4');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(rows.get('ep1').status, 'ready');
  assert.equal(api.getAnimeDeviceSaveSnapshot().status, 'ready');
});

test('paused or canceled downloads never export partial media', async () => {
  for (const state of ['paused', 'removed']) {
    const { api, events } = setup({ download: rows => state === 'removed' ? rows.delete('ep1') : rows.get('ep1').status = state });
    await api.downloadAnimeEpisodeWithDeviceCopy(base);
    assert.equal(api.getAnimeDeviceSaveSnapshot(), null);
    assert.equal(events.calls, 0);
    assert.equal(events.clicks.length, 0);
  }
});

test('existing offline episodes export once; another episode waits without holding a second video', async () => {
  const { api, events } = setup();
  api.requestAnimeVideoSave('21', 'ep1');
  api.requestAnimeVideoSave('21', 'ep1');
  api.requestAnimeVideoSave('21', 'ep2');
  await until(() => api.getAnimeDeviceSaveSnapshot()?.status === 'ready');
  assert.equal(events.calls, 1);
  assert.equal(api.getAnimeDeviceSaveSnapshot().queued, 1);
  api.dismissAnimeDeviceSave();
  await until(() => api.getAnimeDeviceSaveSnapshot()?.status === 'ready');
  assert.equal(events.calls, 2);
  assert.match(events.clicks[1].filename, /Episode 2/);
  assert.equal(events.revoked.length, 0, 'URLs stay valid while the browser starts reading');
  events.timers.forEach(fn => fn());
  assert.equal(events.revoked.length, 1);
});

test('share hands the prepared File to the OS in the same click, without another asynchronous read', async () => {
  const { api, context, events } = setup();
  api.requestAnimeVideoSave('21', 'ep1');
  await until(() => api.getAnimeDeviceSaveSnapshot()?.status === 'ready');
  let activation = true;
  context.navigator.share = data => { assert.equal(activation, true); events.shares.push(data); return Promise.resolve(); };
  const sharing = api.shareAnimeDeviceVideo();
  activation = false;
  await sharing;
  assert.equal(events.shares[0].files[0], events.urls.get(events.clicks[0].href));
  assert.equal(events.calls, 1);
  context.navigator.share = () => Promise.reject(new DOMException('Canceled', 'AbortError'));
  await api.shareAnimeDeviceVideo();
  assert.equal(api.getAnimeDeviceSaveSnapshot().error, undefined);
});

test('canceling preparation or deleting the cached episode cannot start a late device download', async () => {
  for (const action of ['cancel', 'delete']) {
    let finish;
    const wait = new Promise(resolve => { finish = resolve; });
    const { api, events, rows, changed } = setup({ convert: async ({ write }) => {
      await wait;
      await write(new Uint8Array([1]));
      return { mimeType: 'video/mp4', extension: 'mp4', bytes: 1 };
    } });
    api.requestAnimeVideoSave('21', 'ep1');
    await until(() => events.calls === 1);
    if (action === 'cancel') api.dismissAnimeDeviceSave();
    else { rows.delete('ep1'); changed(); await until(() => api.getAnimeDeviceSaveSnapshot()?.status === 'error'); }
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.clicks.length, 0);
    if (action === 'cancel') assert.equal(rows.get('ep1').status, 'ready');
  }
});

test('conversion or size validation failure leaves the offline copy intact and offers a retry', async () => {
  let fail = true;
  const { api, events, rows } = setup({ convert: async ({ write }) => {
    await write(new Uint8Array([1, 2]));
    return { mimeType: 'video/mp4', extension: 'mp4', bytes: fail ? 9 : 2 };
  } });
  api.requestAnimeVideoSave('21', 'ep1');
  await until(() => api.getAnimeDeviceSaveSnapshot()?.status === 'error');
  assert.match(api.getAnimeDeviceSaveSnapshot().error, /incomplete/);
  assert.equal(events.clicks.length, 0);
  assert.equal(rows.get('ep1').status, 'ready');
  fail = false;
  api.retryAnimeDeviceSave();
  await until(() => api.getAnimeDeviceSaveSnapshot()?.status === 'ready');
  assert.equal(events.clicks.length, 1);
});
