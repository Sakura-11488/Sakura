import type { MangaSourceId } from "./source-ids";

export interface Manga {
    id: string;
    title: string;
    description: string;
    cover: string;
    author: string;
    authorId?: string;
    tags: string[];
    status: string;
    year: number;
    rating?: number;
    follows?: number;
    sourceStr?: MangaSourceId;
}

export interface Chapter {
    id: string;
    mangaId: string; // Added to standard
    volume: string;
    chapter: string;
    title: string;
    publishAt: string;
    pages: number;
    sourceStr?: MangaSourceId;
    externalUrl?: string;
}

export interface MangaSource {
    name: string;
    id: MangaSourceId;
    baseUrl?: string;

    searchManga(query: string, limit?: number, offset?: number): Promise<Manga[]>;
    getMangaDetails(id: string): Promise<Manga | null>;
    getChapters(mangaId: string, limit?: number, offset?: number): Promise<Chapter[]>;
    getChapterPages(chapterId: string): Promise<string[]>;
    getTrending(limit?: number): Promise<Manga[]>;
}
