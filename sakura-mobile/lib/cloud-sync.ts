/**
 * Cloud Sync — backs up the Expo app's library and reading/watching progress to
 * Supabase so a wallet keeps its data across devices. Reuses the existing
 * wallet-keyed tables from the web app (`user_library`, `anime_history`,
 * `manga_progress`). All writes are keyed by the connected wallet address.
 *
 * Merge rule: union for collections, newest-updatedAt wins per item.
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

const pushTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function debouncedPush(key: string, fn: () => Promise<void>, delay = 2500) {
  if (pushTimers[key]) clearTimeout(pushTimers[key]);
  pushTimers[key] = setTimeout(() => {
    fn().catch(() => {});
  }, delay);
}

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

// ─── Library ──────────────────────────────────────────────────────────────────
export async function pushLibrary(wallet: string): Promise<void> {
  if (!wallet) return;
  const data = await Library.getAll();
  await supabase
    .from('user_library')
    .upsert({ wallet_address: wallet, data, updated_at: new Date().toISOString() }, { onConflict: 'wallet_address' });
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
  const data = await getAllWatchHistory();
  await supabase
    .from('anime_history')
    .upsert({ wallet_address: wallet, data, updated_at: new Date().toISOString() }, { onConflict: 'wallet_address' });
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
  const store = await exportReadingProgress();
  await supabase
    .from('manga_progress')
    .upsert(
      { wallet_address: wallet, chapter_progress: store, read_chapters: {}, updated_at: new Date().toISOString() },
      { onConflict: 'wallet_address' },
    );
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
  await Promise.allSettled([pullLibrary(wallet), pullWatchProgress(wallet), pullReadingProgress(wallet)]);
}

export async function pushAllToCloud(wallet: string): Promise<void> {
  if (!wallet) return;
  await Promise.allSettled([pushLibrary(wallet), pushWatchProgress(wallet), pushReadingProgress(wallet)]);
}

export function scheduleCloudPush(wallet: string): void {
  if (!wallet) return;
  debouncedPush('all', () => pushAllToCloud(wallet));
}
