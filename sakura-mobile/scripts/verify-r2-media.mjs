#!/usr/bin/env node
/**
 * Proves an R2 origin can actually replace the droplet for Sakura Originals.
 *
 *   node scripts/verify-r2-media.mjs https://media.example.com
 *
 * Checks the four things the app depends on, against the ORIGIN it will really
 * use — not against the S3 API, which behaves differently:
 *
 *   1. the object exists and reports a video Content-Type
 *   2. Access-Control-Allow-Origin is present, or the PWA cannot fetch it at
 *      all and offline downloads fail with an opaque error
 *   3. Range returns 206 with a correct Content-Range, or a <video> loads but
 *      cannot seek — the exact defect the service worker had
 *   4. the bytes are IDENTICAL to the droplet's, compared by hash over a
 *      mid-file range, because a truncated multipart upload can still match on
 *      size
 *
 * Exits non-zero on any failure, so it can gate a cutover.
 */
import crypto from 'node:crypto';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error('usage: node scripts/verify-r2-media.mjs <r2-base-url>');
  process.exit(1);
}

const DROPLET = 'http://165-232-83-159.nip.io';
// One per migrated prefix, so a prefix that never uploaded cannot hide behind
// a sibling that did.
// One per migrated prefix AND one per file extension.
//
// This list claimed to cover every prefix and did not: '/2heanime/' had no
// sample at all, so the entire 2heAnime catalogue could have cut over with
// nothing checking it — exactly the hiding-behind-a-sibling failure the
// comment promised to prevent.
//
// Extension coverage matters just as much and was missing entirely. The
// migration is 91 .mp4 and 21 .mov, and both original samples were .mp4. The
// droplet serves .mov as video/quicktime; if R2 guessed application/octet-
// stream instead, every .mov would refuse to play and the gate would have
// passed anyway. Two of the four Originals are .mov-only.
const SAMPLES = [
  '/psyopanime/videos/BnBj8sRUu6o.mp4',
  '/sakura-originals/burnie-senders/episodes/ep1.mp4',
  '/2heanime/videos/STAR.mov',
  '/sakura-originals/degegen-files/episodes/z-crash.mov',
];

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

/**
 * The origin the PWA actually loads from.
 *
 * This MUST be sent on every request. R2 — like S3 — only emits
 * Access-Control-Allow-Origin in response to a request that carries an Origin
 * header. Without one it stays silent no matter how the bucket is configured,
 * so a CORS check that omits it reports "missing" for a correctly configured
 * bucket and would block a legitimate cutover forever.
 *
 * Sending the real origin also makes the check meaningful rather than
 * decorative: a policy scoped to some other site would answer a wildcard probe
 * and still fail in the browser.
 */
const ORIGIN = process.env.R2_VERIFY_ORIGIN || 'https://sakuraonseeker.com';

async function head(url) {
  const res = await fetch(url, { method: 'HEAD', headers: { Origin: ORIGIN } });
  return { status: res.status, headers: res.headers };
}

async function range(url, from, to) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}`, Origin: ORIGIN } });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentRange: res.headers.get('content-range'),
    type: res.headers.get('content-type'),
    acao: res.headers.get('access-control-allow-origin'),
    sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    bytes: buf.length,
  };
}

for (const path of SAMPLES) {
  console.log(`\n--- ${path}`);
  const r2 = `${base}${path}`;

  let meta;
  try {
    meta = await head(r2);
  } catch (e) {
    check('object reachable', false, String(e.message).slice(0, 90));
    continue;
  }
  check('object exists', meta.status === 200, `HTTP ${meta.status}`);
  if (meta.status !== 200) continue;

  const type = meta.headers.get('content-type') || '';
  check('served as video', /^video\//.test(type), type || '(none)');

  // Presence is not enough: the value has to actually cover our origin, or the
  // browser rejects the response despite the header being there.
  const acao = meta.headers.get('access-control-allow-origin');
  const corsOk = acao === '*' || acao === ORIGIN;
  check(
    'CORS allows the browser',
    corsOk,
    acao
      ? `${acao}${corsOk ? '' : ` — does not cover ${ORIGIN}`}`
      : `missing for ${ORIGIN} — the PWA cannot fetch this and downloads fail opaquely`,
  );

  // Range is what makes seeking work. Access-Control-Allow-Headers comes back
  // only on a PREFLIGHT, never on a plain GET/HEAD — reading it off the HEAD
  // above would report "missing" for every correctly configured bucket, which
  // is the same false-negative this script was just fixed for. So ask properly.
  let acah = null;
  try {
    const pre = await fetch(r2, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
      },
    });
    acah = (pre.headers.get('access-control-allow-headers') || '').toLowerCase();
  } catch {
    acah = null;
  }
  check(
    'CORS preflight permits Range (seeking)',
    acah !== null && (acah.includes('range') || acah === '*'),
    acah || 'preflight did not allow Range — video will load but not scrub',
  );

  const total = Number(meta.headers.get('content-length') || 0);
  check('reports a size', total > 0, `${total} bytes`);
  if (!total) continue;

  // Mid-file, so a stale edge object or a truncated tail cannot pass.
  const from = Math.floor(total / 2);
  const to = Math.min(from + 262143, total - 1);

  const got = await range(r2, from, to);
  check('Range returns 206', got.status === 206, `HTTP ${got.status}`);
  check(
    'Content-Range is correct',
    got.contentRange === `bytes ${from}-${to}/${total}`,
    got.contentRange || '(none)',
  );

  // The decisive one: same bytes as the origin it is replacing.
  let origin;
  try {
    origin = await range(`${DROPLET}${path}`, from, to);
  } catch (e) {
    check('droplet comparison', false, `could not read origin: ${String(e.message).slice(0, 60)}`);
    continue;
  }
  check(
    'bytes identical to the droplet',
    origin.sha === got.sha && origin.bytes === got.bytes,
    `r2=${got.sha}/${got.bytes}B droplet=${origin.sha}/${origin.bytes}B`,
  );
}

console.log(failed === 0 ? '\nALL PASS — safe to set EXPO_PUBLIC_R2_MEDIA_BASE' : `\n${failed} FAILURE(S) — do not cut over`);
process.exit(failed === 0 ? 0 : 1);
