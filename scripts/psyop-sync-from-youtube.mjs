/**
 * Sync PsyopAnime YouTube uploads → DigitalOcean static host + episode list patch.
 *
 * Usage:
 *   node scripts/psyop-sync-from-youtube.mjs              # download + thumbs + upload + patch
 *   node scripts/psyop-sync-from-youtube.mjs --dry-run    # list missing only
 *   node scripts/psyop-sync-from-youtube.mjs --skip-download
 *   node scripts/psyop-sync-from-youtube.mjs --upgrade-sd  # re-pull published
 *       episodes that are below 720p (they were fetched with the old 360p-only
 *       format selector) and re-upload them in HD. Needs ffmpeg for the merge.
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
const CHANNEL = 'https://www.youtube.com/@psyopanime/videos';
// Droplet SSH target — override with PSYOP_REMOTE. Canonical host:
// sakura-mobile/lib/content-hosts.ts
const REMOTE = process.env.PSYOP_REMOTE || 'root@165.232.83.159';
const REMOTE_VIDEOS = '/var/www/psyopanime/videos';
const REMOTE_THUMBS = '/var/www/psyopanime/thumbs';
const ORIGINALS_TS = path.join(ROOT, 'sakura-mobile/lib/sakura-originals.ts');
const LEGACY_TS = path.join(ROOT, 'src/lib/psyopAnime.ts');
// Media-ingest API — registers new episodes in the droplet manifest.json,
// which is what the app actually reads at runtime (the TS arrays below are
// offline fallback only). Set MEDIA_INGEST_TOKEN to enable.
const INGEST_TOKEN = (process.env.MEDIA_INGEST_TOKEN || '').trim();
const INGEST_BASE = (process.env.MEDIA_INGEST_BASE || 'http://165-232-83-159.nip.io/media/v1').replace(/\/+$/, '');

const dryRun = process.argv.includes('--dry-run');
const skipDownload = process.argv.includes('--skip-download');
/** Re-download + re-upload any already-synced episode below 720p (SD backfill). */
const upgradeSd = process.argv.includes('--upgrade-sd');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: opts.stdio ?? 'pipe', ...opts });
}

function readExistingIds() {
  const src = fs.readFileSync(ORIGINALS_TS, 'utf8');
  const ids = [...src.matchAll(/\[\d+,\s*'([A-Za-z0-9_-]{11})'/g)].map((m) => m[1]);
  return new Set(ids);
}

function fetchChannelVideos() {
  const out = sh(
    `yt-dlp --no-update --flat-playlist --print "%(id)s|%(title)s" "${CHANNEL}"`,
    { stdio: 'pipe' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('|');
      return { id: line.slice(0, i).trim(), title: line.slice(i + 1).trim() };
    });
}

function cleanTitle(title) {
  return title
    .replace(/^PsyopAnime\s*[-–—]\s*/i, '')
    .replace(/^PsyopAnime News Network\s*[-–—]\s*/i, 'News Network - ')
    .trim();
}

function escapeTs(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// YouTube only serves 1080p/720p as SEPARATE video+audio (DASH) streams; the
// best pre-muxed single file is itag 18 = 360p. The old selector
// ("best[ext=mp4]/18/best") therefore downloaded 360p every time, which is why
// episodes looked pixelated. Prefer a merged 1080p, then 720p, and only fall
// back to progressive/360p if ffmpeg can't merge on this machine.
const YTDLP_FORMAT = [
  'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]',
  'bestvideo[height<=1080]+bestaudio',
  'best[height<=1080][ext=mp4]',
  'best[ext=mp4]',
  'best',
].join('/');

function downloadOne(id) {
  const out = path.join(VIDEOS, `${id}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 100_000) {
    // Episodes fetched before the format fix are 360p. With --upgrade-sd, drop
    // and re-pull anything below 720p instead of skipping it as "already done".
    const h = upgradeSd ? videoHeight(out) : 0;
    if (!upgradeSd || (h >= 720 && h > 0)) return out;
    console.log(`  re-downloading ${id} (was ${h || '?'}p)...`);
    fs.rmSync(out, { force: true });
  } else {
    console.log(`  downloading ${id}...`);
  }
  const r = spawnSync(
    'yt-dlp',
    [
      '--no-update',
      '-f',
      YTDLP_FORMAT,
      '--merge-output-format',
      'mp4',
      '-o',
      out,
      `https://www.youtube.com/watch?v=${id}`,
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`yt-dlp failed for ${id}`);
  const h = videoHeight(out);
  if (h) console.log(`  ${id}: ${h}p`);
  if (h && h < 720) {
    console.warn(`  [warn] ${id} is only ${h}p — yt-dlp may lack ffmpeg to merge HD streams.`);
  }
  return out;
}

/** Height of a downloaded file, via ffprobe. Returns 0 if ffprobe is missing. */
function videoHeight(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(String(r.stdout || '').trim()) || 0;
}

function thumbOne(id) {
  const thumb = path.join(THUMBS, `${id}.jpg`);
  if (fs.existsSync(thumb) && fs.statSync(thumb).size > 1000) return thumb;
  console.log(`  thumbnail ${id}...`);
  const r = spawnSync(
    'yt-dlp',
    [
      '--no-update',
      '--skip-download',
      '--write-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '-o',
      path.join(THUMBS, id),
      `https://www.youtube.com/watch?v=${id}`,
    ],
    { stdio: 'inherit' },
  );
  const candidates = [thumb, path.join(THUMBS, `${id}.jpg`), path.join(THUMBS, `${id}.webp`)];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).size > 1000) {
      if (c !== thumb) fs.renameSync(c, thumb);
      return thumb;
    }
  }
  if (r.status !== 0) {
    spawnSync(
      'ssh',
      [
        REMOTE,
        `ffmpeg -y -ss 3 -i ${REMOTE_VIDEOS}/${id}.mp4 -vframes 1 -q:v 2 ${REMOTE_THUMBS}/${id}.jpg 2>/dev/null || true`,
      ],
      { stdio: 'inherit' },
    );
  }
  return thumb;
}

