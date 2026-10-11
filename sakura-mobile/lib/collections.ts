import * as FileSystem from 'expo-file-system/legacy';
import type { LibraryItem } from './storage';

export type CollectionItem = Pick<LibraryItem, 'id' | 'type'>;
export interface LibraryCollection {
  id: string;
  name: string;
  items: CollectionItem[];
  createdAt: number;
  updatedAt: number;
}
type Snapshot = { version: 1; collections: LibraryCollection[] };
export const COLLECTIONS_STORAGE_KEY = 'sakura-collections-v1';
const FILE = `${FileSystem.documentDirectory}sakura_collections.json`;
const MAX_COLLECTIONS = 100;
const MAX_ITEMS = 2000;
const MAX_BYTES = 2_000_000;
const listeners = new Set<() => void>();
let queue: Promise<unknown> = Promise.resolve();
let listening = false;
const isWeb = FileSystem.documentDirectory?.startsWith('sakura-web:');
const clone = (value: Snapshot): Snapshot => JSON.parse(JSON.stringify(value));
const finiteDate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 2048 && !/[\u0000-\u001f]/.test(id);

export function collectionItemKey(item: CollectionItem): string {
  return JSON.stringify([item.type, item.id]);
}
function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a collection name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) throw new Error('Use a collection name between 1 and 60 characters.');
  return name;
}
function normalizeItem(value: unknown): CollectionItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as CollectionItem;
  return validId(item.id) && ['anime', 'manga', 'novel'].includes(item.type) ? { id: item.id, type: item.type } : null;
}
function decode(raw: string | null): Snapshot {
  if (!raw) return { version: 1, collections: [] };
  if (raw.length > MAX_BYTES) throw new Error('Collection data is too large to load safely.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Collection data could not be read. Your saved titles are unaffected.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Collection data could not be read.');
  const data = parsed as { version?: number; collections?: unknown };
  // Accept only the same validated shape for version-zero or unversioned snapshots.
  // No library or cloud data is migrated.
  if (data.version !== undefined && data.version !== 0 && data.version !== 1) throw new Error('These collections were saved by a newer app. Refresh Sakura before editing them.');
  if (!Array.isArray(data.collections)) throw new Error('Collection data could not be read.');
  const collections: LibraryCollection[] = [];
  const ids = new Set<string>();
  for (const value of data.collections.slice(0, MAX_COLLECTIONS)) {
    if (!value || typeof value !== 'object' || !validId(value.id) || ids.has(value.id)) continue;
    let name: string;
    try { name = normalizeName(value.name); } catch { continue; }
    const seen = new Set<string>();
    const items: CollectionItem[] = [];
    for (const member of Array.isArray(value.items) ? value.items.slice(0, MAX_ITEMS) : []) {
      const item = normalizeItem(member);
      if (item && !seen.has(collectionItemKey(item))) {
        seen.add(collectionItemKey(item));
        items.push(item);
      }
    }
    ids.add(value.id);
    collections.push({ id: value.id, name, items, createdAt: finiteDate(value.createdAt), updatedAt: finiteDate(value.updatedAt) });
  }
  return { version: 1, collections };
}
function notify() {
  listeners.forEach(listener => { try { listener(); } catch { /* One view must not interrupt saving. */ } });
}
function attachStorageListener() {
  if (listening || typeof window === 'undefined' || !isWeb) return;
  window.addEventListener('storage', event => {
    if (event.key === COLLECTIONS_STORAGE_KEY || event.key === null) notify();
  });
  listening = true;
}
export function subscribeCollections(listener: () => void): () => void {
  attachStorageListener();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function readWeb(): Snapshot {
  let raw: string | null;
  try { raw = localStorage.getItem(COLLECTIONS_STORAGE_KEY); }
  catch { throw new Error('Browser storage is unavailable. Enable local storage to save collections.'); }
  return decode(raw);
}
async function read(): Promise<Snapshot> {
  if (isWeb) return readWeb();
  const info = await FileSystem.getInfoAsync(FILE);
  return info.exists ? decode(await FileSystem.readAsStringAsync(FILE)) : { version: 1, collections: [] };
}
async function write(snapshot: Snapshot): Promise<void> {
  const raw = JSON.stringify(snapshot);
  if (raw.length > MAX_BYTES) throw new Error('Collection storage is full. Remove an unused collection and try again.');
  try {
    if (isWeb) localStorage.setItem(COLLECTIONS_STORAGE_KEY, raw);
    else await FileSystem.writeAsStringAsync(FILE, raw);
  } catch {
    throw new Error('Collections could not be saved. Your browser or device storage may be full or unavailable.');
  }
}
function serial<T>(action: () => Promise<T>): Promise<T> {
  const result = queue.then(action);
  queue = result.catch(() => undefined);
  return result;
}
function mutate<T>(change: (snapshot: Snapshot) => T): Promise<T> {
  return serial(async () => {
    const transaction = async () => {
      // Keep the browser read/change/write in one JS turn even where Web Locks
      // is unavailable; supported browsers additionally get the cross-tab lock.
      const snapshot = isWeb ? readWeb() : await read();
      const result = change(snapshot);
      await write(snapshot);
      notify();
      return result;
    };
    // Web Locks serialize read-modify-write across tabs. Fresh reads also keep
    // tabs current after another tab changes the collection store.
    if (isWeb && typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(COLLECTIONS_STORAGE_KEY, transaction);
    }
    return transaction();
  });
}
function find(snapshot: Snapshot, id: string): LibraryCollection {
  const collection = snapshot.collections.find(value => value.id === id);
  if (!collection) throw new Error('This collection no longer exists. Choose another collection.');
  return collection;
}
export async function getCollections(): Promise<LibraryCollection[]> {
  await queue;
  return clone(await read()).collections;
}
export function createCollection(name: string): Promise<LibraryCollection> {
  const normalized = normalizeName(name);
  return mutate(snapshot => {
    if (snapshot.collections.length >= MAX_COLLECTIONS) throw new Error('You can save up to 100 collections.');
    const now = Date.now();
    let id: string;
    do { id = `collection-${now.toString(36)}-${Math.random().toString(36).slice(2, 11)}`; }
    while (snapshot.collections.some(value => value.id === id));
    const collection: LibraryCollection = { id, name: normalized, items: [], createdAt: now, updatedAt: now };
    snapshot.collections.push(collection);
    return clone({ version: 1, collections: [collection] }).collections[0];
  });
}
export function renameCollection(id: string, name: string): Promise<void> {
  const normalized = normalizeName(name);
  return mutate(snapshot => { const collection = find(snapshot, id); collection.name = normalized; collection.updatedAt = Date.now(); });
}
/** Collection removal never changes the saved library or watch/reading progress. */
export function deleteCollection(id: string): Promise<void> {
  return mutate(snapshot => { snapshot.collections = snapshot.collections.filter(value => value.id !== id); });
}
export function addCollectionItem(id: string, value: CollectionItem): Promise<void> {
  const item = normalizeItem(value);
  if (!item) return Promise.reject(new Error('This title cannot be added to a collection.'));
  return mutate(snapshot => {
    const collection = find(snapshot, id);
    if (collection.items.some(member => collectionItemKey(member) === collectionItemKey(item))) return;
    if (collection.items.length >= MAX_ITEMS) throw new Error('A collection can contain up to 2,000 titles.');
    collection.items.push(item);
    collection.updatedAt = Date.now();
  });
}
export function removeCollectionItem(id: string, item: CollectionItem): Promise<void> {
  return mutate(snapshot => {
    const collection = find(snapshot, id);
    collection.items = collection.items.filter(value => collectionItemKey(value) !== collectionItemKey(item));
    collection.updatedAt = Date.now();
  });
}
/** Move one place in the stored collection order, independently of UI filters. */
export function moveCollectionItem(id: string, item: CollectionItem, direction: -1 | 1, visibleItems?: CollectionItem[]): Promise<void> {
  return mutate(snapshot => {
    const collection = find(snapshot, id);
    const index = collection.items.findIndex(value => collectionItemKey(value) === collectionItemKey(item));
    if (index < 0 || (direction !== -1 && direction !== 1)) return;
    const visible = visibleItems ? new Set(visibleItems.map(collectionItemKey)) : null;
    let next = index + direction;
    // References to titles removed from Library stay available if re-saved,
    // but do not consume an invisible reorder step in the current Library.
    while (next >= 0 && next < collection.items.length && visible && !visible.has(collectionItemKey(collection.items[next]))) next += direction;
    if (next < 0 || next >= collection.items.length) return;
    [collection.items[index], collection.items[next]] = [collection.items[next], collection.items[index]];
    collection.updatedAt = Date.now();
  });
}
