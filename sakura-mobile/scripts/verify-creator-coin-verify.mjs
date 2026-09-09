#!/usr/bin/env node
/**
 * Prove creator-coin-verify's launch check accepts a real pump.fun launch and
 * rejects everything else.
 *
 *   node scripts/verify-creator-coin-verify.mjs
 *
 * Env: SOLANA_RPC (optional; falls back to public mainnet).
 *
 * WHY THIS EXISTS. The previous check was
 * `JSON.stringify(txResult).includes(value)` for the wallet and the mint — a
 * substring scan that proves those characters appear somewhere, not that a coin
 * was created. Any confirmed transaction mentioning both passed, and because
 * `creator_coins.mint_address` is UNIQUE, a false claim also permanently locked
 * out that mint's real owner.
 *
 * So the load-bearing assertion here is a REFUSAL: a real, confirmed, unrelated
 * transaction must be rejected. Testing only the happy path would have passed
 * against the broken version too.
 *
 * Read-only. It samples live mainnet, so it needs no fixtures to go stale.
 */

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CREATE_V2_DISCRIMINATOR = 'd6904cec5f8b31b4';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Kept byte-identical to the copy in supabase/functions/creator-coin-verify. */
function base58ToHexPrefix(value, bytes) {
  let n = 0n;
  for (const ch of value) {
    const i = B58.indexOf(ch);
    if (i < 0) return '';
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of value) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return out.slice(0, bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Kept in step with provesLaunch() in the edge function. */
function provesLaunch(tx, creatorWallet, mintAddress) {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  if (keys.length === 0) return 'Transaction has no account keys.';
  if (keys[0]?.pubkey !== creatorWallet) return 'The creator did not pay for this transaction.';
  const top = tx?.transaction?.message?.instructions ?? [];
  const inner = (tx?.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? []);
  for (const ix of [...top, ...inner]) {
    if (ix.programId !== PUMP_FUN_PROGRAM || !ix.data) continue;
    if (base58ToHexPrefix(ix.data, 8) !== CREATE_V2_DISCRIMINATOR) continue;
    if (ix.accounts?.[0] === mintAddress) return null;
  }
  return 'Transaction does not create this mint on pump.fun.';
}

/** What the OLD implementation did, kept only to demonstrate the regression. */
function oldSubstringCheck(tx, walletAddress, mintAddress) {
  const raw = JSON.stringify(tx);
  return raw.includes(walletAddress) && raw.includes(mintAddress);
}

let calls = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls += 1;
    let res;
    try {
      res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }),
      });
    } catch {
      // The public RPC drops connections under load. A transient network fault
      // is not a failed assertion, and treating it as one would make this
      // script cry wolf.
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }
  throw new Error(`${method}: rate limited`);
}

async function findSamples() {
  const tip = await rpc('getSlot', [{ commitment: 'finalized' }]);
  let launch = null;
  let other = null;
  for (let back = 0; back < 40 && (!launch || !other); back += 1) {
    let blk;
    try {
      blk = await rpc('getBlock', [tip - back, {
        encoding: 'jsonParsed', transactionDetails: 'full', rewards: false,
        maxSupportedTransactionVersion: 0, commitment: 'finalized',
      }]);
    } catch {
      continue;
    }
    if (!blk) continue;
    for (const t of blk.transactions ?? []) {
      if (t.meta?.err) continue;
      const ixs = t.transaction?.message?.instructions ?? [];
      const isLaunch = ixs.some(
        (ix) => ix.programId === PUMP_FUN_PROGRAM && ix.data &&
          base58ToHexPrefix(ix.data, 8) === CREATE_V2_DISCRIMINATOR,
      );
      if (isLaunch && !launch) {
        launch = { sig: t.transaction.signatures[0], tx: { ...t } };
      } else if (!isLaunch && !other && ixs.length > 0) {
        // Any ordinary confirmed transaction. This is the one that matters.
        other = { sig: t.transaction.signatures[0], tx: { ...t } };
      }
      if (launch && other) break;
    }
  }
  return { launch, other };
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  return ok;
};

const { launch, other } = await findSamples();
if (!launch) {
  console.error('No pump.fun create_v2 found in the sampled window. Re-run.');
  process.exit(2);
}

const lix = (launch.tx.transaction.message.instructions ?? []).find(
  (ix) => ix.programId === PUMP_FUN_PROGRAM && ix.data &&
    base58ToHexPrefix(ix.data, 8) === CREATE_V2_DISCRIMINATOR,
);
const mint = lix.accounts[0];
const creator = launch.tx.transaction.message.accountKeys[0].pubkey;

console.log('sampled a real launch');
console.log('  signature: ' + launch.sig);
console.log('  mint     : ' + mint);
console.log('  creator  : ' + creator + '\n');

console.log('accepts the genuine launch:');
check('real create_v2 with the right mint and payer', provesLaunch(launch.tx, creator, mint), null);

console.log('\nrefuses everything else:');
check(
  'a different mint on the same transaction',
  provesLaunch(launch.tx, creator, '11111111111111111111111111111111') !== null,
  true,
);
check(
  'a different creator on the same transaction',
  provesLaunch(launch.tx, '11111111111111111111111111111111', mint) !== null,
  true,
);

if (other) {
  console.log('\n  unrelated confirmed transaction: ' + other.sig.slice(0, 24) + '…');
  // Claim its own fee payer, so only the create_v2 check can reject it.
  const otherPayer = other.tx.transaction.message.accountKeys[0].pubkey;
  check('an ordinary confirmed transaction is not a launch', provesLaunch(other.tx, otherPayer, mint) !== null, true);

  // The regression itself: would the old check have let this through?
  const oldAccepts = oldSubstringCheck(other.tx, otherPayer, otherPayer);
  console.log(
    `\n  for contrast, the old substring check on that same transaction, ` +
      `asked about its own payer twice: ${oldAccepts ? 'ACCEPTS (this is the bug)' : 'rejects'}`,
  );
} else {
  console.log('\n  (no unrelated transaction sampled this run)');
}

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' CHECK(S) FAILED'}  — rpc calls: ${calls}`);
process.exit(failures === 0 ? 0 : 1);
