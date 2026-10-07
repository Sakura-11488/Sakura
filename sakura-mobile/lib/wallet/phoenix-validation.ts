import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getPhoenixGlobalVaultAddress, PHOENIX_PROGRAM_ADDRESS } from '@ellipsis-labs/rise';
import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

const USDC_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT = new PublicKey(USDC_MINT_ADDRESS);
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;

export type PhoenixValidationRequest = { transferAmount?: number };

function pinnedProgram(): PublicKey {
  return new PublicKey(PHOENIX_PROGRAM_ADDRESS);
}

function validateComputeBudget(ix: TransactionInstruction): void {
  const data = Buffer.from(ix.data);
  if (ix.keys.length || !data.length) throw new Error('Phoenix returned a malformed compute budget instruction.');
  if (data[0] === 2 && data.length === 5) {
    if (data.readUInt32LE(1) > MAX_COMPUTE_UNITS) {
      throw new Error('Phoenix requested too many compute units.');
    }
    return;
  }
  if (data[0] === 3 && data.length === 9) {
    if (data.readBigUInt64LE(1) * BigInt(MAX_COMPUTE_UNITS) > MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) {
      throw new Error('Phoenix requested an excessive priority fee.');
    }
    return;
  }
  throw new Error('Phoenix returned an unexpected compute budget instruction.');
}

function validateAtaCreation(ix: TransactionInstruction, user: PublicKey): void {
  const data = Buffer.from(ix.data);
  const expectedAta = getAssociatedTokenAddressSync(USDC_MINT, user);
  if (
    ix.keys.length < 6 ||
    !ix.keys[0].pubkey.equals(user) ||
    !ix.keys[1].pubkey.equals(expectedAta) ||
    !ix.keys[2].pubkey.equals(user) ||
    !ix.keys[3].pubkey.equals(USDC_MINT) ||
    !ix.keys[4].pubkey.equals(SystemProgram.programId) ||
    !ix.keys[5].pubkey.equals(TOKEN_PROGRAM) ||
    !(data.length === 0 || (data.length === 1 && data[0] === 1))
  ) {
    throw new Error('Phoenix requested an unexpected token account creation.');
  }
}

async function validateUsdcTransfer(
  ix: TransactionInstruction,
  user: PublicKey,
  program: PublicKey,
  request: PhoenixValidationRequest,
): Promise<void> {
  if (!Number.isFinite(request.transferAmount) || (request.transferAmount ?? 0) <= 0) {
    throw new Error('Phoenix returned a token transfer when no collateral was requested.');
  }
  const data = Buffer.from(ix.data);
  const checked = data.length === 10 && data[0] === 12;
  const plain = data.length === 9 && data[0] === 3;
  if (!checked && !plain) throw new Error('Phoenix returned an unexpected token instruction.');

  const source = ix.keys[0]?.pubkey;
  const mint = checked ? ix.keys[1]?.pubkey : USDC_MINT;
  const destination = ix.keys[checked ? 2 : 1]?.pubkey;
  const authority = ix.keys[checked ? 3 : 2]?.pubkey;
  const expectedSource = getAssociatedTokenAddressSync(USDC_MINT, user);
  const expectedVaultAddress = await getPhoenixGlobalVaultAddress(
    USDC_MINT_ADDRESS as Parameters<typeof getPhoenixGlobalVaultAddress>[0],
    program.toBase58() as Parameters<typeof getPhoenixGlobalVaultAddress>[1],
  );
  const expectedVault = new PublicKey(expectedVaultAddress);
  const maxRawAmount = BigInt(Math.round((request.transferAmount ?? 0) * 1_000_000));
  const rawAmount = data.readBigUInt64LE(1);
  if (
    !source?.equals(expectedSource) ||
    !mint?.equals(USDC_MINT) ||
    !destination?.equals(expectedVault) ||
    !authority?.equals(user) ||
    (checked && data[9] !== 6) ||
    rawAmount === 0n ||
    rawAmount > maxRawAmount
  ) {
    throw new Error('Phoenix returned a collateral transfer outside the requested USDC vault and amount.');
  }
}

/** Reject instructions returned by the HTTP API that exceed this wallet's order request. */
export async function validatePhoenixInstructions(
  instructions: TransactionInstruction[],
  request: PhoenixValidationRequest,
  user: PublicKey,
): Promise<void> {
  const program = pinnedProgram();
  let sawPhoenix = false;
  for (const ix of instructions) {
    for (const account of ix.keys) {
      if (account.isSigner && !account.pubkey.equals(user)) {
        throw new Error('Phoenix returned an instruction with an unexpected signer.');
      }
    }
    if (ix.programId.equals(program)) {
      sawPhoenix = true;
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      validateComputeBudget(ix);
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM)) {
      validateAtaCreation(ix, user);
    } else if (ix.programId.equals(TOKEN_PROGRAM)) {
      await validateUsdcTransfer(ix, user, program, request);
    } else {
      throw new Error('Phoenix returned an instruction for an unexpected program.');
    }
  }
  if (!sawPhoenix) throw new Error('Phoenix transaction is missing the pinned Phoenix program.');
}
