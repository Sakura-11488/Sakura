import { Connection, PublicKey } from '@solana/web3.js';
import {
  SAKURA_MINT,
  SAKURA_TOKEN_PROGRAM_ID,
  SOLANA_RPC,
  SAKURA_SEND_SOL_RESERVE,
  SOL_SEND_FEE_RESERVE,
  lamportsToSol,
  rawToSakura,
} from './config';

const ASSOC_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS');

let _connection: Connection | null = null;
let _connectionRpc: string | null = null;

function getRpcConnection(): Connection {
  if (!_connection || _connectionRpc !== SOLANA_RPC) {
    _connection = new Connection(SOLANA_RPC, 'confirmed');
    _connectionRpc = SOLANA_RPC;
  }
  return _connection;
}
export function getSakuraAta(owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SAKURA_TOKEN_PROGRAM_ID.toBuffer(), SAKURA_MINT.toBuffer()],
    ASSOC_TOKEN_PROGRAM_ID,
  );
  return ata;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 350 * (i + 1)));
      }
    }
  }
  throw lastError;
}

export async function fetchSolBalance(publicKey: PublicKey): Promise<number> {
  const lamports = await withRetry(() => getRpcConnection().getBalance(publicKey, 'confirmed'));
  return lamportsToSol(lamports);
}

export async function fetchSakuraBalance(publicKey: PublicKey): Promise<number> {
  const conn = getRpcConnection();
  const ata = getSakuraAta(publicKey);

  try {
    const direct = await withRetry(() => conn.getTokenAccountBalance(ata, 'confirmed'));
    return rawToSakura(Number(direct.value.amount));
  } catch {
    // ATA may not exist yet — fall back to owner scan (Token-2022 + legacy).
  }

  const accounts = await withRetry(() =>
    conn.getParsedTokenAccountsByOwner(
      publicKey,
      { programId: SAKURA_TOKEN_PROGRAM_ID },
      'confirmed',
    ),
  );

  let total = 0;
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed?.info;
    if (!info || info.mint !== SAKURA_MINT.toBase58()) continue;
    total += rawToSakura(Number(info.tokenAmount.amount));
  }

  if (total > 0) return total;

  const legacyScan = await withRetry(() =>
    conn.getParsedTokenAccountsByOwner(publicKey, { mint: SAKURA_MINT }, 'confirmed'),
  );
  for (const acc of legacyScan.value) {
    total += rawToSakura(Number(acc.account.data.parsed.info.tokenAmount.amount));
  }

  return total;
}

export async function recipientNeedsSakuraAta(recipient: PublicKey): Promise<boolean> {
  const conn = getRpcConnection();
  const ata = getSakuraAta(recipient);
  const info = await conn.getAccountInfo(ata, 'confirmed');
  return !info;
}

export function maxSendableSol(solBalance: number | null): number {
  return Math.max(0, Math.floor(((solBalance ?? 0) - SOL_SEND_FEE_RESERVE) * 100_000) / 100_000);
}

export async function maxSendableSakura(
  owner: PublicKey,
  sakuraBalance: number | null,
  solBalance: number | null,
  recipientAddress?: string,
): Promise<number> {
  const balance = sakuraBalance ?? 0;
  if (balance <= 0) return 0;

  const sol = solBalance ?? 0;
  if (sol < SAKURA_SEND_SOL_RESERVE) return 0;

  if (!recipientAddress?.trim()) {
    return Math.floor(balance);
  }

  try {
    const recipient = new PublicKey(recipientAddress.trim());
    const needsAta = await recipientNeedsSakuraAta(recipient);
    const minSol = needsAta ? SAKURA_SEND_SOL_RESERVE + 0.001 : SAKURA_SEND_SOL_RESERVE * 0.6;
    if (sol < minSol) return 0;
  } catch {
    return Math.floor(balance);
  }

  return Math.floor(balance);
}

export function formatBalance(value: number | null, digits = 4): string {
  if (value === null) return '—';
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
