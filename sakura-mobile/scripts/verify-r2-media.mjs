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
const SAMPLES = [
  '/psyopanime/videos/BnBj8sRUu6o.mp4',
  '/sakura-originals/burnie-senders/episodes/ep1.mp4',
];

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

async function head(url) {
  const res = await fetch(url, { method: 'HEAD' });
  return { status: res.status, headers: res.headers };
}

async function range(url, from, to) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
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

  const acao = meta.headers.get('access-control-allow-origin');
  check(
    'CORS allows the browser',
    !!acao,
    acao || 'missing — the PWA cannot fetch this and downloads fail opaquely',
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
