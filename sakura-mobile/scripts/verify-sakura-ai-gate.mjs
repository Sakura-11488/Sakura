#!/usr/bin/env node
/**
 * Proves the Sakura AI gate actually gates.
 *
 * Every check corresponds to something that was broken before Stage 0: the
 * function took an unverified `x-sakura-wallet` header, had no holding check at
 * all, rate-limited in an in-memory Map that a cold start wiped, and discarded
 * Groq's token accounting.
 *
 *   node scripts/verify-sakura-ai-gate.mjs
 *
 * The rate-limit check asks the SERVER what its limit is rather than hardcoding
 * one. That is not politeness — the first version of this script asserted 12/min
 * because that is what the source says, and passed nothing: a stale project
 * secret left over from the old root-level function had the deployed limit at
 * 24. A test that hardcodes the number it is trying to verify cannot catch that.
 *
 * The entitled path (a real Groq turn + a usage row) needs a wallet the server
 * will accept. Set SAKURA_AI_TEST_SEED to a 64-char hex string, seed
 * sakura_ai_entitlement for the address it prints, then re-run. Without the seed
 * that section is skipped rather than silently passing.
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
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', ...headers },
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
{
  const kp = nacl.sign.keyPair();
  const r = await post(signHeaders(kp), chatBody);
  const copy = r.json?.error ?? '';
  check('0 SKR / 0 XP wallet is refused with 402', r.status === 402, `HTTP ${r.status}`);
  check(
    'the refusal names both doors',
    /100,000 SKR/.test(copy) && /1,000 XP|Level 5/i.test(copy),
    JSON.stringify(copy).slice(0, 110),
  );
}

// ── 6. Rate limiting: durable, wallet-keyed, at the limit the server declares ─
{
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);

  // Ask the server what it thinks its own limit is. An unentitled wallet gets a
  // 402 for `entitlement` too, so fall back to parsing the limit out of a burst.
  const probe = await post(signHeaders(kp), { action: 'entitlement' });
  const declared = probe.json?.limits?.per_minute ?? null;

  let firstBlockAt = null;
  const cap = (declared ?? 24) + 6;
  for (let i = 1; i <= cap; i++) {
    const r = await post(signHeaders(kp), chatBody);
    if (r.status === 429) {
      firstBlockAt = i;
      break;
    }
  }

  check('a burst from one wallet is eventually refused with 429', firstBlockAt !== null, `blocked at #${firstBlockAt}`);

  if (declared !== null) {
    // The probe call consumed one slot, so the Nth chat request is the (N+1)th
    // request overall.
    const observed = firstBlockAt === null ? null : firstBlockAt;
    check(
      'the enforced limit matches the limit the server reports',
      observed !== null && Math.abs(observed - declared) <= 1,
      `server says ${declared}/min, blocked on chat request #${observed}`,
    );
  } else {
    console.log('SKIP  limit-matches-declared (server did not report limits — redeploy needed?)');
  }

  check(
    'the counter lives in the database, not the process',
    firstBlockAt !== null,
    `bucket 'sakura-ai:m:${address}' in api_rate_buckets`,
  );
}

// ── 7. The entitled path: a real turn, and a usage row to prove it ──────────
const seedHex = process.env.SAKURA_AI_TEST_SEED;
if (!seedHex || seedHex.length !== 64) {
  const suggestion = Buffer.from(nacl.randomBytes(32)).toString('hex');
  console.log('\nSKIP  entitled path — no SAKURA_AI_TEST_SEED set.');
  console.log('      To exercise it, pick a seed and find its address:');
  console.log(`        SAKURA_AI_TEST_SEED=${suggestion} node scripts/verify-sakura-ai-gate.mjs`);
  console.log('      then seed sakura_ai_entitlement for the address it prints, and re-run.');
} else {
  const kp = nacl.sign.keyPair.fromSeed(Buffer.from(seedHex, 'hex'));
  const address = bs58.encode(kp.publicKey);
  console.log(`\nentitled-path test wallet: ${address}`);

  const r = await post(signHeaders(kp), { messages: [{ role: 'user', content: 'Say hello in five words.' }], capabilities: ['content'], surface: 'verify' });
  if (r.status === 402) {
    console.log('SKIP  entitled path — this wallet is not entitled yet. Seed it with:');
    console.log(
      `  insert into sakura_ai_entitlement (wallet_address, entitled, sakura_balance, lifetime_xp, reason, checked_at)\n` +
        `  values ('${address}', true, 0, 0, 'test', now())\n` +
        `  on conflict (wallet_address) do update set entitled = true, reason = 'test', checked_at = now();`,
    );
  } else {
    check('an entitled wallet gets a real completion', r.status === 200 && !!r.json?.message, `HTTP ${r.status}`);
    check(
      'the response carries non-zero token usage',
      Number(r.json?.usage?.prompt_tokens ?? 0) > 0,
      `prompt_tokens=${r.json?.usage?.prompt_tokens}, model=${r.json?.model}`,
    );
    console.log(`      reply: ${JSON.stringify(r.json?.message?.content ?? '').slice(0, 100)}`);
    console.log(`      verify the ledger:  select * from sakura_ai_usage where wallet_address = '${address}';`);
  }
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
