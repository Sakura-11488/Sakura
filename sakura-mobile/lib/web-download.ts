// Web-only download helpers. On the web build there is no native filesystem, so
// offline "downloads" instead stream content into the browser's own Downloads
// folder: novels as a .txt file, image chapters (manga/comics/18+) as a .cbz of
// pages. Call sites must branch on `Platform.OS === 'web'` before importing/using
// these — the functions assume a browser environment (document/fetch/Blob).
//
// This is an EXPORT, not a library. The file lands in the browser's Downloads
// folder and Sakura can never read it back — unlike native, where downloads live
// under the app's control and the reader silently prefers them. Anything in the
// UI that implies otherwise is a lie.
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';

function ensureWebEnv(): void {
  if (typeof document === 'undefined' || typeof fetch === 'undefined') {
    throw new Error('Downloads are not available in this browser.');
  }
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/** Windows reserves these regardless of extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Filesystem-safe filename fragment, in any script.
 *
 * The previous version used `/[^\w.\- ]+/g`, and `\w` is ASCII-only with no `u`
 * flag — so "呪術廻戦 - Ch 12" became "- Ch 12" and every non-Latin series
 * collided on one filename. Unicode letter/number classes keep the title.
 */
function sanitize(name: string): string {
  let out = (name || 'sakura')
    // One allowlist, deliberately. Pairing this with a separate blocklist for
    // path separators and control characters was both redundant — nothing
    // outside this class survives it anyway — and a hazard: the
    // control-character range ended up in the source as literal NUL bytes,
    // which made the whole file read as binary to grep and every other tool.
    .replace(/[^\p{L}\p{N}._\- ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently strips trailing dots and spaces; do it ourselves so the
    // name we promise is the name that lands.
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  if (!out || RESERVED.test(out)) out = `sakura${out ? `-${out}` : ''}`;
  return out;
}
function extFromResponse(res: Response, url: string): string {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('webp')) return 'webp';
  if (type.includes('png')) return 'png';
  if (type.includes('gif')) return 'gif';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  const path = (url.split('?')[0] || '').toLowerCase();
  const m = path.match(/\.(jpg|jpeg|png|webp|gif)$/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  return 'jpg';
}

/** Save arbitrary text as a .txt download (used for novel chapters on web). */
export function saveTextFile(baseName: string, text: string): void {
  ensureWebEnv();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  triggerBrowserDownload(blob, `${sanitize(baseName)}.txt`);
}

// --- Minimal store-only (uncompressed) ZIP writer -------------------------
// A store-only archive is just each file's bytes framed by ZIP headers, so no
// compression library is needed. Good enough for already-compressed JPG/PNG
// pages — deflate returns 0-2% on entropy-coded image data while costing
// battery.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildLocalHeader(nameBytes: Uint8Array, crc: number, size: number): Uint8Array {
  const lfh = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(lfh.buffer);
  lv.setUint32(0, 0x04034b50, true); // local file header signature
  lv.setUint16(4, 20, true); // version needed to extract
  lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename
  lv.setUint16(8, 0, true); // compression method: store
  lv.setUint16(10, 0, true); // mod time
  lv.setUint16(12, 0x21, true); // mod date (1980-01-01)
  lv.setUint32(14, crc, true);
  lv.setUint32(18, size, true); // compressed size
  lv.setUint32(22, size, true); // uncompressed size
  lv.setUint16(26, nameBytes.length, true);
  lv.setUint16(28, 0, true); // extra field length
  lfh.set(nameBytes, 30);
  return lfh;
}

function buildCentralHeader(
  nameBytes: Uint8Array,
  crc: number,
  size: number,
  offset: number,
): Uint8Array {
  const cdh = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(cdh.buffer);
  cv.setUint32(0, 0x02014b50, true); // central directory signature
  cv.setUint16(4, 20, true); // version made by
  cv.setUint16(6, 20, true); // version needed
  cv.setUint16(8, 0x0800, true); // flags: UTF-8
  cv.setUint16(10, 0, true); // method: store
  cv.setUint16(12, 0, true); // time
  cv.setUint16(14, 0x21, true); // date
  cv.setUint32(16, crc, true);
  cv.setUint32(20, size, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint16(30, 0, true); // extra
  cv.setUint16(32, 0, true); // comment
  cv.setUint16(34, 0, true); // disk number
  cv.setUint16(36, 0, true); // internal attrs
  cv.setUint32(38, 0, true); // external attrs
  cv.setUint32(42, offset, true); // local header offset
  cdh.set(nameBytes, 46);
  return cdh;
}

function buildEocd(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir start disk
  ev.setUint16(8, count, true); // entries on this disk
  ev.setUint16(10, count, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length
  return eocd;
}

/**
 * Incremental store-only ZIP writer.
 *
 * The previous implementation accumulated every page's bytes in an array, then
 * allocated a second full copy in `buildStoreZip`, then sliced a third for the
 * Blob — peak memory of roughly 3-4x the chapter. A 92MB comics issue therefore
 * needed ~380MB of live ArrayBuffer, and the tab simply died, after the user
 * had waited through the entire download.
 *
 * Handing each page to `new Blob([data])` immediately moves it out of the JS
 * heap into the browser's blob store (Chromium keeps blob data in the browser
 * process and spills to disk above a threshold), so the heap holds at most
 * `concurrency` pages regardless of chapter length. The header bytes stay in
 * memory but are ~76 bytes per page.
 *
 * NOTE: this is documented Chromium design, not something measured on a real
 * phone. If a large issue still OOMs, the verified fallback is staging the
 * archive in OPFS via createWritable — deliberately not built yet, because it
 * would add a third code path for older iOS where createWritable is missing.
 */
class StoreZipWriter {
  private parts: BlobPart[] = [];
  private centrals: Uint8Array[] = [];
  private offset = 0;
  private enc = new TextEncoder();

  add(name: string, data: Uint8Array): void {
    const nameBytes = this.enc.encode(name);
    const crc = crc32(data);
    const size = data.length;
    const lfh = buildLocalHeader(nameBytes, crc, size);
    // TS 5.7 made Uint8Array generic over ArrayBufferLike, which no longer
    // structurally matches BlobPart; the runtime accepts a Uint8Array fine.
    this.parts.push(lfh as unknown as BlobPart, new Blob([data as unknown as BlobPart]));
    this.centrals.push(buildCentralHeader(nameBytes, crc, size, this.offset));
    this.offset += lfh.length + size;
  }

  get count(): number {
    return this.centrals.length;
  }

  finish(type: string): Blob {
    const centralSize = this.centrals.reduce((n, c) => n + c.length, 0);
    // The format's own ceilings. Both are three orders of magnitude beyond a
    // real chapter — memory would die first — but a silently corrupt archive is
    // worse than a refusal, and ZIP64 is not worth carrying for this.
    if (this.centrals.length > 0xffff) throw new Error('Too many pages for a single archive.');
    if (this.offset + centralSize + 22 > 0xffffffff) throw new Error('This chapter is too large to save in one file.');
    const eocd = buildEocd(this.centrals.length, centralSize, this.offset);
    return new Blob(
      [...this.parts, ...(this.centrals as unknown as BlobPart[]), eocd as unknown as BlobPart],
      { type },
    );
  }
}

export type PageFailure = {
  /** 0-based page index. */
  index: number;
  kind: 'network' | 'http' | 'timeout' | 'notimage';
  status?: number;
};

export type ZipResult = {
  saved: number;
  total: number;
  failed: PageFailure[];
  filename: string;
};

type PageOutcome =
  | { ok: true; index: number; bytes: Uint8Array; ext: string }
  | { ok: false; index: number; kind: PageFailure['kind']; status?: number };

/**
 * The droplet's whole direct-fetch budget is COMICS_DIRECT_CONCURRENCY=6 across
 * all clients, on a 1-worker nginx that also fronts psyopanime, mangadex,
 * manhwa, media and creator-media on a 1GB box. One user at 6 would consume the
 * entire budget and degrade reading and video for everyone else — this proxy
 * has already had to be throttled once for exactly that (commit 4308e77).
 * Three is a real speedup over sequential without being a denial of service.
 */
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

async function fetchPage(
  url: string,
  index: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<PageOutcome> {
  const timer = new AbortController();
  const onAbort = () => timer.abort();
  signal?.addEventListener('abort', onAbort);
  const timeout = setTimeout(() => timer.abort(), timeoutMs);
  try {
    const res = await fetch(getWebMediaProxyUrl(url), { signal: timer.signal });
    if (!res.ok) return { ok: false, index, kind: 'http', status: res.status };
    const ext = extFromResponse(res, url);
    const buf = new Uint8Array(await res.arrayBuffer());
    // A proxy error page is a 200 with HTML in it; an empty body is equally
    // useless. Either way it is not a page, and writing it into the archive
    // would produce a file that opens to a broken image.
    if (!buf.length) return { ok: false, index, kind: 'notimage' };
    return { ok: true, index, bytes: buf, ext };
  } catch (e) {
    // The caller's cancel and our own timeout both surface as AbortError; only
    // the caller's should stop the whole job.
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const kind = e instanceof DOMException && e.name === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, index, kind };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch a list of image URLs and save them as a single .cbz of pages.
 *
 * Returns what actually happened rather than only a count, so the caller can
 * tell the user the truth: the old version silently skipped unreachable pages
 * and reported the survivors as a success, which produced messages like
 * "Saved 1 pages to your device" for a 189-page chapter, and a file that looked
 * complete but was not.
 *
 * The archive is a .cbz — the bytes were always exactly a comic archive, but the
 * .zip extension made Android offer to extract a few hundred loose images
 * instead of opening the chapter in a reader.
 */
export async function saveImagesZip(
  baseName: string,
  urls: string[],
  opts?: {
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
    concurrency?: number;
    perRequestTimeoutMs?: number;
  },
): Promise<ZipResult> {
  ensureWebEnv();
  const folder = sanitize(baseName);
  const filename = `${folder}.cbz`;
  const pad = (n: number) => String(n).padStart(4, '0');
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? DEFAULT_CONCURRENCY, 6));
  const timeoutMs = opts?.perRequestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const writer = new StoreZipWriter();
  const failed: PageFailure[] = [];

  // Batched rather than a windowed pool: order is preserved for free, and at
  // most `concurrency` pages are live at once. It costs head-of-line blocking
  // within a batch, which is worth the simplicity at this size.
  for (let i = 0; i < urls.length; i += concurrency) {
    if (opts?.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const slice = urls.slice(i, i + concurrency);
    const settled = await Promise.all(
      slice.map((u, k) => fetchPage(u, i + k, timeoutMs, opts?.signal)),
    );
    for (const r of settled) {
      if (r.ok) writer.add(`${folder}/page-${pad(r.index + 1)}.${r.ext}`, r.bytes);
      else failed.push({ index: r.index, kind: r.kind, status: r.status });
    }
    opts?.onProgress?.(Math.min(i + concurrency, urls.length), urls.length);
  }

  if (!writer.count) {
    throw new Error(
      urls.length
        ? "None of this chapter's pages could be fetched. This source may not allow downloads in a browser."
        : 'No pages found for this chapter.',
    );
  }

  triggerBrowserDownload(writer.finish('application/vnd.comicbook+zip'), filename);
  return { saved: writer.count, total: urls.length, failed, filename };
}
