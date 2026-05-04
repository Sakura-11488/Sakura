import { MANGA_SOURCE_IDS, normalizeMangaSourceId, type ContentKind, type MangaSourceId } from "./source-ids";

export interface MangaSourceMeta {
    id: MangaSourceId;
    name: string;
    integrationStatus: "active" | "candidate" | "blocked";
    supportsStats: boolean;
    supportsGenreBrowse: boolean;
    supportsCreatorAuthorLookup: boolean;
    contentKind: ContentKind;
    notes: string;
}

export const MANGA_SOURCE_META: Record<MangaSourceId, MangaSourceMeta> = {
    [MANGA_SOURCE_IDS.MANGADEX]: {
        id: MANGA_SOURCE_IDS.MANGADEX,
        name: "MangaDex",
        integrationStatus: "active",
        supportsStats: true,
        supportsGenreBrowse: true,
        supportsCreatorAuthorLookup: true,
        contentKind: "manga",
        notes: "Current production source with creator and stats wiring already in place.",
    },
    [MANGA_SOURCE_IDS.COMIX]: {
        id: MANGA_SOURCE_IDS.COMIX,
        name: "Comix",
        integrationStatus: "candidate",
        supportsStats: false,
        supportsGenreBrowse: false,
        supportsCreatorAuthorLookup: false,
        contentKind: "manga",
        notes: "Clean JSON API surface and promising fit, but chapter/page parity still needs more work before it can replace MangaDex.",
    },
    [MANGA_SOURCE_IDS.MANGABALL]: {
        id: MANGA_SOURCE_IDS.MANGABALL,
        name: "MangaBall",
        integrationStatus: "candidate",
        supportsStats: false,
        supportsGenreBrowse: false,
        supportsCreatorAuthorLookup: false,
        contentKind: "manga",
        notes: "Broad catalog and good candidate coverage, but it requires CSRF/session handling and has a more brittle integration surface.",
    },
    [MANGA_SOURCE_IDS.ATSUMARU]: {
        id: MANGA_SOURCE_IDS.ATSUMARU,
        name: "Atsumaru",
        integrationStatus: "active",
        supportsStats: false,
        supportsGenreBrowse: false,
        supportsCreatorAuthorLookup: false,
        contentKind: "manga",
        notes: "Live runtime source for homepage/search coverage and the first fallback when MangaDex has weak or missing chapters.",
    },
    [MANGA_SOURCE_IDS.MANGAFIRE]: {
        id: MANGA_SOURCE_IDS.MANGAFIRE,
        name: "MangaFire",
        integrationStatus: "blocked",
        supportsStats: false,
        supportsGenreBrowse: false,
        supportsCreatorAuthorLookup: false,
        contentKind: "manga",
        notes: "Coverage is attractive, but search and page access depend on VRF/WebView flows that are currently a poor fit for Sakura.",
    },
    [MANGA_SOURCE_IDS.XOXOCOMIC]: {
        id: MANGA_SOURCE_IDS.XOXOCOMIC,
        name: "Sakura Comics",
        integrationStatus: "active",
        supportsStats: false,
        supportsGenreBrowse: true,
        supportsCreatorAuthorLookup: false,
        contentKind: "comic",
        notes: "Western comics served through the Sakura droplet scraper proxy. Primary upstream is XOXO Comics with ReadComicOnline planned as a fallback.",
    },
};

export function getMangaSourceMeta(sourceId?: string | null): MangaSourceMeta {
    return MANGA_SOURCE_META[normalizeMangaSourceId(sourceId)];
}

export function sourceSupportsStats(sourceId?: string | null): boolean {
    return getMangaSourceMeta(sourceId).supportsStats;
}

export function sourceSupportsGenreBrowse(sourceId?: string | null): boolean {
    return getMangaSourceMeta(sourceId).supportsGenreBrowse;
}

export function sourceSupportsCreatorLookup(sourceId?: string | null): boolean {
    return getMangaSourceMeta(sourceId).supportsCreatorAuthorLookup;
}

export function getExternalAuthorUrl(sourceId: string | null | undefined, authorId: string): string | null {
    if (normalizeMangaSourceId(sourceId) === MANGA_SOURCE_IDS.MANGADEX) {
        return `https://mangadex.org/author/${authorId}`;
    }

    return null;
}
