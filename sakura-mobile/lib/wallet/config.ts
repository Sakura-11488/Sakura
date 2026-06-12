import { PublicKey } from '@solana/web3.js';

/** Mainnet by default so card on-ramps and real balances match Transak/Jupiter. */
export const SOLANA_RPC =
  process.env.EXPO_PUBLIC_SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

export function isSolanaMainnet(): boolean {
  const rpc = SOLANA_RPC.toLowerCase();
  return !rpc.includes('devnet') && !rpc.includes('testnet');
}

export function getSolanaNetworkLabel(): string {
  return isSolanaMainnet() ? 'Mainnet' : 'Devnet';
}

export const SAKURA_MINT = new PublicKey(
  'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump'
);
export const SAKURA_DECIMALS = 6;
export const SAKURA_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);

export const INO_PROGRAM_ID = new PublicKey(
  'E9ju12He2mnBRaneM4xdtUXECDPXdpQQbU6HtSKb6Hpf'
);

export const FEE_ROUTER_PROGRAM_ID = new PublicKey(
  'FNoE2JUhn981hBDyBMvWJYkw9DThhtYwWoPbw6wgz1rg'
);

export const SAKURA_TREASURY_ADMIN = new PublicKey(
  '5NcWtvtQ48QJcizEs9i8H7Ef3YmtmybnSkPQxA2fxFiF'
);

export const MONTHLY_PASS_PRICE = 100; // in SAKURA tokens
export const PASS_DURATION_DAYS = 30;

export function truncateAddress(addr: string) {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

export function lamportsToSol(lamports: number) {
  return lamports / 1_000_000_000;
}

export function sakuraToRaw(amount: number) {
  return Math.round(amount * 10 ** SAKURA_DECIMALS);
}

export function rawToSakura(raw: number) {
  return raw / 10 ** SAKURA_DECIMALS;
}
