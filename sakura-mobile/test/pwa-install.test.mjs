import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/pwa-install.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function browser({ mode, standalone = false, legacyMedia = false, noMedia = false } = {}) {
  const events = new Map(), queries = new Map();
  const window = {
    navigator: { standalone },
    addEventListener(name, listener) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(listener);
    },
    matchMedia: noMedia ? undefined : name => {
      const changes = [];
      const query = { matches: name === `(display-mode: ${mode})`, changes };
      if (legacyMedia) query.addListener = listener => changes.push(listener);
      else query.addEventListener = (event, listener) => { assert.equal(event, 'change'); changes.push(listener); };
      queries.set(name, query);
      return query;
    },
  };
  return {
    window, events, queries,
    dispatch(name, event = {}) { for (const listener of events.get(name) || []) listener(event); },
    setMode(name, matches) {
      const query = queries.get(`(display-mode: ${name})`);
      query.matches = matches;
      for (const listener of query.changes) listener({ matches });
    },
  };
}
function load(mockBrowser) {
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, ...(mockBrowser ? { window: mockBrowser.window } : {}) });
  vm.runInContext(source, context);
  return { api: module.exports, context };
}
function promptEvent(prompt = () => Promise.resolve({ outcome: 'accepted' }), userChoice) {
  const event = { calls: 0, prevented: 0, preventDefault() { this.prevented++; }, prompt() { this.calls++; return prompt(); } };
  if (userChoice) event.userChoice = userChoice;
  return event;
}

test('SSR/native import is inert with stable snapshots; later browser initialization remains available', async () => {
  const { api, context } = load();
  const initial = api.getInstallState();
  assert.deepEqual(plain(initial), { canPrompt: false, installed: false, busy: false });
  assert.equal(api.getInstallState(), initial);
  assert.equal(api.getServerInstallState(), initial);
  assert.equal(Object.isFrozen(initial), true);
  api.initializeInstallPrompt();
  const unsubscribe = api.subscribeInstallState(() => assert.fail('No browser means no state changes'));
  assert.equal(await api.requestInstall(), 'unavailable');
  unsubscribe();
  const web = browser(); context.window = web.window;
  api.initializeInstallPrompt(); web.dispatch('beforeinstallprompt', promptEvent());
  assert.equal(api.getInstallState().canPrompt, true);
  assert.equal(api.getServerInstallState(), initial, 'SSR snapshot cannot inherit browser mutations');
});

test('initialization is idempotent and a dismissed banner cannot lose the captured prompt', async () => {
  const web = browser(), { api } = load(web);
  api.initializeInstallPrompt(); api.initializeInstallPrompt();
  assert.equal(web.events.get('beforeinstallprompt').length, 1);
  assert.equal(web.events.get('appinstalled').length, 1);
  assert.equal(web.queries.size, 3);
  let notifications = 0;
  const unsubscribe = api.subscribeInstallState(() => notifications++);
  const event = promptEvent(); web.dispatch('beforeinstallprompt', event);
  const ready = api.getInstallState();
  assert.equal(event.prevented, 1);
  assert.equal(notifications, 1);
  assert.equal(api.getInstallState(), ready, 'snapshot identity is stable until a real change');
  web.dispatch('focus'); assert.equal(api.getInstallState(), ready);
  unsubscribe();
  const settingsUnsubscribe = api.subscribeInstallState(() => {});
  const install = api.requestInstall();
  assert.equal(event.calls, 1, 'prompt must be invoked before requestInstall returns');
  assert.equal(await install, 'accepted');
  assert.equal(api.getInstallState().installed, false, 'accepted is not an installation confirmation');
  assert.equal(await api.requestInstall(), 'unavailable');
  settingsUnsubscribe();
});

test('a single-use event cannot overlap, be replaced while ready, or be replayed after dismissal', async () => {
  const web = browser(), { api } = load(web), choice = deferred();
  const first = promptEvent(() => choice.promise), duplicate = promptEvent();
  web.dispatch('beforeinstallprompt', first); web.dispatch('beforeinstallprompt', duplicate);
  assert.equal(duplicate.prevented, 1);
  const install = api.requestInstall();
  assert.deepEqual(plain(api.getInstallState()), { canPrompt: false, installed: false, busy: true });
  assert.equal(await api.requestInstall(), 'busy');
  const duringPrompt = promptEvent(); web.dispatch('beforeinstallprompt', duringPrompt);
  assert.equal(first.calls, 1); assert.equal(duplicate.calls, 0); assert.equal(duringPrompt.calls, 0);
  choice.resolve({ outcome: 'dismissed' }); assert.equal(await install, 'dismissed');
  web.dispatch('beforeinstallprompt', first);
  assert.equal(await api.requestInstall(), 'unavailable');
  assert.equal(first.calls, 1);
  const fresh = promptEvent(); web.dispatch('beforeinstallprompt', fresh);
  assert.equal(await api.requestInstall(), 'accepted'); assert.equal(fresh.calls, 1);
});

