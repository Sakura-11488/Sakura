import * as FileSystem from 'expo-file-system/legacy';
import {
  buildPlaybackHeaders,
  fetchEpisodeSources,
  getAnimeStreamUserAgent,
  type StreamingSource,
} from '@/lib/anime';
import { runEmbedBridge } from '@/lib/anime-download-bridge';

export type OfflineEpisodeStatus = 'downloading' | 'paused' | 'ready' | 'error';

export interface OfflineEpisode {
  animeId: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  title: string;
  cover: string;
  episodeThumbnail?: string;
  category: 'sub' | 'dub';
  status: OfflineEpisodeStatus;
  progress: number;
  bytesDownloaded: number;
  totalSegments: number;
  completedSegments: number;
  localPlaylistUri?: string;
  error?: string;
  updatedAt: number;
}

type Manifest = {
  episodes: Record<string, OfflineEpisode>;
};

const ROOT = `${FileSystem.documentDirectory}sakura_anime_offline/`;
const MANIFEST = `${ROOT}manifest.json`;

const mem: Manifest = { episodes: {} };
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeOfflineEpisodes(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function episodeKey(animeId: string, episodeId: string) {
  return `${animeId}::${episodeId}`;
}

function dirFor(animeId: string, episodeId: string) {
  return `${ROOT}${encodeURIComponent(animeId)}/${encodeURIComponent(episodeId)}/`;
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
    const info = await FileSystem.getInfoAsync(MANIFEST);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(MANIFEST);
      const parsed = JSON.parse(raw) as Manifest;
      mem.episodes = parsed?.episodes || {};
    }
  } catch {
    mem.episodes = {};
  } finally {
    loaded = true;
  }
}

async function persist() {
  try {
    await FileSystem.writeAsStringAsync(MANIFEST, JSON.stringify(mem));
  } catch {
    // ignore
  }
}

function resolveUrl(base: string, relative: string): string {
  const t = relative.trim();
  if (!t) return base;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  if (t.startsWith('/')) {
    const u = new URL(base);
    return `${u.origin}${t}`;
  }
  const baseDir = base.includes('/') ? base.replace(/[^/]*$/, '') : `${base}/`;
  return `${baseDir}${t}`;
}

function pickMediaPlaylistUrl(masterText: string, masterUrl: string): string {
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

function parseSegmentUrls(mediaText: string, playlistUrl: string): string[] {
  if (mediaText.includes('#EXT-X-KEY')) {
    throw new Error('This episode uses encrypted video and cannot be downloaded.');
  }
  const urls: string[] = [];
  for (const line of mediaText.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    urls.push(resolveUrl(playlistUrl, t));
  }
  return urls;
}

function assertPlaylist(text: string, label: string) {
  const t = text.trim();
  if (t.startsWith('#EXTM3U') || t.includes('#EXTINF')) return;
  if (t.includes('<!DOCTYPE') || t.toLowerCase().includes('cloudflare')) {
    throw new Error(
      'Stream blocked by CDN. Downloads work best on a real iPhone with Wi‑Fi; the simulator often fails here.',
    );
  }
  throw new Error(`Could not read video playlist (${label}).`);
}

function withCookieHeader(headers: Record<string, string>, cookies: string): Record<string, string> {
  if (!cookies?.trim()) return headers;
  return { ...headers, Cookie: cookies };
}

/** Pages to open in the hidden WebView for cookie priming (HiAnime first — Megaplay often 410 in WebView). */
function bridgePageCandidates(referer?: string, embedUrl?: string): string[] {
  const pages: string[] = [];
  if (embedUrl?.startsWith('http')) pages.push(embedUrl);
  if (referer?.startsWith('http') && referer !== embedUrl) pages.push(referer);
  return [...new Set(pages)];
}

function buildDownloadHeaders(src: StreamingSource, cookies = ''): Record<string, string> {
  const merged: Record<string, string> = {
    ...buildPlaybackHeaders(src.referer),
    'User-Agent': getAnimeStreamUserAgent(),
    Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
  };
  if (src.requestHeaders) {
    for (const [k, v] of Object.entries(src.requestHeaders)) {
      if (typeof v === 'string' && v.trim()) merged[k] = v;
    }
  }
  return withCookieHeader(merged, cookies);
}

function downloadHeaderVariants(src: StreamingSource, cookies: string): Record<string, string>[] {
  const variants: Record<string, string>[] = [];
  const seen = new Set<string>();
  const push = (h: Record<string, string>) => {
    const key = JSON.stringify(h);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(h);
  };

  push(buildDownloadHeaders(src, cookies));

  const ref = src.referer?.trim();
  if (ref?.startsWith('http')) {
    try {
      const origin = new URL(ref).origin;
      push({
        ...buildDownloadHeaders(src, cookies),
        Referer: ref,
        Origin: origin,
      });
    } catch {
      push({ ...buildDownloadHeaders(src, cookies), Referer: ref });
    }
  }

  if (src.embedUrl?.startsWith('http')) {
    try {
      const origin = new URL(src.embedUrl).origin;
      push({
        ...buildDownloadHeaders(src, cookies),
        Referer: `${origin}/`,
        Origin: origin,
      });
    } catch {
      // ignore
    }
  }

  return variants;
}

async function fileDownloadPlaylist(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const tmp = `${FileSystem.cacheDirectory}sakura_pl_${Date.now()}_${Math.random().toString(36).slice(2)}.m3u8`;
  try {
    const result = await FileSystem.downloadAsync(url, tmp, { headers });
    if (result.status < 200 || result.status >= 300) return null;
    const text = await FileSystem.readAsStringAsync(tmp);
    if (!text.trim()) return null;
    assertPlaylist(text, 'file');
    return text;
  } catch {
    return null;
  } finally {
    await FileSystem.deleteAsync(tmp, { idempotent: true });
  }
}

async function nativeFetchText(url: string, headers: Record<string, string>): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const text = await res.text();
      assertPlaylist(text, 'native');
      return text;
    } catch {
      // retry
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null;
}

