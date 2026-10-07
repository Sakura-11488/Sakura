/**
 * Sakura media ingest service.
 *
 * Makes hosting on the droplet automatic: upload (or point at a URL) once and
 * the service stores the file under nginx's web root, generates thumbnails
 * (ffmpeg frame-grab for video, sharp resize/webp for images), and updates the
 * per-work manifest.json that the app reads at runtime. No more scp + nginx
 * edits + app rebuilds.
 *
 * Auth tiers:
 *   - Admin (Originals): `Authorization: Bearer ${MEDIA_INGEST_TOKEN}`
 *   - Creators: Sakura wallet-signature headers (x-wallet-address /
 *     x-signature / x-message with message `sakura:upload-work-media:ts:<unix>`,
 *     ed25519 — same scheme the Supabase edge functions verify). Creator video
 *     lands under /var/www/creator-media/<wallet>/<workId>/ with an auto
 *     poster frame. Ownership of workId is enforced later by the
 *     upload-work-media edge function when the asset rows are recorded.
 *
 * Env:
 *   MEDIA_INGEST_TOKEN   required — admin bearer token
 *   PORT                 default 3200
 *   ORIGINALS_ROOT       default /var/www/sakura-originals
 *   CREATOR_ROOT         default /var/www/creator-media
 *
 * Legacy works keep their historical web roots (see WORK_ROOTS).
 */

import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import bs58 from 'bs58';
import crypto, { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3200);
const INGEST_TOKEN = (process.env.MEDIA_INGEST_TOKEN || '').trim();
const ORIGINALS_ROOT = process.env.ORIGINALS_ROOT || '/var/www/sakura-originals';
const CREATOR_ROOT = process.env.CREATOR_ROOT || '/var/www/creator-media';
const CREATOR_PRIVATE_ROOT = process.env.CREATOR_PRIVATE_ROOT || '/var/lib/sakura/creator-paid-media';

if (!INGEST_TOKEN) {
  console.error('[media-ingest] MEDIA_INGEST_TOKEN is required. Refusing to start unauthenticated.');
  process.exit(1);
}

/**
 * Web root + public path prefix per work. Legacy Originals keep the paths the
 * app already knows; anything else lands under ORIGINALS_ROOT/<slug>.
 */
