import assert from 'node:assert/strict';
import test from 'node:test';
import web3 from '@solana/web3.js';
import { getPhoenixGlobalVaultAddress, PHOENIX_PROGRAM_ADDRESS } from '@ellipsis-labs/rise';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildCreateV2Instruction, computeBudgetInstructions } from '../../services/pumpfun-builder/src/pumpfun.js';
import { validateCreatorCoinTransaction } from '../lib/wallet/creator-coin-validation.ts';
import { validatePhoenixInstructions } from '../lib/wallet/phoenix-validation.ts';
import { validateJupiterTransaction } from '../lib/wallet/swap-validation.ts';
import { SAKURA_MINT_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from '../lib/wallet/addresses.ts';

const { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } = web3;
const SAKURA_MINT = new PublicKey(SAKURA_MINT_ADDRESS);
const SAKURA_TOKEN_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const intent = { name: 'Sakura Creator', symbol: 'SAKU', metadataUri: 'https://example.com/coin.json' };

function buildLaunch(extraInstructions = []) {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const tx = new Transaction({ feePayer: creator.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  tx.add(...computeBudgetInstructions(0));
  tx.add(buildCreateV2Instruction({
    mint: mint.publicKey,
    creator: creator.publicKey,
    name: intent.name,
    symbol: intent.symbol,
    uri: intent.metadataUri,
  }));
  for (const makeInstruction of extraInstructions) tx.add(makeInstruction(creator));
  tx.partialSign(mint);
  return { tx, creator, mint };
}

test('accepts the builder transaction that matches the creator request', () => {
  const { tx, creator, mint } = buildLaunch();
  assert.doesNotThrow(() => validateCreatorCoinTransaction(tx, creator, mint.publicKey, intent));
});

test('rejects a builder transaction with an added SOL transfer', () => {
  const { tx, creator, mint } = buildLaunch([
    (signer) => SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000_000,
    }),
  ]);
  assert.throws(() => validateCreatorCoinTransaction(tx, creator, mint.publicKey, intent), /extra instruction/);
});

test('rejects a changed symbol even with the expected mint signature', () => {
  const { tx, creator, mint } = buildLaunch();
  assert.throws(
    () => validateCreatorCoinTransaction(tx, creator, mint.publicKey, { ...intent, symbol: 'OTHER' }),
    /requested coin metadata/,
  );
});

test('rejects a changed create_v2 account even with the expected mint signature', () => {
  const { tx, creator, mint } = buildLaunch();
  tx.instructions[1].keys[11].pubkey = Keypair.generate().publicKey;
  tx.partialSign(mint);
  assert.throws(
    () => validateCreatorCoinTransaction(tx, creator, mint.publicKey, intent),
    /unexpected create_v2 account/,
  );
});

test('caps the priority fee requested by the builder', () => {
  const { tx, creator, mint } = buildLaunch();
  tx.instructions.splice(1, 0, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000_000 }));
  tx.partialSign(mint);
  assert.throws(() => validateCreatorCoinTransaction(tx, creator, mint.publicKey, intent), /excessive priority fee/);
});

const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function phoenixOrder(user) {
  return new TransactionInstruction({
    programId: new PublicKey(PHOENIX_PROGRAM_ADDRESS),
    keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.from([1]),
  });
}

function usdcTransfer(user, destination, amount) {
  const source = PublicKey.findProgramAddressSync(
    [user.publicKey.toBuffer(), tokenProgram.toBuffer(), usdcMint.toBuffer()], ataProgram,
  )[0];
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = 6;
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: user.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

test('accepts a pinned Phoenix close instruction without collateral transfer', async () => {
  const user = Keypair.generate();
  await assert.doesNotReject(validatePhoenixInstructions([phoenixOrder(user)], {}, user.publicKey));
});

test('rejects an unrelated program from the Phoenix API', async () => {
  const user = Keypair.generate();
  const unknown = new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.from([1]),
  });
  await assert.rejects(
    validatePhoenixInstructions([phoenixOrder(user), unknown], {}, user.publicKey),
    /unexpected program/,
  );
});

