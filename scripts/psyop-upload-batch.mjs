/**
 * Download Psyop episodes locally and upload to droplet (when server yt-dlp is blocked).
 * Usage: node scripts/psyop-upload-batch.mjs
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, '.psyop-sync');
const VIDEOS = path.join(STAGE, 'videos');
const THUMBS = path.join(STAGE, 'thumbs');
// Droplet SSH target — override with PSYOP_REMOTE. Canonical host:
// sakura-mobile/lib/content-hosts.ts
const REMOTE = process.env.PSYOP_REMOTE || 'root@165.232.83.159';
const LIST = path.join(STAGE, 'missing.txt');

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function download(id) {
  const out = path.join(VIDEOS, `${id}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 100_000) return;
  console.log(`download ${id}`);
  const r = spawnSync(
    'yt-dlp',
    ['--no-update', '-f', 'best[ext=mp4]/18/best', '-o', out, `https://www.youtube.com/watch?v=${id}`],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`download failed ${id}`);
}

function thumb(id) {
  const thumb = path.join(THUMBS, `${id}.jpg`);
  if (fs.existsSync(thumb) && fs.statSync(thumb).size > 1000) return;
  console.log(`thumb ${id}`);
  spawnSync(
    'yt-dlp',
    [
      '--no-update', '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '-o', path.join(THUMBS, id), `https://www.youtube.com/watch?v=${id}`,
    ],
    { stdio: 'inherit' },
  );
  const alt = path.join(THUMBS, `${id}.jpg`);
  if (!fs.existsSync(alt)) {
    const webp = path.join(THUMBS, `${id}.webp`);
    if (fs.existsSync(webp)) fs.renameSync(webp, alt);
  }
}

function upload(id) {
  const video = path.join(VIDEOS, `${id}.mp4`);
  const thumbPath = path.join(THUMBS, `${id}.jpg`);
  console.log(`upload ${id}`);
  sh(`scp "${video}" ${REMOTE}:/var/www/psyopanime/videos/${id}.mp4`);
  if (fs.existsSync(thumbPath)) {
    sh(`scp "${thumbPath}" ${REMOTE}:/var/www/psyopanime/thumbs/${id}.jpg`);
  }
}

fs.mkdirSync(VIDEOS, { recursive: true });
fs.mkdirSync(THUMBS, { recursive: true });
const lines = fs.readFileSync(LIST, 'utf8').trim().split('\n').filter(Boolean);
console.log(`Batch upload: ${lines.length} episodes`);

let ok = 0;
let fail = 0;
for (const line of lines) {
  const [id, title] = line.split('|');
  if (!id) continue;
  try {
    download(id);
    thumb(id);
    upload(id);
    ok++;
    console.log(`OK ${id} — ${title ?? ''}`);
  } catch (e) {
    fail++;
    console.error(`FAIL ${id}:`, e.message);
  }
}
console.log(`Finished. ok=${ok} fail=${fail}`);
