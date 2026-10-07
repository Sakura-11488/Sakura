export class ArchiveError extends Error {
    constructor(code, message) { super(message); this.name = 'ArchiveError'; this.code = code; }
}

// Curated original-era comics, not an unrestricted search of user uploads.
// Source item pages document the editions; no login, lending, or challenge
// endpoint is used. Each entry keeps its own Archive attribution in the app.
export const ARCHIVE_CATALOG = [
    { identifier: 'LittleNemo1905-1914ByWinsorMccay', title: 'Little Nemo in Slumberland', author: 'Winsor McCay', year: 1905,
        description: 'The original 1905–1914 newspaper strips. Public-domain scans from the Comic Strip Library, hosted by Internet Archive.' },
    { identifier: 'BusterBrownhisd00Outc', title: 'Buster Brown, His Dog Tige and Their Troubles', author: 'R. F. Outcault', year: 1904,
        description: 'The 1904 collection of Buster Brown comic strips, digitized from the original edition and hosted by Internet Archive.' },
    { identifier: 'myresolutionsbus00outc', title: 'My Resolutions, Buster Brown', author: 'R. F. Outcault', year: 1910,
        description: 'The 1910 Buster Brown comic-strip collection, digitized from the original edition and hosted by Internet Archive.' },
];
const PAGE_BATCH = 24;
export const isArchiveId = (id) => /^ia-[a-zA-Z0-9_-]+$/.test(String(id || ''));

export function parseArchiveManifest(manifest) {
    // Internet Archive publishes IIIF Presentation 3. Only accept original
    // image bodies from its image service, never arbitrary URLs in metadata.
    const pages = [];
    for (const canvas of manifest?.items || []) {
        const body = canvas?.items?.[0]?.items?.find((item) => item.motivation === 'painting')?.body;
        if (body?.type !== 'Image' || body.format !== 'image/jpeg') continue;
        let url;
        try { url = new URL(body.id); } catch { continue; }
        if (url.protocol !== 'https:' || url.hostname !== 'iiif.archive.org' || !url.pathname.startsWith('/image/iiif/')) continue;
        // 1200px is readable on a phone and avoids downloading multi-megabyte
        // archival masters. Preserve smaller originals without upscaling.
        if (Number(canvas.width) > 1200) url.pathname = url.pathname.replace('/full/max/', '/full/1200,/');
        pages.push(url.href);
    }
    return [...new Set(pages)];
}

export function createInternetArchive({ fetchJson, cacheTtlMs = 24 * 60 * 60 * 1000 }) {
    const catalog = ARCHIVE_CATALOG.map((entry) => ({
        ...entry, id: `ia-${entry.identifier}`, cover: `https://archive.org/services/img/${entry.identifier}`,
        url: `https://archive.org/details/${entry.identifier}`, authors: [entry.author],
        tags: ['Classic comic strips', 'Internet Archive'], status: 'Completed',
    }));
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));
    const manifests = new Map();
    const inFlight = new Map();
    const stats = { requests: 0, consecutiveFailures: 0 };

    async function loadPages(id) {
        const entry = byId.get(id);
        if (!entry) return [];
        const hit = manifests.get(id);
        if (hit && Date.now() - hit.at < cacheTtlMs) return hit.pages;
        if (inFlight.has(id)) return inFlight.get(id);
        const run = (async () => {
            stats.requests += 1;
            try {
                const manifest = await fetchJson(`https://iiif.archive.org/iiif/${entry.identifier}/manifest.json`);
                const pages = parseArchiveManifest(manifest);
                if (!pages.length) throw new ArchiveError('INVALID', 'Internet Archive returned no readable comic pages');
                manifests.set(id, { pages, at: Date.now() });
                stats.consecutiveFailures = 0;
                return pages;
            } catch (error) {
                stats.consecutiveFailures += 1;
                if (hit) return hit.pages;
                throw error;
            } finally { inFlight.delete(id); }
        })();
        inFlight.set(id, run);
        return run;
    }

    return {
        id: 'archive', label: 'Internet Archive', base: 'https://archive.org',
        popular: async (limit) => catalog.slice(0, limit),
        search: async (query, limit, offset) => {
            const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
            return catalog.filter((entry) => words.every((word) => `${entry.title} ${entry.author}`.toLowerCase().includes(word))).slice(offset, offset + limit);
        },
        details: async (id) => byId.get(id) || null,
        chapters: async (id) => {
            const pages = await loadPages(id);
            return Array.from({ length: Math.ceil(pages.length / PAGE_BATCH) }, (_, index) => ({
                id: `${id}-part-${index + 1}`, number: index + 1,
                title: `Pages ${index * PAGE_BATCH + 1}–${Math.min((index + 1) * PAGE_BATCH, pages.length)}`,
                pages: Math.min(PAGE_BATCH, pages.length - index * PAGE_BATCH), publishAt: null,
            })).reverse();
        },
        pages: async (id, chapterId) => {
            if (!byId.has(id) || !chapterId.startsWith(`${id}-part-`)) return [];
            const part = chapterId.slice(`${id}-part-`.length);
            if (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part))) return [];
            const pages = await loadPages(id);
            return pages.slice((Number(part) - 1) * PAGE_BATCH, Number(part) * PAGE_BATCH);
        },
        stats: () => ({ ...stats, catalogSize: catalog.length }),
    };
}

// Use the public API directly. No proxy/challenge-solving tier is involved.
export async function fetchArchiveJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'SakuraComics/1.0 (public-domain reader)' } });
        if (!response.ok) {
            await response.body?.cancel();
            throw new ArchiveError(response.status === 403 || response.status === 429 ? 'BLOCKED' : 'HTTP', `Internet Archive HTTP ${response.status}`);
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 3 * 1024 * 1024) throw new ArchiveError('INVALID', 'Internet Archive manifest exceeded size limit');
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        if (error instanceof ArchiveError) throw error;
        throw new ArchiveError(controller.signal.aborted ? 'TIMEOUT' : 'HTTP', 'Could not load Internet Archive comic pages');
    } finally { clearTimeout(timeout); }
}