async function nativeFetchFollowingRedirects(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    try {
      const res = await fetch(current, { headers, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        current = resolveUrl(current, loc);
        continue;
      }
      if (!res.ok) return null;
      const text = await res.text();
      if (text.includes('#EXTM3U') || text.includes('#EXTINF')) {
        if (text.includes('#EXT-X-STREAM-INF')) {
          const media = pickMediaPlaylistUrl(text, current);
          if (media && media !== current) {
            current = media;
            continue;
          }
        }
        assertPlaylist(text, 'redirect');
        return text;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

async function tryNativePlaylistFetch(
  url: string,
  src: StreamingSource,
  cookies: string,
): Promise<string | null> {
  for (const headers of downloadHeaderVariants(src, cookies)) {
    const file = await fileDownloadPlaylist(url, headers);
    if (file) return file;
    const direct = await nativeFetchText(url, headers);
    if (direct) return direct;
    const followed = await nativeFetchFollowingRedirects(url, headers);
    if (followed) return followed;
  }
  return null;
}

async function primeStreamCookies(embedUrl: string, referer?: string): Promise<string> {
  const pages = bridgePageCandidates(referer, embedUrl);
  let cookies = '';
  for (const page of pages) {
    try {
      const session = await runEmbedBridge({ embedUrl: page, referer, mode: 'cookies' });
      if (session.cookies) cookies = session.cookies;
      if (cookies) break;
    } catch {
      // try next page
    }
  }
  return cookies;
}

async function fetchPlaylistText(
  url: string,
  src: StreamingSource,
): Promise<{ text: string; cookies: string }> {
  const ref = src.referer || src.requestHeaders?.Referer || src.requestHeaders?.referer;
  const embedUrl = src.embedUrl || '';
  let lastError: Error | null = null;

  let cookies = await primeStreamCookies(embedUrl, ref);
  const headerCookie = src.requestHeaders?.Cookie || src.requestHeaders?.cookie;
  if (typeof headerCookie === 'string' && headerCookie.trim()) {
    cookies = cookies ? `${cookies}; ${headerCookie}` : headerCookie;
  }

  const nativeText = await tryNativePlaylistFetch(url, src, cookies);
  if (nativeText) {
    return { text: nativeText, cookies };
  }

  for (const page of bridgePageCandidates(ref, embedUrl)) {
    try {
      const bridge = await runEmbedBridge({
        embedUrl: page,
        targetUrl: url,
        referer: ref,
        mode: 'fetch',
      });
      assertPlaylist(bridge.text || '', 'embed');
      return {
        text: bridge.text!,
        cookies: bridge.cookies || cookies,
      };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  try {
    const direct = await runEmbedBridge({
      embedUrl: url,
      referer: ref,
      mode: 'document',
    });
    assertPlaylist(direct.text || '', 'direct');
    return {
      text: direct.text!,
      cookies: direct.cookies || cookies,
    };
  } catch (e) {
    lastError = e instanceof Error ? e : new Error(String(e));
  }

  throw (
    lastError ||
    new Error(
      'Could not access the video stream for download. Stay on Wi‑Fi, keep the app open, and try again.',
    )
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function downloadFile(
  url: string,
  dest: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const res = await FileSystem.downloadAsync(url, dest, { headers });
    if (res.status >= 200 && res.status < 300) return;
  } catch {
    // fall through to fetch()
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Segment download failed (HTTP ${response.status})`);
  }
  const data = await response.arrayBuffer();
  await FileSystem.writeAsStringAsync(dest, arrayBufferToBase64(data), {
    encoding: FileSystem.EncodingType.Base64,
  });
}

async function patchManifest(ep: OfflineEpisode) {
  mem.episodes[episodeKey(ep.animeId, ep.episodeId)] = ep;
  await persist();
  notify();
}

export async function getOfflineEpisode(
  animeId: string,
  episodeId: string,
): Promise<OfflineEpisode | null> {
  await ensureLoaded();
  return mem.episodes[episodeKey(animeId, episodeId)] || null;
}

export async function listOfflineEpisodes(): Promise<OfflineEpisode[]> {
  await ensureLoaded();
  return Object.values(mem.episodes).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getOfflinePlaybackUri(
  animeId: string,
  episodeId: string,
): Promise<string | null> {
  const ep = await getOfflineEpisode(animeId, episodeId);
  if (ep?.status !== 'ready' || !ep.localPlaylistUri) return null;
  const info = await FileSystem.getInfoAsync(ep.localPlaylistUri);
  return info.exists ? ep.localPlaylistUri : null;
}

export async function deleteOfflineEpisode(animeId: string, episodeId: string) {
  await ensureLoaded();
  const key = episodeKey(animeId, episodeId);
  const dir = dirFor(animeId, episodeId);
  try {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  } catch {
    // ignore
  }
  delete mem.episodes[key];
  await persist();
  notify();
}

export async function clearAllOfflineEpisodes() {
  await ensureLoaded();
  try {
    await FileSystem.deleteAsync(ROOT, { idempotent: true });
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
  } catch {
    // ignore
  }
  mem.episodes = {};
  await persist();
  notify();
}

export async function getOfflineStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const ep of Object.values(mem.episodes)) {
    if (ep.status !== 'ready' || !ep.localPlaylistUri) continue;
    const dir = dirFor(ep.animeId, ep.episodeId);
    try {
      const files = await FileSystem.readDirectoryAsync(dir);
      for (const f of files) {
        const info = await FileSystem.getInfoAsync(`${dir}${f}`);
        if (info.exists && 'size' in info && typeof info.size === 'number') {
          total += info.size;
        }
      }
    } catch {
      // ignore
    }
  }
  return total;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const activeJobs = new Set<string>();
const pausedEpisodeJobs = new Set<string>();

export function pauseAnimeEpisodeDownload(animeId: string, episodeId: string) {
  pausedEpisodeJobs.add(episodeKey(animeId, episodeId));
  notify();
}

export function resumeAnimeEpisodeDownload(animeId: string, episodeId: string) {
  pausedEpisodeJobs.delete(episodeKey(animeId, episodeId));
}

export function isAnimeEpisodePaused(animeId: string, episodeId: string): boolean {
  return pausedEpisodeJobs.has(episodeKey(animeId, episodeId));
}

async function fileHasContent(path: string, minBytes = 100): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists && 'size' in info && typeof info.size === 'number' && info.size >= minBytes;
  } catch {
    return false;
  }
}

function isRetryableDownloadError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('load failed') ||
    m.includes('player could not') ||
    m.includes('cdn') ||
    m.includes('stream') ||
    m.includes('playlist') ||
    m.includes('timed out') ||
    m.includes('could not access') ||
    m.includes('http 403') ||
    m.includes('http 410') ||
    m.includes('no iframe') ||
    m.includes('cross-origin') ||
    m.includes('could not read playlist')
  );
}

function isDirectFileUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?|$)/i.test(url);
}

async function performDirectFileDownload(
  opts: {
    animeId: string;
    episodeId: string;
    episodeNumber: number;
    episodeTitle: string;
    title: string;
    cover: string;
    episodeThumbnail?: string;
    category: 'sub' | 'dub';
  },
  record: OfflineEpisode,
  src: StreamingSource,
): Promise<OfflineEpisode> {
  const dir = dirFor(opts.animeId, opts.episodeId);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const extMatch = src.url.match(/\.(mp4|mov|m4v)(\?|$)/i);
  const ext = extMatch?.[1]?.toLowerCase() || 'mp4';
  const dest = `${dir}video.${ext}`;
  const headers = buildDownloadHeaders(src, '');

  let current: OfflineEpisode = {
    ...record,
    progress: 0,
    totalSegments: 1,
    completedSegments: 0,
    error: undefined,
  };
  await patchManifest(current);

  if (pausedEpisodeJobs.has(episodeKey(opts.animeId, opts.episodeId))) {
    current = { ...current, status: 'paused', updatedAt: Date.now() };
    await patchManifest(current);
    return current;
  }

  if (await fileHasContent(dest, 1024)) {
    const info = await FileSystem.getInfoAsync(dest);
    const size = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
    current = {
      ...current,
      status: 'ready',
      progress: 1,
      bytesDownloaded: size,
      completedSegments: 1,
      localPlaylistUri: dest,
      error: undefined,
      updatedAt: Date.now(),
    };
    await patchManifest(current);
    return current;
  }

  await downloadFile(src.url, dest, headers);

  const info = await FileSystem.getInfoAsync(dest);
  const size = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
  if (size < 1024) {
    throw new Error('Downloaded file is empty or corrupted.');
  }

  current = {
    ...current,
    status: 'ready',
    progress: 1,
    bytesDownloaded: size,
    completedSegments: 1,
    localPlaylistUri: dest,
    error: undefined,
    updatedAt: Date.now(),
  };
  await patchManifest(current);
  return current;
}

async function performDownload(
  opts: {
    animeId: string;
    episodeId: string;
    episodeNumber: number;
    episodeTitle: string;
    title: string;
    cover: string;
    episodeThumbnail?: string;
    category: 'sub' | 'dub';
  },
  record: OfflineEpisode,
): Promise<OfflineEpisode> {
  const src = await fetchEpisodeSources(opts.episodeId, opts.category, opts.animeId);
  if (!src?.url) {
    throw new Error('No stream found for this episode.');
  }

  if (!src.isM3U8 && isDirectFileUrl(src.url)) {
    return performDirectFileDownload(opts, record, src);
  }

  if (!src.embedUrl) {
    throw new Error('No stream found for this episode.');
  }

  const playlistCandidates = [
    src.url,
    ...(src.allSources?.map((s) => s.url).filter((u) => u && /\.m3u8?/i.test(u)) || []),
  ];
  const uniquePlaylistUrls = [...new Set(playlistCandidates)];

  let master: { text: string; cookies: string } | null = null;
  let playlistError: Error | null = null;
  for (const playlistUrl of uniquePlaylistUrls) {
    try {
      master = await fetchPlaylistText(playlistUrl, src);
      break;
    } catch (e) {
      playlistError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (!master) {
    throw (
      playlistError ||
      new Error('Could not access the video stream. Check Wi‑Fi and try again.')
    );
  }
  const headers = buildDownloadHeaders(src, master.cookies);
  const masterText = master.text;
  const mediaUrl = pickMediaPlaylistUrl(masterText, src.url) || src.url;
  const mediaText =
    mediaUrl === src.url ? masterText : (await fetchPlaylistText(mediaUrl, src)).text;

  const segments = parseSegmentUrls(mediaText, mediaUrl);
  if (segments.length === 0) throw new Error('No video segments in stream.');

  const dir = dirFor(opts.animeId, opts.episodeId);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  let current = {
    ...record,
    totalSegments: segments.length,
    completedSegments: 0,
    progress: 0,
    error: undefined,
  };
  await patchManifest(current);

  const epKey = episodeKey(opts.animeId, opts.episodeId);
  const targetMatch = mediaText.match(/#EXT-X-TARGETDURATION:(\d+)/i);
  const targetDuration = targetMatch?.[1] || '10';
  const segmentNames = new Array<string>(segments.length);
  let completed = 0;
  let bytes = 0;
  const concurrency = 3;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < segments.length) {
      if (pausedEpisodeJobs.has(epKey)) return;
      const i = nextIndex++;
      const segUrl = segments[i];
      const name = `seg${String(i).padStart(5, '0')}.ts`;
      const dest = `${dir}${name}`;
      if (await fileHasContent(dest)) {
        segmentNames[i] = name;
        const info = await FileSystem.getInfoAsync(dest);
        const size = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
        completed += 1;
        bytes += size;
        current = {
          ...current,
          completedSegments: completed,
          progress: completed / segments.length,
          bytesDownloaded: bytes,
          updatedAt: Date.now(),
        };
        await patchManifest(current);
        continue;
      }
      if (pausedEpisodeJobs.has(epKey)) return;
      await downloadFile(segUrl, dest, headers);
      segmentNames[i] = name;
      const info = await FileSystem.getInfoAsync(dest);
      const size = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
      completed += 1;
      bytes += size;
      current = {
        ...current,
        completedSegments: completed,
        progress: completed / segments.length,
        bytesDownloaded: bytes,
        updatedAt: Date.now(),
      };
      await patchManifest(current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()),
  );

  if (pausedEpisodeJobs.has(epKey) && completed < segments.length) {
    current = {
      ...current,
      status: 'paused',
      completedSegments: completed,
      progress: segments.length > 0 ? completed / segments.length : 0,
      bytesDownloaded: bytes,
      updatedAt: Date.now(),
    };
    await patchManifest(current);
    return current;
  }

  const localLines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
  ];
  for (const name of segmentNames) {
    localLines.push('#EXTINF:10.0,', name);
  }
  localLines.push('#EXT-X-ENDLIST');
  const playlistPath = `${dir}index.m3u8`;
  await FileSystem.writeAsStringAsync(playlistPath, localLines.join('\n'));

  current = {
    ...current,
    status: 'ready',
    progress: 1,
    localPlaylistUri: playlistPath,
    error: undefined,
    updatedAt: Date.now(),
  };
  await patchManifest(current);
  return current;
}

export async function downloadAnimeEpisode(opts: {
  animeId: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  title: string;
  cover: string;
  episodeThumbnail?: string;
  category?: 'sub' | 'dub';
}): Promise<void> {
  const key = episodeKey(opts.animeId, opts.episodeId);
  if (activeJobs.has(key)) return;

  await ensureLoaded();
  const existing = mem.episodes[key];
  if (existing?.status === 'ready') return;

  const category = opts.category || 'sub';
  activeJobs.add(key);

  let record: OfflineEpisode = {
    animeId: opts.animeId,
    episodeId: opts.episodeId,
    episodeNumber: opts.episodeNumber,
    episodeTitle: opts.episodeTitle,
    title: opts.title,
    cover: opts.cover,
    episodeThumbnail: opts.episodeThumbnail,
    category,
    status: 'downloading',
    progress: 0,
    bytesDownloaded: 0,
    totalSegments: 0,
    completedSegments: 0,
    updatedAt: Date.now(),
  };
  await patchManifest(record);

  const runOpts = { ...opts, category };

  try {
    record = await performDownload(runOpts, record);
    if (record.status === 'paused') return;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Download failed';
    if (mem.episodes[key]?.status === 'paused') return;
    if (isRetryableDownloadError(message)) {
      try {
        await FileSystem.deleteAsync(dirFor(opts.animeId, opts.episodeId), { idempotent: true });
      } catch {
        // ignore
      }
      record = {
        ...record,
        status: 'downloading',
        progress: 0,
        completedSegments: 0,
        totalSegments: 0,
        bytesDownloaded: 0,
        error: undefined,
        updatedAt: Date.now(),
      };
      await patchManifest(record);
      try {
        record = await performDownload(runOpts, record);
        if (record.status === 'paused') return;
        return;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : 'Download failed';
        record = {
          ...record,
          status: 'error',
          error: retryMsg,
          updatedAt: Date.now(),
        };
        await patchManifest(record);
        try {
          await FileSystem.deleteAsync(dirFor(opts.animeId, opts.episodeId), { idempotent: true });
        } catch {
          // ignore
        }
        throw retryErr;
      }
    }
    record = {
      ...record,
      status: 'error',
      error: message,
      updatedAt: Date.now(),
    };
    await patchManifest(record);
    try {
      await FileSystem.deleteAsync(dirFor(opts.animeId, opts.episodeId), { idempotent: true });
    } catch {
      // ignore
    }
    throw e;
  } finally {
    activeJobs.delete(key);
  }
}
