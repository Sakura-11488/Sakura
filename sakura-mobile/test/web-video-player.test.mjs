import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../components/anime/WebVideoPlayer.web.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    listeners,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name) { for (const callback of [...(listeners.get(name) ?? [])]) callback(); },
  });
}

// Drive source changes and actual registered callbacks without a browser decoder.
// Browser playback/network verification remains separate from these lifecycle tests.
function harness(initialProps = {}, { hlsSupported = true } = {}) {
  const slots = [], effects = [], instances = [], timers = new Map();
  let cursor = 0, nextTimer = 0, ready = 0, errors = 0, plays = 0;
  const track = { kind: 'subtitles', mode: 'disabled' };
  const window = events();
  const document = events({ visibilityState: 'visible' });
  const video = events({
    duration: NaN, currentTime: 0, error: null, src: '', ended: false, textTracks: events([track]),
    play() { plays++; return Promise.resolve(); },
    load() { this.currentTime = 0; this.duration = NaN; this.error = null; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
  });
  class Hls {
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest', SUBTITLE_TRACKS_UPDATED: 'subtitles' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
    static isSupported() { return hlsSupported; }
    constructor(config) { this.config = config; this.handlers = new Map(); this.recoveries = 0; this.destroyed = false; instances.push(this); }
    on(name, callback) { this.handlers.set(name, callback); }
    emit(name, data) { this.handlers.get(name)?.(name, data); }
    loadSource(uri) { this.uri = uri; }
    attachMedia(media) { this.media = media; }
    destroy() { this.destroyed = true; }
    recoverMediaError() { this.recoveries++; this.media.error = null; }
  }
  const react = {
    __esModule: true,
    forwardRef(render) { return render; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useImperativeHandle(ref, create) { ref.current = create(); },
    useEffect(callback, deps) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, at) => value !== old.deps[at])) {
        effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
      }
    },
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports, window, document,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (id === 'react-native') return { View: 'View', StyleSheet: { create: styles => styles } };
      if (id === 'hls.js') return Hls;
      if (id === './PlayerChrome.web') return 'PlayerChrome';
      if (id === './player-preferences') return { readPlayerPreferences: () => ({ volume: 1, muted: false, speed: 1 }) };
      throw new Error(id);
    },
  });
  const props = { uri: 'https://media.example/episode-1.m3u8', startAt: 80, onReady: () => { ready++; }, onError: () => { errors++; }, ...initialProps };
  const ref = { current: null };
  return {
    instances, video, track, timers, ref, window, document,
    get ready() { return ready; }, get errors() { return errors; }, get plays() { return plays; },
    render(next = {}) {
      Object.assign(props, next); cursor = 0;
      const tree = exports.default(props, ref);
      const findVideo = node => {
        if (node?.type === 'video') return node;
        const children = node?.props?.children;
        return (Array.isArray(children) ? children : [children]).map(child => child && findVideo(child)).find(Boolean);
      };
      findVideo(tree).props.ref.current = video;
      effects.splice(0).forEach(effect => effect());
      return tree;
    },
    unmount() { slots.forEach(slot => slot.cleanup?.()); },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
  };
}

test('HLS resume and readiness wait for real metadata and run once per source', () => {
  const h = harness();
  const tree = h.render();
  assert.equal(tree.props.children.props.controls, true);
  assert.equal(tree.props.children.props.playsInline, true);
  h.instances[0].emit('manifest');
  assert.equal(h.ready, 0);
  assert.equal(h.video.currentTime, 0);
  h.video.duration = 300;
  h.video.emit('loadedmetadata');
  assert.equal(h.video.currentTime, 80);
  assert.equal(h.ready, 1);
  assert.equal(h.plays, 1);
  h.video.currentTime = 120;
  h.video.emit('loadedmetadata');
  assert.equal(h.video.currentTime, 120, 'reattachment must not rewind to the initial resume point');
  assert.equal(h.ready, 1);
  h.ref.current.seekTo(25);
  assert.equal(h.video.currentTime, 25);
  h.ref.current.seekTo(NaN);
  assert.equal(h.video.currentTime, 25);
});

test('browser-controlled headers are filtered while allowed headers remain stable', () => {
  const h = harness({ headers: { Referer: 'https://provider.example', ORIGIN: 'https://provider.example', 'User-Agent': 'native', Cookie: 'session=1', 'Sec-Fetch-Site': 'same-origin', Authorization: 'Bearer example', Accept: '*/*' } });
  h.render();
  const sent = [];
  h.instances[0].config.xhrSetup({ setRequestHeader: (key, value) => sent.push([key, value]) });
  assert.deepEqual(sent, [['accept', '*/*'], ['authorization', 'Bearer example']]);
  h.render({ headers: { authorization: 'Bearer example', accept: '*/*', Referer: 'https://other-provider.example' } });
  assert.equal(h.instances.length, 1, 'equivalent effective headers should keep the engine');
  h.render({ headers: { Authorization: 'Bearer changed' } });
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0].destroyed, true);
});

