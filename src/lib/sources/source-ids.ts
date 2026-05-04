export const MANGA_SOURCE_IDS = {
    MANGADEX: "mangadex",
    COMIX: "comix",
    MANGABALL: "mangaball",
    ATSUMARU: "atsumaru",
    MANGAFIRE: "mangafire",
    XOXOCOMIC: "xoxocomic",
} as const;

export type MangaSourceId = (typeof MANGA_SOURCE_IDS)[keyof typeof MANGA_SOURCE_IDS];

export type ContentKind = "manga" | "comic";

const COMIC_SOURCE_IDS = new Set<MangaSourceId>([
    MANGA_SOURCE_IDS.XOXOCOMIC,
]);

export function isComicSourceId(sourceId?: string | null): boolean {
    if (!sourceId) return false;
    return COMIC_SOURCE_IDS.has(normalizeMangaSourceId(sourceId));
}

export function getContentKindForSource(sourceId?: string | null): ContentKind {
    return isComicSourceId(sourceId) ? "comic" : "manga";
}

export const DEFAULT_MANGA_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.MANGADEX;
export const PRIMARY_MANGA_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.ATSUMARU;
export const HOME_MANGA_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.ATSUMARU;
export const DEFAULT_COMIC_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.XOXOCOMIC;
export const PRIMARY_COMIC_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.XOXOCOMIC;

const SOURCE_ALIASES: Record<string, MangaSourceId> = {
    sakura: MANGA_SOURCE_IDS.MANGADEX,
    weebcentral: MANGA_SOURCE_IDS.MANGADEX,
    "atsu-moe": MANGA_SOURCE_IDS.ATSUMARU,
    "atsu.moe": MANGA_SOURCE_IDS.ATSUMARU,
    "comic-extra": MANGA_SOURCE_IDS.XOXOCOMIC,
    "comicextra": MANGA_SOURCE_IDS.XOXOCOMIC,
    "comics": MANGA_SOURCE_IDS.XOXOCOMIC,
    "xoxo": MANGA_SOURCE_IDS.XOXOCOMIC,
    "xoxocomics": MANGA_SOURCE_IDS.XOXOCOMIC,
};

export function normalizeMangaSourceId(value?: string | null): MangaSourceId {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return DEFAULT_MANGA_SOURCE_ID;

    const aliased = SOURCE_ALIASES[normalized];
    if (aliased) return aliased;

    const allIds = Object.values(MANGA_SOURCE_IDS) as string[];
    if (allIds.includes(normalized)) {
        return normalized as MangaSourceId;
    }

    return DEFAULT_MANGA_SOURCE_ID;
}

export function getDefaultMangaSourceId(): MangaSourceId {
    return DEFAULT_MANGA_SOURCE_ID;
}

export function getPrimaryMangaSourceId(): MangaSourceId {
    return PRIMARY_MANGA_SOURCE_ID;
}

export function getHomeMangaSourceId(): MangaSourceId {
    return HOME_MANGA_SOURCE_ID;
}

export function getDefaultComicSourceId(): MangaSourceId {
    return DEFAULT_COMIC_SOURCE_ID;
}

export function getPrimaryComicSourceId(): MangaSourceId {
    return PRIMARY_COMIC_SOURCE_ID;
}

export function listComicSourceIds(): MangaSourceId[] {
    return Array.from(COMIC_SOURCE_IDS);
}
