/**
 * The unsigned-transaction builder behind `PUMPFUN_UNSIGNED_TX_URL`.
 *
 * POST /build  { creatorWallet, name, symbol, metadataUri }
 *   -> { unsignedTransaction, mintAddress, lastValidBlockHeight, expiresInSeconds }
 *
 * WHAT IT DOES AND WHY IT IS SEPARATE. It reserves a `…sakura` mint from the
 * pool, builds a pump.fun create_v2 with the CREATOR as fee payer, partially
 * signs as the mint, and returns the transaction for the creator to
 * counter-sign on their device. It lives outside the Supabase edge functions
 * because `@solana/spl-token`'s esm.sh build exceeds the edge worker boot
 * budget — `process-xp-redemptions` died with WORKER_RESOURCE_LIMIT on every
 * request until it was hand-rolled — and full transaction assembly is worse.
 *
 * THE SECURITY MODEL, in one line: this service holds mint keys, so it must
 * never take orders from the public internet.
 *
 * - Every request needs `x-builder-secret`, compared in constant time. Without
 *   it, anyone who found the URL could drain the vanity pool one reservation at
 *   a time. That is a denial-of-service on a resource that costs hours of
 *   grinding to refill, so the gate is not optional.
 * - The creator is the fee payer, so pump.fun's creator fees accrue to them
 *   natively. Sakura takes no cut and holds no custody.
 * - This service never signs as the creator and never holds their key. The
 *   transaction it returns is unusable until the creator signs it.
 * - A reservation is returned to the pool if anything after it fails.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import pkg from '@solana/web3.js';
import { loadConfig, redactRpc } from './config.js';
import { reserveMint, releaseReservation } from './vanity.js';
import { buildCreateV2Instruction, computeBudgetInstructions, LIMITS } from './pumpfun.js';

const { Connection, PublicKey, Transaction } = pkg;

const cfg = loadConfig();
const connection = new Connection(cfg.rpcUrl, 'confirmed');

const log = {
  info: (event, data = {}) => console.log(JSON.stringify({ level: 'info', event, ...data })),
  warn: (event, data = {}) => console.warn(JSON.stringify({ level: 'warn', event, ...data })),
  error: (event, data = {}) => console.error(JSON.stringify({ level: 'error', event, ...data })),
};

/** Constant time, and length-safe — timingSafeEqual throws on a length mismatch. */
function secretMatches(provided) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(cfg.authSecret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * pump.fun stores the URI and never validates it, so a broken link produces a
 * permanent token with no name or image and no way to fix it. Check it here,
 * while the launch can still be refused.
 */
async function assertMetadataUsable(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw badRequest('metadataUri is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') throw badRequest('metadataUri must be https.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.metadataFetchTimeoutMs);
  let res;
  try {
    res = await fetch(uri, { signal: ctrl.signal, redirect: 'follow' });
  } catch {
    throw badRequest('metadataUri could not be fetched.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw badRequest(`metadataUri returned ${res.status}.`);

  let json;
  try {
    json = await res.json();
  } catch {
    // The comics scraper learned this the hard way: a 200 with HTML is the
    // normal shape of a broken upstream, not an exception.
    throw badRequest('metadataUri did not return JSON.');
  }
  if (!json || typeof json.name !== 'string' || typeof json.image !== 'string') {
    throw badRequest('metadata JSON needs at least `name` and `image`.');
  }
}

async function handleBuild(body) {
  const { creatorWallet, name, symbol, metadataUri } = body ?? {};

  let creator;
  try {
    creator = new PublicKey(String(creatorWallet));
  } catch {
    throw badRequest('creatorWallet is not a valid public key.');
  }
  if (typeof name !== 'string' || !name.trim()) throw badRequest('name is required.');
  if (typeof symbol !== 'string' || !symbol.trim()) throw badRequest('symbol is required.');
  if (name.length > LIMITS.name) throw badRequest(`name must be <= ${LIMITS.name} characters.`);
  if (symbol.length > LIMITS.symbol) throw badRequest(`symbol must be <= ${LIMITS.symbol} characters.`);
  if (typeof metadataUri !== 'string' || metadataUri.length > LIMITS.uri) {
    throw badRequest(`metadataUri is required and must be <= ${LIMITS.uri} characters.`);
  }

  await assertMetadataUsable(metadataUri);

  const mint = await reserveMint(cfg, creator.toBase58());
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

    const tx = new Transaction();
    // Fee payer is the CREATOR, not this service. That is what routes pump.fun
    // creator fees to them and what keeps Sakura out of custody.
    tx.feePayer = creator;
    tx.recentBlockhash = blockhash;
    for (const ix of computeBudgetInstructions(cfg.priorityFeeMicroLamports)) tx.add(ix);
    tx.add(
      buildCreateV2Instruction({
        mint: mint.publicKey,
        creator,
        name: name.trim(),
        symbol: symbol.trim(),
        uri: metadataUri,
      }),
    );

    // Partial: the mint's signature only. The creator's slot stays empty, so
    // this transaction cannot be submitted by anyone who intercepts it.
    tx.partialSign(mint.keypair);

    const serialized = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    log.info('built', {
      mint: mint.publicKey.toBase58(),
      creator: creator.toBase58(),
      symbol: symbol.trim(),
    });

    return {
      unsignedTransaction: serialized,
      mintAddress: mint.publicKey.toBase58(),
      lastValidBlockHeight,
      // A blockhash lives ~60-90s. The caller must treat this as short-lived
      // and rebuild rather than storing it against a 30-minute stale window.
      expiresInSeconds: 60,
    };
  } catch (e) {
    await releaseReservation(cfg, mint.publicKey.toBase58(), log);
    throw e;
  }
}

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  if (req.method === 'GET' && req.url === '/healthz') {
    // Liveness only. Deliberately says nothing about the pool or the database:
    // this endpoint is reachable without the shared secret.
    return send(200, { ok: true });
  }
  if (req.method !== 'POST' || req.url !== '/build') return send(404, { error: 'Not found.' });
  if (!secretMatches(req.headers['x-builder-secret'])) return send(401, { error: 'Unauthorized.' });

  let raw = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 16_384) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (tooBig) return send(413, { error: 'Body too large.' });
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return send(400, { error: 'Body must be JSON.' });
    }
    try {
      send(200, await handleBuild(body));
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) log.error('build-failed', { detail: String(e.message).slice(0, 300) });
      send(status, { error: e.message ?? 'Build failed.' });
    }
  });
});

server.listen(cfg.port, () => {
  log.info('listening', { port: cfg.port, rpc: redactRpc(cfg.rpcUrl) });
});
