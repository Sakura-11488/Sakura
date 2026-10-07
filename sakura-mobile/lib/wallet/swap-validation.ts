import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type AddressLookupTableAccount,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
const ROUTE_DISCRIMINATOR = [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a];
const SHARED_ROUTE_DISCRIMINATOR = [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81];

export type ExpectedSwap = {
  inAmount: string;
  outAmount: string;
  _raw: Record<string, unknown>;
  outputMint: PublicKey;
  outputTokenProgram: PublicKey;
};

function u64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function validateAta(ix: TransactionInstruction, user: PublicKey, source: PublicKey, destination: PublicKey, quote: ExpectedSwap): void {
  const mint = ix.keys[3]?.pubkey;
  const account = ix.keys[1]?.pubkey;
  const expectedTokenProgram = mint?.equals(quote.outputMint) ? quote.outputTokenProgram : TOKEN_PROGRAM;
  if (
    ix.keys.length < 6 ||
    !ix.keys[0].pubkey.equals(user) ||
    !ix.keys[2].pubkey.equals(user) ||
    !ix.keys[4].pubkey.equals(SystemProgram.programId) ||
    !ix.keys[5].pubkey.equals(expectedTokenProgram) ||
    !(mint?.equals(WSOL_MINT) || mint?.equals(quote.outputMint)) ||
    !(account?.equals(source) || account?.equals(destination)) ||
    !(ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 1))
  ) throw new Error('Swap requested an unexpected token account.');
}

function validateToken(ix: TransactionInstruction, user: PublicKey, source: PublicKey): void {
  const op = ix.data[0];
  if (op === 17 && ix.data.length === 1 && ix.keys.length === 1 && ix.keys[0].pubkey.equals(source)) return;
  if (op === 9 && ix.data.length === 1 && ix.keys.length === 3 &&
      ix.keys[0].pubkey.equals(source) && ix.keys[1].pubkey.equals(user) &&
      ix.keys[2].pubkey.equals(user)) return;
  throw new Error('Swap requested an unexpected direct token instruction.');
}

function validateRoute(
  ix: TransactionInstruction,
  quote: ExpectedSwap,
  user: PublicKey,
  source: PublicKey,
  destination: PublicKey,
): void {
  const data = Uint8Array.from(ix.data);
  const route = ROUTE_DISCRIMINATOR.every((byte, i) => data[i] === byte);
  const shared = SHARED_ROUTE_DISCRIMINATOR.every((byte, i) => data[i] === byte);
  if (!route && !shared) throw new Error('Swap returned an unsupported Jupiter route instruction.');
  const authorityIndex = shared ? 2 : 1;
  const sourceIndex = shared ? 3 : 2;
  const destinationIndex = shared ? 6 : 3;
  const mintIndex = shared ? 8 : 5;
  if (
    ix.keys.length <= mintIndex ||
    !ix.keys[0].pubkey.equals(TOKEN_PROGRAM) ||
    !ix.keys[authorityIndex].pubkey.equals(user) ||
    !ix.keys[sourceIndex].pubkey.equals(source) ||
    !ix.keys[destinationIndex].pubkey.equals(destination) ||
    !ix.keys[mintIndex].pubkey.equals(quote.outputMint)
  ) throw new Error('Swap route does not use your expected token accounts.');

  // Anchor's final arguments are fixed-width after its variable route plan.
  // Check the amount and on-chain minimum against the quote before signing.
  if (data.length < 31) throw new Error('Swap route data is incomplete.');
  const inAmount = u64(data, data.length - 19);
  const quotedOut = u64(data, data.length - 11);
  const slippage = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(data.length - 3, true);
  const platformFee = data[data.length - 1];
  if (inAmount !== BigInt(quote.inAmount) || quotedOut !== BigInt(quote.outAmount) ||
      slippage > Number(quote._raw.slippageBps) || platformFee !== 0) {
    throw new Error('Swap route amounts or slippage exceed the requested quote.');
  }
}

/** Fail closed on instructions outside a SOL-to-SAKURA Jupiter V6 swap. */
export function validateJupiterTransaction(
  tx: VersionedTransaction,
  quote: ExpectedSwap,
  user: PublicKey,
  lookupTables: AddressLookupTableAccount[] = [],
): void {
  const raw = quote._raw;
  const inAmount = BigInt(quote.inAmount);
  if (
    raw.inputMint !== WSOL_MINT.toBase58() || raw.outputMint !== quote.outputMint.toBase58() ||
    String(raw.inAmount) !== quote.inAmount || String(raw.outAmount) !== quote.outAmount ||
    raw.swapMode !== 'ExactIn' || !Number.isSafeInteger(Number(raw.slippageBps)) ||
    Number(raw.slippageBps) > 100 || inAmount <= 0n || BigInt(quote.outAmount) <= 0n
  ) throw new Error('Swap quote changed unexpectedly.');

  const message = tx.message;
  if (!message.staticAccountKeys[0]?.equals(user)) throw new Error('Swap fee payer does not match wallet.');
  if (message.header.numRequiredSignatures !== 1) throw new Error('Swap requested an unexpected signer.');
  const decoded = TransactionMessage.decompile(message, { addressLookupTableAccounts: lookupTables });
  const source = getAssociatedTokenAddressSync(WSOL_MINT, user);
  const destination = getAssociatedTokenAddressSync(quote.outputMint, user, false, quote.outputTokenProgram);
  let wrapped = 0n;
  let sawJupiter = false;
  let sawLimit = false;
  let sawPrice = false;
  for (const ix of decoded.instructions) {
    for (const account of ix.keys) {
      if (account.isSigner && !account.pubkey.equals(user)) {
        throw new Error('Swap requested an unexpected instruction signer.');
      }
    }
    const data = Uint8Array.from(ix.data);
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (ix.keys.length || !data.length) throw new Error('Swap compute budget is malformed.');
      if (data[0] === 2 && data.length === 5 && !sawLimit) {
        if (new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true) > MAX_COMPUTE_UNITS) {
          throw new Error('Swap compute limit is excessive.');
        }
        sawLimit = true;
      } else if (data[0] === 3 && data.length === 9 && !sawPrice) {
        if (u64(data, 1) * BigInt(MAX_COMPUTE_UNITS) > MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) {
          throw new Error('Swap priority fee is excessive.');
        }
        sawPrice = true;
      } else throw new Error('Swap compute budget contains an unexpected instruction.');
    } else if (ix.programId.equals(ATA_PROGRAM)) {
      validateAta(ix, user, source, destination, quote);
    } else if (ix.programId.equals(SystemProgram.programId)) {
      if (data.length !== 12 || ix.keys.length !== 2 ||
          new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) !== 2 ||
          !ix.keys[0].pubkey.equals(user) || !ix.keys[1].pubkey.equals(source)) {
        throw new Error('Swap requested an unexpected SOL transfer.');
      }
      wrapped += u64(data, 4);
      if (wrapped > inAmount) throw new Error('Swap tried to wrap more SOL than quoted.');
    } else if (ix.programId.equals(TOKEN_PROGRAM)) {
      validateToken(ix, user, source);
    } else if (ix.programId.equals(JUPITER_V6) && !sawJupiter) {
      validateRoute(ix, quote, user, source, destination);
      sawJupiter = true;
    } else {
      throw new Error('Swap transaction contains an unexpected program or extra route.');
    }
  }
  if (!sawJupiter || wrapped !== inAmount) {
    throw new Error('Swap transaction does not match the quoted SOL input and SAKURA output.');
  }
}
