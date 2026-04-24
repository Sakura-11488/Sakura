export const MANGA_SOURCE_IDS = {
    MANGADEX: "mangadex",
    COMIX: "comix",
    MANGABALL: "mangaball",
    ATSUMARU: "atsumaru",
    MANGAFIRE: "mangafire",
} as const;

export type MangaSourceId = (typeof MANGA_SOURCE_IDS)[keyof typeof MANGA_SOURCE_IDS];

export const DEFAULT_MANGA_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.MANGADEX;
export const PRIMARY_MANGA_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.ATSUMARU;
export const HOME_MANGA_SOURCE_ID: MangaSourceId = MANGA_SOURCE_IDS.ATSUMARU;

const SOURCE_ALIASES: Record<string, MangaSourceId> = {
    sakura: MANGA_SOURCE_IDS.MANGADEX,
    weebcentral: MANGA_SOURCE_IDS.MANGADEX,
    "atsu-moe": MANGA_SOURCE_IDS.ATSUMARU,
    "atsu.moe": MANGA_SOURCE_IDS.ATSUMARU,
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
