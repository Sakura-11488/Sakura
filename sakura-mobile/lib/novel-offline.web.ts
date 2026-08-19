import { parseChapterContent } from '@/lib/allnovel';

/**
 * Offline novel library on web.
 *
 * The `.web.ts` counterpart of lib/novel-offline.ts, exporting the same surface
 * so app/novel/ext.tsx, app/novel/read.tsx, app/downloads.tsx and settings all
 * work unchanged.
 *
 * IMPORTANT: never import '@/lib/novel-offline' from here — on web that
 * specifier resolves to THIS file. A module importing its own base name is how
 * every Consumet call on web was silently killed once before.
 *
 * Unlike the manhwa store this needs no service worker: chapters are TEXT, and
 * the reader asks for a string (`getOfflineNovelChapterContent`) rather than a
 * URL to put in an <Image>. So the bytes are read straight out of Cache Storage
 * from the main thread, and nothing depends on a fetch being intercepted.
 *
 * Chapter text is ~8KB, so a whole book is roughly 20MB — the quota question
 * that shapes the image library simply does not bite here, which is why the
 * batch "download all" path is kept rather than capped.
 *
 * Fetching works on web because lib/allnovel-html.web.ts already routes novel
 * HTML through the Supabase web-content-proxy edge function; parseChapterContent
 * sits on top of that and needs no change.
 */

export type OfflineNovelStatus = 'downloading' | 'ready' | 'error';

export interface OfflineNovelChapter {
  novelPath: string;
  chapterPath: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
  status: OfflineNovelStatus;
  progress: number;
  error?: string;
  updatedAt: number;
  /** Stored size. Web-only; native stats the file instead. */
  bytes?: number;
}

// Same cache as the image library, so there is exactly one store to protect
// from the service worker's activate sweep (see web/public/sw.js — it deletes
// only `sakura-shell-*`).
const LIBRARY_CACHE = 'sakura-offline-v1';
const NOVEL_PREFIX = '/app/__offline/novel/';
const MANIFEST_URL = '/app/__offline/novel-manifest.json';

type Manifest = { chapters: Record<string, OfflineNovelChapter> };

const mem: Manifest = { chapters: {} };
let loaded = false;
const listeners = new Set<() => void>();
const batchListeners = new Set<() => void>();
const activeJobs = new Set<string>();

type NovelBatchJob = {
  novelPath: string;
  paused: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
};

const batchJobs = new Map<string, NovelBatchJob>();

function notifyBatch() {
  batchListeners.forEach((fn) => fn());
}

export function subscribeNovelBatch(fn: () => void) {
  batchListeners.add(fn);
  return () => batchListeners.delete(fn);
}

export function getNovelBatchState(novelPath: string): NovelBatchJob | null {
  return batchJobs.get(novelPath) ?? null;
}

export function pauseNovelBatchDownload(novelPath: string) {
  const job = batchJobs.get(novelPath);
  if (!job || job.paused) return;
  job.paused = true;
  notifyBatch();
}

export function resumeNovelBatchDownload(novelPath: string) {
  const job = batchJobs.get(novelPath);
  if (!job?.paused) return;
  job.paused = false;
  notifyBatch();
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeOfflineNovel(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function chapterKey(novelPath: string, chapterPath: string) {
  return `${novelPath}::${chapterPath}`;
}

function contentUrl(novelPath: string, chapterPath: string): string {
  return `${NOVEL_PREFIX}${encodeURIComponent(novelPath)}/${encodeURIComponent(chapterPath)}`;
}

async function openLibrary(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(LIBRARY_CACHE);
  } catch {
    return null;
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const cache = await openLibrary();
  if (!cache) return;
  try {
    const res = await cache.match(MANIFEST_URL);
    if (res) {
      const parsed = (await res.json()) as Manifest;
      if (parsed?.chapters) Object.assign(mem.chapters, parsed.chapters);
    }
  } catch {
    // A corrupt manifest must not take the app down; re-downloading rewrites it.
  }
}

async function persist(): Promise<void> {
  const cache = await openLibrary();
  if (!cache) return;
  try {
    await cache.put(
      MANIFEST_URL,
      new Response(JSON.stringify(mem), { headers: { 'content-type': 'application/json' } }),
    );
  } catch {
    // Quota or private mode. The in-memory manifest still drives this session.
  }
}

async function patch(record: OfflineNovelChapter): Promise<void> {
  mem.chapters[chapterKey(record.novelPath, record.chapterPath)] = record;
  await persist();
  notify();
}

export async function getOfflineNovelChapter(
  novelPath: string,
  chapterPath: string,
): Promise<OfflineNovelChapter | null> {
  await ensureLoaded();
  return mem.chapters[chapterKey(novelPath, chapterPath)] || null;
}

/** Single manifest scan — avoids N lookups when rendering long chapter lists. */
export async function getOfflineMapForNovel(
  novelPath: string,
): Promise<Record<string, OfflineNovelChapter>> {
  await ensureLoaded();
  const map: Record<string, OfflineNovelChapter> = {};
  for (const row of Object.values(mem.chapters)) {
    if (row.novelPath === novelPath) map[row.chapterPath] = row;
  }
  return map;
}

export async function getOfflineNovelChapterContent(
  novelPath: string,
  chapterPath: string,
): Promise<string | null> {
  const row = await getOfflineNovelChapter(novelPath, chapterPath);
  if (row?.status !== 'ready') return null;
  const cache = await openLibrary();
  if (!cache) return null;
  try {
    // Read the bytes rather than trusting the manifest: Cache Storage can be
    // evicted by the browser while the in-memory manifest survives, and
    // returning null here just falls the reader back to the network.
    const res = await cache.match(contentUrl(novelPath, chapterPath));
    if (!res) return null;
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  }
}

export async function listOfflineNovelChapters(): Promise<OfflineNovelChapter[]> {
  await ensureLoaded();
  return Object.values(mem.chapters).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A tab closed mid-download leaves a row claiming to be downloading forever.
 * Only rows older than module load are touched, so a job started by this
 * session is never stolen from itself.
 */
const MODULE_LOADED_AT = Date.now();

export async function reconcileInterruptedNovelChapters(): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const [key, row] of Object.entries(mem.chapters)) {
    if (row.status === 'downloading' && row.updatedAt < MODULE_LOADED_AT && !activeJobs.has(key)) {
      // Novels have no resume: a chapter is one request, so there is no partial
      // state to continue from. Native marks these 'error' with a retry hint
      // for exactly that reason, and this mirrors it.
      mem.chapters[key] = {
        ...row,
        status: 'error',
        error: 'Interrupted — tap to retry',
        updatedAt: Date.now(),
      };
      changed = true;
    }
  }
  if (changed) {
    await persist();
    notify();
  }
}

export async function deleteOfflineNovelChapter(novelPath: string, chapterPath: string) {
  await ensureLoaded();
  const cache = await openLibrary();
  if (cache) await cache.delete(contentUrl(novelPath, chapterPath)).catch(() => undefined);
  delete mem.chapters[chapterKey(novelPath, chapterPath)];
  await persist();
  notify();
}

export async function clearAllOfflineNovel() {
  await ensureLoaded();
  const cache = await openLibrary();
  if (cache) {
    for (const row of Object.values(mem.chapters)) {
      // eslint-disable-next-line no-await-in-loop
      await cache.delete(contentUrl(row.novelPath, row.chapterPath)).catch(() => undefined);
    }
  }
  mem.chapters = {};
  await persist();
  notify();
}

export async function getOfflineNovelStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const row of Object.values(mem.chapters)) {
    if (row.status !== 'ready') continue;
    total += row.bytes || 0;
  }
  return total;
}

