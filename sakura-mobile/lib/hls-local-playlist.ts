/**
 * Pure HLS playlist helpers for offline episode copies.
 *
 * Shared by the native downloader (lib/anime-offline.ts, which writes files to
 * the device) and the browser one (lib/anime-offline.web.ts, which writes Cache
 * Storage entries the service worker serves). Both turn a remote media playlist
 * into a local one the same way, and they must not drift: a playlist that
 * names a resource the downloader stored under a different name plays for a
 * few seconds and then stalls, which looks like a network problem rather than
 * the bug it is.
 *
 * These lived inside lib/anime-offline.ts, which imports expo-file-system and
 * so cannot load in the browser bundle or in a plain `node --test`. Nothing in
 * here may import expo, React Native or a platform module, and this file must
 * never get a `.web.ts` sibling — the whole point is one implementation.
 *
 * The first four exports were moved verbatim from the native store; native
 * calls them with the same arguments and gets byte-identical results. The rest
 * exist for the browser downloader, which has to choose a rendition, estimate
 * the size before writing a byte, and recognise the same playlist again after
 * its signed URLs expire.
 */

export function resolveUrl(base: string, relative: string): string {
  const t = relative.trim();
  if (!t) return base;
  return new URL(t, base).href;
}

/** Native's choice: the highest-bandwidth variant. The browser uses chooseVariant instead. */
export function pickMediaPlaylistUrl(masterText: string, masterUrl: string): string {
  const lines = masterText.split('\n').map((l) => l.trim());
  let bestUrl = '';
  let bestBw = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
    const bw = bwMatch ? Number(bwMatch[1]) : 0;
    const next = lines[i + 1];
    if (!next || next.startsWith('#')) continue;
    if (bw >= bestBw) {
      bestBw = bw;
      bestUrl = resolveUrl(masterUrl, next);
    }
  }
  if (bestUrl) return bestUrl;
  for (const line of lines) {
    if (line && !line.startsWith('#')) return resolveUrl(masterUrl, line);
  }
  return '';
}

export function extFromUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  const m = /\.([a-z0-9]{1,5})$/i.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

export type LocalResourceKind = 'key' | 'map' | 'seg';

/** One remote resource a local playlist depends on, and the name it is stored under. */
export interface LocalResource {
  url: string;
  name: string;
  kind: LocalResourceKind;
}

export interface LocalPlaylistPlan {
  outLines: string[];
  downloads: LocalResource[];
}

/**
 * Turn a remote HLS media playlist into a fully-local one: every resource
 * (AES-128 key, fMP4 init segment via #EXT-X-MAP, and each media segment) is
 * scheduled for download and rewritten to a local filename, while ALL playlist
 * tags — real #EXTINF durations, #EXT-X-TARGETDURATION, #EXT-X-KEY (IV/METHOD),
 * #EXT-X-BYTERANGE — are preserved verbatim. This lets ExoPlayer/expo-video
 * decrypt encrypted streams from the local key and seek correctly, instead of
 * the old approach that threw on encryption and faked 10s segment durations.
 *
 * A resource referenced more than once (byte-range segments sharing one file,
 * a key repeated across #EXT-X-KEY lines) is downloaded once; the preserved
 * BYTERANGE tags then address parts of the local copy.
 *
 * `localUri` maps a stored name to what the playlist should say. Native writes
 * the playlist next to its files, so a bare name resolves and the default
 * keeps it that way. The browser passes a same-origin /app/__offline/... URL so
 * the playlist names exactly the Cache Storage key the service worker matches,
 * with no relative-resolution step in between to disagree about encoding.
 */
