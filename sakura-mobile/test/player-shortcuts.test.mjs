import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const plain = (value) => JSON.parse(JSON.stringify(value));
function load(path, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, ...globals });
  return exports;
}
const controls = load('../components/anime/player-shortcuts.ts');

test('keyboard map covers the standard video shortcuts', () => {
  const key = (k, extra = {}) => plain(controls.shortcutFor({ key: k, ...extra }, 'other'));
  assert.deepEqual(key(' '), { type: 'toggle-play' });
  assert.deepEqual(key('k'), { type: 'toggle-play' });
  assert.deepEqual(key('K'), { type: 'toggle-play' });
  assert.deepEqual(key('j'), { type: 'seek-by', seconds: -10 });
  assert.deepEqual(key('l'), { type: 'seek-by', seconds: 10 });
  assert.deepEqual(key('ArrowLeft'), { type: 'seek-by', seconds: -5 });
  assert.deepEqual(key('ArrowRight'), { type: 'seek-by', seconds: 5 });
  assert.deepEqual(key('ArrowUp'), { type: 'volume', delta: 0.05 });
  assert.deepEqual(key('f'), { type: 'fullscreen' });
  assert.deepEqual(key('m'), { type: 'mute' });
  assert.deepEqual(key('n'), { type: 'next' });
  assert.deepEqual(key('N', { shiftKey: true }), { type: 'next' });
  assert.deepEqual(key('c'), { type: 'captions' });
  assert.deepEqual(key('i'), { type: 'pip' });
  assert.deepEqual(key('>', { shiftKey: true }), { type: 'speed', step: 1 });
  assert.deepEqual(key('.', { shiftKey: true }), { type: 'speed', step: 1 });
  assert.deepEqual(key('<', { shiftKey: true }), { type: 'speed', step: -1 });
  assert.deepEqual(key('7'), { type: 'seek-fraction', fraction: 0.7 });
  assert.deepEqual(key('?', { shiftKey: true }), { type: 'help' });
  assert.equal(key('x'), null);
});

test('focused controls keep the keys they handle themselves, and typing is never hijacked', () => {
  assert.equal(controls.shortcutFor({ key: ' ' }, 'button'), null, 'Space presses the focused button');
  assert.deepEqual(plain(controls.shortcutFor({ key: 'j' }, 'button')), { type: 'seek-by', seconds: -10 }, 'letters still work after clicking a control');
  assert.equal(controls.shortcutFor({ key: 'ArrowLeft' }, 'range'), null, 'arrows move a focused slider');
  assert.deepEqual(plain(controls.shortcutFor({ key: 'k' }, 'range')), { type: 'toggle-play' });
  for (const key of ['k', ' ', 'f', 'ArrowLeft', '5']) {
    assert.equal(controls.shortcutFor({ key }, 'text'), null);
    assert.equal(controls.shortcutFor({ key }, 'dialog'), null);
  }
});

test('speed steps along the saved ladder and clamps at both ends', () => {
  assert.equal(controls.nextPlayerSpeed(1, 1), 1.25);
  assert.equal(controls.nextPlayerSpeed(1, -1), 0.75);
  assert.equal(controls.nextPlayerSpeed(2, 1), 2);
  assert.equal(controls.nextPlayerSpeed(0.75, -1), 0.75);
  assert.equal(controls.nextPlayerSpeed(1.1, 1), 1.25, 'an off-ladder rate snaps upward');
  assert.equal(controls.nextPlayerSpeed(1.1, -1), 1);
});

test('double tap seeks only on the same side within the window, adding 10 s per extra tap', () => {
  assert.equal(controls.tapSide(10, 300), -1);
  assert.equal(controls.tapSide(150, 300), 0);
  assert.equal(controls.tapSide(290, 300), 1);
  assert.equal(controls.tapSide(5, 0), 0);
  let step = controls.registerTap(null, 0, 1);
  assert.equal(step.seekBy, 0);
  step = controls.registerTap(step.state, 200, 1);
  assert.deepEqual([step.seekBy, step.total], [10, 10]);
  step = controls.registerTap(step.state, 400, 1);
  assert.deepEqual([step.seekBy, step.total], [10, 20]);
  assert.equal(controls.registerTap(step.state, 1000, 1).seekBy, 0, 'too slow is a new first tap');
  assert.equal(controls.registerTap(step.state, 500, -1).seekBy, 0, 'the other side starts over');
  const center = controls.registerTap(controls.registerTap(null, 0, 0).state, 100, 0);
  assert.equal(center.seekBy, 0, 'the middle third never seeks');
});

test('auto-skip fires once inside a valid marker while playing; markers map to timeline spans', () => {
  const intro = { start: 30, end: 120 };
  assert.equal(controls.autoSkipTarget(31, 1440, intro, false, true), 120);
  assert.equal(controls.autoSkipTarget(31, 1440, intro, true, true), null, 'handled markers stay put (Undo)');
  assert.equal(controls.autoSkipTarget(31, 1440, intro, false, false), null, 'never while paused');
  assert.equal(controls.autoSkipTarget(119.5, 1440, intro, false, true), null, 'pointless in the last second');
  assert.equal(controls.autoSkipTarget(10, 1440, intro, false, true), null);
  assert.equal(controls.autoSkipTarget(31, 100, intro, false, true), null, 'a marker past the end belongs to another cut');
  assert.equal(controls.autoSkipTarget(31, 1440, { start: 50, end: 40 }, false, true), null);
  assert.deepEqual(plain(controls.markerSpan(intro, 1440)), { left: 30 / 1440 * 100, width: 90 / 1440 * 100 });
  assert.equal(controls.markerSpan(intro, 0), null);
  assert.ok(controls.markerSpan({ start: 1439, end: 1440 }, 1440).width >= 0.069);
});

test('auto-skip preference defaults off and persists alongside other viewing choices', () => {
  let data = JSON.stringify({ speed: 1.5 });
  const prefs = load('../components/anime/player-preferences.ts', { localStorage: { getItem: () => data, setItem: (_key, value) => { data = value; } } });
  assert.equal(prefs.readPlayerPreferences().autoSkip, false);
  prefs.savePlayerPreferences({ autoSkip: true });
  assert.equal(prefs.readPlayerPreferences().autoSkip, true);
  assert.equal(prefs.readPlayerPreferences().speed, 1.5);
  data = JSON.stringify({ autoSkip: 'yes' });
  assert.equal(prefs.readPlayerPreferences().autoSkip, false, 'only an explicit true enables it');
});
