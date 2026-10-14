// What the wallet's balance refresh costs in RPC calls. On web every call is
// a request to the wallet-rpc edge function, which allows 3600 an hour per
// client IP. Runs the real context.tsx -> connection.ts -> balances.ts ->
// read-only-rpc.ts chain and @solana/web3.js against a scripted JSON-RPC
// server: no network, no wallet, no keys.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = webRequire('typescript');
const web3 = webRequire('@solana/web3.js');
const splToken = webRequire('@solana/spl-token');

const WALLET_RPC_URL = 'https://project.supabase.test/functions/v1/wallet-rpc';
const OWNER = new web3.PublicKey(new Uint8Array(32).fill(7));
const INTERVAL_MS = 20_000;
const HOUR_MS = 3_600_000;

// The web cases use react-native-web's own AppState and Platform, the modules
// the web bundle gets for 'react-native', on a document whose visibility the
// tests flip and announce the way a browser does when a tab is hidden or
// shown. AppState binds to the document the first time it is used, so every
// web case shares this one.
const tab = Object.assign(new EventTarget(), { visibilityState: 'visible', createElement() {} });
globalThis.window = { document: tab };
globalThis.document = tab;
const reactNativeWeb = {
  AppState: webRequire('react-native-web/dist/cjs/exports/AppState'),
  Platform: webRequire('react-native-web/dist/cjs/exports/Platform'),
};
assert.ok(reactNativeWeb.AppState.isAvailable, 'react-native-web AppState is reading the test document');

function loadTs(relativeUrl, imports, globals = {}) {
  const url = new URL(relativeUrl, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.React,
    },
    fileName: url.pathname,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports, Response, Request, Headers, URL, TextEncoder,
    AbortController, AbortSignal, setTimeout, clearTimeout, console, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
  }, { filename: url.pathname });
  return module.exports;
}

// --- the JSON-RPC server behind wallet-rpc ---------------------------------

const ok = (value) => ({ result: { context: { slot: 1 }, value } });
// Recorded from wallet-rpc on 2026-10-14 for an ATA that does not exist:
// HTTP 200 with this body, which web3.js turns into a SolanaJSONRPCError.
const NOT_FOUND = { error: { code: -32602, message: 'Invalid param: could not find account' } };

/** A wallet that has SOL and has never held SAKURA: the common case on web. */
function walletWithoutSakura(method) {
  switch (method) {
    case 'getBalance': return ok(2_500_000_000);
    case 'getTokenAccountBalance': return NOT_FOUND;
    case 'getAccountInfo': return ok(null);
    case 'getTokenAccountsByOwner': return ok([]);
    default: throw new Error(`Unexpected RPC method: ${method}`);
  }
}

function parsedTokenAccount(config, mint, amount) {
  return {
    pubkey: new web3.PublicKey(new Uint8Array(32).fill(amount.length)).toBase58(),
    account: {
      executable: false,
      owner: config.SAKURA_TOKEN_PROGRAM_ID.toBase58(),
      lamports: 2_039_280,
      rentEpoch: 0,
      space: 170,
      data: {
        program: 'spl-token-2022',
        space: 170,
        parsed: { type: 'account', info: { mint, owner: OWNER.toBase58(), tokenAmount: { amount, decimals: 6 } } },
      },
    },
  };
}

const countBy = (calls) => calls.reduce((acc, method) => ({ ...acc, [method]: (acc[method] ?? 0) + 1 }), {});

/**
 * The real balance modules, configured for web (SOLANA_RPC = wallet-rpc), with
 * every RPC request recorded. `rpc(method, nthCallOfThatMethod)` answers; it
 * may return a Response to answer at the HTTP level.
 */
