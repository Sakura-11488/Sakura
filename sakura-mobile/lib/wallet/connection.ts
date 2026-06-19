import { Buffer } from 'buffer';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, Keypair, TransactionInstruction } from '@solana/web3.js';
import { SOLANA_RPC, SAKURA_MINT, SAKURA_TOKEN_PROGRAM_ID, lamportsToSol, rawToSakura, sakuraToRaw, SAKURA_SEND_SOL_RESERVE } from './config';
import { fetchSolBalance, fetchSakuraBalance, fetchSakuraBalanceWithMeta, getSakuraAta } from './balances';
import type { SakuraBalanceSource } from './balance-diagnostics';
export { SAKURA_SEND_SOL_RESERVE, SOL_SEND_FEE_RESERVE } from './config';

const ASSOC_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS');
const SYS_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

function getAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return getSakuraAta(owner);
}

function u64LeBuffer(value: number): Buffer {
  const buf = Buffer.alloc(8);
  let v = BigInt(Math.round(value));
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

export async function sendSakura(keypair: Keypair, toAddress: string, amount: number): Promise<string> {
  const conn = getConnection();
  const toPubkey = new PublicKey(toAddress);
  const fromAta = getAta(keypair.publicKey, SAKURA_MINT);
  const toAta = getAta(toPubkey, SAKURA_MINT);
  const rawAmount = sakuraToRaw(amount);

  const solLamports = await conn.getBalance(keypair.publicKey, 'confirmed');
  const toAtaInfo = await conn.getAccountInfo(toAta, 'confirmed');
  const minLamports = Math.round(
    (toAtaInfo ? SAKURA_SEND_SOL_RESERVE * 0.6 : SAKURA_SEND_SOL_RESERVE + 0.001) * LAMPORTS_PER_SOL,
  );
  if (solLamports < minLamports) {
    throw new Error(
      `Need at least ${(minLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL for network fees${toAtaInfo ? '' : ' and recipient token account rent'}.`,
    );
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = keypair.publicKey;

  // Create receiver ATA if it doesn't exist (idempotent create)
  if (!toAtaInfo) {
    tx.add(new TransactionInstruction({
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: toAta, isSigner: false, isWritable: true },
        { pubkey: toPubkey, isSigner: false, isWritable: false },
        { pubkey: SAKURA_MINT, isSigner: false, isWritable: false },
        { pubkey: SYS_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SAKURA_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: ASSOC_TOKEN_PROGRAM_ID,
      data: Buffer.from([1]), // idempotent create
    }));
  }

  // SPL token transfer (instruction type 3)
  const transferData = Buffer.concat([Buffer.from([3]), u64LeBuffer(rawAmount)]);
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: fromAta, isSigner: false, isWritable: true },
      { pubkey: toAta, isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
    ],
    programId: SAKURA_TOKEN_PROGRAM_ID,
    data: transferData,
  }));

  tx.sign(keypair);
  const txid = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ blockhash, lastValidBlockHeight, signature: txid }, 'confirmed');
  return txid;
}

let _connection: Connection | null = null;
let _connectionRpc: string | null = null;

export function getConnection(): Connection {
  if (!_connection || _connectionRpc !== SOLANA_RPC) {
    _connection = new Connection(SOLANA_RPC, 'confirmed');
    _connectionRpc = SOLANA_RPC;
  }
  return _connection;
}

export async function getSolBalance(publicKey: PublicKey): Promise<number | null> {
  try {
    return await fetchSolBalance(publicKey);
  } catch (e) {
    if (__DEV__) console.warn('[wallet] getSolBalance failed', e);
    return null;
  }
}

export async function getSakuraBalance(publicKey: PublicKey): Promise<number | null> {
  try {
    return await fetchSakuraBalance(publicKey);
  } catch (e) {
    if (__DEV__) console.warn('[wallet] getSakuraBalance failed', e);
    return null;
  }
}

export async function getSakuraBalanceWithMeta(publicKey: PublicKey): Promise<{
  balance: number | null;
  source: SakuraBalanceSource;
  error: string | null;
}> {
  try {
    const result = await fetchSakuraBalanceWithMeta(publicKey);
    return { balance: result.balance, source: result.source, error: result.error ?? null };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Balance read failed';
    if (__DEV__) console.warn('[wallet] getSakuraBalanceWithMeta failed', e);
    return { balance: null, source: 'error', error: message };
  }
}

export async function sendSol(
  keypair: Keypair,
  toAddress: string,
  amountSol: number,
): Promise<string> {
  const conn = getConnection();
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey, lamports }),
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);
  const txid = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ blockhash, lastValidBlockHeight, signature: txid }, 'confirmed');
  return txid;
}

export async function requestAirdrop(publicKey: PublicKey): Promise<string> {
  const conn = getConnection();
  const sig = await conn.requestAirdrop(publicKey, LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}