test('rejects an unexpected SOL transfer even when collateral was requested', async () => {
  const user = Keypair.generate();
  const transfer = SystemProgram.transfer({
    fromPubkey: user.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1_000_000_000,
  });
  await assert.rejects(
    validatePhoenixInstructions([phoenixOrder(user), transfer], { transferAmount: 1 }, user.publicKey),
    /unexpected program/,
  );
});

test('bounds a USDC collateral transfer to the Phoenix vault and requested amount', async () => {
  const user = Keypair.generate();
  const vault = new PublicKey(await getPhoenixGlobalVaultAddress(
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', PHOENIX_PROGRAM_ADDRESS,
  ));
  await assert.doesNotReject(validatePhoenixInstructions(
    [phoenixOrder(user), usdcTransfer(user, vault, 1_000_000)], { transferAmount: 1 }, user.publicKey,
  ));
  await assert.rejects(
    validatePhoenixInstructions(
      [phoenixOrder(user), usdcTransfer(user, Keypair.generate().publicKey, 1_000_000)],
      { transferAmount: 1 }, user.publicKey,
    ),
    /outside the requested USDC vault/,
  );
  await assert.rejects(
    validatePhoenixInstructions(
      [phoenixOrder(user), usdcTransfer(user, vault, 2_000_000)], { transferAmount: 1 }, user.publicKey,
    ),
    /outside the requested USDC vault/,
  );
});

const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
const jupiterProgram = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const swapQuote = {
  inAmount: '100000000', outAmount: '500000000',
  outputMint: SAKURA_MINT, outputTokenProgram: SAKURA_TOKEN_PROGRAM_ID,
  _raw: {
    inputMint: wsolMint.toBase58(), outputMint: SAKURA_MINT.toBase58(),
    inAmount: '100000000', outAmount: '500000000', swapMode: 'ExactIn', slippageBps: 100,
  },
};

function buildSwap(extra = []) {
  const user = Keypair.generate();
  const source = getAssociatedTokenAddressSync(wsolMint, user.publicKey);
  const destination = getAssociatedTokenAddressSync(SAKURA_MINT, user.publicKey, false, SAKURA_TOKEN_PROGRAM_ID);
  const routeData = Buffer.alloc(31);
  Buffer.from('e517cb977ae3ad2a', 'hex').copy(routeData, 0);
  routeData.writeBigUInt64LE(100_000_000n, 12);
  routeData.writeBigUInt64LE(500_000_000n, 20);
  routeData.writeUInt16LE(100, 28);
  const route = new TransactionInstruction({
    programId: jupiterProgram,
    keys: [
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: user.publicKey, isSigner: true, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: SAKURA_MINT, isSigner: false, isWritable: false },
    ],
    data: routeData,
  });
  const message = new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: source, lamports: 100_000_000 }),
      route,
      ...extra.map((make) => make(user)),
    ],
  }).compileToV0Message();
  return { user, tx: new VersionedTransaction(message) };
}

test('accepts a bounded SOL-to-SAKURA Jupiter route', () => {
  const { user, tx } = buildSwap();
  assert.doesNotThrow(() => validateJupiterTransaction(tx, swapQuote, user.publicKey));
});

test('rejects an extra SOL transfer in Jupiter transaction bytes', () => {
  const { user, tx } = buildSwap([signer => SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1_000_000_000,
  })]);
  assert.throws(() => validateJupiterTransaction(tx, swapQuote, user.publicKey), /unexpected SOL transfer/);
});

test('rejects a Jupiter route whose on-chain output quote is reduced', () => {
  const { user, tx } = buildSwap();
  const route = tx.message.compiledInstructions.find((ix) =>
    tx.message.staticAccountKeys[ix.programIdIndex].equals(jupiterProgram));
  new DataView(route.data.buffer, route.data.byteOffset, route.data.byteLength)
    .setBigUint64(route.data.length - 11, 1n, true);
  assert.throws(() => validateJupiterTransaction(tx, swapQuote, user.publicKey), /amounts or slippage/);
});
