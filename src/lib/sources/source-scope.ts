import { normalizeMangaSourceId, type MangaSourceId } from "./source-ids";

export function getMangaScopedKey(mangaId: string, sourceId?: string | null): string {
    return `${normalizeMangaSourceId(sourceId)}::${mangaId}`;
}

export function getChapterScopedKey(chapterId: string, sourceId?: string | null): string {
    return `${normalizeMangaSourceId(sourceId)}::${chapterId}`;
}

export function buildSourceCacheKey(sourceId: string | null | undefined, key: string): string {
    return `${normalizeMangaSourceId(sourceId)}:${key}`;
}

export function parseScopedKey(value: string): { sourceId: MangaSourceId; id: string } {
    const [rawSourceId, ...rest] = value.split("::");
    return {
        sourceId: normalizeMangaSourceId(rawSourceId),
        id: rest.join("::"),
    };
}