function uploadOne(id) {
  const video = path.join(VIDEOS, `${id}.mp4`);
  const thumb = path.join(THUMBS, `${id}.jpg`);
  console.log(`  uploading ${id}...`);
  sh(`scp "${video}" ${REMOTE}:${REMOTE_VIDEOS}/${id}.mp4`, { stdio: 'inherit' });
  if (fs.existsSync(thumb)) {
    sh(`scp "${thumb}" ${REMOTE}:${REMOTE_THUMBS}/${id}.jpg`, { stdio: 'inherit' });
  }
}

function patchEpisodeLists(newEpisodes) {
  const rowsOriginals = newEpisodes
    .map(([num, id, title]) => `  [${num}, '${id}', '${escapeTs(title)}'],`)
    .join('\n');
  const rowsLegacy = newEpisodes
    .map(([num, id, title]) => `    ep(${num}, "${id}", "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"),`)
    .join('\n');

  let originals = fs.readFileSync(ORIGINALS_TS, 'utf8');
  originals = originals.replace(
    /(\[43, 'zXlBHNZx_RA', 'Untitled 2026 Series - Transformation'\],)\n(\];)/,
    `$1\n${rowsOriginals}\n$2`,
  );
  fs.writeFileSync(ORIGINALS_TS, originals);
  console.log('Patched', path.relative(ROOT, ORIGINALS_TS));

  if (fs.existsSync(LEGACY_TS)) {
    let legacy = fs.readFileSync(LEGACY_TS, 'utf8');
    legacy = legacy.replace(
      /(ep\(43, "zXlBHNZx_RA", "Untitled 2026 Series - Transformation"\),)\n(\];)/,
      `$1\n${rowsLegacy}\n$2`,
    );
    fs.writeFileSync(LEGACY_TS, legacy);
    console.log('Patched', path.relative(ROOT, LEGACY_TS));
  }
}

async function registerInManifest(newEpisodes) {
  if (!INGEST_TOKEN) {
    console.warn(
      'MEDIA_INGEST_TOKEN not set — droplet manifest.json NOT updated. ' +
        'The app reads the manifest at runtime; new episodes will not appear until you register them ' +
        '(re-run with MEDIA_INGEST_TOKEN set, or run bootstrap-manifests.mjs).',
    );
    return;
  }
  for (const [num, id, title] of newEpisodes) {
    const res = await fetch(`${INGEST_BASE}/works/psyopanime/episodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({
        id: `psyop-${id}`,
        number: num,
        title,
        videoUrl: `/psyopanime/videos/${id}.mp4`,
        thumbnail: `/psyopanime/thumbs/${id}.jpg`,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`Manifest register failed for ${id}: ${res.status} ${body.error || ''}`);
    } else {
      console.log(`  registered psyop-${id} in manifest`);
    }
  }
}

async function main() {
  ensureDir(VIDEOS);
  ensureDir(THUMBS);

  const existing = readExistingIds();

  // SD backfill: re-pull + re-upload already-published episodes that were
  // fetched with the old 360p-only format selector. Touches no episode lists.
  if (upgradeSd) {
    const ids = [...existing];
    console.log(`Checking ${ids.length} published episodes for sub-720p video...`);
    let upgraded = 0;
    for (const id of ids) {
      try {
        const before = path.join(VIDEOS, `${id}.mp4`);
        const had = fs.existsSync(before) ? videoHeight(before) : 0;
        downloadOne(id);
        const after = videoHeight(path.join(VIDEOS, `${id}.mp4`));
        if (after > had || !had) {
          thumbOne(id);
          uploadOne(id);
          upgraded += 1;
        }
      } catch (e) {
        console.error(`Failed ${id}:`, e.message);
      }
    }
    console.log(`Done. Re-uploaded ${upgraded} episode(s) in HD.`);
    return;
  }

  const channel = fetchChannelVideos();
  const missing = channel.filter((v) => !existing.has(v.id));
  const maxEp = Math.max(
    ...[...fs.readFileSync(ORIGINALS_TS, 'utf8').matchAll(/\[\s*(\d+)\s*,\s*'[A-Za-z0-9_-]{11}'/g)].map(
      (m) => Number(m[1]),
    ),
  );

  // YouTube returns newest-first; episode numbers continue after latest oldest→newest.
  const ordered = [...missing].reverse();
  const startNum = maxEp + 1;

  console.log(`Channel videos: ${channel.length}`);
  console.log(`In app already: ${existing.size}`);
  console.log(`Missing: ${missing.length}`);

  if (missing.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  missing.forEach((v, i) => console.log(`  ${startNum + i}. ${v.id} — ${cleanTitle(v.title)}`));

  if (dryRun) return;

  const newEpisodes = ordered.map((v, i) => [startNum + i, v.id, cleanTitle(v.title)]);

  if (!skipDownload) {
    for (const v of ordered) {
      try {
        downloadOne(v.id);
        thumbOne(v.id);
        uploadOne(v.id);
      } catch (e) {
        console.error(`Failed ${v.id}:`, e.message);
      }
    }
  }

  patchEpisodeLists(newEpisodes);
  await registerInManifest(newEpisodes);
  console.log(`Done. Added episodes ${startNum}–${startNum + ordered.length - 1}.`);
}

main();
