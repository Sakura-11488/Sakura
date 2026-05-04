import type { Chapter } from "@/lib/sources/types";

/**
 * Chapter ordering helpers.
 *
 * Several sources return chapters in provider-specific order, and some return
 * duplicate chapter numbers from different groups/releases. Reader navigation
 * should be based on reading order, not raw API order.
 */

function parseNumber(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    const match = String(value).match(/\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

function chapterKey(chapter: Chapter): string {
    const volume = parseNumber(chapter.volume);
    const number = parseNumber(chapter.chapter);
    if (number == null) return `id:${chapter.id}`;
    return `${volume ?? "novol"}:${number}`;
}

function publishTime(chapter: Chapter): number {
    const t = Date.parse(chapter.publishAt || "");
    return Number.isFinite(t) ? t : 0;
}

export function compareChaptersByReadingOrder(a: Chapter, b: Chapter): number {
    const av = parseNumber(a.volume);
    const bv = parseNumber(b.volume);
    if (av != null || bv != null) {
        if (av == null) return -1;
        if (bv == null) return 1;
        if (av !== bv) return av - bv;
    }

    const ac = parseNumber(a.chapter);
    const bc = parseNumber(b.chapter);
    if (ac != null || bc != null) {
        if (ac == null) return -1;
        if (bc == null) return 1;
        if (ac !== bc) return ac - bc;
    }

    // Stable fallback for special/unnumbered chapters.
    return publishTime(a) - publishTime(b);
}

function pickBetterDuplicate(existing: Chapter, candidate: Chapter, currentChapterId?: string | null): Chapter {
    // If the reader is currently on one of the duplicate uploads, preserve
    // that item so currentIdx can be found and navigation never jumps through
    // a same-number duplicate first.
    if (currentChapterId) {
        if (candidate.id === currentChapterId) return candidate;
        if (existing.id === currentChapterId) return existing;
    }

    // Prefer the upload with actual pages, then more pages, then newest.
    const existingPages = existing.pages || 0;
    const candidatePages = candidate.pages || 0;
    if (candidatePages !== existingPages) return candidatePages > existingPages ? candidate : existing;
    return publishTime(candidate) > publishTime(existing) ? candidate : existing;
}

export function normalizeChaptersForReading(chapters: Chapter[], currentChapterId?: string | null): Chapter[] {
    const byKey = new Map<string, Chapter>();
    for (const chapter of chapters) {
        const key = chapterKey(chapter);
        const existing = byKey.get(key);
        byKey.set(key, existing ? pickBetterDuplicate(existing, chapter, currentChapterId) : chapter);
    }
    return Array.from(byKey.values()).sort(compareChaptersByReadingOrder);
}

export function sortChaptersForDisplay(chapters: Chapter[], order: "asc" | "desc"): Chapter[] {
    const readingOrder = normalizeChaptersForReading(chapters);
    return order === "asc" ? readingOrder : [...readingOrder].reverse();
}

export function getChapterNeighbors(chapters: Chapter[], currentChapterId: string): {
    current: Chapter | null;
    next: Chapter | null;
    prev: Chapter | null;
    ordered: Chapter[];
} {
    const ordered = normalizeChaptersForReading(chapters, currentChapterId);
    const idx = ordered.findIndex((chapter) => chapter.id === currentChapterId);
    if (idx < 0) return { current: null, next: null, prev: null, ordered };
    return {
        current: ordered[idx],
        next: idx < ordered.length - 1 ? ordered[idx + 1] : null,
        prev: idx > 0 ? ordered[idx - 1] : null,
        ordered,
    };
}
