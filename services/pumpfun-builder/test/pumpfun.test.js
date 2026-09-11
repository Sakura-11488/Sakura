/**
 * Offline checks on the create_v2 builder. No network, no signatures.
 *
 * The golden values are real mainnet observations, not invention. If pump.fun
 * changes the layout again — it already changed `create` -> `create_v2` once —
 * these fail, which is the entire point of pinning them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '@solana/web3.js';
import {
  buildCreateV2Instruction,
  createV2Accounts,
  PUMP_FUN,
  TOKEN_2022,
  MAYHEM,
} from '../src/pumpfun.js';

const { PublicKey, Keypair } = pkg;

// Observed on chain, constant across every sampled launch.
const OBSERVED = {
  mintAuthority: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  global: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
  globalParams: '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ',
  solVault: 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s',
  eventAuthority: 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
};

// A real launch: mint and creator taken from a confirmed mainnet create_v2,
// with the two per-launch PDAs that were derived and matched against it.
const REAL = {
  mint: '6J3k3aeatRCFQrSVPNUYQHC9DAhuHgvf1yk4ejMipump',
  creator: 'jAWjap1jBXDm8wL2Qfped3j4ASa5nhKv5vmwm4gmTx4',
  bondingCurve: '8UiH4iaTQUC5spJH3VzjxXpzmWc1rESGMnzaoLEHe7Yo',
  associatedBondingCurve: '3Eo7DkxwqvNdVoVg7iAu1n3T29c4tDKGJesdbE2jFeD5',
};

test('constant accounts match what mainnet actually uses', () => {
  const a = createV2Accounts(new PublicKey(REAL.mint), new PublicKey(REAL.creator));
  assert.equal(a.mintAuthority.toBase58(), OBSERVED.mintAuthority);
  assert.equal(a.global.toBase58(), OBSERVED.global);
  assert.equal(a.globalParams.toBase58(), OBSERVED.globalParams);
  assert.equal(a.solVault.toBase58(), OBSERVED.solVault);
  assert.equal(a.eventAuthority.toBase58(), OBSERVED.eventAuthority);
});

test('per-launch PDAs reproduce a real confirmed launch', () => {
  const a = createV2Accounts(new PublicKey(REAL.mint), new PublicKey(REAL.creator));
  assert.equal(a.bondingCurve.toBase58(), REAL.bondingCurve);
  assert.equal(a.associatedBondingCurve.toBase58(), REAL.associatedBondingCurve);
});

test('global_params and sol_vault derive under MAYHEM, not pump.fun', () => {
  // The bug this guards: deriving them under pump.fun yields plausible-looking
  // addresses that are simply wrong, and nothing complains until the chain does.
  const wrongGlobalParams = PublicKey.findProgramAddressSync(
    [Buffer.from('global-params')],
    PUMP_FUN,
  )[0].toBase58();
  assert.notEqual(wrongGlobalParams, OBSERVED.globalParams);

  const rightGlobalParams = PublicKey.findProgramAddressSync(
    [Buffer.from('global-params')],
    MAYHEM,
  )[0].toBase58();
  assert.equal(rightGlobalParams, OBSERVED.globalParams);
});

test('instruction shape: program, 16 accounts, correct signers and fee payer slot', () => {
  const mint = new PublicKey(REAL.mint);
  const creator = new PublicKey(REAL.creator);
  const ix = buildCreateV2Instruction({
    mint,
    creator,
    name: 'Test',
    symbol: 'TEST',
    uri: 'https://example.com/m.json',
  });

  assert.equal(ix.programId.toBase58(), PUMP_FUN.toBase58());
  assert.equal(ix.keys.length, 16, 'account count is part of the ABI');

  assert.equal(ix.keys[0].pubkey.toBase58(), mint.toBase58());
  assert.ok(ix.keys[0].isSigner, 'the mint must sign — this is why a vanity keypair works');
  assert.ok(ix.keys[0].isWritable);

  assert.equal(ix.keys[5].pubkey.toBase58(), creator.toBase58());
  assert.ok(ix.keys[5].isSigner, 'the creator must sign');
  assert.ok(ix.keys[5].isWritable);

  // Exactly two signers, and they are the mint and the creator. A third signer
  // would mean the transaction cannot be completed on the creator's device.
  const signers = ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
  assert.deepEqual(new Set(signers), new Set([mint.toBase58(), creator.toBase58()]));

  assert.equal(ix.keys[7].pubkey.toBase58(), TOKEN_2022.toBase58(), 'Token-2022, not classic SPL');
  assert.equal(ix.keys[15].pubkey.toBase58(), PUMP_FUN.toBase58());
});

test('discriminator is create_v2, and explicitly NOT create', () => {
  const ix = buildCreateV2Instruction({
    mint: new PublicKey(REAL.mint),
    creator: new PublicKey(REAL.creator),
    name: 'Test',
    symbol: 'TEST',
    uri: 'https://example.com/m.json',
  });
  const disc = ix.data.subarray(0, 8).toString('hex');
  assert.equal(disc, 'd6904cec5f8b31b4', 'live launches use create_v2');
  assert.notEqual(disc, '181ec828051c0777', 'that is `create`, which is not the live path');
});

test('args encode as Borsh, with mayhem off and the two trailing flag bytes', () => {
  const creator = new PublicKey(REAL.creator);
  const ix = buildCreateV2Instruction({
    mint: new PublicKey(REAL.mint),
    creator,
    name: 'Ab',
    symbol: 'XY',
    uri: 'https://e.co/m',
  });
  let o = 8;
  const readStr = () => {
    const len = ix.data.readUInt32LE(o);
    o += 4;
    const s = ix.data.subarray(o, o + len).toString('utf8');
    o += len;
    return s;
  };
  assert.equal(readStr(), 'Ab');
  assert.equal(readStr(), 'XY');
  assert.equal(readStr(), 'https://e.co/m');
  assert.equal(ix.data.subarray(o, o + 32).toString('hex'), creator.toBuffer().toString('hex'));
  o += 32;
  assert.equal(ix.data[o], 0, 'is_mayhem_mode must be false — true fails with MissingAccount');
  assert.equal(ix.data[o + 1], 0, 'is_cashback_enabled: OptionBool is one byte');
  assert.equal(ix.data.length, o + 2, 'no trailing junk');
});

test('a different mint changes only the per-launch accounts', () => {
  const creator = new PublicKey(REAL.creator);
  const a = createV2Accounts(Keypair.generate().publicKey, creator);
  const b = createV2Accounts(Keypair.generate().publicKey, creator);
  assert.notEqual(a.bondingCurve.toBase58(), b.bondingCurve.toBase58());
  assert.notEqual(a.mayhemState.toBase58(), b.mayhemState.toBase58());
  assert.equal(a.global.toBase58(), b.global.toBase58());
  assert.equal(a.solVault.toBase58(), b.solVault.toBase58());
});