test('subtitle changes and newly discovered tracks do not recreate the engine', () => {
  const h = harness();
  h.render();
  const instance = h.instances[0];
  assert.equal(instance.subtitleDisplay, false);
  h.render({ subtitleMode: 'auto' });
  assert.equal(h.instances.length, 1);
  assert.equal(h.track.mode, 'showing');
  assert.equal(instance.subtitleDisplay, true);
  const lateTrack = { kind: 'captions', mode: 'disabled' };
  h.video.textTracks.push(lateTrack);
  h.video.textTracks.emit('addtrack');
  assert.equal(lateTrack.mode, 'disabled', 'do not layer a second language over the selected captions');
  assert.equal(h.track.mode, 'showing');
  h.render({ subtitleMode: 'off' });
  instance.emit('subtitles');
  assert.equal(h.track.mode, 'disabled');
  assert.equal(lateTrack.mode, 'disabled');
  assert.equal(instance.subtitleDisplay, false);
  assert.equal(h.instances.length, 1);
});

test('replacing or unmounting a source removes metadata listeners and ignores queued callbacks', () => {
  const h = harness();
  h.render();
  const oldMetadata = [...h.video.listeners.get('loadedmetadata')][0];
  const oldEngine = h.instances[0];
  h.render({ uri: 'https://media.example/episode-2.mp4', startAt: 40 });
  assert.equal(oldEngine.destroyed, true);
  assert.equal(h.video.listeners.get('loadedmetadata').size, 1);
  h.video.duration = 200;
  oldMetadata();
  oldEngine.emit('error', { fatal: true, type: 'networkError' });
  assert.equal(h.ready, 0);
  assert.equal(h.errors, 0);
  h.video.emit('loadedmetadata');
  assert.equal(h.ready, 1);
  assert.equal(h.video.currentTime, 40);
  const latestMetadata = [...h.video.listeners.get('loadedmetadata')][0];
  h.unmount();
  assert.equal(h.video.listeners.get('loadedmetadata').size, 0);
  assert.equal(h.video.textTracks.listeners.get('addtrack').size, 0);
  latestMetadata();
  assert.equal(h.ready, 1);
});

test('media recovery gets one attempt per source and terminal errors notify once', () => {
  const h = harness();
  h.render();
  const engine = h.instances[0];
  h.video.error = { code: 3 };
  h.video.emit('error');
  engine.emit('error', { fatal: true, type: 'mediaError' });
  h.flushTimers();
  assert.equal(engine.recoveries, 1);
  assert.equal(h.errors, 0, 'the DOM error must not also fail a recovery in progress');
  engine.emit('error', { fatal: true, type: 'mediaError' });
  engine.emit('error', { fatal: true, type: 'networkError' });
  h.video.emit('error');
  h.flushTimers();
  assert.equal(engine.recoveries, 1);
  assert.equal(h.errors, 1);
  h.render({ uri: 'https://media.example/episode-2.m3u8' });
  h.instances[1].emit('error', { fatal: true, type: 'mediaError' });
  assert.equal(h.instances[1].recoveries, 1, 'a new source gets its own attempt');
});

test('a standalone decoder error recovers once; pending error work is cancelled on unmount', () => {
  const h = harness();
  h.render();
  h.video.error = { code: 3 };
  h.video.emit('error');
  h.flushTimers();
  assert.equal(h.instances[0].recoveries, 1);
  assert.equal(h.errors, 0);
  h.video.error = { code: 3 };
  h.video.emit('error');
  h.unmount();
  assert.equal(h.timers.size, 0);
  assert.equal(h.errors, 0);
});

test('nonfatal HLS errors keep playing and a thrown recovery reports one failure', () => {
  const h = harness();
  h.render();
  const engine = h.instances[0];
  engine.emit('error', { fatal: false, type: 'mediaError' });
  assert.equal(engine.recoveries, 0);
  assert.equal(h.errors, 0);
  engine.recoverMediaError = () => { engine.recoveries++; throw new Error('Decoder cannot reattach'); };
  engine.emit('error', { fatal: true, type: 'mediaError' });
  engine.emit('error', { fatal: true, type: 'mediaError' });
  assert.equal(engine.recoveries, 1);
  assert.equal(h.errors, 1);
});

test('native playback clamps resume safely and reports one terminal error', () => {
  const h = harness({ startAt: 800 }, { hlsSupported: false });
  h.render();
  assert.equal(h.instances.length, 0);
  h.video.duration = 120;
  h.video.emit('loadedmetadata');
  assert.equal(h.video.currentTime, 119.9);
  h.video.emit('error');
  h.video.emit('error');
  assert.equal(h.errors, 1);
  h.unmount();
  assert.equal(h.video.listeners.get('loadedmetadata').size, 0);
});

