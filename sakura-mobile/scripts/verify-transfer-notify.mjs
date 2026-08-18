#!/usr/bin/env node
/**
 * Proves notify-sakura-transfer cannot be made to lie about an amount.
 *
 *   node scripts/verify-transfer-notify.mjs
 *
 * The function had no authentication at all once: anyone who could reach the URL
 * could push "you received 50,000 SAKURA" to any wallet, naming any sender. A
 * signature closed the impersonation half. It did NOT close exaggeration —
 * `amount` came straight from the request body, so a real 1-token transfer could
 * be announced as fifty thousand. Nothing read the chain.
 *
 * These checks are all negative, and deliberately so: the positive path needs a
 * real settled transfer between two wallets with push tokens, which this script
 * must not create. What it can prove is that every way of asserting an amount
 * WITHOUT a matching on-chain transaction is refused.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, '..', '.env');

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv();
const BASE = (env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const ANON = env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const FN = `${BASE}/functions/v1/notify-sakura-transfer`;

if (!BASE || !ANON) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

function signHeaders(keypair, action = 'transfer-notify') {
  const message = `sakura:${action}:ts:${Math.floor(Date.now() / 1000)}`;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey));
  return {
    'x-wallet-address': bs58.encode(keypair.publicKey),
    'x-signature': signature,
    'x-message': message,
  };
}

const kp = nacl.sign.keyPair();
const ME = bs58.encode(kp.publicKey);
const VICTIM = 'G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1';

async function post(body, headers = signHeaders(kp)) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

const base = { asset: 'sakura', senderWallet: ME, receiverWallet: VICTIM, amount: 50000 };

// 1. Unsigned. The oldest hole, and the one that made this a phishing primitive.
{
  const r = await post(base, {});
  check('an unsigned request is rejected', r.status === 401, `HTTP ${r.status}`);
}

// 2. Signed, but claiming to be somebody else's transfer.
{
  const r = await post({ ...base, senderWallet: VICTIM, txid: '1'.repeat(88) });
  check('you cannot announce a transfer you did not send', r.status === 403, `HTTP ${r.status}`);
}

// 3. No txid at all — this used to be allowed, and is exactly what made the
//    amount unfalsifiable.
{
  const r = await post(base);
  check(
    'a notification without a transaction signature is refused',
    r.status === 400 && /signature is required/i.test(r.json?.error ?? ''),
    `HTTP ${r.status} ${JSON.stringify(r.json?.error ?? '')}`,
  );
}

// 4. A syntactically valid signature that does not exist on chain. The claim is
//    50,000 SAKURA; the chain has nothing to say about it.
{
  const fake = bs58.encode(nacl.sign.detached(new TextEncoder().encode('not a real transaction'), kp.secretKey));
  const r = await post({ ...base, txid: fake });
  check(
    'an amount backed by no on-chain transaction is refused',
    r.status === 503 || r.status === 400,
    `HTTP ${r.status} ${JSON.stringify(r.json?.reason ?? r.json?.error ?? '')}`,
  );
  check(
    'the refusal names why, rather than reporting a send',
    r.json?.sent === undefined,
    r.json?.sent === undefined ? 'no `sent` in the body' : `LEAKED sent=${r.json.sent}`,
  );
}

// 5. A REAL, confirmed mainnet transaction that this keypair did not sign. This
//    is the check that distinguishes "verifies the signature exists" from
//    "verifies the signature is yours" — a bug that would otherwise let anyone
//    quote any transfer on the chain as their own.
{
  // process.env first: this one is passed on the command line, not stored.
  const real = process.env.SAKURA_TEST_REAL_TXID || env.SAKURA_TEST_REAL_TXID;
  if (!real) {
    console.log('\nSKIP  someone else\'s real transaction — set SAKURA_TEST_REAL_TXID to a confirmed mainnet signature.');
  } else {
    const r = await post({ ...base, txid: real });
    check(
      "someone else's real transaction is refused",
      r.status === 400 && r.json?.reason === 'payer_mismatch',
      `HTTP ${r.status} ${JSON.stringify(r.json?.reason ?? r.json?.error ?? '')}`,
    );
  }
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