const WORK_ROOTS = {
  psyopanime: { dir: '/var/www/psyopanime', publicPrefix: '/psyopanime' },
  '2heanime': { dir: '/var/www/2heanime', publicPrefix: '/2heanime' },
  'degegen-files': {
    dir: path.join(ORIGINALS_ROOT, 'degegen-files'),
    publicPrefix: '/sakura-originals/degegen-files',
  },
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const WORK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aofzomovaozcwcozokll.supabase.co';
const PRIVATE_VIDEO_RE = /^\/media\/v1\/creator\/private\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([0-9a-f-]{36})\/([a-f0-9-]{36}\.(?:mp4|mov|webm|m4v))$/i;

function workRoot(slug) {
  return (
    WORK_ROOTS[slug] || {
      dir: path.join(ORIGINALS_ROOT, slug),
      publicPrefix: `/sakura-originals/${slug}`,
    }
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `ingest-${randomUUID()}${path.extname(file.originalname || '') || ''}`),
  }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 40 },
});

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function requireAdmin(req, res, next) {
  const token = bearer(req);
  if (!token || token !== INGEST_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify Sakura wallet-signature headers (same scheme as the Supabase edge
 * functions' _shared/wallet-auth.ts): x-wallet-address, x-signature,
 * x-message = `sakura:<action>:ts:<unix>`, ed25519, 5-minute window.
 */
function verifyWalletHeaders(req, expectedAction, maxAgeSeconds = 300) {
  const walletAddress = String(req.headers['x-wallet-address'] || '').trim();
  const signature = String(req.headers['x-signature'] || '').trim();
  const message = String(req.headers['x-message'] || '').trim();
  if (!WALLET_RE.test(walletAddress) || !signature || !message) return null;

  const parts = message.split(':');
  if (parts.length !== 4 || parts[0] !== 'sakura' || parts[1] !== expectedAction || parts[2] !== 'ts') {
    return null;
  }
  const ts = Number(parts[3]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxAgeSeconds) return null;

  try {
    const publicKeyBytes = Buffer.from(bs58.decode(walletAddress));
    if (publicKeyBytes.length !== 32) return null;
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: 'der',
      type: 'spki',
    });
    const ok = crypto.verify(
      null,
      Buffer.from(message, 'utf8'),
      keyObject,
      Buffer.from(bs58.decode(signature)),
    );
    return ok ? { walletAddress } : null;
  } catch {
    return null;
  }
}

function requireCreator(req, res, next) {
  const verified = verifyWalletHeaders(req, 'upload-work-media');
  if (!verified) return res.status(401).json({ error: 'Unauthorized (valid wallet signature required)' });
  req.creatorWallet = verified.walletAddress;
  next();
}

async function verifyCreatorVideoWork(req, workId) {
  if (!WORK_ID_RE.test(workId)) return { ok: false, status: 400, error: 'Invalid workId.' };
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/upload-work-media`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wallet-address': req.headers['x-wallet-address'],
        'x-signature': req.headers['x-signature'],
        'x-message': req.headers['x-message'],
      },
      body: JSON.stringify({ work_id: workId, video_preflight: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    return response.ok && payload.ok
      ? { ok: true, paid: payload.paid === true }
      : { ok: false, status: response.status, error: payload.error || 'Work ownership check failed.' };
  } catch {
    return { ok: false, status: 503, error: 'Could not verify this work. Try again.' };
  }
}

/** New clients include x-work-id so ownership is checked before multer writes
 * any bytes. Old clients are checked immediately after their multipart upload. */
async function preflightCreatorVideo(req, res, next) {
  const raw = String(req.headers['x-work-id'] || '').trim().toLowerCase();
  if (!raw) return next();
  const check = await verifyCreatorVideoWork(req, raw);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  req.verifiedWorkId = raw;
  req.verifiedPaid = check.paid;
  next();
}

/** Reject path-traversal in user-supplied name segments. */
function safeSegment(value, label, res) {
  const v = String(value || '').trim();
  if (!v || !SLUG_RE.test(v)) {
    res.status(400).json({ error: `Invalid ${label}: use lowercase letters, digits, hyphens (2-64 chars)` });
    return null;
  }
  return v;
}

async function downloadToTmp(url, maxBytes) {
  const parsed = new URL(url); // throws on invalid
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Source URL returned ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error('Source file too large');
  const tmp = path.join(os.tmpdir(), `ingest-${randomUUID()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error('Source file too large');
  await fs.writeFile(tmp, buf);
  return tmp;
}

/** Grab a poster frame with ffmpeg. Tries 3s in, falls back to first frame. */
async function videoThumbnail(videoPath, outPath) {
  const attempts = [
    ['-ss', '3', '-i', videoPath, '-vframes', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', outPath],
    ['-i', videoPath, '-vframes', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', outPath],
  ];
  for (const args of attempts) {
    try {
      await execFileAsync('ffmpeg', args, { timeout: 120_000 });
      await fs.access(outPath);
      return;
    } catch {
      /* try next */
    }
  }
  throw new Error('ffmpeg could not extract a poster frame');
}

async function writeCoverVariants(srcPath, destDir, baseName) {
  await fs.mkdir(destDir, { recursive: true });
  const cover = path.join(destDir, `${baseName}.jpg`);
  const thumb = path.join(destDir, `${baseName}-thumb.webp`);
  await sharp(srcPath).rotate().resize(600, 900, { fit: 'cover' }).jpeg({ quality: 88 }).toFile(cover);
  await sharp(srcPath).rotate().resize(300, 450, { fit: 'cover' }).webp({ quality: 80 }).toFile(thumb);
  return { cover, thumb };
}

// ─── manifest handling ────────────────────────────────────────────────────────

const manifestLocks = new Map();

/** Serialize manifest read-modify-write per slug. */
async function withManifest(slug, fn) {
  const prev = manifestLocks.get(slug) || Promise.resolve();
  const job = prev.then(async () => {
    const { dir } = workRoot(slug);
    const file = path.join(dir, 'manifest.json');
    let manifest = {};
    try {
      manifest = JSON.parse(String(await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
    } catch {
      /* new manifest */
    }
    if (!manifest.id) manifest.id = slug;
    if (!Array.isArray(manifest.episodes)) manifest.episodes = [];
    const result = await fn(manifest);
    manifest.updatedAt = new Date().toISOString();
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
    await fs.rename(tmp, file);
    return { manifest, result };
  });
  manifestLocks.set(slug, job.catch(() => {}));
  return job;
}

// ─── app ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // x-wallet-address / x-signature / x-message are how creator uploads
  // authenticate (requireCreator). Omitting them makes the browser reject the
  // request AFTER a 204 preflight, which looks like a network error rather than
  // a CORS problem — the web PWA cannot upload at all without them listed.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, x-wallet-address, x-signature, x-message, x-work-id',
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'sakura-media-ingest' }));
// nginx maps /media/v1/ -> /v1/, so this is what clients can actually reach as
// GET /media/v1/healthz. Clients preflight against it to tell "service is up"
// from "route not deployed" — Express answers unknown routes with an HTML 404
// just like nginx does, so only an affirmative JSON body distinguishes them.
app.get('/v1/healthz', (_req, res) => res.json({ ok: true, service: 'sakura-media-ingest' }));

// Supabase checks that a signed creator upload actually landed on this host
// before it records the asset. This route never serves the private bytes.
app.get('/v1/creator/videos/check', requireCreator, async (req, res) => {
  const mediaPath = String(req.query.path || '');
  const match = PRIVATE_VIDEO_RE.exec(mediaPath);
  if (!match || match[1] !== req.creatorWallet) return res.sendStatus(403);
  try {
    await fs.access(path.join(CREATOR_PRIVATE_ROOT, match[1], match[2], match[3]));
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(404);
  }
});

// The file lives outside every nginx web root. A fresh bearer token is issued
// only after the owner or buyer signs read-work-media. Range requests support
// seeking without copying a multi-GB file into the Edge runtime.
async function servePrivateVideo(req, res) {
  const mediaPath = `/media/v1${req.path.slice(3)}`;
  const match = PRIVATE_VIDEO_RE.exec(mediaPath);
  const token = String(req.query.token || '');
  if (!match || !/^[0-9a-f-]{72}$/i.test(token)) return res.sendStatus(403);
  try {
    const auth = await fetch(`${SUPABASE_URL}/functions/v1/authorize-creator-video`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: mediaPath, token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!auth.ok) return res.sendStatus(auth.status === 403 ? 403 : 503);
    const file = path.join(CREATOR_PRIVATE_ROOT, match[1], match[2], match[3]);
    const stat = await fs.stat(file);
    const size = stat.size;
    let start = 0;
    let end = size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range));
      if (!range) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Number(range[2]);
      if (!range[1] && range[2]) {
        start = Math.max(0, size - end);
        end = size - 1;
      }
      if (!range[2]) end = size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || start >= size) {
        return res.status(416).set('Content-Range', `bytes */${size}`).end();
      }
      end = Math.min(end, size - 1);
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    const ext = path.extname(match[3]).toLowerCase();
    res.set({ 'Content-Type': ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4',
      'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  } catch {
    return res.sendStatus(503);
  }
}
app.get('/v1/creator/private/:wallet/:workId/:name', servePrivateVideo);
app.head('/v1/creator/private/:wallet/:workId/:name', servePrivateVideo);

/** Upsert work-level metadata in the manifest. */
app.post('/v1/works', requireAdmin, async (req, res) => {
  try {
    const slug = safeSegment(req.body.slug, 'slug', res);
    if (!slug) return;
    const { manifest } = await withManifest(slug, (m) => {
      for (const key of ['title', 'description', 'status']) {
        if (typeof req.body[key] === 'string' && req.body[key].trim()) m[key] = req.body[key].trim();
      }
      if (Array.isArray(req.body.genres)) m.genres = req.body.genres.map(String);
      if (typeof req.body.score === 'number' || req.body.score === null) m.score = req.body.score;
    });
    res.json({ ok: true, manifest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Upload/replace the work cover (multipart `file` or JSON `{url}`). */
app.post('/v1/works/:slug/cover', requireAdmin, upload.single('file'), async (req, res) => {
  let tmp = req.file?.path;
  try {
    const slug = safeSegment(req.params.slug, 'slug', res);
    if (!slug) return;
    if (!tmp && req.body.url) tmp = await downloadToTmp(req.body.url, MAX_IMAGE_BYTES);
    if (!tmp) return res.status(400).json({ error: 'Provide multipart `file` or JSON `{url}`' });

    const { dir, publicPrefix } = workRoot(slug);
    await writeCoverVariants(tmp, dir, 'cover');
    const { manifest } = await withManifest(slug, (m) => {
      m.image = `${publicPrefix}/cover.jpg`;
      m.cover = `${publicPrefix}/cover.jpg`;
      m.thumbnail = `${publicPrefix}/cover-thumb.webp`;
    });
    res.json({ ok: true, image: manifest.image, thumbnail: manifest.thumbnail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (tmp) fs.unlink(tmp).catch(() => {});
  }
});

/**
 * Add/replace an episode. Multipart `file` (video) or JSON `{url}` plus
 * fields: id (slug-safe), title, number?. Stores video under videos/,
 * generates thumbs/<id>.jpg, updates manifest.
 */
app.post('/v1/works/:slug/episodes', requireAdmin, upload.single('file'), async (req, res) => {
  let tmp = req.file?.path;
  try {
    const slug = safeSegment(req.params.slug, 'slug', res);
    if (!slug) return;
    const epId = safeSegment(req.body.id, 'episode id', res);
    if (!epId) return;
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title is required' });

    if (!tmp && req.body.url) tmp = await downloadToTmp(req.body.url, MAX_VIDEO_BYTES);
    if (!tmp) return res.status(400).json({ error: 'Provide multipart `file` or JSON `{url}`' });

    const ext = (req.file?.originalname || String(req.body.url || '')).match(VIDEO_EXT_RE)?.[0]?.toLowerCase() || '.mp4';
    const { dir, publicPrefix } = workRoot(slug);
    const videosDir = path.join(dir, 'videos');
    const thumbsDir = path.join(dir, 'thumbs');
    await fs.mkdir(videosDir, { recursive: true });
    await fs.mkdir(thumbsDir, { recursive: true });

    const videoFile = path.join(videosDir, `${epId}${ext}`);
    await fs.copyFile(tmp, videoFile);
    const thumbFile = path.join(thumbsDir, `${epId}.jpg`);
    await videoThumbnail(videoFile, thumbFile);

    const { manifest } = await withManifest(slug, (m) => {
      const entry = {
        id: `${slug}-${epId}`,
        number: Number.isFinite(Number(req.body.number))
          ? Number(req.body.number)
          : m.episodes.length + 1,
        title,
        thumbnail: `${publicPrefix}/thumbs/${epId}.jpg`,
        videoUrl: `${publicPrefix}/videos/${epId}${ext}`,
      };
      const idx = m.episodes.findIndex((e) => e.id === entry.id);
      if (idx >= 0) m.episodes[idx] = { ...m.episodes[idx], ...entry };
      else m.episodes.push(entry);
      m.episodes.sort((a, b) => (a.number || 0) - (b.number || 0));
    });
    res.json({ ok: true, episode: manifest.episodes.find((e) => e.id === `${slug}-${epId}`) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (tmp) fs.unlink(tmp).catch(() => {});
  }
});

/**
 * Register an episode whose video already exists on disk (no upload) —
 * used to bootstrap manifests for legacy content and by sync scripts.
 * JSON: { id, title, number?, videoUrl, thumbnail? } (path-absolute URLs).
 * If thumbnail is omitted and the video exists locally, one is generated.
 */
app.post('/v1/works/:slug/episodes/register', requireAdmin, async (req, res) => {
  try {
    const slug = safeSegment(req.params.slug, 'slug', res);
    if (!slug) return;
    const rawId = String(req.body.id || '').trim();
    if (!rawId) return res.status(400).json({ error: 'id is required' });
    const title = String(req.body.title || '').trim();
    const videoUrl = String(req.body.videoUrl || '').trim();
    if (!title || !videoUrl.startsWith('/')) {
      return res.status(400).json({ error: 'title and path-absolute videoUrl are required' });
    }

    let thumbnail = String(req.body.thumbnail || '').trim();
    const { dir, publicPrefix } = workRoot(slug);
    if (!thumbnail && videoUrl.startsWith(`${publicPrefix}/`)) {
      const localVideo = path.join(dir, videoUrl.slice(publicPrefix.length + 1));
      const thumbName = `${path.basename(localVideo).replace(/\.[^.]+$/, '')}.jpg`;
      const thumbFile = path.join(dir, 'thumbs', thumbName);
      try {
        await fs.access(localVideo);
        await fs.mkdir(path.join(dir, 'thumbs'), { recursive: true });
        try {
          await fs.access(thumbFile);
        } catch {
          await videoThumbnail(localVideo, thumbFile);
        }
        thumbnail = `${publicPrefix}/thumbs/${thumbName}`;
      } catch {
        /* video not local — leave thumbnail empty */
      }
    }

    const { manifest } = await withManifest(slug, (m) => {
      const entry = {
        id: rawId,
        number: Number.isFinite(Number(req.body.number))
          ? Number(req.body.number)
          : m.episodes.length + 1,
        title,
        ...(thumbnail ? { thumbnail } : {}),
        videoUrl,
      };
      const idx = m.episodes.findIndex((e) => e.id === entry.id);
      if (idx >= 0) m.episodes[idx] = { ...m.episodes[idx], ...entry };
      else m.episodes.push(entry);
      m.episodes.sort((a, b) => (a.number || 0) - (b.number || 0));
    });
    res.json({ ok: true, episode: manifest.episodes.find((e) => e.id === rawId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Remove an episode from the manifest (files kept on disk for safety). */
app.delete('/v1/works/:slug/episodes/:epId', requireAdmin, async (req, res) => {
  try {
    const slug = safeSegment(req.params.slug, 'slug', res);
    if (!slug) return;
    const epId = String(req.params.epId || '').trim();
    const { manifest } = await withManifest(slug, (m) => {
      m.episodes = m.episodes.filter((e) => e.id !== epId && e.id !== `${slug}-${epId}`);
    });
    res.json({ ok: true, episodes: manifest.episodes.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/v1/works/:slug/manifest', async (req, res) => {
  try {
    const slug = safeSegment(req.params.slug, 'slug', res);
    if (!slug) return;
    const file = path.join(workRoot(slug).dir, 'manifest.json');
    res.type('application/json').send(await fs.readFile(file, 'utf8'));
  } catch {
    res.status(404).json({ error: 'No manifest for that work' });
  }
});

/**
 * Creator video upload (wallet-signature authenticated). Multipart `file` +
 * field `workId` (uuid). Stores under CREATOR_ROOT/<wallet>/<workId>/ and
 * returns path-absolute URLs (video + generated poster). The app then records
 * these via the upload-work-media edge function, which enforces work
 * ownership before any DB rows are written.
 */
app.post('/v1/creator/videos', requireCreator, preflightCreatorVideo, upload.single('file'), async (req, res) => {
  const tmp = req.file?.path;
  try {
    if (!tmp) return res.status(400).json({ error: 'Provide multipart `file`' });
    if (!VIDEO_EXT_RE.test(req.file.originalname || '')) {
      return res.status(400).json({ error: 'Unsupported video type (mp4, mov, webm, m4v)' });
    }
    const workId = safeSegment(String(req.body.workId || '').toLowerCase(), 'workId', res);
    if (!workId) return;
    if (req.verifiedWorkId && req.verifiedWorkId !== workId) {
      return res.status(400).json({ error: 'Signed workId does not match the upload.' });
    }
    let paid = req.verifiedPaid === true;
    if (!req.verifiedWorkId) {
      const check = await verifyCreatorVideoWork(req, workId);
      if (!check.ok) return res.status(check.status).json({ error: check.error });
      paid = check.paid;
    }

    const userId = req.creatorWallet;
    const publicDir = path.join(CREATOR_ROOT, userId, workId);
    const videoDir = path.join(paid ? CREATOR_PRIVATE_ROOT : CREATOR_ROOT, userId, workId);
    await fs.mkdir(publicDir, { recursive: true });
    await fs.mkdir(videoDir, { recursive: true });

    const fileId = randomUUID();
    const ext = req.file.originalname.match(VIDEO_EXT_RE)[0].toLowerCase();
    const videoFile = path.join(videoDir, `${fileId}${ext}`);
    await fs.copyFile(tmp, videoFile);
    const posterFile = path.join(publicDir, `${fileId}.jpg`);
    await videoThumbnail(videoFile, posterFile);
    const stat = await fs.stat(videoFile);

    const prefix = `/creator-media/${userId}/${workId}`;
    res.json({
      ok: true,
      videoUrl: paid
        ? `/media/v1/creator/private/${userId}/${workId}/${fileId}${ext}`
        : `${prefix}/${fileId}${ext}`,
      posterUrl: `${prefix}/${fileId}.jpg`,
      bytes: stat.size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (tmp) fs.unlink(tmp).catch(() => {});
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.code}` });
  }
  console.error('[media-ingest]', err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[media-ingest] listening on 127.0.0.1:${PORT}`);
  console.log(`[media-ingest] originals root: ${ORIGINALS_ROOT}; creator root: ${CREATOR_ROOT}`);
});
