import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  SAKURA_MINT,
  SAKURA_TOKEN_PROGRAM_ID,
  SOLANA_RPC,
  SAKURA_SEND_SOL_RESERVE,
  SOL_SEND_FEE_RESERVE,
  lamportsToSol,
  rawToSakura,
} from './config';
import type { SakuraBalanceSource } from './balance-diagnostics';

let _connection: Connection | null = null;
let _connectionRpc: string | null = null;

function getRpcConnection(): Connection {
  if (!_connection || _connectionRpc !== SOLANA_RPC) {
    _connection = new Connection(SOLANA_RPC, 'confirmed');
    _connectionRpc = SOLANA_RPC;
  }
  return _connection;
}

export type SakuraBalanceResult = {
  balance: number;
  source: SakuraBalanceSource;
  error?: string;
};

function readRawTokenAmount(data: Buffer): bigint | null {
  if (data.length < 72) return null;
  try {
    const mint = new PublicKey(data.subarray(0, 32));
    if (!mint.equals(SAKURA_MINT)) return null;
    return data.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

async function sumRawOwnerScan(conn: Connection, owner: PublicKey): Promise<number> {
  const rawAccounts = await conn.getTokenAccountsByOwner(
    owner,
    { programId: SAKURA_TOKEN_PROGRAM_ID },
    'confirmed',
  );

  let total = 0n;
  for (const acc of rawAccounts.value) {
    const amount = readRawTokenAmount(acc.account.data);
    if (amount !== null) total += amount;
  }
  return rawToSakura(Number(total));
}

export function getSakuraAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    SAKURA_MINT,
    owner,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/** Pick the wallet's funded SKR token account (ATA first, then owner scan). */
export async function resolveSakuraTokenAccount(
  owner: PublicKey,
  minRawAmount = 0n,
): Promise<PublicKey> {
  const conn = getRpcConnection();
  const ata = getSakuraAta(owner);

  try {
    const balance = await conn.getTokenAccountBalance(ata, 'confirmed');
    const raw = BigInt(balance.value.amount);
    if (raw >= minRawAmount) return ata;
  } catch {
    // ATA may not exist yet — fall through to owner scan.
  }

  const accounts = await conn.getParsedTokenAccountsByOwner(
    owner,
    { mint: SAKURA_MINT },
    'confirmed',
  );

  let best: { pubkey: PublicKey; raw: bigint } | null = null;
  for (const entry of accounts.value) {
    const amount = entry.account.data.parsed?.info?.tokenAmount?.amount;
    if (amount == null) continue;
    const raw = BigInt(amount);
    if (raw < minRawAmount) continue;
    if (!best || raw > best.raw) {
      best = { pubkey: entry.pubkey, raw };
    }
  }

  if (!best) {
    const programAccounts = await conn.getParsedTokenAccountsByOwner(
      owner,
      { programId: SAKURA_TOKEN_PROGRAM_ID },
      'confirmed',
    );
    for (const entry of programAccounts.value) {
      const info = entry.account.data.parsed?.info;
      if (!info || info.mint !== SAKURA_MINT.toBase58()) continue;
      const amount = info.tokenAmount?.amount;
      if (amount == null) continue;
      const raw = BigInt(amount);
      if (raw < minRawAmount) continue;
      if (!best || raw > best.raw) {
        best = { pubkey: entry.pubkey, raw };
      }
    }
  }

  if (!best) {
    throw new Error('No SAKURA token account with enough balance for this payment.');
  }
  return best.pubkey;
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
  const result = await fetchSakuraBalanceWithMeta(publicKey);
  return result.balance;
}

export async function fetchSakuraBalanceWithMeta(publicKey: PublicKey): Promise<SakuraBalanceResult> {
  const conn = getRpcConnection();
  const ata = getSakuraAta(publicKey);

  try {
    const direct = await withRetry(() => conn.getTokenAccountBalance(ata, 'confirmed'));
    return { balance: rawToSakura(Number(direct.value.amount)), source: 'ata' };
  } catch {
    // ATA may not exist yet — fall through to other reads.
  }

  try {
    const parsedAta = await withRetry(() => conn.getParsedAccountInfo(ata, 'confirmed'));
    const parsedAmount = parsedAta.value?.data && 'parsed' in parsedAta.value.data
      ? parsedAta.value.data.parsed?.info?.tokenAmount?.amount
      : null;
    if (parsedAmount != null) {
      return { balance: rawToSakura(Number(parsedAmount)), source: 'ata' };
    }
  } catch {
    // continue
  }

  try {
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

    if (total > 0) return { balance: total, source: 'ownerParsedScan' };

    const legacyScan = await withRetry(() =>
      conn.getParsedTokenAccountsByOwner(publicKey, { mint: SAKURA_MINT }, 'confirmed'),
    );
    for (const acc of legacyScan.value) {
      total += rawToSakura(Number(acc.account.data.parsed.info.tokenAmount.amount));
    }

    if (total > 0) return { balance: total, source: 'legacyMintScan' };

    const rawTotal = await withRetry(() => sumRawOwnerScan(conn, publicKey));
    if (rawTotal > 0) return { balance: rawTotal, source: 'rawScan' };

    return { balance: 0, source: 'none' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Balance read failed';
    throw new Error(message);
  }
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
