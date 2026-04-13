/**
 * Cloud Sync — backs up all local data to Supabase so users
 * keep their library, settings, history, and progress across devices.
 *
 * Strategy:
 *   - On wallet connect / app open → pull from cloud, merge with local
 *   - On local writes → push to cloud in background (debounced)
 *   - Merge rule: union for collections (library, history), cloud-wins for scalar settings
 */
import { supabase } from "./supabase";
import { getLocal, setLocal, STORAGE_KEYS, type LibraryCategory, type AnimeHistoryEntry, type NovelBookmark, type NovelDownloadEntry } from "./storage";

/* ═══════ Debounce Helper ═══════ */

const pushTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function debouncedPush(key: string, fn: () => Promise<void>, delay = 2000) {
    if (pushTimers[key]) clearTimeout(pushTimers[key]);
    pushTimers[key] = setTimeout(() => { fn().catch(console.error); }, delay);
}

/* ═══════ Library Sync ═══════ */

export async function pushLibrary(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const lib = getLocal<LibraryCategory[]>("sakura_library", []);
    await supabase.from("user_library").upsert({
        wallet_address: wallet,
        data: lib,
        updated_at: new Date().toISOString(),
    }, { onConflict: "wallet_address" });
}

export async function pullLibrary(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const { data } = await supabase
        .from("user_library")
        .select("data, updated_at")
        .eq("wallet_address", wallet)
        .maybeSingle();

    if (!data?.data) return;
    const cloudLib = data.data as LibraryCategory[];
    const localLib = getLocal<LibraryCategory[]>("sakura_library", []);
    const merged = mergeLibraries(localLib, cloudLib);
    setLocal("sakura_library", merged);
}

function mergeLibraries(local: LibraryCategory[], cloud: LibraryCategory[]): LibraryCategory[] {
    const catMap = new Map<string, LibraryCategory>();

    for (const cat of cloud) {
        catMap.set(cat.name, { name: cat.name, items: [...cat.items] });
    }
    for (const cat of local) {
        const existing = catMap.get(cat.name);
        if (!existing) {
            catMap.set(cat.name, { name: cat.name, items: [...cat.items] });
        } else {
            for (const item of cat.items) {
                if (!existing.items.find(i => i.id === item.id && i.type === item.type)) {
                    existing.items.push(item);
                }
            }
        }
    }
    return Array.from(catMap.values());
}

export function schedulePushLibrary(wallet: string) {
    debouncedPush("library", () => pushLibrary(wallet));
}

/* ═══════ Settings Sync ═══════ */

export async function pushSettings(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const settings = getLocal<Record<string, unknown>>(STORAGE_KEYS.SETTINGS, {});
    const readingMode = getLocal<string>(STORAGE_KEYS.READING_MODE, "scroll");
    const novelReaderSettings = getLocal<Record<string, unknown>>(STORAGE_KEYS.NOVEL_READER_SETTINGS, {});
    const novelTtsSettings = getLocal<Record<string, unknown>>(STORAGE_KEYS.NOVEL_TTS_SETTINGS, {});
    const novelCustomCSS = getLocal<string>(STORAGE_KEYS.NOVEL_CUSTOM_CSS, "");
    await supabase.from("user_settings").upsert({
        wallet_address: wallet,
        data: { ...settings, readingMode, novelReaderSettings, novelTtsSettings, novelCustomCSS },
        updated_at: new Date().toISOString(),
    }, { onConflict: "wallet_address" });
}

export async function pullSettings(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const { data } = await supabase
        .from("user_settings")
        .select("data")
        .eq("wallet_address", wallet)
        .maybeSingle();

    if (!data?.data) return;
    const cloud = data.data as Record<string, unknown>;
    const local = getLocal<Record<string, unknown>>(STORAGE_KEYS.SETTINGS, {});

    const merged = { ...cloud, ...local };
    setLocal(STORAGE_KEYS.SETTINGS, merged);
    if (cloud.readingMode) {
        setLocal(STORAGE_KEYS.READING_MODE, cloud.readingMode as string);
    }
    if (cloud.novelReaderSettings) {
        const localNovel = getLocal<Record<string, unknown>>(STORAGE_KEYS.NOVEL_READER_SETTINGS, {});
        setLocal(STORAGE_KEYS.NOVEL_READER_SETTINGS, { ...cloud.novelReaderSettings as Record<string, unknown>, ...localNovel });
    }
    if (cloud.novelTtsSettings) {
        const localTts = getLocal<Record<string, unknown>>(STORAGE_KEYS.NOVEL_TTS_SETTINGS, {});
        setLocal(STORAGE_KEYS.NOVEL_TTS_SETTINGS, { ...cloud.novelTtsSettings as Record<string, unknown>, ...localTts });
    }
    if (cloud.novelCustomCSS && !getLocal<string>(STORAGE_KEYS.NOVEL_CUSTOM_CSS, "")) {
        setLocal(STORAGE_KEYS.NOVEL_CUSTOM_CSS, cloud.novelCustomCSS as string);
    }
}