export function planLocalPlaylist(
  mediaText: string,
  mediaUrl: string,
  localUri: (name: string) => string = (name) => name,
): LocalPlaylistPlan {
  const outLines: string[] = [];
  const downloads: LocalResource[] = [];
  const seen = new Map<string, string>();
  let keyIdx = 0;
  let mapIdx = 0;
  let segIdx = 0;

  const localFor = (absUrl: string, kind: LocalResourceKind): string => {
    const existing = seen.get(absUrl);
    if (existing) return existing;
    const ext = extFromUrl(absUrl);
    let name: string;
    if (kind === 'key') name = `key${keyIdx++}.key`;
    else if (kind === 'map') name = `init${mapIdx++}.${ext || 'mp4'}`;
    else name = `seg${String(segIdx++).padStart(5, '0')}.${ext || 'ts'}`;
    seen.set(absUrl, name);
    downloads.push({ url: absUrl, name, kind });
    return name;
  };

  const rewriteUri = (line: string, kind: 'key' | 'map'): string => {
    const uriMatch = /\bURI\s*=\s*"([^"]+)"/i.exec(line);
    if (!uriMatch) return line;
    const abs = resolveUrl(mediaUrl, uriMatch[1]);
    const local = localFor(abs, kind);
    return line.replace(/\bURI\s*=\s*"[^"]+"/i, `URI="${localUri(local)}"`);
  };

  for (const rawLine of mediaText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const t = line.trim();
    if (!t) continue;
    if (/^#EXT-X-KEY/i.test(t)) {
      outLines.push(/METHOD=NONE/i.test(t) ? t : rewriteUri(t, 'key'));
      continue;
    }
    if (/^#EXT-X-MAP/i.test(t)) {
      outLines.push(rewriteUri(t, 'map'));
      continue;
    }
    // Low-latency hints and reports are unnecessary for a saved VOD and would
    // otherwise leave signed network URLs inside an apparently local copy.
    if (/^#EXT-X-(?:PART|PRELOAD-HINT|RENDITION-REPORT|SERVER-CONTROL|SKIP)(?::|$)/i.test(t)) continue;
    if (/\bURI\s*=/i.test(t)) throw new Error('This playlist has an unsupported offline resource.');
    if (t.startsWith('#')) {
      outLines.push(t); // preserve EXTINF, TARGETDURATION, BYTERANGE, etc.
      continue;
    }
    outLines.push(localUri(localFor(resolveUrl(mediaUrl, t), 'seg')));
  }

  if (!outLines.some((l) => /#EXT-X-ENDLIST/i.test(l))) outLines.push('#EXT-X-ENDLIST');
  return { outLines, downloads };
}

// ─── Browser downloader helpers ──────────────────────────────────────────────

/** `KEY=VALUE,KEY="quoted, value"` → record. Quoted values keep their commas. */
export function parseAttributeList(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const colon = line.indexOf(':');
  const body = colon >= 0 ? line.slice(colon + 1) : line;
  const re = /([A-Z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const raw = m[2].trim();
    out[m[1].toUpperCase()] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF/im.test(text);
}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  audioGroup?: string;
}

/**
 * Every playable rendition of a master playlist.
 *
 * Only #EXT-X-STREAM-INF counts. I-frame and image (trick-play) streams are
 * #EXT-X-I-FRAME-STREAM-INF / #EXT-X-IMAGE-STREAM-INF tags whose URI is an
 * attribute, not the following line, so they are never mistaken for a
 * rendition here.
 */
export function parseMasterVariants(masterText: string, masterUrl: string): HlsVariant[] {
  const lines = masterText.split('\n').map((l) => l.trim());
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) {
      // A tag between STREAM-INF and its URI is legal; another STREAM-INF is not.
      if (/^#EXT-X-STREAM-INF:/i.test(lines[j])) break;
      j++;
    }
    const uri = lines[j];
    if (!uri || uri.startsWith('#')) continue;
    const attrs = parseAttributeList(lines[i]);
    const [w, h] = (attrs.RESOLUTION || '').split(/x/i).map(Number);
    const average = Number(attrs['AVERAGE-BANDWIDTH']);
    variants.push({
      url: resolveUrl(masterUrl, uri),
      bandwidth: Number(attrs.BANDWIDTH) || 0,
      averageBandwidth: Number.isFinite(average) && average > 0 ? average : undefined,
      width: Number.isFinite(w) && w > 0 ? w : undefined,
      height: Number.isFinite(h) && h > 0 ? h : undefined,
      codecs: attrs.CODECS || undefined,
      audioGroup: attrs.AUDIO || undefined,
    });
  }
  return variants;
}

/** A CODECS list with no video codec is an audio-only rendition. */
function isAudioOnly(v: HlsVariant): boolean {
  if (!v.codecs) return false;
  return !/(?:avc|hvc|hev|av01|vp0?9|vp8|dvh)/i.test(v.codecs);
}

/** Below this, a variant with no RESOLUTION is treated as "about 720p". */
const UNLABELLED_720P_BPS = 3_000_000;

/**
 * Which rendition to keep.
 *
 * About 720p: the size of a downloaded episode is the size of the rendition,
 * and on a phone screen 1080p roughly doubles storage for little visible gain.
 * Prefer the tallest rendition at or a little above 720 lines; failing that
 * (a ladder that starts at 1080p) the lowest one, so we never pick the most
 * expensive option by accident. Without RESOLUTION, bandwidth stands in.
 */
export function chooseVariant(variants: HlsVariant[], targetHeight = 720): HlsVariant | null {
  const video = variants.filter((v) => !isAudioOnly(v));
  const pool = video.length ? video : variants;
  if (!pool.length) return null;
  const sized = pool.filter((v) => v.height);
  if (sized.length) {
    const fit = sized.filter((v) => (v.height as number) <= targetHeight * 1.1);
    if (fit.length) {
      return [...fit].sort((a, b) => (b.height as number) - (a.height as number) || b.bandwidth - a.bandwidth)[0];
    }
    return [...sized].sort((a, b) => (a.height as number) - (b.height as number) || a.bandwidth - b.bandwidth)[0];
  }
  const byBandwidth = [...pool].sort((a, b) => a.bandwidth - b.bandwidth);
  const under = byBandwidth.filter((v) => v.bandwidth > 0 && v.bandwidth <= UNLABELLED_720P_BPS);
  return under.length ? under[under.length - 1] : byBandwidth[0];
}

/** '720p', or '2800 kbps' when the master gives no resolution. */
export function variantLabel(v: HlsVariant | null | undefined): string | undefined {
  if (!v) return undefined;
  if (v.height) return `${v.height}p`;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)} kbps`;
  return undefined;
}

/**
 * True when the variant's audio lives in a separate rendition playlist.
 *
 * Downloading that would mean a second playlist, a second segment list and a
 * master to tie them together; the provider does not do this today, so it is
 * refused with a clear message instead of producing a silent video.
 */
export function hasSeparateAudio(masterText: string, variant: HlsVariant): boolean {
  if (!variant.audioGroup) return false;
  for (const raw of masterText.split('\n')) {
    const line = raw.trim();
    if (!/^#EXT-X-MEDIA:/i.test(line)) continue;
    const attrs = parseAttributeList(line);
    if (attrs.TYPE === 'AUDIO' && attrs['GROUP-ID'] === variant.audioGroup && attrs.URI) return true;
  }
  return false;
}

export interface MediaPlaylistSummary {
  /** URI lines, i.e. media segments (byte-range parts count once each). */
  segmentCount: number;
  durationSec: number;
  encrypted: boolean;
  hasMap: boolean;
  hasByteRange: boolean;
  endList: boolean;
}

export function summarizeMediaPlaylist(text: string): MediaPlaylistSummary {
  let segmentCount = 0;
  let durationSec = 0;
  let encrypted = false;
  let hasMap = false;
  let hasByteRange = false;
  let endList = false;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    if (/^#EXTINF:/i.test(t)) {
      const d = parseFloat(t.slice(t.indexOf(':') + 1));
      if (Number.isFinite(d) && d > 0) durationSec += d;
    } else if (/^#EXT-X-KEY:/i.test(t)) {
      if (!/METHOD=NONE/i.test(t)) encrypted = true;
    } else if (/^#EXT-X-MAP:/i.test(t)) {
      hasMap = true;
      if (/BYTERANGE=/i.test(t)) hasByteRange = true;
    } else if (/^#EXT-X-BYTERANGE:/i.test(t)) {
      hasByteRange = true;
    } else if (/^#EXT-X-ENDLIST/i.test(t)) {
      endList = true;
    } else if (!t.startsWith('#')) {
      segmentCount++;
    }
  }
  return { segmentCount, durationSec, encrypted, hasMap, hasByteRange, endList };
}

/**
 * Identity of a media playlist that survives re-signing.
 *
 * The relay mints new signed URLs on every resolve, so URLs cannot identify a
 * playlist across a token expiry or a page reload. What cannot change without
 * the encode itself changing is the shape: how many resources, every segment
 * duration and byte range, and whether there is a key or init segment. A resume
 * that would stitch segment 120 of one encode onto segments 0-119 of another
 * (a different cut, a re-upload) is caught here and restarted instead.
 */
function resourceIdentity(raw: string, base?: string): string {
  try {
    const url = new URL(raw, base);
    const token = url.searchParams.get('token');
    if (token) {
      try {
        // Read only for cache identity; authorization remains the relay's job.
        const value = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
        if (typeof value.u === 'string') return new URL(value.u).pathname;
      } catch { /* Non-relay fixtures or URLs still have a stable pathname. */ }
    }
    return url.pathname;
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

export function mediaPlaylistFingerprint(text: string, mediaUrl?: string): string {
  const parts: string[] = [];
  let uris = 0;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    if (/^#EXTINF:/i.test(t)) {
      const d = parseFloat(t.slice(t.indexOf(':') + 1));
      parts.push(Number.isFinite(d) ? d.toFixed(3) : '?');
    } else if (/^#EXT-X-BYTERANGE:/i.test(t)) {
      parts.push(`b${t.slice(t.indexOf(':') + 1)}`);
    } else if (/^#EXT-X-KEY:/i.test(t)) {
      const attrs = parseAttributeList(t);
      parts.push(`k${attrs.METHOD}:${attrs.IV ?? ''}:${attrs.KEYFORMAT ?? 'identity'}:${attrs.URI ? resourceIdentity(attrs.URI, mediaUrl) : ''}`);
    } else if (/^#EXT-X-MAP:/i.test(t)) {
      const attrs = parseAttributeList(t);
      parts.push(`m${attrs.BYTERANGE ?? ''}:${resourceIdentity(attrs.URI ?? '', mediaUrl)}`);
    } else if (/^#EXT-X-(?:MEDIA-SEQUENCE|DISCONTINUITY(?:-SEQUENCE)?)(?::|$)/i.test(t)) {
      parts.push(t);
    } else if (!t.startsWith('#')) {
      uris++;
      parts.push(resourceIdentity(t, mediaUrl));
    }
  }
  // FNV-1a, 32-bit: a short, stable token for the manifest, not a security hash.
  let hash = 0x811c9dc5;
  const joined = parts.join(',');
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${uris}:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Bytes a rendition needs on disk: bits per second × seconds ÷ 8.
 *
 * AVERAGE-BANDWIDTH when the master has it; BANDWIDTH is the peak and
 * overstates a typical episode by a third or more. Used to refuse a download
 * that cannot fit before any of it is written.
 */
export function estimateRenditionBytes(variant: HlsVariant | null | undefined, durationSec: number, fallbackBps = 2_500_000): number {
  const bps = variant?.averageBandwidth || variant?.bandwidth || fallbackBps;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.ceil((bps * durationSec) / 8);
}

export type MediaBytesCheck = 'ok' | 'invalid' | 'misaligned';

function looksLikeMarkup(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && i < 64 && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) i++;
  // '<' (an HTML error page or captive portal) or '{' (a JSON error body).
  return bytes[i] === 0x3c || bytes[i] === 0x7b;
}

/**
 * Is this plausibly the resource it claims to be?
 *
 * The relay already refuses HTML and JavaScript disguised as media, so this is
 * the last line against what it cannot see: a body cut short in transit, or an
 * error page from something between the browser and the relay. `contentType`
 * is the relay's own sniffed type (it ignores the provider's, which lies).
 *
 * MPEG-TS is a sequence of 188-byte packets that each start with 0x47, so a
 * truncated segment almost always ends mid-packet. 'misaligned' lets the
 * caller fetch again rather than store a segment that glitches on playback;
 * it is a separate verdict from 'invalid' because a provider that consistently
 * pads its segments would otherwise make an episode impossible to download.
 */
export function checkMediaBytes(bytes: Uint8Array, kind: LocalResourceKind, contentType: string | null): MediaBytesCheck {
  if (kind === 'key') return bytes.length === 16 ? 'ok' : 'invalid';
  if (!bytes.length) return 'invalid';
  const type = (contentType || '').toLowerCase();
  if (type.includes('mp2t')) {
    for (let offset = 0; offset < Math.min(188, bytes.length); offset++) {
      if (bytes[offset] !== 0x47) continue;
      if (offset + 188 < bytes.length && bytes[offset + 188] !== 0x47) continue;
      return (bytes.length - offset) % 188 === 0 ? 'ok' : 'misaligned';
    }
    return 'invalid';
  }
  if (type.includes('html') || type.includes('json') || type.startsWith('text/')) return 'invalid';
  // Encrypted segments are opaque by design (the relay labels them
  // octet-stream), and 1 in 128 of them starts with '<' or '{' by chance.
  if (type.includes('octet-stream')) return 'ok';
  return looksLikeMarkup(bytes) ? 'invalid' : 'ok';
}
