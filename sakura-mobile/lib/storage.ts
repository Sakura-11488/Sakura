import * as FileSystem from 'expo-file-system/legacy';

/**
 * Where a saved title stands for you — the shelves every tracker has (Mihon,
 * MangaDex, AniList): Reading, Plan to read, Completed, On hold, Dropped.
 * Optional on LibraryItem: unset means "work it out" (reading once there is
 * progress, otherwise plan to read; see effectiveReadingStatus).
 */
export type ReadingStatus = 'reading' | 'plan' | 'completed' | 'on-hold' | 'dropped';

export const READING_STATUSES: readonly { id: ReadingStatus; label: string }[] = [
  { id: 'reading', label: 'Reading' },
  { id: 'plan', label: 'Plan to read' },
  { id: 'completed', label: 'Completed' },
  { id: 'on-hold', label: 'On hold' },
  { id: 'dropped', label: 'Dropped' },
];

/** A status worth keeping; anything else came from a bad sync row. */
export function cleanReadingStatus(value: unknown): ReadingStatus | undefined {
  return READING_STATUSES.some((s) => s.id === value) ? (value as ReadingStatus) : undefined;
}

/** The status to show and filter by: the one chosen, else reading once started, else plan to read. */
export function effectiveReadingStatus(item: Pick<LibraryItem, 'status'>, hasProgress: boolean): ReadingStatus {
  return cleanReadingStatus(item.status) ?? (hasProgress ? 'reading' : 'plan');
}

export interface LibraryItem {
  id: string;
  title: string;
  cover: string;
  type: 'anime' | 'manga' | 'novel';
  savedAt: number;
  /**
   * Which backend a `manga` item came from: a scraped source key ('manhwa',
   * 'comics', …), or absent for atsu, the default. The manga screen serves
   * every source and picks its backend from the route's `source` param, so
   * before this was stored a saved manhwa reopened from Library as an atsu
   * title — the wrong data or "Could not load this title", and none of its
   * downloads.
   *
   * Optional because items saved by earlier builds (and synced copies of them)
   * have none, and for those atsu is the right reading. Untrusted: it
   * round-trips through cloud sync, so readers check it against the source
   * registry before routing on it.
   */
  source?: string;
  /** Chosen reading status (manga and novels). Untrusted, like `source`: check with cleanReadingStatus. */
  status?: ReadingStatus;
  /**
   * When `status` was last chosen or cleared. Status changes do not move
   * savedAt (the library would reorder), so cloud merges need their own
   * clock to know which device's choice is newer.
   */
  statusAt?: number;
}

const FILE = FileSystem.documentDirectory + 'sakura_library.json';

async function getAll(): Promise<LibraryItem[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(FILE);
    return JSON.parse(raw) as LibraryItem[];
  } catch {
    return [];
  }
}

async function writeAll(items: LibraryItem[]): Promise<void> {
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(items));
}

async function save(item: LibraryItem): Promise<void> {
  const items = await getAll();
  if (!items.some((i) => i.id === item.id && i.type === item.type)) {
    await writeAll([{ ...item, savedAt: Date.now() }, ...items]);
  }
}

async function unsave(id: string, type: LibraryItem['type']): Promise<void> {
  const items = await getAll();
  await writeAll(items.filter((i) => !(i.id === id && i.type === type)));
}

async function isSaved(id: string, type: LibraryItem['type']): Promise<boolean> {
  const items = await getAll();
  return items.some((i) => i.id === id && i.type === type);
}

async function toggle(item: LibraryItem): Promise<boolean> {
  const already = await isSaved(item.id, item.type);
  if (already) {
    await unsave(item.id, item.type);
    return false;
  }
  await save(item);
  return true;
}

/**
 * Record the source on an item saved before `source` existed, so it reopens on
 * the right backend from then on. The manga screen calls this when it loads
 * with a source; it is a no-op when the item is not saved or already says the
 * same thing. `savedAt` is left alone so the library never reorders.
 */
async function setSource(id: string, type: LibraryItem['type'], source: string): Promise<void> {
  const items = await getAll();
  const at = items.findIndex((i) => i.id === id && i.type === type);
  if (at < 0 || items[at].source === source) return;
  const next = [...items];
  next[at] = { ...items[at], source };
  await writeAll(next);
}

/**
 * Choose (or with null, clear) an item's reading status. A no-op for an item
 * that is not saved. savedAt is left alone so the library never reorders.
 */
async function setStatus(id: string, type: LibraryItem['type'], status: ReadingStatus | null): Promise<void> {
  const items = await getAll();
  const at = items.findIndex((i) => i.id === id && i.type === type);
  if (at < 0) return;
  const clean = status ? cleanReadingStatus(status) : undefined;
  if (status && !clean) return;
  const { status: _old, ...rest } = items[at];
  const next = [...items];
  next[at] = { ...rest, ...(clean ? { status: clean } : {}), statusAt: Date.now() };
  await writeAll(next);
}

/** Replace the entire library (used by cloud-sync restore). */
async function setAll(items: LibraryItem[]): Promise<void> {
  await writeAll(items);
}

/** A source worth keeping: a short string. Anything else came from a bad sync row. */
function cleanSource(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : undefined;
}

/** Union-merge cloud items into local, de-duped by id+type, newest savedAt wins. */
async function mergeAll(incoming: LibraryItem[]): Promise<LibraryItem[]> {
  const local = await getAll();
  const merged = mergeLibraryItems(incoming, local);
  await writeAll(merged);
  return merged;
}

/**
 * The merge itself, pure for the tests. Newest savedAt wins the item; the
 * source and reading status are then settled separately, because neither
 * moves savedAt: a copy synced by an older build carries no source, and
 * losing the savedAt tie-break must not also drop the other copy's source
 * (or a manhwa would go back to opening as atsu after every sync); a status
 * chosen on one device must survive a merge with the other's older copy, so
 * the newest statusAt decides it.
 */
export function mergeLibraryItems(incoming: LibraryItem[], local: LibraryItem[]): LibraryItem[] {
  const map = new Map<string, LibraryItem>();
  for (const item of [...incoming, ...local]) {
    const key = `${item.type}:${item.id}`;
    const existing = map.get(key);
    const winner = !existing || (item.savedAt || 0) > (existing.savedAt || 0) ? item : existing;
    const source = cleanSource(winner.source) ?? cleanSource(item.source) ?? cleanSource(existing?.source);
    const statusFrom = [item, existing]
      .filter((c): c is LibraryItem => !!c && typeof c.statusAt === 'number' && Number.isFinite(c.statusAt))
      .sort((a, b) => (b.statusAt || 0) - (a.statusAt || 0))[0];
    const { source: _raw, status: _status, statusAt: _statusAt, ...rest } = winner;
    const status = statusFrom ? cleanReadingStatus(statusFrom.status) : cleanReadingStatus(winner.status);
    map.set(key, {
      ...rest,
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
      ...(statusFrom ? { statusAt: statusFrom.statusAt } : {}),
    });
  }
  return Array.from(map.values()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export const Library = { getAll, save, unsave, isSaved, toggle, setSource, setStatus, setAll, mergeAll };