function loadWalletChain(rpc) {
  const calls = [];
  let held = null;
  const fetch = async (url, init) => {
    assert.equal(String(url), WALLET_RPC_URL);
    const body = JSON.parse(init.body);
    calls.push(body.method);
    if (held) await held.promise;
    const answer = rpc(body.method, calls.filter((m) => m === body.method).length);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const addresses = loadTs('../lib/wallet/addresses.ts', {});
  const config = loadTs('../lib/wallet/config.ts', {
    '@solana/web3.js': web3, './addresses': addresses, './helius-key': loadTs('../lib/wallet/helius-key.web.ts', {}),
  },
    { process: { env: { EXPO_PUBLIC_SOLANA_RPC: WALLET_RPC_URL } } });
  const readOnlyRpc = loadTs('../lib/wallet/read-only-rpc.ts', {});
  const balances = loadTs('../lib/wallet/balances.ts', {
    './read-only-rpc': readOnlyRpc, '@solana/web3.js': web3, '@solana/spl-token': splToken, './config': config,
  }, { fetch });
  const connection = loadTs('../lib/wallet/connection.ts', {
    '@solana/web3.js': web3, '@solana/spl-token': splToken, './config': config, './balances': balances,
    './confirm': { confirmTransactionByPolling() { throw new Error('No transactions in this test.'); } },
  }, { __DEV__: false });
  return {
    calls, config, connection,
    /** Leave every RPC request unanswered until the returned function runs. */
    hold() {
      let release;
      held = { promise: new Promise((resolve) => { release = resolve; }) };
      return () => { held = null; release(); };
    },
  };
}

/** Exactly what one WalletProvider refresh reads. */
const refreshOnce = ({ connection }) => Promise.all([
  connection.getSolBalance(OWNER),
  connection.getSakuraBalanceWithMeta(OWNER),
]);

test('a refresh for a wallet without a SAKURA account costs 6 RPC calls, not 8', async () => {
  const chain = loadWalletChain(walletWithoutSakura);
  const [sol, sakura] = await refreshOnce(chain);
  // What the wallet shows is unchanged: SOL, and SAKURA 0 from an empty search.
  assert.equal(sol, 2.5);
  assert.deepEqual({ ...sakura }, { balance: 0, source: 'none', error: null });
  // The missing ATA was asked about once. It used to be asked three times,
  // 0.35 s and 0.7 s apart, for the same -32602 answer: 8 calls a refresh.
  assert.deepEqual(countBy(chain.calls), {
    getBalance: 1,
    getTokenAccountBalance: 1,
    getAccountInfo: 1, // getParsedAccountInfo: still read, as before
    getTokenAccountsByOwner: 3, // parsed by program, parsed by mint, raw by program: still read, as before
  });
});

test('transient wallet-rpc failures (429, 503) are still retried', async () => {
  const chain = loadWalletChain((method, n) => {
    if (method !== 'getTokenAccountBalance') return walletWithoutSakura(method);
    if (n === 1) return new Response('RPC rate limit reached.', { status: 429 });
    if (n === 2) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'RPC is temporarily unavailable.' }, id: null }),
        { status: 503 });
    }
    return ok({ amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5' });
  });
  const sakura = await chain.connection.getSakuraBalanceWithMeta(OWNER);
  assert.deepEqual({ ...sakura }, { balance: 2.5, source: 'ata', error: null });
  assert.deepEqual(countBy(chain.calls), { getTokenAccountBalance: 3 });
});

test('SAKURA held outside the ATA is still found by the owner scan, after one ATA read', async () => {
  let config;
  const chain = loadWalletChain((method) => {
    if (method !== 'getTokenAccountsByOwner') return walletWithoutSakura(method);
    return ok([
      parsedTokenAccount(config, config.SAKURA_MINT.toBase58(), '123456789'),
      parsedTokenAccount(config, OWNER.toBase58(), '999'), // another Token-2022 mint: ignored, as before
    ]);
  });
  config = chain.config;
  const sakura = await chain.connection.getSakuraBalanceWithMeta(OWNER);
  assert.deepEqual({ ...sakura }, { balance: 123.456789, source: 'ownerParsedScan', error: null });
  assert.deepEqual(countBy(chain.calls), { getTokenAccountBalance: 1, getAccountInfo: 1, getTokenAccountsByOwner: 1 });
});

// --- WalletProvider: when refreshes happen ---------------------------------

/**
 * Just enough of React to run WalletProvider: hook slots by call order,
 * batched re-renders, effects with dependency checks and cleanups.
 */
