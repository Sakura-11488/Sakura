#!/usr/bin/env node
/**
 * Mint comped avatars for the wallets that were charged SAKURA and got nothing,
 * then record a one-time apology grant for each.
 *
 * Two bugs caused this, both of which took payment BEFORE the server committed
 * anything, so no row existed to find:
 *   - float-precision rejection in verify-sakura-payment (fixed 2026-08-13, v17)
 *   - the 24h rate limit returning 429 after the client had already paid
 *
 * SAFETY
 *   - Idempotent per wallet: re-running tops up to `avatars` rather than doubling.
 *   - Never writes shown_at / resolved_at, so it cannot re-prompt someone who
 *     has already made their choice.
 *   - --dry-run prints the plan and touches nothing.
 *
 * USAGE
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... AVATAR_ADMIN_TEST_SECRET=... \
 *     node scripts/issue-avatar-apology-grants.mjs [--dry-run] [--only=<wallet>]
 *
 * REMOVE AVATAR_ADMIN_TEST_SECRET FROM SUPABASE AFTERWARDS. While it is set,
 * resolveMintContext returns before verifyWalletHeaders, so anyone holding it
 * can mint to any wallet with no signature at all.
 */
const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.AVATAR_ADMIN_TEST_SECRET;
const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

/**
 * The refund is sent MANUALLY by the operator, outside this script.
 * Set `refund` to 0 for any wallet you have not actually paid: the apology modal
 * only claims a refund when refund_sakura > 0, and when it is > 0 it also drops
 * the "your original payment is still claimable" line, so the user is not
 * invited to redeem a payment they have already been reimbursed for.
 */
const GRANTS = [
  {
    wallet: 'GBwEZYyqSy3hMYZKnYK4hEnkyCRSKzK9HYdSjKsP3sST',
    avatars: 4, charged: 100000, refund: 100000, received: 0,
    incident: 'charged_without_delivery',
    sigs: ['2W1A6iUBTrNSVpKr1nsTCcNnmTxtJD8DxEmVsjiK8WSyMGo8BSwFxpf3yzcm7fCbFu6Fj9KxUyxYxFizYuyyyeAG'],
    note: '2026-08-11 float-precision rejection. Reported the bug. Received nothing.',
  },
  {
    wallet: '89JdgtH9LKuTtefhQZx7VrQ3DnQdpyKp6hjtXFduV2Z1',
    avatars: 4, charged: 100000, refund: 100000, received: 1,
    incident: 'charged_twice_delivered_once',
    sigs: ['3FarPrXr86y1Au1PRQvjMG9edarupcrdiZQgeTTiXX6yJqTtQPkpYLMKciMpK59hpzGBvR185xRguKk43b9CS6hk'],
    note: '2026-06-24 float-precision rejection. Paid twice, delivered once.',
  },
  {
    wallet: 'BNa19q59iGFfBvY6KoDpWJdthDkEVCLPGk8XHXAvnYZM',
    avatars: 4, charged: 100000, refund: 100000, received: 1,
    incident: 'charged_twice_delivered_once',
    sigs: ['Qgi4ZaaU6uL7rgWasMdSbnT543ezpafZvRCU3wZ4xfzqbYzQ4XHTKPPex86sMxnTn8jy2NK4xnySwTPiVMkrvUd'],
    note: '2026-06-24 float-precision rejection. Paid twice, delivered once.',
  },
  {
    wallet: 'J4oXmhjZk9YR3wERQUiHPdMBbXeQqfRFVKq57GsMeWVa',
    avatars: 4, charged: 100000, refund: 100000, received: 2,
    incident: 'charged_twice_delivered_once',
    sigs: ['1Sddo2NpF48sPVnYXB5W6q5iH86AbSzkprqbdWD86hhit9AZ29V9e6Bf2rtAXCuBbp6tvgjpfD6AqzXEavFVVXf'],
    note: '2026-06-19 rate-limit 429 after payment. Paid three times, delivered twice.',
  },
];

