import * as FileSystem from 'expo-file-system/legacy';

export interface LibraryItem {
  id: string;
  title: string;
  cover: string;
  type: 'anime' | 'manga' | 'novel';
  savedAt: number;
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

/** Replace the entire library (used by cloud-sync restore). */
async function setAll(items: LibraryItem[]): Promise<void> {
  await writeAll(items);
}

/** Union-merge cloud items into local, de-duped by id+type, newest savedAt wins. */
async function mergeAll(incoming: LibraryItem[]): Promise<LibraryItem[]> {
  const local = await getAll();
  const map = new Map<string, LibraryItem>();
  for (const item of [...incoming, ...local]) {
    const key = `${item.type}:${item.id}`;
    const existing = map.get(key);
    if (!existing || (item.savedAt || 0) > (existing.savedAt || 0)) map.set(key, item);
  }
  const merged = Array.from(map.values()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  await writeAll(merged);
  return merged;
}

export const Library = { getAll, save, unsave, isSaved, toggle, setAll, mergeAll };
