import { Buffer } from 'buffer';
import {
  ComputeBudgetProgram,
  PublicKey,
  type Keypair,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MAYHEM_PROGRAM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
const CREATE_V2_DISCRIMINATOR = Uint8Array.from(Buffer.from('d6904cec5f8b31b4', 'hex'));
const CREATE_V2_CU_LIMIT = 160_000;
const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;

export type ExpectedCreatorCoinLaunch = {
  name: string;
  symbol: string;
  metadataUri: string;
};

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function borshString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const result = new Uint8Array(4 + encoded.length);
  new DataView(result.buffer).setUint32(0, encoded.length, true);
  result.set(encoded, 4);
  return result;
}

function expectedCreateData(intent: ExpectedCreatorCoinLaunch, creator: PublicKey): Uint8Array {
  return concatenate([
    CREATE_V2_DISCRIMINATOR,
    borshString(intent.name.trim()),
    borshString(intent.symbol.trim()),
    borshString(intent.metadataUri.trim()),
    creator.toBytes(),
    new Uint8Array([0, 0]), // mayhem mode and cashback are both disabled
  ]);
}

function pda(program: PublicKey, ...seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

function seed(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function tokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  return pda(ASSOCIATED_TOKEN_PROGRAM, owner.toBytes(), TOKEN_2022_PROGRAM.toBytes(), mint.toBytes());
}

function expectedCreateAccounts(creator: PublicKey, mint: PublicKey): Array<[PublicKey, boolean]> {
  const curve = pda(PUMP_FUN_PROGRAM, seed('bonding-curve'), mint.toBytes());
  const mayhemState = pda(MAYHEM_PROGRAM, seed('mayhem-state'), mint.toBytes());
  return [
    [mint, true],
    [pda(PUMP_FUN_PROGRAM, seed('mint-authority')), false],
    [curve, true],
    [tokenAccount(curve, mint), true],
    [pda(PUMP_FUN_PROGRAM, seed('global')), false],
    [creator, true],
    [SYSTEM_PROGRAM, false],
    [TOKEN_2022_PROGRAM, false],
    [ASSOCIATED_TOKEN_PROGRAM, false],
    [MAYHEM_PROGRAM, true],
    [pda(MAYHEM_PROGRAM, seed('global-params')), false],
    [pda(MAYHEM_PROGRAM, seed('sol-vault')), true],
    [mayhemState, true],
    [tokenAccount(mayhemState, mint), true],
    [pda(PUMP_FUN_PROGRAM, seed('__event_authority')), false],
    [PUMP_FUN_PROGRAM, false],
  ];
}

function validateCreateInstruction(
  instruction: TransactionInstruction,
  creator: PublicKey,
  mint: PublicKey,
  intent: ExpectedCreatorCoinLaunch,
): void {
  if (!instruction.programId.equals(PUMP_FUN_PROGRAM)) {
    throw new Error('Launch transaction contains an unexpected program.');
  }
  if (instruction.keys.length !== 16) {
    throw new Error('Launch transaction has an unexpected create_v2 account list.');
  }
  const expectedAccounts = expectedCreateAccounts(creator, mint);
  for (let i = 0; i < instruction.keys.length; i++) {
    const account = instruction.keys[i];
    const [expectedKey, expectedWritable] = expectedAccounts[i];
    if (!account.pubkey.equals(expectedKey) || account.isWritable !== expectedWritable ||
        account.isSigner !== (i === 0 || i === 5)) {
      throw new Error('Launch transaction has an unexpected create_v2 account.');
    }
  }
  const expectedData = expectedCreateData(intent, creator);
  if (instruction.data.length !== expectedData.length ||
      instruction.data.some((byte, index) => byte !== expectedData[index])) {
    throw new Error('Launch transaction does not match the requested coin metadata.');
  }
}

/** Validate every instruction before the creator signs bytes supplied by the builder. */
export function validateCreatorCoinTransaction(
  tx: Transaction,
  keypair: Keypair,
  mint: PublicKey,
  intent: ExpectedCreatorCoinLaunch,
): void {
  const creator = keypair.publicKey;
  if (!tx.feePayer?.equals(creator)) {
    throw new Error('Launch transaction fee payer does not match your wallet.');
  }
  const signers = tx.signatures.map((slot) => slot.publicKey.toBase58());
  if (
    signers.length !== 2 ||
    !signers.includes(creator.toBase58()) ||
    !signers.includes(mint.toBase58())
  ) {
    throw new Error('Launch transaction has an unexpected signer.');
  }
  if (!tx.signatures.find((slot) => slot.publicKey.equals(mint))?.signature) {
    throw new Error('Launch transaction is missing the mint signature.');
  }
  if (!tx.verifySignatures(false)) {
    throw new Error('Launch transaction has an invalid mint signature.');
  }

  let sawLimit = false;
  let sawPrice = false;
  let sawCreate = false;
  for (const instruction of tx.instructions) {
    if (instruction.programId.equals(ComputeBudgetProgram.programId)) {
      const data = Buffer.from(instruction.data);
      if (instruction.keys.length || !data.length) {
        throw new Error('Launch transaction has a malformed compute budget instruction.');
      }
      if (data[0] === 2 && data.length === 5 && !sawLimit) {
        if (data.readUInt32LE(1) !== CREATE_V2_CU_LIMIT) {
          throw new Error('Launch transaction changed the compute limit.');
        }
        sawLimit = true;
      } else if (data[0] === 3 && data.length === 9 && !sawPrice) {
        const microLamports = data.readBigUInt64LE(1);
        if (microLamports * BigInt(CREATE_V2_CU_LIMIT) > MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) {
          throw new Error('Launch transaction requests an excessive priority fee.');
        }
        sawPrice = true;
      } else {
        throw new Error('Launch transaction has an unexpected compute budget instruction.');
      }
    } else if (!sawCreate) {
      validateCreateInstruction(instruction, creator, mint, intent);
      sawCreate = true;
    } else {
      throw new Error('Launch transaction contains an extra instruction.');
    }
  }
  if (!sawLimit || !sawCreate) {
    throw new Error('Launch transaction is missing the expected create_v2 instructions.');
  }
}
