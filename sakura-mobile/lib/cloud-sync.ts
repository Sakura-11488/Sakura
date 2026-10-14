/**
 * Cloud Sync — backs up the Expo app's library and reading/watching progress to
 * Supabase so a wallet keeps its data across devices. Reuses the existing
 * wallet-keyed tables from the web app (`user_library`, `anime_history`,
 * `manga_progress`). All writes are keyed by the connected wallet address.
 *
 * Merge rule: union for collections, newest-updatedAt wins per item.
 *
 * Push cadence. Each table row holds a whole store, and CloudSyncBridge asks
 * for a push on every progress change: the player saves a bookmark every 3 s
 * and the reader on every page, and a 2.5 s debounce fired inside each gap,
 * so a 24-minute episode cost ~480 pushes of all three stores (~1,440
 * upserts) though only one store had changed. Now:
 *
 * - a push is coalesced to at most one per PUSH_MIN_INTERVAL_MS (30 s) per
 *   wallet — the first change after a quiet spell still goes out after a
 *   short settle — plus an immediate flush when the app backgrounds (the
 *   bridge) or the page is hidden/unloaded (`pagehide`, here);
 * - only a store whose contents changed since our last successful push is
 *   sent (a fingerprint of what the cloud row holds);
 * - flushes run one at a time per wallet, so an older snapshot can never land
 *   after a newer one (the old timer and background pushes could overlap).
 *
 * No data loss: everything stays in local storage first, a store only counts
 * as pushed once Supabase accepted it (failures are retried on the next
 * window), and every connect pulls, merges and pushes everything again. At
 * worst ~30 s of progress waits for the next launch if the app is killed
 * before its background flush completes.
 */
import { supabase } from './supabase';
import { Library, type LibraryItem } from './storage';
import {
  exportReadingProgress,
  importReadingProgress,
} from './reader-progress';
import {
  getAllWatchHistory,
  importWatchProgress,
  type AnimeWatchProgress,
} from './watch-progress';

/** At most one scheduled push per wallet in this window. */
export const PUSH_MIN_INTERVAL_MS = 30_000;
/** Lets a burst of changes (save + progress) leave as one push. */
export const PUSH_SETTLE_MS = 2_500;
/**
 * Ceiling for the retry window while pushes keep failing. Offline, or a row
 * Supabase keeps rejecting, would otherwise re-send whole stores every 30 s
 * for as long as the app stays open; the window doubles per failure instead
 * (30 s, 1 min, 2 min, 4 min, 5 min…). Nothing is lost meanwhile: the data
 * is local, and a background flush or reconnect still sends it at once.
 */
export const PUSH_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Cloud rows are untrusted input, not our own data coming home.
 *
 * `user_library`, `anime_history` and `manga_progress` each carry a single
 * `FOR ALL … USING (true)` policy, so until every write moves behind a
 * signature-verified function, any holder of the anon key that ships in the
 * public bundle can put arbitrary JSON in another wallet's row. These pulls
 * used to cast that straight into `LibraryItem[]` and merge it into local
 * storage — stored client-side injection, and completely silent.
 *
 * Validating here is worth keeping even after the writes are locked down: a
 * malformed row from an old client version should be dropped, not merged.
 */
function keepValid<T>(value: unknown, isValid: (entry: unknown) => boolean): T[] {
  if (!Array.isArray(value)) return [];
  // Drop bad entries rather than rejecting the whole payload, so one corrupt
  // row cannot cost the user their entire synced library.
  return value.filter(isValid) as T[];
}

const isLibraryItem = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    o.id.length < 512 &&
    typeof o.title === 'string' &&
    (o.type === 'anime' || o.type === 'manga' || o.type === 'novel')
  );
};

const isWatchProgress = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return typeof o.animeId === 'string' && o.animeId.length > 0 && o.animeId.length < 512;
};

/**
 * A short, stable digest of a store (cyrb53 over its JSON, plus the length),
 * so "did this change since the last push?" costs one string compare instead
 * of keeping a copy of every store in memory.
 */
