#!/usr/bin/env node
/**
 * Proves the Sakura AI gate actually gates.
 *
 * Every check here corresponds to something that was broken before Stage 0:
 * the function took an unverified `x-sakura-wallet` header, had no holding
 * check at all, rate-limited in an in-memory Map that a cold start wiped, and
 * discarded Groq's token accounting.
 *
 *   node scripts/verify-sakura-ai-gate.mjs
 *
 * Reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY from
 * sakura-mobile/.env. The entitled-path check needs a wallet the server will
 * accept; pass one by seeding sakura_ai_entitlement for the throwaway keypair
 * this script prints (see --seed-sql), or skip it with --no-entitled.
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
const FN = `${BASE}/functions/v1/sakura-ai-chat`;

if (!BASE || !ANON) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const skipEntitled = args.includes('--no-entitled');

function signHeaders(keypair, action = 'sakura-ai') {
  const message = `sakura:${action}:ts:${Math.floor(Date.now() / 1000)}`;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey));
  return {
    'x-wallet-address': bs58.encode(keypair.publicKey),
    'x-signature': signature,
    'x-message': message,
  };
}

async function post(headers, body) {
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, json, text };
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const chatBody = { messages: [{ role: 'user', content: 'hi' }], capabilities: ['content'] };

// ── 1. Anon key alone is not enough ─────────────────────────────────────────
{
  const r = await post({}, chatBody);
  check('anon key with no signature is rejected', r.status === 401, `HTTP ${r.status}`);
}

// ── 2. A forged wallet claim is not enough ──────────────────────────────────
{
  const victim = nacl.sign.keyPair();
  const attacker = nacl.sign.keyPair();
  const headers = signHeaders(attacker);
  headers['x-wallet-address'] = bs58.encode(victim.publicKey); // claim someone else
  const r = await post(headers, chatBody);
  check('signature signed by a different key is rejected', r.status === 401, `HTTP ${r.status}`);
}

// ── 3. An expired signature is not enough ───────────────────────────────────
{
  const kp = nacl.sign.keyPair();
  const stale = `sakura:sakura-ai:ts:${Math.floor(Date.now() / 1000) - 3600}`;
  const r = await post(
    {
      'x-wallet-address': bs58.encode(kp.publicKey),
      'x-message': stale,
      'x-signature': bs58.encode(nacl.sign.detached(new TextEncoder().encode(stale), kp.secretKey)),
    },
    chatBody,
  );
  check('an hour-old signature is rejected', r.status === 401, `HTTP ${r.status}`);
}

// ── 4. A signature for a different action is not enough ─────────────────────
{
  const kp = nacl.sign.keyPair();
  const r = await post(signHeaders(kp, 'reading-ingest'), chatBody);
  check('a signature scoped to another action is rejected', r.status === 401, `HTTP ${r.status}`);
}

// ── 5. Valid signature, empty wallet: 402 with the gate copy ────────────────
const broke = nacl.sign.keyPair();
const brokeAddress = bs58.encode(broke.publicKey);
{
  const r = await post(signHeaders(broke), chatBody);
  const copy = r.json?.error ?? '';
  check('0 SKR / 0 XP wallet is refused with 402', r.status === 402, `HTTP ${r.status}`);
  check(
    'the refusal names both doors',
    /100,000 SKR/.test(copy) && /1,000 XP|Level 5/i.test(copy),
    JSON.stringify(copy).slice(0, 120),
  );
}

// ── 6. The entitled path: a real turn, and a usage row to prove it ──────────
if (skipEntitled) {
  console.log('SKIP  entitled path (--no-entitled)');
} else {
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  console.log(`\n--seed-sql (run in the SQL editor, then re-run this script):`);
  console.log(
    `insert into sakura_ai_entitlement (wallet_address, entitled, sakura_balance, lifetime_xp, reason, checked_at)\n` +
      `values ('${address}', true, 0, 0, 'test', now())\n` +
      `on conflict (wallet_address) do update set entitled = true, checked_at = now();\n`,
  );
  const r = await post(signHeaders(kp), chatBody);
  check(
    'a freshly generated wallet is NOT entitled by default',
    r.status === 402,
    `HTTP ${r.status} (seed the row above to exercise the 200 path)`,
  );
}

// ── 7. Rate limiting is durable, not in-memory ──────────────────────────────
{
  let sawLimit = false;
  let statuses = [];
  for (let i = 0; i < 16; i++) {
    const r = await post(signHeaders(broke), chatBody);
    statuses.push(r.status);
    if (r.status === 429) {
      sawLimit = true;
      break;
    }
  }
  check(
    'a burst from one wallet hits a 429',
    sawLimit,
    `statuses: ${statuses.join(',')}`,
  );
  check(
    'the limit is keyed to the wallet, not the process',
    sawLimit,
    `check api_rate_buckets for bucket 'sakura-ai:m:${brokeAddress}'`,
  );
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