export function schedulePushSettings(wallet: string) {
    debouncedPush("settings", () => pushSettings(wallet));
}

/* ═══════ Anime History Sync ═══════ */

export async function pushAnimeHistory(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const history = getLocal<AnimeHistoryEntry[]>(STORAGE_KEYS.ANIME_HISTORY, []);
    await supabase.from("anime_history").upsert({
        wallet_address: wallet,
        data: history,
        updated_at: new Date().toISOString(),
    }, { onConflict: "wallet_address" });
}

export async function pullAnimeHistory(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const { data } = await supabase
        .from("anime_history")
        .select("data")
        .eq("wallet_address", wallet)
        .maybeSingle();

    if (!data?.data) return;
    const cloud = data.data as AnimeHistoryEntry[];
    const local = getLocal<AnimeHistoryEntry[]>(STORAGE_KEYS.ANIME_HISTORY, []);
    const merged = mergeAnimeHistory(local, cloud);
    setLocal(STORAGE_KEYS.ANIME_HISTORY, merged);
}

function mergeAnimeHistory(local: AnimeHistoryEntry[], cloud: AnimeHistoryEntry[]): AnimeHistoryEntry[] {
    const map = new Map<string, AnimeHistoryEntry>();
    for (const e of cloud) map.set(e.animeId, e);
    for (const e of local) {
        const existing = map.get(e.animeId);
        if (!existing || e.timestamp > existing.timestamp) {
            map.set(e.animeId, e);
        }
    }
    return Array.from(map.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);
}

export function schedulePushAnimeHistory(wallet: string) {
    debouncedPush("animeHistory", () => pushAnimeHistory(wallet));
}

/* ═══════ Manga Progress Sync ═══════ */

export async function pushMangaProgress(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const progress = getLocal<Record<string, Record<string, number>>>(STORAGE_KEYS.CHAPTER_PROGRESS, {});
    const readChapters = getLocal<Record<string, string[]>>(STORAGE_KEYS.READ_CHAPTERS, {});
    await supabase.from("manga_progress").upsert({
        wallet_address: wallet,
        chapter_progress: progress,
        read_chapters: readChapters,
        updated_at: new Date().toISOString(),
    }, { onConflict: "wallet_address" });
}

export async function pullMangaProgress(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const { data } = await supabase
        .from("manga_progress")
        .select("chapter_progress, read_chapters")
        .eq("wallet_address", wallet)
        .maybeSingle();

    if (!data) return;

    if (data.chapter_progress) {
        const cloud = data.chapter_progress as Record<string, Record<string, number>>;
        const local = getLocal<Record<string, Record<string, number>>>(STORAGE_KEYS.CHAPTER_PROGRESS, {});
        const merged = mergeMangaProgress(local, cloud);
        setLocal(STORAGE_KEYS.CHAPTER_PROGRESS, merged);
    }

    if (data.read_chapters) {
        const cloud = data.read_chapters as Record<string, string[]>;
        const local = getLocal<Record<string, string[]>>(STORAGE_KEYS.READ_CHAPTERS, {});
        const merged = mergeReadChapters(local, cloud);
        setLocal(STORAGE_KEYS.READ_CHAPTERS, merged);
    }
}

function mergeMangaProgress(
    local: Record<string, Record<string, number>>,
    cloud: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
    const merged = { ...cloud };
    for (const [mangaId, chapters] of Object.entries(local)) {
        if (!merged[mangaId]) merged[mangaId] = {};
        for (const [chId, pct] of Object.entries(chapters)) {
            merged[mangaId][chId] = Math.max(merged[mangaId][chId] || 0, pct);
        }
    }
    return merged;
}

function mergeReadChapters(
    local: Record<string, string[]>,
    cloud: Record<string, string[]>
): Record<string, string[]> {
    const merged = { ...cloud };
    for (const [mangaId, chapters] of Object.entries(local)) {
        const existing = new Set(merged[mangaId] || []);
        for (const ch of chapters) existing.add(ch);
        merged[mangaId] = Array.from(existing);
    }
    return merged;
}

export function schedulePushMangaProgress(wallet: string) {
    debouncedPush("mangaProgress", () => pushMangaProgress(wallet));
}

/* ═══════ Recent Searches Sync ═══════ */

export async function pushSearches(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const searches: Record<string, string[]> = {};
    for (const suffix of ["", "_ANIME", "_NOVEL"]) {
        const key = STORAGE_KEYS.RECENT_SEARCHES + suffix;
        searches[key] = getLocal<string[]>(key, []);
    }
    await supabase.from("user_searches").upsert({
        wallet_address: wallet,
        data: searches,
        updated_at: new Date().toISOString(),
    }, { onConflict: "wallet_address" });
}