test('synchronous throws, rejected prompts and rejected legacy choices recover without a stuck busy state', async () => {
  const web = browser(), { api } = load(web);
  for (const fail of [() => { throw new Error('No activation'); }, () => Promise.reject(new Error('Unavailable'))]) {
    const event = promptEvent(fail); web.dispatch('beforeinstallprompt', event);
    assert.equal(await api.requestInstall(), 'unavailable');
    assert.deepEqual(plain(api.getInstallState()), { canPrompt: false, installed: false, busy: false });
  }
  const choice = deferred();
  web.dispatch('beforeinstallprompt', promptEvent(() => Promise.resolve(), choice.promise));
  const install = api.requestInstall(); choice.reject(new Error('Choice unavailable'));
  assert.equal(await install, 'unavailable'); assert.equal(api.getInstallState().busy, false);
  web.dispatch('beforeinstallprompt', promptEvent());
  assert.equal(await api.requestInstall(), 'accepted');
});

test('legacy prompt completion waits for userChoice and subscriber failures do not consume user activation', async () => {
  const web = browser(), { api } = load(web), choice = deferred();
  let notifications = 0;
  api.subscribeInstallState(() => { throw new Error('Broken banner'); });
  api.subscribeInstallState(() => notifications++);
  const event = promptEvent(() => Promise.resolve(), choice.promise);
  web.dispatch('beforeinstallprompt', event);
  const install = api.requestInstall();
  assert.equal(event.calls, 1);
  await Promise.resolve(); assert.equal(api.getInstallState().busy, true);
  choice.resolve({ outcome: 'dismissed' });
  assert.equal(await install, 'dismissed'); assert.equal(notifications, 3);
});

test('appinstalled clears pending choices immediately and a late failure cannot undo installation', async () => {
  const web = browser(), { api } = load(web), gate = deferred();
  web.dispatch('beforeinstallprompt', promptEvent(() => gate.promise));
  const install = api.requestInstall(); web.dispatch('appinstalled');
  const installed = api.getInstallState();
  assert.deepEqual(plain(installed), { canPrompt: false, installed: true, busy: false });
  const obsolete = promptEvent(); web.dispatch('beforeinstallprompt', obsolete);
  assert.equal(await api.requestInstall(), 'installed'); assert.equal(obsolete.calls, 0);
  gate.reject(new Error('Late cancellation')); assert.equal(await install, 'installed');
  web.dispatch('focus'); assert.equal(api.getInstallState(), installed);
});

test('standalone, fullscreen, minimal-ui and iOS standalone suppress install UI on initial load', async () => {
  for (const options of [{ mode: 'standalone' }, { mode: 'fullscreen' }, { mode: 'minimal-ui' }, { standalone: true, noMedia: true }]) {
    const web = browser(options), { api } = load(web), event = promptEvent();
    assert.equal(api.getInstallState().installed, true);
    web.dispatch('beforeinstallprompt', event);
    assert.equal(await api.requestInstall(), 'installed'); assert.equal(event.calls, 0);
  }
});

test('display mode changes clear the retained event and stale choices cannot finish a newer request', async () => {
  const web = browser({ legacyMedia: true }), { api } = load(web), firstChoice = deferred(), nextChoice = deferred();
  web.dispatch('beforeinstallprompt', promptEvent(() => firstChoice.promise));
  const first = api.requestInstall();
  web.setMode('standalone', true);
  assert.equal(api.getInstallState().installed, true); assert.equal(api.getInstallState().busy, false);
  web.setMode('standalone', false);
  assert.deepEqual(plain(api.getInstallState()), { canPrompt: false, installed: false, busy: false });
  assert.equal(await api.requestInstall(), 'unavailable');
  web.dispatch('beforeinstallprompt', promptEvent(() => nextChoice.promise));
  const next = api.requestInstall();
  firstChoice.resolve({ outcome: 'accepted' }); assert.equal(await first, 'unavailable');
  assert.equal(api.getInstallState().busy, true, 'an obsolete choice must not unlock the active prompt');
  nextChoice.resolve({ outcome: 'dismissed' }); assert.equal(await next, 'dismissed');
  assert.equal(api.getInstallState().busy, false);
});

test('iOS standalone is refreshed on focus, pageshow and direct install requests without media queries', async () => {
  const web = browser({ noMedia: true }), { api } = load(web);
  web.dispatch('beforeinstallprompt', promptEvent());
  web.window.navigator.standalone = true; web.dispatch('focus');
  assert.equal(api.getInstallState().installed, true);
  web.window.navigator.standalone = false; web.dispatch('pageshow');
  assert.equal(api.getInstallState().installed, false);
  assert.equal(api.getInstallState().canPrompt, false);
  web.window.navigator.standalone = true;
  assert.equal(await api.requestInstall(), 'installed');
});
