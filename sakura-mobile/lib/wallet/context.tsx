import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from 'react';
import { AppState } from 'react-native';
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
import { getSolBalance, getSakuraBalanceWithMeta } from './connection';
import { truncateAddress, getSolanaNetworkLabel, SOLANA_RPC } from './config';
import { rpcDisplayLabel, setBalanceDiagnostics, type SakuraBalanceSource } from './balance-diagnostics';
import { unlockForAppSession, clearAppSessionKeypair } from './app-session';
import { clearWebTransactionAuth } from './web-transaction-auth';

export { getSolanaNetworkLabel };

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

  const refreshBalances = useCallback(async () => {
    if (!publicKey) return;
    setLoadingBalances(true);
    const [sol, sakuraMeta] = await Promise.all([
      getSolBalance(publicKey),
      getSakuraBalanceWithMeta(publicKey),
    ]);

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

  useEffect(() => {
    if (!publicKey) return;
    const timer = setInterval(() => {
      refreshBalances();
    }, 20_000);
    return () => clearInterval(timer);
  }, [publicKey, refreshBalances]);

  // Refresh when returning from Transak / background
  useEffect(() => {
    if (!publicKey) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        clearWalletAuthSession();
      }
      if (state === 'active') refreshBalances();
    });
    return () => sub.remove();
  }, [publicKey, refreshBalances]);

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

  return (
    <WalletContext.Provider
      value={{
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
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
