import { parseChapterContent } from '@/lib/allnovel';
import {
  NOVEL_MANIFEST_URL,
  OFFLINE_PREFIX,
  offlineNovelUrl,
  openOfflineLibrary,
} from '@/lib/offline-cache-keys';

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
// only `sakura-shell-*`). Keys come from lib/offline-cache-keys.ts so the
// exporter reads exactly what this writes.
const MANIFEST_URL = NOVEL_MANIFEST_URL;

type Manifest = { chapters: Record<string, OfflineNovelChapter> };

const mem: Manifest = { chapters: {} };
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const batchListeners = new Set<() => void>();
const activeJobs = new Map<string, object>();
const deleting = new Set<string>();
let clearing = 0;
let mutations: Promise<unknown> = Promise.resolve();

// Cache writes must finish before a delete, and manifests must be written in
// order. Network requests stay outside this queue so deletion never waits on
// a slow novel source.
function mutate<T>(work: () => Promise<T>): Promise<T> {
  const next = mutations.then(work);
  mutations = next.catch(() => undefined);
  return next;
}

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

const contentUrl = offlineNovelUrl;
const openLibrary = openOfflineLibrary;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        const cache = await openLibrary();
        const res = await cache?.match(MANIFEST_URL);
        if (res) {
          const parsed = (await res.json()) as Manifest;
          if (parsed?.chapters) Object.assign(mem.chapters, parsed.chapters);
        }
      } catch {
        // A corrupt manifest must not take the app down.
      } finally {
        loaded = true;
      }
    })();
  }
  await loading;
}

async function persist(strict = false): Promise<void> {
  const cache = await openLibrary();
  if (!cache) return;
  try {
    await cache.put(
      MANIFEST_URL,
      new Response(JSON.stringify(mem), { headers: { 'content-type': 'application/json' } }),
    );
  } catch (error) {
    if (strict) throw error;
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
    await mutate(() => persist());
    notify();
  }
}

export async function deleteOfflineNovelChapter(novelPath: string, chapterPath: string) {
  const key = chapterKey(novelPath, chapterPath);
  if (deleting.has(key)) return;
  deleting.add(key);
  activeJobs.delete(key);
  // Stop queued chapters too: a running Download all must not recreate a
  // chapter after the user explicitly removes it.
  batchJobs.delete(novelPath);
  notifyBatch();
  try {
    await ensureLoaded();
    await mutate(async () => {
      const cache = await openLibrary();
      if (cache) await cache.delete(contentUrl(novelPath, chapterPath));
      delete mem.chapters[key];
      await persist(true);
      notify();
    });
  } finally { deleting.delete(key); }
}

export async function clearAllOfflineNovel() {
  clearing++;
  activeJobs.clear();
  batchJobs.clear();
  notifyBatch();
  try {
    await ensureLoaded();
    await mutate(async () => {
      const cache = await openLibrary();
      if (cache) {
        // Include orphaned bodies left by interrupted older versions, but
        // never touch another media type in this shared library.
        for (const request of await cache.keys()) {
          if (!new URL(request.url).pathname.startsWith(`${OFFLINE_PREFIX}novel/`)) continue;
          // eslint-disable-next-line no-await-in-loop
          await cache.delete(request);
        }
      }
      mem.chapters = {};
      await persist(true);
      notify();
    });
  } finally { clearing--; }
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
  if (clearing || deleting.has(key) || activeJobs.has(key)) return;
  const job = {};
  activeJobs.set(key, job);
  const current = () => activeJobs.get(key) === job;
  let cache: Cache | null = null;
  let record: OfflineNovelChapter = {
    ...opts,
    status: 'downloading',
    progress: 0,
    updatedAt: Date.now(),
    bytes: 0,
  };

  try {
    await ensureLoaded();
    if (!current() || mem.chapters[key]?.status === 'ready') return;
    cache = await openLibrary();
    if (!cache) throw new Error('Offline downloads are not available in this browser.');
    if (!current()) return;

    // Best-effort durability; failure never blocks a download.
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
        void navigator.storage.persist().catch(() => undefined);
      }
    } catch { /* Storage persistence is optional. */ }

    await mutate(async () => { if (current()) await patch(record); });
    if (!current()) return;
    const content = await parseChapterContent(opts.chapterPath);
    if (!current()) return;
    if (!content?.trim()) throw new Error('Chapter has no content.');

    await mutate(async () => {
      if (!current()) return;
      await cache!.put(
        contentUrl(opts.novelPath, opts.chapterPath),
        new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      );
      if (!current()) return;
      record = {
        ...record,
        status: 'ready',
        progress: 1,
        error: undefined,
        bytes: new TextEncoder().encode(content).length,
        updatedAt: Date.now(),
      };
      await patch(record);
    });
  } catch (e) {
    // A deleted job may finish or fail later. Neither outcome may resurrect
    // its row or remove a newer download of the same chapter.
    if (!current()) return;
    const message =
      e instanceof DOMException && e.name === 'QuotaExceededError'
        ? 'Your device is out of space for downloads.'
        : e instanceof Error ? e.message : 'Download failed';
    await mutate(async () => {
      if (!current()) return;
      record = { ...record, status: 'error', error: message, updatedAt: Date.now() };
      await patch(record);
      await cache?.delete(contentUrl(opts.novelPath, opts.chapterPath)).catch(() => undefined);
    });
    if (current()) throw e;
  } finally {
    if (current()) activeJobs.delete(key);
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
  if (clearing) return { ok: 0, failed: 0 };
  const list = opts.chapters.slice(0, opts.limit ?? opts.chapters.length);
  const existing = batchJobs.get(opts.novelPath);
  const startIndex = existing?.paused ? existing.done : 0;
  let ok = existing?.paused ? existing.ok : 0;
  let failed = existing?.paused ? existing.failed : 0;

  const batch: NovelBatchJob = {
    novelPath: opts.novelPath,
    paused: false,
    done: startIndex,
    total: list.length,
    ok,
    failed,
  };
  batchJobs.set(opts.novelPath, batch);
  notifyBatch();

  for (let i = startIndex; i < list.length; i++) {
    const job = batchJobs.get(opts.novelPath);
    if (job !== batch) return { ok, failed };
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
      if (batchJobs.get(opts.novelPath) !== batch) return { ok, failed };
      ok++;
    } catch {
      if (batchJobs.get(opts.novelPath) !== batch) return { ok, failed };
      // One bad chapter must not abandon the rest of the book.
      failed++;
    }

    const current = batchJobs.get(opts.novelPath);
    if (current !== batch) return { ok, failed };
    if (current) {
      current.done = i + 1;
      current.ok = ok;
      current.failed = failed;
      notifyBatch();
    }
    opts.onProgress?.(i + 1, list.length);
  }

  if (batchJobs.get(opts.novelPath) === batch) batchJobs.delete(opts.novelPath);
  notifyBatch();
  return { ok, failed };
}