export function syncFingerprint(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** supabase-js reports failures in `{ error }` rather than throwing; make them throw. */
async function upsertRow(table: string, row: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from(table).upsert(row, { onConflict: 'wallet_address' });
  if (error) throw new Error(`${table}: ${error.message || 'upsert failed'}`);
}

type StoreKey = 'library' | 'watch' | 'reading';
const STORE_KEYS: StoreKey[] = ['library', 'watch', 'reading'];

const STORES: Record<StoreKey, { read: () => Promise<unknown>; write: (wallet: string, data: any) => Promise<void> }> = {
  library: {
    read: () => Library.getAll(),
    write: (wallet, data) =>
      upsertRow('user_library', { wallet_address: wallet, data, updated_at: new Date().toISOString() }),
  },
  watch: {
    read: () => getAllWatchHistory(),
    write: (wallet, data) =>
      upsertRow('anime_history', { wallet_address: wallet, data, updated_at: new Date().toISOString() }),
  },
  reading: {
    read: () => exportReadingProgress(),
    write: (wallet, store) =>
      upsertRow('manga_progress', {
        wallet_address: wallet,
        chapter_progress: store,
        read_chapters: {},
        updated_at: new Date().toISOString(),
      }),
  },
};

interface WalletPushState {
  timer: ReturnType<typeof setTimeout> | null;
  /** When the last flush that actually sent something started (0 = never). */
  lastPushAt: number;
  /** Fingerprint of what the cloud row holds from our last accepted push. */
  pushed: Partial<Record<StoreKey, string>>;
  /** Flushes for this wallet run strictly one after another. */
  chain: Promise<void>;
  /** Consecutive flushes with a failed store; widens the retry window. */
  failures: number;
}

const states = new Map<string, WalletPushState>();

/**
 * The wallet CloudSyncBridge is syncing now. The local stores are shared by
 * every wallet on the device, so a retry may only be scheduled for this one:
 * a failed flush of the previous wallet during a switch would otherwise fire
 * 30 s later and upload the new wallet's merged library into the old row.
 * (The old wallet's changes are still local, and its next connect sends them.)
 */
let activeWallet: string | null = null;

function stateFor(wallet: string): WalletPushState {
  let state = states.get(wallet);
  if (!state) {
    state = { timer: null, lastPushAt: 0, pushed: {}, chain: Promise.resolve(), failures: 0 };
    states.set(wallet, state);
  }
  return state;
}

/** The push window: PUSH_MIN_INTERVAL_MS, doubled per consecutive failure, capped. */
function pushWindow(state: WalletPushState): number {
  if (state.failures <= 1) return PUSH_MIN_INTERVAL_MS;
  return Math.min(PUSH_MIN_INTERVAL_MS * 2 ** Math.min(state.failures - 1, 10), PUSH_MAX_BACKOFF_MS);
}

async function pushStore(wallet: string, key: StoreKey, state: WalletPushState, force: boolean): Promise<boolean> {
  const data = await STORES[key].read();
  const print = syncFingerprint(data);
  if (!force && state.pushed[key] === print) return false;
  await STORES[key].write(wallet, data);
  // Only now does the cloud hold it; a failed write leaves the old print, so
  // the next flush tries again.
  state.pushed[key] = print;
  return true;
}

async function pushChanged(wallet: string, state: WalletPushState): Promise<void> {
  const startedAt = Date.now();
  const results = await Promise.allSettled(STORE_KEYS.map((key) => pushStore(wallet, key, state, false)));
  const sent = results.some((r) => r.status === 'fulfilled' && r.value);
  const failed = results.some((r) => r.status === 'rejected');
  if (sent || failed) state.lastPushAt = startedAt;
  state.failures = failed ? state.failures + 1 : 0;
  // Offline or Supabase down: try again next window rather than dropping it —
  // but only for the wallet still being synced (see activeWallet).
  if (failed && wallet === activeWallet) armPush(wallet);
}

/** Run `task` after every earlier push for this wallet has finished. */
function enqueue<T>(wallet: string, task: (state: WalletPushState) => Promise<T>): Promise<T> {
  const state = stateFor(wallet);
  const run = state.chain.then(() => task(state));
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Push now (skipping the window) whatever changed; resolves when it is done. */
function flushWallet(wallet: string): Promise<void> {
  const state = stateFor(wallet);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  return enqueue(wallet, (s) => pushChanged(wallet, s));
}

/** Flush every wallet with a push waiting (page hidden or unloading). */
function flushPending(): void {
  states.forEach((state, wallet) => {
    if (state.timer) flushWallet(wallet).catch(() => {});
  });
}

let pageHideHooked = false;
/**
 * Web only: closing or navigating away from the tab must not strand up to
 * 30 s of progress. `pagehide` fires on unload and when the page enters the
 * back/forward cache. (Backgrounding — visibilitychange on web, AppState on
 * native — is CloudSyncBridge's pushAllToCloud.) React Native's `window` has
 * no addEventListener, so this is a no-op there.
 */
function hookPageHide(): void {
  if (pageHideHooked) return;
  pageHideHooked = true;
  const w = typeof window !== 'undefined' ? (window as unknown as { addEventListener?: unknown }) : null;
  if (!w || typeof w.addEventListener !== 'function') return;
  (w.addEventListener as (type: string, fn: () => void) => void)('pagehide', flushPending);
}

// ─── Library ──────────────────────────────────────────────────────────────────
export async function pushLibrary(wallet: string): Promise<void> {
  if (!wallet) return;
  await enqueue(wallet, (state) => pushStore(wallet, 'library', state, true));
}

export async function pullLibrary(wallet: string): Promise<void> {
  if (!wallet) return;
  const { data } = await supabase.from('user_library').select('data').eq('wallet_address', wallet).maybeSingle();
  const cloud = keepValid<LibraryItem>(data?.data, isLibraryItem);
  if (cloud.length) await Library.mergeAll(cloud);
}

// ─── Anime watch progress ─────────────────────────────────────────────────────
export async function pushWatchProgress(wallet: string): Promise<void> {
  if (!wallet) return;
  await enqueue(wallet, (state) => pushStore(wallet, 'watch', state, true));
}

export async function pullWatchProgress(wallet: string): Promise<void> {
  if (!wallet) return;
  const { data } = await supabase.from('anime_history').select('data').eq('wallet_address', wallet).maybeSingle();
  const cloud = keepValid<AnimeWatchProgress>(data?.data, isWatchProgress);
  if (cloud.length) await importWatchProgress(cloud);
}

// ─── Reading progress (manga + novels) ────────────────────────────────────────
export async function pushReadingProgress(wallet: string): Promise<void> {
  if (!wallet) return;
  await enqueue(wallet, (state) => pushStore(wallet, 'reading', state, true));
}

export async function pullReadingProgress(wallet: string): Promise<void> {
  if (!wallet) return;
  const { data } = await supabase
    .from('manga_progress')
    .select('chapter_progress')
    .eq('wallet_address', wallet)
    .maybeSingle();
  const store = data?.chapter_progress as { novels?: Record<string, any>; manga?: Record<string, any> } | undefined;
  if (store && (store.novels || store.manga)) await importReadingProgress(store);
}

// ─── Orchestration ──────────────────────────────────────────────────────────
export async function pullAllFromCloud(wallet: string): Promise<void> {
  if (!wallet) return;
  activeWallet = wallet;
  // A wallet switch: the local stores are shared, so another wallet's waiting
  // push must reach ITS row before this wallet's cloud data is merged in —
  // otherwise its timer would later upload this wallet's titles to it.
  await Promise.allSettled(
    [...states.entries()]
      .filter(([other, state]) => other !== wallet && state.timer)
      .map(([other]) => flushWallet(other)),
  );
  await Promise.allSettled([pullLibrary(wallet), pullWatchProgress(wallet), pullReadingProgress(wallet)]);
  // Another device may have rewritten these rows since we last pushed, so we
  // no longer know what they hold: the next flush sends all three again.
  stateFor(wallet).pushed = {};
}

/**
 * Flush now: send every store that changed since the last accepted push and
 * skip the rest (nothing changed → no request). Called by CloudSyncBridge when
 * the app backgrounds, which is not throttled — it may be the last chance.
 */
export async function pushAllToCloud(wallet: string): Promise<void> {
  if (!wallet) return;
  activeWallet = wallet;
  await flushWallet(wallet).catch(() => {});
}

/**
 * Something changed locally: push it soon. Calls within a window coalesce
 * into one push, at most every PUSH_MIN_INTERVAL_MS per wallet (wider while
 * pushes keep failing, up to PUSH_MAX_BACKOFF_MS).
 */
export function scheduleCloudPush(wallet: string): void {
  if (!wallet) return;
  activeWallet = wallet;
  hookPageHide();
  armPush(wallet);
}

function armPush(wallet: string): void {
  const state = stateFor(wallet);
  if (state.timer) return;
  const delay = Math.max(PUSH_SETTLE_MS, state.lastPushAt + pushWindow(state) - Date.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    flushWallet(wallet).catch(() => {});
  }, delay);
}
