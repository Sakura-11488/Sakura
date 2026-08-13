#!/usr/bin/env node
/**
 * Reconcile SAKURA payments against delivered avatars / fan-art.
 *
 * WHY THIS EXISTS
 * ---------------
 * verifyAvatarSakuraPayment runs BEFORE the generation row is inserted, so a
 * rejected payment leaves NO trace in Postgres: the user's SAKURA is gone, and
 * the only record anywhere is the on-chain transfer. A float-precision bug in
 * that verifier silently ate 3 payments (300,000 SAKURA) across 7 weeks before
 * a user happened to report it.
 *
 * The only way to detect this class of failure is to compare the CHAIN against
 * the DATABASE. That is what this does.
 *
 * USAGE
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... [SOLANA_RPC=...] \
 *     node scripts/reconcile-avatar-payments.mjs [--limit 200]
 *
 * Exit code 1 if any unreconciled payment is found, so it can gate CI/cron.
 */
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TREASURY = process.env.AVATAR_PAYMENT_WALLET || 'G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1';
const MINT = process.env.SAKURA_MINT || 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
const MIN_SKR = Number(process.env.MIN_PAYMENT_SKR || 40_000);  // below fan-art's 50k floor
const MAX_SKR = Number(process.env.MAX_PAYMENT_SKR || 1_000_000); // above it is a treasury top-up, not a user payment
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 200);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(2);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const rawAmount = (b) => { const a = b?.uiTokenAmount?.amount; if (!a) return 0n; try { return BigInt(a); } catch { return 0n; } };

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  // 1. Treasury's SAKURA token account(s)
  const owned = await rpc('getTokenAccountsByOwner',
    [TREASURY, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }]);
  const atas = owned.value.filter(a => a.account.data.parsed.info.mint === MINT).map(a => a.pubkey);
  if (!atas.length) { console.error('No Token-2022 SAKURA account found for treasury.'); process.exit(2); }

  // 2. Incoming payments on chain
  const seen = new Set(); const payments = [];
  for (const ata of atas) {
    let before;
    for (let page = 0; page < Math.ceil(LIMIT / 50); page++) {
      const sigs = await rpc('getSignaturesForAddress', [ata, before ? { limit: 50, before } : { limit: 50 }]);
      if (!sigs.length) break;
      before = sigs[sigs.length - 1].signature;
      for (const s of sigs) {
        if (seen.has(s.signature) || s.err) continue;
        seen.add(s.signature);
        await sleep(120);
        const tx = await rpc('getTransaction', [s.signature,
          { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]).catch(() => null);
        if (!tx?.meta) continue;
        const post = tx.meta.postTokenBalances ?? [], pre = tx.meta.preTokenBalances ?? [];
        const pe = post.find(b => b.mint === MINT && b.owner === TREASURY);
        if (!pe) continue;
        const p = pre.find(b => b.accountIndex === pe.accountIndex && b.mint === MINT);
        const delta = rawAmount(pe) - rawAmount(p);
        if (delta < BigInt(MIN_SKR) * 1000000n) continue;
        if (delta > BigInt(MAX_SKR) * 1000000n) continue; // treasury funding, not a purchase
        const keys = tx.transaction.message.accountKeys;
        const payer = typeof keys[0] === 'string' ? keys[0] : keys[0].pubkey;
        if (payer === TREASURY) continue; // treasury's own outbound/internal moves
        payments.push({ sig: s.signature, payer, skr: Number(delta) / 1e6,
          when: new Date(tx.blockTime * 1000).toISOString().slice(0, 19) });
      }
      await sleep(200);
    }
  }

  // 3. What the DB knows about.
  //
  // A generation row existing is NOT the same as an avatar being delivered:
  // 'failed' rows are mints that blew up after the charge. And since 2026-08-13
  // the function records every attributable refusal in avatar_payment_rejections,
  // so most losses now surface within seconds instead of seven weeks.
  const avatarRows = await sb('user_avatar_generations?select=payment_tx_signature,wallet_address,status');
  const delivered = new Set(
    avatarRows.filter(r => r.payment_tx_signature && r.status !== 'failed')
              .map(r => r.payment_tx_signature),
  );

  let rejections = [];
  try {
    rejections = await sb('avatar_payment_rejections?select=payment_tx_signature,wallet_address,stage,reason,credited_sakura,created_at');
  } catch { /* table not migrated yet */ }
  const recorded = new Map(rejections.map(r => [r.payment_tx_signature, r]));

  // 4. Anything paid but never delivered, split by whether the server noticed.
  const undelivered = payments.filter(p => !delivered.has(p.sig));
  const known   = undelivered.filter(p => recorded.has(p.sig));
  const orphans = undelivered.filter(p => !recorded.has(p.sig));

  console.log(`on-chain payments >=${MIN_SKR.toLocaleString()} SKR : ${payments.length}`);
  console.log(`delivered (row exists, not failed)    : ${payments.length - undelivered.length}`);
  console.log(`RECORDED refusals (paid, refused)     : ${known.length}`);
  console.log(`UNRECONCILED (paid, no trace at all)  : ${orphans.length}\n`);

  for (const k of known) {
    const row = recorded.get(k.sig);
    console.log(`  [${row.stage}] ${k.when}  ${k.payer}  ${k.skr.toLocaleString()} SKR`);
    console.log(`    ${k.sig}`);
    console.log(`    reason: ${row.reason}`);
  }
  if (known.length && orphans.length) console.log('');
  for (const o of orphans) {
    console.log(`  [no row]   ${o.when}  ${o.payer}  ${o.skr.toLocaleString()} SKR`);
    console.log(`    ${o.sig}`);
  }

  if (undelivered.length) {
    const total = undelivered.reduce((a, o) => a + o.skr, 0);
    console.log(`\n  TOTAL OWED: ${total.toLocaleString()} SAKURA`);
    console.log('  Each signature is still claimable by its original payer (feePayer must match),');
    console.log('  so a retry through the app delivers without charging again.');
    console.log('');
    console.log('  Two known causes, both of which charge BEFORE the server commits anything:');
    console.log('    1. float-precision rejection in verifyAvatarSakuraPayment (fixed 2026-08-13)');
    console.log('    2. the 24h RATE_LIMIT_HOURS 429, returned after the client has already paid');
    if (orphans.length) {
      console.log('');
      console.log('  "no row" entries predate the refusal audit, or the client paid and never');
      console.log('  reached the server at all. Anything dated after 2026-08-13 is a NEW gap.');
    }
  }

  // 5. Apology grants issued but never actually shown to the user. A mistyped
  // generation id in the grant row, or one mint that failed, leaves the card
  // permanently unshowable and silent. Nothing else in the system looks.
  let staleGrants = [];
  try {
    const grants = await sb('avatar_apology_grants?select=wallet_address,granted_at,shown_at,resolved_at,avatar_count,generation_ids&resolved_at=is.null');
    const dayAgo = Date.now() - 86_400_000;
    staleGrants = grants.filter(g => !g.shown_at && new Date(g.granted_at).getTime() < dayAgo);
    if (staleGrants.length) {
      console.log(`\n  STALE APOLOGY GRANTS (issued >24h ago, never shown): ${staleGrants.length}`);
      for (const g of staleGrants) {
        console.log(`    ${g.wallet_address}  granted ${String(g.granted_at).slice(0, 19)}  ` +
          `${(g.generation_ids || []).length}/${g.avatar_count} generation ids`);
      }
      console.log('    Check every generation id is a status=ready row owned by that wallet.');
    }
  } catch { /* table not migrated yet */ }

  process.exit(undelivered.length || staleGrants.length ? 1 : 0);
})().catch(e => { console.error('reconcile failed:', e.message); process.exit(2); });
