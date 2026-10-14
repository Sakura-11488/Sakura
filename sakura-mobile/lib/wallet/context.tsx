import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { AppState, Platform } from 'react-native';
import { PublicKey } from '@solana/web3.js';
import {
  generateWallet,
  storeWallet,
  getStoredPublicKey,
  getWalletWithBiometrics,
  removeWallet,
  hasStoredWallet,
  importWalletFromKey,
} from './storage';
import { clearWalletAuthSession } from '@/lib/wallet-auth-session';
// ./connection brings @solana/spl-token. The provider wraps every screen, so
// a static import put it in every cold start although balances are only read
// once a wallet is connected; load it with the first balance refresh instead.
// Like the originals these never throw: a chunk that cannot load (offline,
// not yet cached) reads as a failed refresh, so loadingBalances still clears.
async function getSolBalance(publicKey: PublicKey): Promise<number | null> {
  try {
    return await (await import('./connection')).getSolBalance(publicKey);
  } catch {
    return null;
  }
}

async function getSakuraBalanceWithMeta(publicKey: PublicKey): Promise<{
  balance: number | null;
  source: SakuraBalanceSource;
  error: string | null;
}> {
  try {
    return await (await import('./connection')).getSakuraBalanceWithMeta(publicKey);
  } catch (e) {
    return { balance: null, source: 'error', error: e instanceof Error ? e.message : 'Could not load the wallet tools.' };
  }
}
import { truncateAddress, getSolanaNetworkLabel, SOLANA_RPC } from './config';
import { rpcDisplayLabel, setBalanceDiagnostics, type SakuraBalanceSource } from './balance-diagnostics';
import { unlockForAppSession, clearAppSessionKeypair } from './app-session';
import { clearWebTransactionAuth } from './web-transaction-auth';

export { getSolanaNetworkLabel };

/**
 * On web every balance read is a call to the wallet-rpc edge function, which
 * allows 3600 an hour per client IP, shared by every tab and by everyone
 * behind the same address. A refresh is ~6 calls for a wallet without a
 * SAKURA account (getBalance plus five reads looking for one), so this timer
 * alone is ~1,080 calls an hour for each tab running it. It used to run in
 * hidden tabs too (browsers slow background timers, they do not stop them),
 * so a few open tabs were enough to hit 429s.
 */
const BALANCE_REFRESH_MS = 20_000;

/**
 * Whether the user can see the app. On web that is the tab's own visibility;
 * react-native-web derives AppState from the same property, but reading it
 * directly does not depend on that mapping. Native uses AppState: 'inactive'
 * (app switcher, Control Center, a Face ID sheet) counts as away, as it does
 * for clearWalletAuthSession below.
 */
function appIsVisible(): boolean {
  if (Platform.OS === 'web') {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }
  return AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
}

