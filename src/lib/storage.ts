import { Preferences } from '@capacitor/preferences';
import {
    schedulePushLibrary,
    schedulePushSettings,
    schedulePushAnimeHistory,
    schedulePushMangaProgress,
    schedulePushSearches,
} from "./cloud-sync";

function getConnectedWallet(): string | null {
    if (typeof window === 'undefined') return null;
    try { return localStorage.getItem('sakura_wallet_address') || null; } catch { return null; }
}

export const STORAGE_KEYS = {
    FAVORITES: 'sakura_favorites',
    HISTORY: 'sakura_history',
    SETTINGS: 'sakura_settings',
    READING_MODE: 'sakura_reading_mode',
    CHAPTER_CACHE: 'sakura_chapter_cache',
    READ_CHAPTERS: 'sakura_read_chapters',
    CHAPTER_PROGRESS: 'sakura_chapter_progress',
    RECENT_SEARCHES: 'sakura_recent_searches',
    COMMENTS_CACHE: 'sakura_comments_cache',
    PROFILES_CACHE: 'sakura_profiles_cache',
    WALLET_ADDRESS: 'sakura_wallet_address',
    CONNECTED_WALLET_NAME: 'sakura_connected_wallet_name',
    DOWNLOADS: 'sakura_downloads',
    ANIME_DOWNLOADS: 'sakura_anime_downloads',
    ANIME_WATCH_PROGRESS: 'sakura_anime_watch_progress',
    ANIME_HISTORY: 'sakura_anime_history',
    PASS_RECEIPTS: 'sakura_pass_receipts',
    NOVEL_READER_SETTINGS: 'sakura_novel_reader_settings',
    NOVEL_BOOKMARKS: 'sakura_novel_bookmarks',
    NOVEL_DOWNLOADS_INDEX: 'sakura_novel_downloads_index',
    NOVEL_DL_PREFIX: 'sakura_novel_dl_',
    NOVEL_CUSTOM_CSS: 'sakura_novel_reader_custom_css',
    NOVEL_TTS_SETTINGS: 'sakura_novel_tts_settings',
    NOVEL_AMBIENT_SETTINGS: 'sakura_novel_ambient_settings',
    TERMS_ACCEPTED: 'sakura_terms_accepted',
};

// ── Secure Storage (Capacitor Preferences) ──

export async function setSecure(key: string, value: any): Promise<void> {
    await Preferences.set({
        key,
        value: JSON.stringify(value)
    });
}

export async function getSecure<T>(key: string, defaultValue: T): Promise<T> {
    const { value } = await Preferences.get({ key });
    if (!value) return defaultValue;
    try {
        return JSON.parse(value);
    } catch (e) {
        return defaultValue;
    }
}

export async function removeSecure(key: string): Promise<void> {
    await Preferences.remove({ key });
}

// ── Local Storage (Synchronous) ──

export function getLocal<T>(key: string, defaultValue: T): T {
    if (typeof window === 'undefined') return defaultValue;
    try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
        console.error(`Error reading ${key} from localStorage`, e);
        return defaultValue;
    }
}

export function setLocal<T>(key: string, value: T): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error(`Error writing ${key} to localStorage`, e);
    }
}

export function removeLocal(key: string): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.removeItem(key);
    } catch (e) {
        console.error(`Error removing ${key} from localStorage`, e);
    }
}

/* ── Read Chapter Tracking ── */

/** Threshold: chapter is "read" when progress >= this % */
export const READ_THRESHOLD = 85;

export function markChapterRead(mangaId: string, chapterId: string): void {
    const all = getLocal<Record<string, string[]>>(STORAGE_KEYS.READ_CHAPTERS, {});
    const list = all[mangaId] || [];
    if (!list.includes(chapterId)) {
        list.push(chapterId);
        all[mangaId] = list;
        setLocal(STORAGE_KEYS.READ_CHAPTERS, all);
    }
}

export function getReadChapters(mangaId: string): string[] {
    const all = getLocal<Record<string, string[]>>(STORAGE_KEYS.READ_CHAPTERS, {});
    return all[mangaId] || [];
}

/* ── Chapter Progress Tracking (Netflix-style) ── */

/**
 * Save reading progress for a chapter (0–100%).
 * Automatically marks the chapter as "read" if progress >= READ_THRESHOLD.
 */
