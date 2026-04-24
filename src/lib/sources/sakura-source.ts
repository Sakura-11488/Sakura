import { Manga, Chapter, MangaSource } from './types';
import * as api from '../content-source';
import { MANGA_SOURCE_IDS } from './source-ids';

export class MangadexSource implements MangaSource {
    name = "Sakura";
    id = MANGA_SOURCE_IDS.MANGADEX;

    async searchManga(query: string): Promise<Manga[]> {
        const results = await api.searchManga(query, 20, 0);
        return results.map(m => ({
            ...m,
            sourceStr: this.id
        }));
    }

    async getMangaDetails(id: string): Promise<Manga | null> {
        const manga = await api.getMangaDetails(id);
        if (!manga) return null;
        return {
            ...manga,
            sourceStr: this.id
        };
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const chapters = await api.getChapters(mangaId, 100, 0);
        return chapters.map(c => ({
            ...c,
            mangaId: mangaId,
            sourceStr: this.id
        }));
    }

    async getChapterPages(chapterId: string): Promise<string[]> {
        return await api.getChapterPages(chapterId);
    }

    async getTrending(limit = 20): Promise<Manga[]> {
        const results = await api.getFeaturedManga();
        return results.map(m => ({
            ...m,
            sourceStr: this.id
        }));
    }
}