/** Distinct hints, otherwise the four portraits come out near-identical. */
const LOOKS = [
  { mode: 'tastes', name: 'Sakura Sorry 1', hint: 'moonlit rooftop, cool silver tones, calm' },
  { mode: 'general', name: 'Sakura Sorry 2', hint: 'cool blue night city, quiet confidence' },
  { mode: 'tastes', name: 'Sakura Sorry 3', hint: 'warm sunset gold, gentle smile' },
  { mode: 'general', name: 'Sakura Sorry 4', hint: 'deep violet starfield, sharp gaze' },
  { mode: 'tastes', name: 'Sakura Sorry 5', hint: 'soft dawn pink, hopeful' },
  { mode: 'general', name: 'Sakura Sorry 6', hint: 'emerald forest dusk, watchful' },
];

if (!URL_BASE || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(2);
}
if (!ADMIN_SECRET && !DRY) {
  console.error('AVATAR_ADMIN_TEST_SECRET is required. Set it in Supabase, and REMOVE IT after this run.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, init = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function mintOne(wallet, look) {
  const r = await fetch(`${URL_BASE}/functions/v1/generate-user-avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-avatar-admin-test': ADMIN_SECRET },
    body: JSON.stringify({
      action: 'generate',
      mode: look.mode,
      hint: look.hint,
      nft_name: look.name,
      recipient_wallet: wallet,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.status !== 'ready') {
    throw new Error(`HTTP ${r.status}: ${body.error || JSON.stringify(body).slice(0, 200)}`);
  }
  return body.id;
}

(async () => {
  const targets = GRANTS.filter((g) => !ONLY || g.wallet === ONLY);
  if (!targets.length) {
    console.error('No matching wallet.');
    process.exit(2);
  }
  console.log(`${DRY ? '[DRY RUN] ' : ''}${targets.length} wallet(s)\n`);

  for (const g of targets) {
    // Comped rows only. Never count an avatar the user actually paid for.
    const existing = await rest(
      `user_avatar_generations?wallet_address=eq.${g.wallet}` +
        '&status=eq.ready&payment_amount_sakura=eq.0&select=id,created_at&order=created_at.desc',
    );
    const have = existing.map((r) => r.id);
    const need = Math.max(0, g.avatars - have.length);

    console.log(g.wallet);
    console.log(
      `  comped already: ${have.length}   to mint now: ${need}   ` +
        `refund recorded: ${g.refund.toLocaleString()} SKR`,
    );
    if (DRY) {
      console.log('');
      continue;
    }

    const ids = [...have];
    for (let i = 0; i < need; i++) {
      const look = LOOKS[(have.length + i) % LOOKS.length];
      process.stdout.write(`  minting ${i + 1}/${need} (${look.name})... `);
      try {
        ids.push(await mintOne(g.wallet, look));
        console.log('ok');
      } catch (e) {
        console.log(`FAILED - ${e.message}`);
      }
      await sleep(1500);
    }

    if (ids.length < g.avatars) {
      console.log(`  SKIPPING grant row: only ${ids.length}/${g.avatars} minted. Re-run to top up.\n`);
      continue;
    }

    // Upsert. Deliberately never writes shown_at / resolved_at / resolution, so
    // re-running can never un-resolve a grant and re-prompt someone who decided.
    await rest('avatar_apology_grants?on_conflict=wallet_address', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([
        {
          wallet_address: g.wallet,
          incident: g.incident,
          avatar_count: g.avatars,
          charged_sakura: g.charged,
          refund_sakura: g.refund,
          received_count: g.received,
          payment_tx_signatures: g.sigs,
          generation_ids: ids.slice(0, g.avatars),
          note: g.note,
          minted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]),
    });
    console.log(`  grant recorded (${ids.length} avatars)\n`);
  }

  console.log(
    DRY
      ? 'Dry run only - nothing changed.'
      : 'Done. NOW REMOVE AVATAR_ADMIN_TEST_SECRET from Supabase.',
  );
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
