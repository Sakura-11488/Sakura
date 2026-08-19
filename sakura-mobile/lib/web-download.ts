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
/** Extension from a MIME type, or '' when it says nothing useful. */
function extFromMime(mime: string | undefined): string {
  const type = (mime || '').toLowerCase();
  if (type.includes('webp')) return 'webp';
  if (type.includes('png')) return 'png';
  if (type.includes('gif')) return 'gif';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return '';
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

/**
 * Save pages that are ALREADY on disk as a single .cbz.
 *
 * This takes bytes rather than URLs on purpose. The version that fetched its
 * own pages is gone: the offline library downloads them once, and re-fetching
 * a chapter the user already has would cost them their data and cost the
 * droplet its concurrency budget for a file they could already read.
 *
 * So this is now a pure repackage — zero network — and it exists for one
 * reason: a file in the browser's Downloads folder cannot be evicted, and a
 * Cache Storage entry can. The library is the convenient copy; this is the
 * durable one.
 *
 * The archive is a .cbz. The bytes were always exactly a comic archive, but a
 * .zip extension made Android offer to extract a few hundred loose images
 * instead of opening the chapter in a reader.
 */
export async function saveCbzFromBlobs(
  baseName: string,
  pages: Array<{ blob: Blob; ext?: string }>,
): Promise<{ filename: string; pages: number; bytes: number }> {
  ensureWebEnv();
  if (!pages.length) throw new Error('Nothing to save.');

  const folder = sanitize(baseName);
  const filename = `${folder}.cbz`;
  const pad = (n: number) => String(n).padStart(4, '0');
  const writer = new StoreZipWriter();
  let bytes = 0;

  for (let i = 0; i < pages.length; i++) {
    const { blob, ext } = pages[i];
    if (!blob?.size) continue;
    // Prefer the stored Content-Type over any caller-supplied hint: these
    // blobs came out of Cache Storage with the type the server actually sent.
    const fromType = extFromMime(blob.type);
    // eslint-disable-next-line no-await-in-loop
    const buf = new Uint8Array(await blob.arrayBuffer());
    bytes += buf.length;
    writer.add(`${folder}/page-${pad(i + 1)}.${fromType || ext || 'jpg'}`, buf);
  }

  if (!writer.count) throw new Error('Nothing to save.');
  triggerBrowserDownload(writer.finish('application/vnd.comicbook+zip'), filename);
  return { filename, pages: writer.count, bytes };
}