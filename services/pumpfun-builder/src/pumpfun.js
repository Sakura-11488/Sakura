/**
 * Build a pump.fun `create_v2` instruction.
 *
 * EVERY CONSTANT HERE WAS DERIVED FROM MAINNET, not from documentation or
 * memory. The full derivation, the evidence, and the reproduction steps are in
 * `sakura-mobile/docs/pumpfun-create-v2.md`. Read that before changing anything
 * in this file.
 *
 * The one thing to carry in your head: the instruction is NOT called `create`.
 * `sha256("global:create")[0..8]` = 181ec828051c0777 is a real instruction that
 * still exists on the program, and using it produces a transaction that fails
 * on chain for no obvious reason. Live launches use `create_v2`. `buy` and
 * `sell` do match their naive discriminators, which is exactly what makes the
 * mistake easy to make.
 */
import { createHash } from 'node:crypto';
import pkg from '@solana/web3.js';

const { PublicKey, TransactionInstruction, ComputeBudgetProgram } = pkg;

export const PUMP_FUN = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const MAYHEM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
/** Token-2022, NOT classic SPL. New pump.fun mints carry metadata extensions. */
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

const seed = (s) => Buffer.from(s, 'utf8');
const discriminator = (name) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

/** Measured: the program consumes ~97-104k CU. Headroom, not a guess. */
export const CREATE_V2_CU_LIMIT = 160_000;

const pumpPda = (seeds) => PublicKey.findProgramAddressSync(seeds, PUMP_FUN)[0];
/**
 * Accounts 10-12 derive under the MAYHEM program, not pump.fun. Anchor encodes
 * this in the IDL's `pda.program` field, which is easy to skip — and skipping
 * it yields plausible-looking addresses that are simply wrong.
 */
const mayhemPda = (seeds) => PublicKey.findProgramAddressSync(seeds, MAYHEM)[0];

const associatedTokenAddress = (owner, mint) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN,
  )[0];

function borshString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/**
 * Derive every account `create_v2` needs from just the mint and the creator.
 * Exported so the caller can assert the mint it reserved is the one being used.
 */
export function createV2Accounts(mint, creator) {
  const bondingCurve = pumpPda([seed('bonding-curve'), mint.toBuffer()]);
  const mayhemState = mayhemPda([seed('mayhem-state'), mint.toBuffer()]);
  return {
    mint,
    mintAuthority: pumpPda([seed('mint-authority')]),
    bondingCurve,
    associatedBondingCurve: associatedTokenAddress(bondingCurve, mint),
    global: pumpPda([seed('global')]),
    user: creator,
    globalParams: mayhemPda([seed('global-params')]),
    solVault: mayhemPda([seed('sol-vault')]),
    mayhemState,
    // Not validated while is_mayhem_mode is false — simulation accepted a
    // random pubkey and rejected only the System Program, with ConstraintMut,
    // so the sole requirement is "writable and non-executable". The state's own
    // ATA is used anyway: it matches the account's name and stays correct if
    // pump.fun ever starts enforcing it.
    mayhemTokenVault: associatedTokenAddress(mayhemState, mint),
    eventAuthority: pumpPda([seed('__event_authority')]),
  };
}

/**
 * `create_v2`. Account ORDER is part of the ABI — do not sort or reorder.
 */
export function buildCreateV2Instruction({ mint, creator, name, symbol, uri }) {
  const a = createV2Accounts(mint, creator);

  const data = Buffer.concat([
    discriminator('create_v2'),
    borshString(name),
    borshString(symbol),
    borshString(uri),
    creator.toBuffer(),
    // is_mayhem_mode = false. True needs accounts this instruction does not
    // carry and fails with MissingAccount regardless of what else is passed.
    Buffer.from([0]),
    // is_cashback_enabled: OptionBool is a struct of one bool, so one byte.
    Buffer.from([0]),
  ]);

  return new TransactionInstruction({
    programId: PUMP_FUN,
    data,
    keys: [
      { pubkey: a.mint, isSigner: true, isWritable: true },
      { pubkey: a.mintAuthority, isSigner: false, isWritable: false },
      { pubkey: a.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: a.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: a.global, isSigner: false, isWritable: false },
      { pubkey: a.user, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN, isSigner: false, isWritable: false },
      { pubkey: MAYHEM, isSigner: false, isWritable: true },
      { pubkey: a.globalParams, isSigner: false, isWritable: false },
      { pubkey: a.solVault, isSigner: false, isWritable: true },
      { pubkey: a.mayhemState, isSigner: false, isWritable: true },
      { pubkey: a.mayhemTokenVault, isSigner: false, isWritable: true },
      { pubkey: a.eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN, isSigner: false, isWritable: false },
    ],
  });
}

export function computeBudgetInstructions(microLamports) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_V2_CU_LIMIT })];
  if (microLamports > 0) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  return ixs;
}

/** pump.fun's own limits. Rejecting here beats a confusing on-chain failure. */
export const LIMITS = { name: 32, symbol: 10, uri: 200 };