export async function downloadNovelChapter(opts: {
  novelPath: string;
  chapterPath: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
}): Promise<void> {
  const key = chapterKey(opts.novelPath, opts.chapterPath);
  if (activeJobs.has(key)) return;
  await ensureLoaded();
  if (mem.chapters[key]?.status === 'ready') return;

  const cache = await openLibrary();
  if (!cache) throw new Error('Offline downloads are not available in this browser.');

  // Best-effort durability. On an installed Android Chrome PWA this is normally
  // granted without a prompt; when it is not, downloads still work but the
  // browser may reclaim them, which the Downloads screen says plainly.
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      void navigator.storage.persist();
    }
  } catch {
    // Not fatal, and not worth telling the user about at this moment.
  }

  activeJobs.add(key);
  let record: OfflineNovelChapter = {
    ...opts,
    status: 'downloading',
    progress: 0,
    updatedAt: Date.now(),
    bytes: 0,
  };
  await patch(record);

  try {
    const content = await parseChapterContent(opts.chapterPath);
    if (!content?.trim()) throw new Error('Chapter has no content.');

    await cache.put(
      contentUrl(opts.novelPath, opts.chapterPath),
      new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    );

    record = {
      ...record,
      status: 'ready',
      progress: 1,
      error: undefined,
      // Byte length, not string length: the text is UTF-8 and a CJK novel is
      // roughly three times its character count on disk.
      bytes: new TextEncoder().encode(content).length,
      updatedAt: Date.now(),
    };
    await patch(record);
  } catch (e) {
    const message =
      e instanceof DOMException && e.name === 'QuotaExceededError'
        ? 'Your device is out of space for downloads.'
        : e instanceof Error
          ? e.message
          : 'Download failed';
    record = { ...record, status: 'error', error: message, updatedAt: Date.now() };
    await patch(record);
    // Drop any half-written body so a retry cannot read a truncated chapter.
    await cache.delete(contentUrl(opts.novelPath, opts.chapterPath)).catch(() => undefined);
    throw e;
  } finally {
    activeJobs.delete(key);
  }
}

export async function downloadAllNovelChapters(opts: {
  novelPath: string;
  title: string;
  cover: string;
  chapters: Array<{ path: string; chapterNumber: number; name: string }>;
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const list = opts.chapters.slice(0, opts.limit ?? opts.chapters.length);
  const existing = batchJobs.get(opts.novelPath);
  const startIndex = existing?.paused ? existing.done : 0;
  let ok = existing?.paused ? existing.ok : 0;
  let failed = existing?.paused ? existing.failed : 0;

  batchJobs.set(opts.novelPath, {
    novelPath: opts.novelPath,
    paused: false,
    done: startIndex,
    total: list.length,
    ok,
    failed,
  });
  notifyBatch();

  for (let i = startIndex; i < list.length; i++) {
    const job = batchJobs.get(opts.novelPath);
    if (!job) break;
    if (job.paused) {
      notifyBatch();
      return { ok, failed, paused: true };
    }

    const ch = list[i];
    try {
      await downloadNovelChapter({
        novelPath: opts.novelPath,
        chapterPath: ch.path,
        chapterNumber: ch.chapterNumber,
        chapterTitle: ch.name,
        title: opts.title,
        cover: opts.cover,
      });
      ok++;
    } catch {
      // One bad chapter must not abandon the rest of the book.
      failed++;
    }

    const current = batchJobs.get(opts.novelPath);
    if (current) {
      current.done = i + 1;
      current.ok = ok;
      current.failed = failed;
      notifyBatch();
    }
    opts.onProgress?.(i + 1, list.length);
  }

  batchJobs.delete(opts.novelPath);
  notifyBatch();
  return { ok, failed };
}
