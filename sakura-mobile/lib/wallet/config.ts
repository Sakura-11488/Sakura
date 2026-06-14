import { PublicKey } from '@solana/web3.js';

export const SAKURA_SEND_SOL_RESERVE = 0.003;
export const SOL_SEND_FEE_RESERVE = 0.005;

/** Mainnet by default so card on-ramps and real balances match Transak/Jupiter. */
const HELIUS_KEY = (process.env.EXPO_PUBLIC_HELIUS_API_KEY || '').trim();
export const SOLANA_RPC =
  process.env.EXPO_PUBLIC_SOLANA_RPC?.trim()
  || (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : '')
  || 'https://api.mainnet-beta.solana.com';

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

/** Treasury wallet for paid avatar NFT mints (100k SAKURA). */
export const AVATAR_PAYMENT_WALLET = (
  process.env.EXPO_PUBLIC_AVATAR_PAYMENT_WALLET ?? 'G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1'
).trim();

export const AVATAR_MINT_PRICE_SAKURA = Number(
  process.env.EXPO_PUBLIC_AVATAR_MINT_PRICE_SAKURA ?? '100000',
);

export function formatAvatarMintPrice(): string {
  return `${AVATAR_MINT_PRICE_SAKURA.toLocaleString()} SKR`;
}

export function solanaExplorerTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

export function solanaExplorerToken(mintAddress: string): string {
  return `https://solscan.io/token/${mintAddress}`;
}

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
