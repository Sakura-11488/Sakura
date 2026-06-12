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
import { getSolBalance, getSakuraBalance } from './connection';
import { truncateAddress, getSolanaNetworkLabel } from './config';

export { getSolanaNetworkLabel };

export interface WalletState {
  address: string | null;
  publicKey: PublicKey | null;
  connected: boolean;
  connecting: boolean;
  solBalance: number | null;
  sakuraBalance: number | null;
  loadingBalances: boolean;
  // Actions
  createWallet: () => Promise<void>;
  connectExisting: () => Promise<void>;
  importWallet: (key: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalances: () => Promise<void>;
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
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [sakuraBalance, setSakuraBalance] = useState<number | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) return;
    setLoadingBalances(true);
    const [sol, sakura] = await Promise.all([
      getSolBalance(publicKey),
      getSakuraBalance(publicKey),
    ]);
    setSolBalance(sol);
    setSakuraBalance(sakura);
    setLoadingBalances(false);
  }, [publicKey]);

  // Restore session on mount
  useEffect(() => {
    getStoredPublicKey().then((stored) => {
      if (stored) {
        const pk = new PublicKey(stored);
        setPublicKey(pk);
        setAddress(stored);
        setConnected(true);
      }
    });
  }, []);

  // Refresh balances whenever connected
  useEffect(() => {
    if (publicKey) refreshBalances();
  }, [publicKey, refreshBalances]);

  // Refresh when returning from Transak / background
  useEffect(() => {
    if (!publicKey) return;
    const sub = AppState.addEventListener('change', (state) => {
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
    setPublicKey(null);
    setAddress(null);
    setConnected(false);
    setSolBalance(null);
    setSakuraBalance(null);
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
        solBalance,
        sakuraBalance,
        loadingBalances,
        createWallet,
        connectExisting,
        importWallet,
        disconnect,
        refreshBalances,
        signWithBiometrics,
        shortAddress,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