export async function pullSearches(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const { data } = await supabase
        .from("user_searches")
        .select("data")
        .eq("wallet_address", wallet)
        .maybeSingle();
    if (!data?.data) return;
    const cloud = data.data as Record<string, string[]>;
    for (const [key, values] of Object.entries(cloud)) {
        const local = getLocal<string[]>(key, []);
        const merged = [...new Set([...local, ...values])].slice(0, 20);
        setLocal(key, merged);
    }
}

export function schedulePushSearches(wallet: string) {
    debouncedPush("searches", () => pushSearches(wallet));
}

/* ═══════ Novel Bookmarks Sync ═══════ */

export async function pushNovelBookmarks(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const bookmarks = getLocal<NovelBookmark[]>(STORAGE_KEYS.NOVEL_BOOKMARKS, []);
    for (const bm of bookmarks) {
        await supabase.from("novel_bookmarks").upsert({
            id: bm.id,
            user_wallet: wallet,
            novel_id: bm.novelId,
            chapter_id: bm.chapterId,
            source: bm.source,
            type: bm.type,
            position_percent: bm.positionPercent,
            selected_text: bm.selectedText,
            note: bm.note,
            color: bm.color,
            created_at: new Date(bm.createdAt).toISOString(),
        }, { onConflict: "id" });
    }
}

export async function pullNovelBookmarks(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const { data } = await supabase
        .from("novel_bookmarks")
        .select("*")
        .eq("user_wallet", wallet);
    if (!data) return;
    const cloud: NovelBookmark[] = data.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        novelId: row.novel_id as string,
        chapterId: row.chapter_id as string,
        source: 'sakura' as const,
        type: (row.type as 'bookmark' | 'highlight') || 'bookmark',
        positionPercent: row.position_percent as number | undefined,
        selectedText: row.selected_text as string | undefined,
        note: row.note as string | undefined,
        color: (row.color as string) || 'yellow',
        createdAt: new Date(row.created_at as string).getTime(),
    }));
    const local = getLocal<NovelBookmark[]>(STORAGE_KEYS.NOVEL_BOOKMARKS, []);
    const map = new Map<string, NovelBookmark>();
    for (const bm of cloud) map.set(bm.id, bm);
    for (const bm of local) {
        if (!map.has(bm.id)) map.set(bm.id, bm);
    }
    setLocal(STORAGE_KEYS.NOVEL_BOOKMARKS, Array.from(map.values()));
}

export function schedulePushNovelBookmarks(wallet: string) {
    debouncedPush("novelBookmarks", () => pushNovelBookmarks(wallet));
}

/* ═══════ Novel Download Index Sync ═══════ */

export async function pushNovelDownloadIndex(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const index = getLocal<NovelDownloadEntry[]>(STORAGE_KEYS.NOVEL_DOWNLOADS_INDEX, []);
    await supabase.from("novel_downloads_index").upsert({
        wallet_address: wallet,
        data: index,
        updated_at: new Date().toISOString(),
    }, { onConflict: "wallet_address" });
}

export async function pullNovelDownloadIndex(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    const { data } = await supabase
        .from("novel_downloads_index")
        .select("data")
        .eq("wallet_address", wallet)
        .maybeSingle();
    if (!data?.data) return;
    const cloud = data.data as NovelDownloadEntry[];
    const local = getLocal<NovelDownloadEntry[]>(STORAGE_KEYS.NOVEL_DOWNLOADS_INDEX, []);
    const map = new Map<string, NovelDownloadEntry>();
    for (const e of cloud) map.set(`${e.novelId}_${e.chapterId}`, e);
    for (const e of local) map.set(`${e.novelId}_${e.chapterId}`, e);
    setLocal(STORAGE_KEYS.NOVEL_DOWNLOADS_INDEX, Array.from(map.values()));
}

/* ═══════ Full Sync (pull all on login) ═══════ */

export async function pullAllFromCloud(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    await Promise.all([
        pullLibrary(wallet),
        pullSettings(wallet),
        pullAnimeHistory(wallet),
        pullMangaProgress(wallet),
        pullSearches(wallet),
        pullNovelBookmarks(wallet),
        pullNovelDownloadIndex(wallet),
    ]);
}

export async function pushAllToCloud(wallet: string): Promise<void> {
    if (!supabase || !wallet) return;
    await Promise.all([
        pushLibrary(wallet),
        pushSettings(wallet),
        pushAnimeHistory(wallet),
        pushMangaProgress(wallet),
        pushSearches(wallet),
        pushNovelBookmarks(wallet),
        pushNovelDownloadIndex(wallet),
    ]);
}