export function setChapterProgress(mangaId: string, chapterId: string, percent: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));

    const all = getLocal<Record<string, Record<string, number>>>(STORAGE_KEYS.CHAPTER_PROGRESS, {});
    if (!all[mangaId]) all[mangaId] = {};
    all[mangaId][chapterId] = clamped;
    setLocal(STORAGE_KEYS.CHAPTER_PROGRESS, all);

    if (clamped >= READ_THRESHOLD) {
        markChapterRead(mangaId, chapterId);
    }
    const w = getConnectedWallet(); if (w) schedulePushMangaProgress(w);
}

/**
 * Get reading progress for a chapter (0–100%).
 */
export function getChapterProgress(mangaId: string, chapterId: string): number {
    const all = getLocal<Record<string, Record<string, number>>>(STORAGE_KEYS.CHAPTER_PROGRESS, {});
    return all[mangaId]?.[chapterId] || 0;
}

/**
 * Get all chapter progress for a manga.
 * Returns { chapterId: percent }
 */
export function getAllChapterProgress(mangaId: string): Record<string, number> {
    const all = getLocal<Record<string, Record<string, number>>>(STORAGE_KEYS.CHAPTER_PROGRESS, {});
    return all[mangaId] || {};
}

/* ── Anime Watch History ── */

export interface AnimeHistoryEntry {
    animeId: string;
    episodeId: string;
    animeTitle: string;
    episodeTitle: string;
    episodeNumber: number;
    image?: string;
    timestamp: number;
}

const MAX_ANIME_HISTORY = 20;

export function saveAnimeWatchEntry(entry: AnimeHistoryEntry): void {
    const all = getLocal<AnimeHistoryEntry[]>(STORAGE_KEYS.ANIME_HISTORY, []);
    const filtered = all.filter(e => e.animeId !== entry.animeId);
    const updated = [entry, ...filtered].slice(0, MAX_ANIME_HISTORY);
    setLocal(STORAGE_KEYS.ANIME_HISTORY, updated);
    const w = getConnectedWallet(); if (w) schedulePushAnimeHistory(w);
}

export function getAnimeHistory(): AnimeHistoryEntry[] {
    return getLocal<AnimeHistoryEntry[]>(STORAGE_KEYS.ANIME_HISTORY, []);
}

/* ── Library System ── */

export interface LibraryItem {
    id: string;
    title: string;
    image?: string;
    type: 'anime' | 'manga' | 'novel';
    source?: 'sakura' | 'external';
    addedAt: number;
}

/* ── Novel Bookmark / Highlight ── */

export interface NovelBookmark {
    id: string;
    novelId: string;
    chapterId: string;
    source: 'sakura';
    type: 'bookmark' | 'highlight';
    positionPercent?: number;
    selectedText?: string;
    note?: string;
    color?: string;
    createdAt: number;
}

/* ── Novel Download Index ── */

export interface NovelDownloadEntry {
    novelId: string;
    chapterId: string;
    chapterNumber: number;
    chapterName: string;
    novelTitle: string;
    coverUrl?: string;
    source: 'sakura';
    downloadedAt: number;
    sizeBytes?: number;
}

export function getNovelDownloadsIndex(): NovelDownloadEntry[] {
    return getLocal<NovelDownloadEntry[]>(STORAGE_KEYS.NOVEL_DOWNLOADS_INDEX, []);
}

export function addNovelDownload(entry: NovelDownloadEntry, content: string): void {
    const index = getNovelDownloadsIndex();
    const existing = index.findIndex(e => e.novelId === entry.novelId && e.chapterId === entry.chapterId);
    if (existing >= 0) index[existing] = entry;
    else index.push(entry);
    setLocal(STORAGE_KEYS.NOVEL_DOWNLOADS_INDEX, index);
    const key = `${STORAGE_KEYS.NOVEL_DL_PREFIX}${entry.source}_${entry.novelId}_${entry.chapterId}`;
    setLocal(key, content);
}

export function getNovelDownloadContent(source: string, novelId: string, chapterId: string): string | null {
    const key = `${STORAGE_KEYS.NOVEL_DL_PREFIX}${source}_${novelId}_${chapterId}`;
    return getLocal<string | null>(key, null);
}

export function removeNovelDownload(source: string, novelId: string, chapterId: string): void {
    const index = getNovelDownloadsIndex().filter(
        e => !(e.novelId === novelId && e.chapterId === chapterId)
    );
    setLocal(STORAGE_KEYS.NOVEL_DOWNLOADS_INDEX, index);
    removeLocal(`${STORAGE_KEYS.NOVEL_DL_PREFIX}${source}_${novelId}_${chapterId}`);
}

