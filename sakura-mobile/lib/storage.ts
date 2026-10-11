import * as FileSystem from 'expo-file-system/legacy';

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
  const map = new Map<string, LibraryItem>();
  for (const item of [...incoming, ...local]) {
    const key = `${item.type}:${item.id}`;
    const existing = map.get(key);
    const winner = !existing || (item.savedAt || 0) > (existing.savedAt || 0) ? item : existing;
    // A copy synced by an older build carries no source. Losing the savedAt
    // tie-break must not also drop the other copy's source, or a manhwa would
    // go back to opening as atsu after every sync.
    const source = cleanSource(winner.source) ?? cleanSource(item.source) ?? cleanSource(existing?.source);
    const { source: _raw, ...rest } = winner;
    map.set(key, source ? { ...rest, source } : rest);
  }
  const merged = Array.from(map.values()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  await writeAll(merged);
  return merged;
}

export const Library = { getAll, save, unsave, isSaved, toggle, setSource, setAll, mergeAll };