export interface WalletState {
  address: string | null;
  publicKey: PublicKey | null;
  connected: boolean;
  connecting: boolean;
  /**
   * True until the stored session has been read back. `connected === false`
   * alone cannot distinguish "no wallet" from "haven't looked yet", which made
   * screens redirect connected users to the connect screen on a cold load.
   */
  restoring: boolean;
  solBalance: number | null;
  sakuraBalance: number | null;
  loadingBalances: boolean;
  balanceError: string | null;
  sakuraBalanceSource: SakuraBalanceSource;
  rpcLabel: string;
  lastBalanceRefreshAt: number | null;
  // Actions
  createWallet: () => Promise<void>;
  connectExisting: () => Promise<void>;
  importWallet: (key: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalances: () => Promise<void>;
  /** Cached unlock for chat/realtime — prompts once per app session. */
  unlockForAppSession: () => Promise<import('@solana/web3.js').Keypair | null>;
  /** Fresh biometric unlock for payments, transfers, and trades. */
  signWithBiometrics: () => Promise<import('@solana/web3.js').Keypair | null>;
  shortAddress: string | null;
}

const WalletContext = createContext<WalletState>({} as WalletState);

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [sakuraBalance, setSakuraBalance] = useState<number | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [sakuraBalanceSource, setSakuraBalanceSource] = useState<SakuraBalanceSource>('none');
  const [lastBalanceRefreshAt, setLastBalanceRefreshAt] = useState<number | null>(null);
  const rpcLabel = rpcDisplayLabel(SOLANA_RPC);
  // Read by the timer and foreground refreshes only. Refs, not state, so
  // refreshBalances keeps one identity: screens list it in focus-effect deps,
  // and a new identity would re-run those effects, each of which refreshes.
  const refreshesInFlight = useRef(0);
  const lastRefreshStartedAt = useRef(0);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) return;
    refreshesInFlight.current += 1;
    lastRefreshStartedAt.current = Date.now();
    setLoadingBalances(true);
    const [sol, sakuraMeta] = await Promise.all([
      getSolBalance(publicKey),
      getSakuraBalanceWithMeta(publicKey),
    ]).finally(() => {
      refreshesInFlight.current -= 1;
    });

    if (sol !== null) setSolBalance(sol);
    if (sakuraMeta.balance !== null) {
      setSakuraBalance(sakuraMeta.balance);
      setSakuraBalanceSource(sakuraMeta.source);
      setBalanceError(sakuraMeta.error ?? null);
    } else {
      setBalanceError(sakuraMeta.error ?? 'Could not refresh SAKURA balance');
    }

    const refreshedAt = Date.now();
    setLastBalanceRefreshAt(refreshedAt);
    setBalanceDiagnostics({
      sakuraSource: sakuraMeta.source,
      sakuraError: sakuraMeta.error,
      rpcLabel,
      lastRefreshAt: refreshedAt,
    });
    setLoadingBalances(false);
  }, [publicKey, rpcLabel]);

  /**
   * The automatic refreshes (timer, return to foreground) step aside while a
   * refresh is running or when one started within `freshForMs`: a screen's
   * focus refresh, the connect-time one and the refresh button all count, so
   * coming back at second 19 does not read twice in two seconds. Calls to
   * refreshBalances() itself are never skipped; they follow sends and
   * purchases, and must read after them.
   *
   * A refresh settles within its 12 s read deadline. One still running after
   * a whole interval is stuck (a lazy chunk that never arrives) and must not
   * stop the timer for good, so it only holds the next refresh back that long.
   *
   * Date.now() is the wall clock, and it can move back (set by hand, or a
   * network time correction on a phone that was wrong). The last start then
   * lies in the future and every check above would read it as fresh until the
   * clock caught up: hours or days without an automatic refresh. A negative
   * age is treated as stale; the read it lets through restamps the start
   * time, so the 20 s cadence resumes from the corrected clock.
   */
  const refreshIfStale = useCallback((freshForMs: number) => {
    const sinceLastStart = Date.now() - lastRefreshStartedAt.current;
    if (sinceLastStart >= 0) {
      if (refreshesInFlight.current > 0 && sinceLastStart < BALANCE_REFRESH_MS) return;
      if (sinceLastStart < freshForMs) return;
    }
    void refreshBalances();
  }, [refreshBalances]);

  // Restore session on mount. The `finally` matters: without it a rejected read
  // would leave `restoring` true forever and every gated screen would hang.
  useEffect(() => {
    getStoredPublicKey()
      .then((stored) => {
        if (stored) {
          const pk = new PublicKey(stored);
          setPublicKey(pk);
          setAddress(stored);
          setConnected(true);
        }
      })
      .catch((e) => console.warn('[wallet] session restore failed:', e))
      .finally(() => setRestoring(false));
  }, []);

  // Refresh balances whenever connected
  useEffect(() => {
    if (publicKey) refreshBalances();
  }, [publicKey, refreshBalances]);

  // Every 20 s while the app is on screen. A hidden tab or a backgrounded app
  // skips the tick instead of spending the shared wallet-rpc budget on numbers
  // nobody sees; the foreground listener below catches up on return. A tick
  // also steps aside when another refresh started in the last 10 s, which
  // stops two reads in a row but never skips the tick after a tick's own read
  // (20 s old by then).
  useEffect(() => {
    if (!publicKey) return;
    const timer = setInterval(() => {
      if (appIsVisible()) refreshIfStale(BALANCE_REFRESH_MS / 2);
    }, BALANCE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [publicKey, refreshIfStale]);

  // Refresh when returning from Transak / background. On web, react-native-web
  // raises this from the tab's visibilitychange event, so it is also the
  // "tab shown again" refresh. It reads only when the last refresh is older
  // than one timer interval: a Transak round trip or a long absence still
  // refreshes at once, a quick tab switch or a Face ID sheet ('inactive' then
  // 'active') no longer does, and the timer covers it within 20 s.
  useEffect(() => {
    if (!publicKey) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        clearWalletAuthSession();
      }
      if (state === 'active') refreshIfStale(BALANCE_REFRESH_MS);
    });
    return () => sub.remove();
  }, [publicKey, refreshIfStale]);

  const applyKeypair = (pk: PublicKey) => {
    setPublicKey(pk);
    setAddress(pk.toBase58());
    setConnected(true);
  };

  const createWallet = useCallback(async () => {
    setConnecting(true);
    try {
      const kp = generateWallet();
      await storeWallet(kp);
      applyKeypair(kp.publicKey);
    } finally {
      setConnecting(false);
    }
  }, []);

  const connectExisting = useCallback(async () => {
    setConnecting(true);
    try {
      const stored = await getStoredPublicKey();
      if (!stored) throw new Error('No wallet found. Create one first.');
      applyKeypair(new PublicKey(stored));
    } finally {
      setConnecting(false);
    }
  }, []);

  const importWallet = useCallback(async (key: string) => {
    setConnecting(true);
    try {
      const kp = await importWalletFromKey(key.trim());
      applyKeypair(kp.publicKey);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await removeWallet();
    clearAppSessionKeypair();
    clearWalletAuthSession();
    // The 24-hour "don't ask again" grace was granted to this wallet; it must
    // not carry over to whoever connects next on a shared device.
    clearWebTransactionAuth();
    setPublicKey(null);
    setAddress(null);
    setConnected(false);
    setSolBalance(null);
    setSakuraBalance(null);
    setBalanceError(null);
    setSakuraBalanceSource('none');
    setLastBalanceRefreshAt(null);
  }, []);

  const unlockForAppSessionFn = useCallback(async () => {
    return unlockForAppSession();
  }, []);

  const signWithBiometrics = useCallback(async () => {
    return getWalletWithBiometrics();
  }, []);

  const shortAddress = address ? truncateAddress(address) : null;

  /**
   * Memoised because this value is consumed by nearly every screen.
   *
   * refreshBalances runs on a 20s interval and fires ~7 setState calls per tick.
   * With an inline object literal here, each of those renders handed every
   * useWallet() consumer in the app a new context identity, so the whole tree
   * re-rendered three times a minute whether or not the numbers changed — and
   * on screens that show a balance, the text genuinely re-flowed each time.
   */
  const value = useMemo(
    () => ({
        address,
        publicKey,
        connected,
        connecting,
        restoring,
        solBalance,
        sakuraBalance,
        loadingBalances,
        balanceError,
        sakuraBalanceSource,
        rpcLabel,
        lastBalanceRefreshAt,
        createWallet,
        connectExisting,
        importWallet,
        disconnect,
        refreshBalances,
        unlockForAppSession: unlockForAppSessionFn,
        signWithBiometrics,
        shortAddress,
    }),
    [
      address,
      publicKey,
      connected,
      connecting,
      restoring,
      solBalance,
      sakuraBalance,
      loadingBalances,
      balanceError,
      sakuraBalanceSource,
      rpcLabel,
      lastBalanceRefreshAt,
      shortAddress,
      createWallet,
      connectExisting,
      importWallet,
      disconnect,
      refreshBalances,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