export function removeAllNovelDownloads(source: string, novelId: string): void {
    const index = getNovelDownloadsIndex();
    const toRemove = index.filter(e => e.novelId === novelId);
    toRemove.forEach(e => {
        removeLocal(`${STORAGE_KEYS.NOVEL_DL_PREFIX}${source}_${e.novelId}_${e.chapterId}`);
    });
    setLocal(STORAGE_KEYS.NOVEL_DOWNLOADS_INDEX, index.filter(e => e.novelId !== novelId));
}

/* ── Novel Bookmarks (local) ── */

export function getNovelBookmarks(): NovelBookmark[] {
    return getLocal<NovelBookmark[]>(STORAGE_KEYS.NOVEL_BOOKMARKS, []);
}

export function addNovelBookmark(bookmark: NovelBookmark): void {
    const all = getNovelBookmarks();
    all.push(bookmark);
    setLocal(STORAGE_KEYS.NOVEL_BOOKMARKS, all);
}

export function removeNovelBookmark(id: string): void {
    const all = getNovelBookmarks().filter(b => b.id !== id);
    setLocal(STORAGE_KEYS.NOVEL_BOOKMARKS, all);
}

export function getChapterBookmarks(novelId: string, chapterId: string): NovelBookmark[] {
    return getNovelBookmarks().filter(b => b.novelId === novelId && b.chapterId === chapterId);
}

export interface LibraryCategory {
    name: string;
    items: LibraryItem[];
}

const LIBRARY_KEY = 'sakura_library';
const DEFAULT_CATEGORY = 'Default';

function getLibrary(): LibraryCategory[] {
    const lib = getLocal<LibraryCategory[]>(LIBRARY_KEY, []);
    if (lib.length === 0) return [{ name: DEFAULT_CATEGORY, items: [] }];
    if (!lib.find(c => c.name === DEFAULT_CATEGORY)) {
        lib.unshift({ name: DEFAULT_CATEGORY, items: [] });
    }
    return lib;
}

function saveLibrary(lib: LibraryCategory[]): void {
    setLocal(LIBRARY_KEY, lib);
}

export function getLibraryCategories(): LibraryCategory[] {
    return getLibrary();
}

export function addToLibrary(categoryName: string, item: LibraryItem): void {
    const lib = getLibrary();
    let cat = lib.find(c => c.name === categoryName);
    if (!cat) {
        cat = { name: categoryName, items: [] };
        lib.push(cat);
    }
    if (!cat.items.find(i => i.id === item.id && i.type === item.type)) {
        cat.items.unshift(item);
    }
    saveLibrary(lib);
    const w = getConnectedWallet(); if (w) schedulePushLibrary(w);
}

export function removeFromLibrary(categoryName: string, itemId: string, itemType: 'anime' | 'manga' | 'novel'): void {
    const lib = getLibrary();
    const cat = lib.find(c => c.name === categoryName);
    if (cat) {
        cat.items = cat.items.filter(i => !(i.id === itemId && i.type === itemType));
        saveLibrary(lib);
        const w = getConnectedWallet(); if (w) schedulePushLibrary(w);
    }
}

export function createLibraryCategory(name: string): void {
    const lib = getLibrary();
    if (!lib.find(c => c.name === name)) {
        lib.push({ name, items: [] });
        saveLibrary(lib);
        const w = getConnectedWallet(); if (w) schedulePushLibrary(w);
    }
}

export function deleteLibraryCategory(name: string): void {
    if (name === DEFAULT_CATEGORY) return;
    const lib = getLibrary().filter(c => c.name !== name);
    saveLibrary(lib);
    const w = getConnectedWallet(); if (w) schedulePushLibrary(w);
}

export function getItemCategories(itemId: string, itemType: 'anime' | 'manga' | 'novel'): string[] {
    return getLibrary()
        .filter(c => c.items.some(i => i.id === itemId && i.type === itemType))
        .map(c => c.name);
}

export function isInLibrary(itemId: string, itemType: 'anime' | 'manga' | 'novel'): boolean {
    return getLibrary().some(c => c.items.some(i => i.id === itemId && i.type === itemType));
}

/* ── Cloud-synced setLocal wrappers ── */

export function setLocalAndSyncSearches(key: string, value: string[]): void {
    setLocal(key, value);
    const w = getConnectedWallet(); if (w) schedulePushSearches(w);
}

export function setLocalAndSyncSettings(key: string, value: unknown): void {
    setLocal(key, value);
    const w = getConnectedWallet(); if (w) schedulePushSettings(w);
}
