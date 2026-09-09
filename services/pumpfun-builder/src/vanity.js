/**
 * The vanity mint pool: reserve one, decrypt it, hand it back on failure.
 *
 * The pool lives in Supabase (`vanity_mints`) as AES-256-GCM ciphertext. The
 * key lives ONLY here, in this service's environment, so a database compromise
 * on its own yields nothing usable.
 *
 * These are single-use throwaway keys that sign exactly one create instruction.
 * If one leaked, an attacker could create a token at that address first and
 * burn a pool slot; they could not touch a creator's wallet, their coin, or
 * their fees, because the creator signs separately as fee payer. That bounds
 * the damage — it is not a reason to be careless with them.
 */
import { createDecipheriv } from 'node:crypto';
import pkg from '@solana/web3.js';

const { Keypair, PublicKey } = pkg;

const SUFFIX = 'sakura';

/** Mirrors scripts/grind-vanity-mints.mjs: base64(iv[12] || tag[16] || ct). */
function decryptSecret(ciphertextB64, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('VANITY_MINT_ENCRYPTION_KEY must decode to 32 bytes');
  const raw = Buffer.from(ciphertextB64, 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('vanity secret ciphertext is too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

async function rpcCall(cfg, fn, body) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // The body can echo request detail; keep it short and never log the key.
    throw new Error(`${fn} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Take one mint out of the pool for this creator.
 *
 * The atomicity lives in the SQL function (FOR UPDATE SKIP LOCKED), not here —
 * two concurrent launches must never be handed the same address, and a
 * select-then-update in JavaScript would do exactly that.
 */
export async function reserveMint(cfg, creatorWallet) {
  const rows = await rpcCall(cfg, 'reserve_vanity_mint', { p_wallet: creatorWallet });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.public_key) {
    throw Object.assign(new Error('No vanity mint addresses left in the pool.'), { status: 503 });
  }

  const secret = decryptSecret(row.secret_encrypted, cfg.encryptionKey);
  let keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  } finally {
    secret.fill(0);
  }

  // Assert on the DERIVED key, never on the stored label. A row claiming a
  // `…sakura` public key proves nothing about the secret beside it, and signing
  // with a mismatched key produces a baffling on-chain failure.
  const derived = keypair.publicKey.toBase58();
  if (derived !== row.public_key) {
    throw new Error(`pool row ${row.public_key} decrypts to a different key — refusing it`);
  }
  if (!derived.endsWith(SUFFIX)) {
    throw new Error(`pool row ${derived} does not end in "${SUFFIX}" — refusing it`);
  }

  return { keypair, publicKey: new PublicKey(derived) };
}

/**
 * Return THIS reservation when the build fails after taking one.
 *
 * Targeted at a single public key on purpose. The obvious shortcut —
 * `release_stale_vanity_reservations(0)` — releases every reservation older
 * than zero minutes, which is all of them, including other creators' in-flight
 * launches. That would hand a mint to a second creator while the first is still
 * signing for it.
 *
 * Best-effort, and deliberately not a hard failure: losing a pool slot is
 * cheap, and throwing here would replace the caller's real error with a
 * bookkeeping one.
 */
export async function releaseReservation(cfg, publicKey, log) {
  try {
    await rpcCall(cfg, 'release_vanity_mint', { p_public_key: publicKey });
  } catch (e) {
    log?.warn?.('vanity-release-failed', { mint: publicKey, detail: String(e.message).slice(0, 160) });
  }
}
