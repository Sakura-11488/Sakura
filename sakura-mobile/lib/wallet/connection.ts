import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  Keypair,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  SOLANA_RPC,
  SAKURA_MINT,
  SAKURA_DECIMALS,
  sakuraToRaw,
  SAKURA_SEND_SOL_RESERVE,
} from './config';
import {
  fetchSolBalance,
  fetchSakuraBalance,
  fetchSakuraBalanceWithMeta,
  resolveSakuraTokenAccount,
} from './balances';
import type { SakuraBalanceSource } from './balance-diagnostics';
export { SAKURA_SEND_SOL_RESERVE, SOL_SEND_FEE_RESERVE } from './config';

function destinationAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    SAKURA_MINT,
    owner,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export async function sendSakura(keypair: Keypair, toAddress: string, amount: number): Promise<string> {
  const conn = getConnection();
  const toPubkey = new PublicKey(toAddress);
  const rawAmount = BigInt(sakuraToRaw(amount));
  const fromTokenAccount = await resolveSakuraTokenAccount(keypair.publicKey, rawAmount);
  const toAta = destinationAta(toPubkey);

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

  if (!toAtaInfo) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        toAta,
        toPubkey,
        SAKURA_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  tx.add(
    createTransferCheckedInstruction(
      fromTokenAccount,
      SAKURA_MINT,
      toAta,
      keypair.publicKey,
      rawAmount,
      SAKURA_DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );

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
