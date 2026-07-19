import { PublicKey } from '@solana/web3.js';
import {
  SAKURA_MINT_ADDRESS,
  SAKURA_DECIMALS as SAKURA_DECIMALS_CANONICAL,
  TOKEN_2022_PROGRAM_ADDRESS,
  INO_PROGRAM_ADDRESS,
  FEE_ROUTER_PROGRAM_ADDRESS,
  PERCOLATOR_INSURANCE_VAULT_ADDRESS,
  INSURANCE_SPLIT,
  BURN_SPLIT,
  SAKURA_TREASURY_PROGRAM_ADDRESS,
  SAKURA_TREASURY_ADMIN_ADDRESS,
  AVATAR_PAYMENT_WALLET_ADDRESS,
  MONTHLY_PASS_PRICE as MONTHLY_PASS_PRICE_CANONICAL,
  PASS_DURATION_DAYS as PASS_DURATION_DAYS_CANONICAL,
} from './addresses';

export { INSURANCE_SPLIT, BURN_SPLIT };

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

// On-chain constants come from lib/wallet/addresses.ts — the single source
// of truth shared with legacy src/lib/solana.ts. Edit addresses there.
export const SAKURA_MINT = new PublicKey(SAKURA_MINT_ADDRESS);
export const SAKURA_DECIMALS = SAKURA_DECIMALS_CANONICAL;
export const SAKURA_TOKEN_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);

export const INO_PROGRAM_ID = new PublicKey(INO_PROGRAM_ADDRESS);

export const FEE_ROUTER_PROGRAM_ID = new PublicKey(FEE_ROUTER_PROGRAM_ADDRESS);
export const PERCOLATOR_INSURANCE_VAULT = new PublicKey(
  PERCOLATOR_INSURANCE_VAULT_ADDRESS
);

export const SAKURA_TREASURY_PROGRAM_ID = new PublicKey(
  SAKURA_TREASURY_PROGRAM_ADDRESS
);
export const SAKURA_TREASURY_ADMIN = new PublicKey(SAKURA_TREASURY_ADMIN_ADDRESS);

/** Treasury wallet for paid avatar NFT mints (100k SAKURA). */
export const AVATAR_PAYMENT_WALLET = (
  process.env.EXPO_PUBLIC_AVATAR_PAYMENT_WALLET ?? AVATAR_PAYMENT_WALLET_ADDRESS
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

export const MONTHLY_PASS_PRICE = MONTHLY_PASS_PRICE_CANONICAL; // in SAKURA tokens
export const PASS_DURATION_DAYS = PASS_DURATION_DAYS_CANONICAL;

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