test('legacy ratio resumes after metadata while exact fractional seconds take priority', () => {
  const ratio = harness({ startAt: 0, startProgress: 0.25 });
  ratio.render();
  ratio.instances[0].emit('manifest');
  assert.equal(ratio.video.currentTime, 0);
  ratio.video.duration = 1440;
  ratio.video.emit('loadedmetadata');
  assert.equal(ratio.video.currentTime, 360);
  ratio.video.currentTime = 420;
  ratio.video.emit('loadedmetadata');
  assert.equal(ratio.video.currentTime, 420, 'recovery never reapplies the ratio');

  const exact = harness({ startAt: 0.25, startProgress: 0.75 });
  exact.render(); exact.video.duration = 1440; exact.video.emit('loadedmetadata');
  assert.equal(exact.video.currentTime, 0.25, 'early exact bookmarks do not jump to a percentage');
  const zero = harness({ startAt: 0, startProgress: NaN });
  zero.render(); zero.video.duration = 1440; zero.video.emit('loadedmetadata');
  assert.equal(zero.video.currentTime, 0, 'restart remains at zero');
});

test('metadata with unknown duration retries once real duration arrives without seeking at manifest time', () => {
  const times = [];
  const h = harness({ startAt: 7.25, onTimeUpdate: (...args) => times.push(args) });
  h.render();
  h.video.duration = 1440;
  h.video.emit('durationchange');
  h.video.emit('timeupdate');
  assert.equal(h.ready, 0, 'duration alone is not decoded metadata');
  assert.equal(times.length, 0, 'pre-resume timeupdate cannot overwrite the bookmark with zero');
  h.video.duration = NaN;
  h.video.emit('loadedmetadata');
  assert.equal(h.ready, 0);
  assert.equal(h.video.currentTime, 0);
  h.video.duration = 1440;
  h.video.emit('durationchange');
  assert.equal(h.ready, 1);
  assert.equal(h.video.currentTime, 7.25);
  assert.deepEqual(times, [[7.25, 1440]]);
  h.video.currentTime = 30;
  h.video.emit('durationchange');
  assert.equal(h.video.currentTime, 30);
  h.unmount();
  assert.equal(h.video.listeners.get('durationchange').size, 0);
});

test('pause, seek, ended, pagehide and hidden checkpoints preserve exact zero and completion', () => {
  const checkpoints = [], times = [];
  const h = harness({ startAt: 0, onCheckpoint: (...args) => checkpoints.push(args), onTimeUpdate: (...args) => times.push(args) });
  h.render();
  h.video.emit('pause'); h.window.emit('pagehide');
  assert.equal(checkpoints.length, 0, 'unloaded sources cannot erase a saved bookmark');
  h.video.duration = 1440; h.video.emit('loadedmetadata');
  assert.deepEqual(times[0], [0, 1440], 'initial metadata exposes the measured clock');
  h.video.currentTime = 7.125; h.video.emit('pause');
  h.video.currentTime = 0; h.video.emit('seeked');
  h.video.currentTime = 12.5; h.window.emit('pagehide');
  h.document.emit('visibilitychange');
  assert.equal(checkpoints.length, 3, 'visible transitions do not checkpoint');
  h.document.visibilityState = 'hidden'; h.document.emit('visibilitychange');
  h.video.currentTime = 1440; h.video.ended = true; h.video.emit('ended');
  assert.deepEqual(checkpoints, [[7.125, 1440, false], [0, 1440, false], [12.5, 1440, false], [12.5, 1440, false], [1440, 1440, true]]);
  const stale = [...h.window.listeners.get('pagehide')][0];
  h.unmount();
  assert.equal(h.window.listeners.get('pagehide').size, 0);
  assert.equal(h.document.listeners.get('visibilitychange').size, 0);
  assert.equal(h.video.listeners.get('seeked').size, 0);
  stale();
  assert.equal(checkpoints.length, 5, 'queued old-source checkpoints are ignored after disposal');
});

test('checkpoint callback changes and custom chrome do not recreate the playback engine', () => {
  const old = [], latest = [];
  const h = harness({ onCheckpoint: (...args) => old.push(args) });
  h.render(); h.video.duration = 1440; h.video.emit('loadedmetadata');
  h.render({ onCheckpoint: (...args) => latest.push(args), chrome: { title: 'One Piece' } });
  assert.equal(h.instances.length, 1);
  h.video.currentTime = 25; h.video.emit('pause');
  assert.equal(old.length, 0);
  assert.deepEqual(latest, [[25, 1440, false]]);
});