function createReactRuntime() {
  const slots = [];
  let index = 0;
  let render = () => {};
  let queued = false;
  let pendingEffects = [];
  const depsChanged = (prev, next) => !prev || !next || prev.length !== next.length ||
    prev.some((value, i) => !Object.is(value, next[i]));
  const scheduleRender = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    createContext: () => ({ Provider: 'WalletContext.Provider' }),
    useContext: () => { throw new Error('Not used by the provider.'); },
    useState(initial) {
      const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      index++;
      slot.set ??= (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        scheduleRender();
      };
      return [slot.value, slot.set];
    },
    useRef(initial) {
      return slots[index++] ??= { current: initial };
    },
    useMemo(factory, deps) {
      const slot = slots[index++] ??= {};
      if (depsChanged(slot.deps, deps)) Object.assign(slot, { value: factory(), deps });
      return slot.value;
    },
    useCallback: (fn, deps) => React.useMemo(() => fn, deps),
    useEffect(effect, deps) {
      const slot = slots[index++] ??= {};
      if (depsChanged(slot.deps, deps)) {
        slot.deps = deps;
        pendingEffects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect() ?? undefined;
        });
      }
    },
  };
  let element;
  return {
    React,
    mount(Component, props) {
      render = () => {
        index = 0;
        element = Component(props);
        const effects = pendingEffects;
        pendingEffects = [];
        for (const run of effects) run();
      };
      render();
    },
    get value() { return element.props.value; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

/** Lets every pending promise, fetch and re-render run to completion. */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Mounts the real WalletProvider with a stored wallet (address only) on a
 * fake clock. On web, AppState and Platform are react-native-web's and the
 * tab's visibility drives them; native gets a scripted AppState with React
 * Native's 'active' | 'inactive' | 'background' states.
 */
async function mountWallet({ platform = 'web', rpc = walletWithoutSakura } = {}) {
  const chain = loadWalletChain(rpc);
  const clock = { now: Date.UTC(2026, 9, 14, 12) };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const intervals = new Map();
  let nextTimer = 1;
  const nativeAppState = {
    currentState: 'active',
    listeners: new Set(),
    addEventListener(type, listener) {
      assert.equal(type, 'change');
      this.listeners.add(listener);
      return { remove: () => this.listeners.delete(listener) };
    },
  };
  tab.visibilityState = 'visible';
  const authSessionClears = [];
  const runtime = createReactRuntime();
  const unexpected = (name) => () => { throw new Error(`${name} must not run in this test.`); };
  const { WalletProvider } = loadTs('../lib/wallet/context.tsx', {
    react: runtime.React,
    'react-native': platform === 'web' ? reactNativeWeb : { AppState: nativeAppState, Platform: { OS: platform } },
    '@solana/web3.js': web3,
    './storage': {
      getStoredPublicKey: async () => OWNER.toBase58(),
      generateWallet: unexpected('generateWallet'),
      storeWallet: unexpected('storeWallet'),
      getWalletWithBiometrics: unexpected('getWalletWithBiometrics'),
      removeWallet: unexpected('removeWallet'),
      hasStoredWallet: unexpected('hasStoredWallet'),
      importWalletFromKey: unexpected('importWalletFromKey'),
    },
    '@/lib/wallet-auth-session': { clearWalletAuthSession: () => authSessionClears.push(clock.now) },
    './config': chain.config,
    './balance-diagnostics': loadTs('../lib/wallet/balance-diagnostics.ts', {}),
    './app-session': { unlockForAppSession: unexpected('unlockForAppSession'), clearAppSessionKeypair() {} },
    './web-transaction-auth': { clearWebTransactionAuth() {} },
    './connection': chain.connection,
  }, {
    Date: FakeDate,
    setInterval(callback, ms) {
      const id = nextTimer++;
      intervals.set(id, { callback, ms, next: clock.now + ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    ...(platform === 'web' ? { document: tab } : {}),
  });
  runtime.mount(WalletProvider, { children: null });
  await settle();

  return {
    chain,
    runtime,
    authSessionClears,
    refreshes: () => chain.calls.filter((m) => m === 'getBalance').length,
    /** Moves the clock, firing interval callbacks that fall due on the way. */
    async advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = [...intervals.values()].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        clock.now = due.next;
        due.next += due.ms;
        due.callback();
        await settle();
      }
      clock.now = end;
      await settle();
    },
    /**
     * Sets the wall clock (Date.now) forward or back without moving time:
     * timers run on a monotonic clock, so the next tick still lands one
     * interval after the last.
     */
    jumpWallClock(ms) {
      clock.now += ms;
      for (const timer of intervals.values()) timer.next += ms;
    },
    /** Native: what React Native's AppState reports and announces. */
    async setAppState(state) {
      nativeAppState.currentState = state;
      for (const listener of [...nativeAppState.listeners]) listener(state);
      await settle();
    },
    /** Web: the browser hides or shows the tab; react-native-web turns that into AppState. */
    async setTabVisible(visible) {
      tab.visibilityState = visible ? 'visible' : 'hidden';
      tab.dispatchEvent(new Event('visibilitychange'));
      await settle();
    },
  };
}

test('web: a visible tab refreshes every 20 s; a hidden tab makes no RPC calls', async (t) => {
  const wallet = await mountWallet();
  t.after(() => wallet.runtime.unmount());
  assert.equal(wallet.refreshes(), 1, 'the connect-time refresh');
  assert.equal(wallet.runtime.value.sakuraBalance, 0);
  assert.equal(wallet.runtime.value.solBalance, 2.5);

  await wallet.advance(HOUR_MS);
  const visibleHour = wallet.chain.calls.length - 6;
  assert.equal(wallet.refreshes() - 1, HOUR_MS / INTERVAL_MS);
  // 180 refreshes x 6 calls. It was 180 x 8 = 1,440 before -32602 stopped
  // being retried, and the same again for every hidden tab.
  assert.equal(visibleHour, 1080);

  await wallet.setTabVisible(false);
  assert.equal(wallet.authSessionClears.length, 1, 'leaving still clears the wallet auth session');
  const beforeHidden = wallet.chain.calls.length;
  await wallet.advance(HOUR_MS);
  assert.equal(wallet.chain.calls.length - beforeHidden, 0, 'an hour hidden costs nothing');
});

test('web: showing the tab again refreshes once if the balance is stale, not on a quick switch', async (t) => {
  const wallet = await mountWallet();
  t.after(() => wallet.runtime.unmount());
  await wallet.advance(INTERVAL_MS); // tick at 20 s
  assert.equal(wallet.refreshes(), 2);

  // Away for 5 s: the last read is 5 s old, so coming back reads nothing.
  await wallet.setTabVisible(false);
  await wallet.advance(5_000);
  await wallet.setTabVisible(true);
  assert.equal(wallet.refreshes(), 2);
  await wallet.advance(15_000); // the 40 s tick still runs
  assert.equal(wallet.refreshes(), 3);

  // Away for ten minutes: one read on return, then the timer resumes.
  await wallet.setTabVisible(false);
  await wallet.advance(615_000);
  assert.equal(wallet.refreshes(), 3);
  await wallet.setTabVisible(true); // at 655 s
  assert.equal(wallet.refreshes(), 4, 'one catch-up read on return');
  assert.equal(wallet.runtime.value.lastBalanceRefreshAt, Date.UTC(2026, 9, 14, 12) + 655_000);
  // The 660 s tick lands 5 s after that read and steps aside; the 680 s one reads.
  await wallet.advance(5_000);
  assert.equal(wallet.refreshes(), 4);
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 5);
});

test('native: AppState background pauses the timer and active catches up; auth session handling is unchanged', async (t) => {
  const wallet = await mountWallet({ platform: 'ios' });
  t.after(() => wallet.runtime.unmount());
  assert.equal(wallet.refreshes(), 1);

  await wallet.setAppState('background');
  await wallet.advance(5 * 60_000);
  assert.equal(wallet.refreshes(), 1, 'no reads while backgrounded');
  await wallet.setAppState('active'); // back from Transak, say
  assert.equal(wallet.refreshes(), 2);

  // A Face ID sheet: inactive -> active within seconds of the last read.
  await wallet.setAppState('inactive');
  await wallet.advance(3_000);
  await wallet.setAppState('active');
  assert.equal(wallet.refreshes(), 2);
  assert.equal(wallet.authSessionClears.length, 2, 'background and inactive both still clear the session');

  await wallet.advance(17_000); // the 320 s tick, 20 s after the last read
  assert.equal(wallet.refreshes(), 3, 'the timer runs again while active');
});

test('an explicit refreshBalances() always reads; the timer skips a tick while one is running', async (t) => {
  const wallet = await mountWallet();
  t.after(() => wallet.runtime.unmount());
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 2);

  // Right after the timer's read, a send completes and asks for fresh numbers.
  await wallet.runtime.value.refreshBalances();
  await settle();
  assert.equal(wallet.refreshes(), 3, 'never coalesced into the earlier read');

  // A slow explicit refresh started at 25 s is still running at the 40 s
  // tick. 15 s is old enough for the tick on its own; the tick steps aside
  // only because a read is already on the way.
  await wallet.advance(5_000);
  const release = wallet.chain.hold();
  const slow = wallet.runtime.value.refreshBalances();
  await wallet.advance(15_000);
  assert.equal(wallet.refreshes(), 4, 'the 40 s tick stepped aside');
  release();
  await slow;
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 5, 'the 60 s tick reads');
});

test('a refresh that never finishes does not stop the timer for good', async (t) => {
  const wallet = await mountWallet();
  t.after(() => wallet.runtime.unmount());
  const release = wallet.chain.hold();
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 2);
  // Stuck for a whole interval: the next tick reads anyway.
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 3);
  release();
  await settle();
});

test('a wall clock set back does not stop the automatic refreshes', async (t) => {
  const wallet = await mountWallet();
  t.after(() => wallet.runtime.unmount());
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 2);

  // The phone's clock is corrected back by a day. The last read now looks
  // like it started tomorrow; the next tick must still read, and the 20 s
  // cadence resume from the corrected time.
  wallet.jumpWallClock(-24 * HOUR_MS);
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 3, 'the next tick reads');
  await wallet.advance(INTERVAL_MS);
  assert.equal(wallet.refreshes(), 4, 'and the one after it');

  // Coming back to the tab after a clock change reads too.
  await wallet.setTabVisible(false);
  wallet.jumpWallClock(-HOUR_MS);
  await wallet.setTabVisible(true);
  assert.equal(wallet.refreshes(), 5, 'the return to the tab reads');
});
