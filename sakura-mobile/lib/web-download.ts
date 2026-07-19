// Web-only download helpers. On the web build there is no native filesystem, so
// offline "downloads" instead stream content into the browser's own Downloads
// folder: novels as a .txt file, image chapters (manga/comics/18+) as a .zip of
// pages. Call sites must branch on `Platform.OS === 'web'` before importing/using
// these — the functions assume a browser environment (document/fetch/Blob).
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

/** Filesystem-safe filename fragment. */
function sanitize(name: string): string {
  return (name || 'sakura')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .slice(0, 80) || 'sakura';
}

function extFromUrl(url: string): string {
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
// compression library is needed. Good enough for already-compressed JP/PNG pages.

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

type ZipEntry = { name: string; data: Uint8Array };

function buildStoreZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

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
    locals.push(lfh, entry.data);

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
    centrals.push(cdh);

    offset += lfh.length + size;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir start disk
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of locals) {
    out.set(chunk, p);
    p += chunk.length;
  }
  for (const chunk of centrals) {
    out.set(chunk, p);
    p += chunk.length;
  }
  out.set(eocd, p);
  return out;
}

/**
 * Fetch a list of image URLs and save them as a single .zip of pages. Droplet
 * URLs are routed through the web media proxy (CORS + no mixed-content); pages
 * that fail to fetch are skipped rather than aborting the whole archive.
 */
export async function saveImagesZip(
  baseName: string,
  urls: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  ensureWebEnv();
  const folder = sanitize(baseName);
  const entries: ZipEntry[] = [];
  const pad = (n: number) => String(n).padStart(4, '0');

  for (let i = 0; i < urls.length; i++) {
    const src = getWebMediaProxyUrl(urls[i]);
    try {
      const res = await fetch(src);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length) {
          entries.push({ name: `${folder}/page-${pad(i + 1)}.${extFromUrl(urls[i])}`, data: buf });
        }
      }
    } catch {
      // skip an unreachable page (e.g. a source that blocks cross-origin fetch)
    }
    onProgress?.(i + 1, urls.length);
  }

  if (!entries.length) {
    throw new Error('Pages could not be downloaded in the browser. Use the Sakura mobile app for offline reading.');
  }

  const zip = buildStoreZip(entries);
  const part = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
  triggerBrowserDownload(new Blob([part], { type: 'application/zip' }), `${folder}.zip`);
  return entries.length;
}
