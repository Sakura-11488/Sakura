#!/usr/bin/env node
/**
 * Fill the `vanity_mints` pool with keypairs whose public key ends in `sakura`.
 *
 *   node scripts/grind-vanity-mints.mjs --measure
 *   node scripts/grind-vanity-mints.mjs --count 5
 *   node scripts/grind-vanity-mints.mjs --from-dir ./ground
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VANITY_MINT_ENCRYPTION_KEY.
 *
 * RUN THIS ON A MACHINE YOU CONTROL. It generates private keys. They are
 * single-use throwaways that only ever sign one pump.fun create instruction —
 * an attacker holding one could create a token at that address first and burn a
 * pool slot, but could not touch a creator's wallet, coin or fees — so the blast
 * radius is small. It is still not a reason to grind on rented hardware when
 * your own machine does the job for nothing.
 *
 * WHY A POOL AND NOT ON DEMAND. Exact lowercase `sakura` is 58^6 =
 * 38,068,692,544 expected attempts. That is minutes on a GPU and hours on a
 * CPU — fine as an occasional batch, impossible while a creator waits. Grinding
 * is a batch job with no uptime requirement and nothing to host; it does not
 * belong on the app's server.
 *
 * At current volume this is a small job: one creator is eligible today and no
 * coin has ever launched, so ten to twenty addresses covers a long time. Start
 * with `--measure` to learn your real rate before committing to a count.
 *
 * THE SECRET NEVER LEAVES IN PLAINTEXT. Each secret key is encrypted with
 * AES-256-GCM under VANITY_MINT_ENCRYPTION_KEY before upload; the database
 * stores ciphertext and the key lives only in the builder service's
 * environment, so a database read alone yields nothing usable. Nothing here
 * prints a secret, and the temporary keypair files are overwritten before
 * deletion.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const SUFFIX = 'sakura';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const MEASURE = has('measure');
const COUNT = Number(flag('count', '1'));
const FROM_DIR = flag('from-dir');
const DRY_RUN = has('dry-run');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENC_KEY_B64 = process.env.VANITY_MINT_ENCRYPTION_KEY;

/**
 * AES-256-GCM. Output is base64 of iv(12) || tag(16) || ciphertext, which is
 * what the builder service must expect when it decrypts.
 */
function encryptSecret(secretKeyBytes, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `VANITY_MINT_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secretKeyBytes)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Overwrite before unlinking. Deleting a file leaves its bytes on disk. */
function shred(file) {
  try {
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, randomBytes(size));
  } catch {
    // Best effort; the unlink below still runs.
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Load a Solana CLI keypair file and DERIVE its public key.
 *
 * Deriving rather than trusting the filename is the whole check: a file named
 * `<something>sakura.json` proves nothing about the key inside it.
 */
function loadAndVerify(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`${path.basename(file)}: not a 64-byte Solana keypair file`);
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  const pub = kp.publicKey.toBase58();
  if (!pub.endsWith(SUFFIX)) {
    throw new Error(`derived key ${pub} does not end in "${SUFFIX}" — refusing it`);
  }
  return { publicKey: pub, secretKey: kp.secretKey };
}

function grindInto(dir, count) {
  const started = Date.now();
  // `--ends-with SUFFIX:COUNT` writes one <pubkey>.json per hit into cwd, which
  // is what this reads back. Do NOT add --no-outfile: it suppresses exactly
  // those files. There is no --silent flag; the progress output goes to the
  // terminal on purpose, because this runs for a long time.
  const threads = Math.max(1, os.cpus().length);
  const res = spawnSync(
    'solana-keygen',
    ['grind', '--ends-with', `${SUFFIX}:${count}`, '--num-threads', String(threads)],
    { cwd: dir, stdio: 'inherit' },
  );
  if (res.error) {
    throw new Error(
      `could not run solana-keygen (${res.error.message}). Install the Solana CLI, ` +
        'or grind elsewhere and use --from-dir.',
    );
  }
  if (res.status !== 0) throw new Error(`solana-keygen exited ${res.status}`);
  return Date.now() - started;
}

async function upload(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/vanity_mints`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upload failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function main() {
  if (MEASURE) {
    // Time a short grind for a suffix that will not hit, to learn the rate
    // without spending it. `sakura` itself would take hours on a CPU, which is
    // exactly the number this is here to find out.
    console.log('Measuring grind rate. This runs solana-keygen for a moment.\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanity-measure-'));
    const started = Date.now();
    const res = spawnSync('solana-keygen', ['grind', '--ends-with', 'sakura:1'], {
      cwd: dir,
      timeout: 20_000,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const elapsed = (Date.now() - started) / 1000;
    for (const f of fs.readdirSync(dir)) shred(path.join(dir, f));
    fs.rmSync(dir, { recursive: true, force: true });

    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const m = out.match(/([\d,]+)\s+attempts/i);
    if (m) {
      const attempts = Number(m[1].replace(/,/g, ''));
      const rate = attempts / elapsed;
      const expected = Math.pow(58, 6);
      console.log(`  ~${Math.round(rate).toLocaleString()} keys/sec`);
      console.log(`  expected attempts for "${SUFFIX}": ${expected.toLocaleString()}`);
      console.log(`  ≈ ${(expected / rate / 3600).toFixed(1)} hours per address on this machine`);
      console.log('\nIf that is hours, grind on a GPU instead and use --from-dir.');
    } else {
      console.log(`  ran ${elapsed.toFixed(1)}s; solana-keygen reported no attempt count.`);
      console.log('  Re-run with a longer window, or grind on a GPU and use --from-dir.');
    }
    return;
  }

  if (!ENC_KEY_B64) throw new Error('set VANITY_MINT_ENCRYPTION_KEY (base64 of 32 random bytes)');
  if (!DRY_RUN && (!SUPABASE_URL || !SERVICE_KEY)) {
    throw new Error('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }

  let dir = FROM_DIR;
  let temporary = false;
  if (!dir) {
    if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 100) {
      throw new Error('--count must be between 1 and 100');
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanity-grind-'));
    temporary = true;
    console.log(`grinding ${COUNT} keypair(s) ending in "${SUFFIX}" — this can take a while`);
    const ms = grindInto(dir, COUNT);
    console.log(`  done in ${(ms / 1000 / 60).toFixed(1)} min`);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no keypair .json files in ${dir}`);

  const rows = [];
  const accepted = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const { publicKey, secretKey } = loadAndVerify(full);
    rows.push({ public_key: publicKey, secret_encrypted: encryptSecret(secretKey, ENC_KEY_B64) });
    accepted.push(publicKey);
  }

  if (DRY_RUN) {
    console.log(`\ndry run — ${rows.length} key(s) verified, nothing uploaded:`);
    for (const p of accepted) console.log(`  ${p}`);
  } else {
    await upload(rows);
    console.log(`\nuploaded ${rows.length} key(s):`);
    for (const p of accepted) console.log(`  ${p}`);
  }

  // Plaintext keys must not outlive this process.
  for (const f of files) shred(path.join(dir, f));
  if (temporary) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`\nshredded the plaintext keypair files in ${dir}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
