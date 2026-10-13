export class ArchiveError extends Error {
    constructor(code, message) { super(message); this.name = 'ArchiveError'; this.code = code; }
}

// Curated original-era comics, not an unrestricted search of user uploads.
// Source item pages document the editions; no login, lending, or challenge
// endpoint is used. Each entry keeps its own Archive attribution in the app.
//
// The bar for an entry (verified per item, 2026-10-13): a comic or
// picture-story book, not prose or an article about one; an original edition
// first published in 1930 or earlier (US public domain) whose creators died
// before 1956 (also public domain under life+70); freely viewable, with no
// lending or access restriction; not a Google Books scan; and an IIIF
// manifest that parses to 10+ JPEG pages. The large comics_inbox uploads are
// deliberately not searched: they mix in company-owned characters. Order is
// the order of the Comics shelves.
export const ARCHIVE_CATALOG = [
    { identifier: 'LittleNemo1905-1914ByWinsorMccay', title: 'Little Nemo in Slumberland', author: 'Winsor McCay', year: 1905,
        description: 'The original 1905–1914 newspaper strips. Public-domain scans from the Comic Strip Library, hosted by Internet Archive.' },
    { identifier: 'BringingUpFatherSeries1', title: 'Bringing Up Father, First Series', author: 'George McManus', year: 1919,
        description: 'The first book collection of George McManus\'s Jiggs and Maggie strips, from an original 1919 Cupples & Leon copy, hosted by Internet Archive.' },
    { identifier: 'barneygooglehisf0000debe_d8b9', title: 'Barney Google and His Faithful Nag Spark Plug', author: 'Billy DeBeck', year: 1923,
        description: 'Billy DeBeck\'s 1923 collection of Barney Google and Spark Plug strips, digitized from the original Cupples & Leon edition by Ohio State University and hosted by Internet Archive.' },
    { identifier: 'maxmauricejuveni00busc', title: 'Max and Maurice', author: 'Wilhelm Busch', year: 1902,
        description: 'Wilhelm Busch\'s picture story of two pranksters and their seven tricks, in Charles T. Brooks\'s English verse translation. From a 1902 Little, Brown printing, hosted by Internet Archive.' },
    { identifier: 'BusterBrownhisd00Outc', title: 'Buster Brown, His Dog Tige and Their Troubles', author: 'R. F. Outcault', year: 1904,
        description: 'The 1904 collection of Buster Brown comic strips, digitized from the original edition and hosted by Internet Archive.' },
    { identifier: 'foxy-grandpa-flip-flaps', title: 'Foxy Grandpa Flip-Flaps', author: 'Carl E. Schultze', year: 1905,
        description: '"Bunny" Schultze\'s 1905 collection of Foxy Grandpa colour strips from the New York Herald, from an original M. A. Donohue edition, hosted by Internet Archive.' },
    { identifier: 'McGillLibrary-122951-2115', title: 'The Strange Adventures of Bachelor Butterfly', author: 'Rodolphe Töpffer', year: 1846,
        description: 'An 1846 New York edition of Töpffer\'s Histoire de M. Cryptogame, one of the first comic albums: a butterfly-collecting bachelor flees his fiancée by land and sea. Hosted by Internet Archive.' },
    { identifier: 'gri_33125013775024', title: 'Carlo', author: 'A. B. Frost', year: 1913,
        description: 'A. B. Frost\'s 1913 picture story of a mischievous dog, told in sequential drawings with occasional captions. Digitized by the Getty Research Institute, hosted by Internet Archive.' },
    { identifier: 'albumcarandache00cara', title: 'Album Caran d\'Ache', author: 'Caran d\'Ache', year: 1889,
        description: 'Caran d\'Ache\'s first Plon album of comic strips, told almost entirely without words (strip titles in French). From the original Paris edition, hosted by Internet Archive.' },
    { identifier: 'seamansiadventur00pear', title: 'Seaman Si', author: 'Perce Pearce', year: 1918,
        description: 'Perce Pearce\'s 1918 navy comic strips, reprinted from the Great Lakes Bulletin. Digitized from the original Reilly & Britton edition by the Getty Research Institute, hosted by Internet Archive.' },
    { identifier: 'gri_33125014432682', title: 'Joys and Glooms', author: 'T. E. Powers', year: 1912,
        description: 'T. E. Powers\'s 1912 book of his Joys and Glooms newspaper strips, from the original Reilly & Britton edition, hosted by Internet Archive.' },
    { identifier: 'bullcalrtal00fros', title: 'The Bull Calf and Other Tales', author: 'A. B. Frost', year: 1892,
        description: 'A. B. Frost\'s 1892 collection of ten comic picture stories, many wordless. From the original Charles Scribner\'s Sons edition, hosted by Internet Archive.' },
    { identifier: 'plishplum00busc', title: 'Plish and Plum', author: 'Wilhelm Busch', year: 1900,
        description: 'Wilhelm Busch\'s picture story of two brothers and their mischievous dogs, in Charles T. Brooks\'s English verse translation. From a 1900 Little, Brown printing, hosted by Internet Archive.' },
    { identifier: 'buzzbuzzorbees00busc', title: 'Buzz a Buzz, or The Bees', author: 'Wilhelm Busch', year: 1873,
        description: 'Busch\'s coloured picture story of a beekeeper, his bees and his neighbours, in an 1873 English verse translation. From the original Henry Holt edition, hosted by Internet Archive.' },
    { identifier: 'barneygooglespar0000debe', title: 'Barney Google and Spark Plug, Book 4', author: 'Billy DeBeck', year: 1926,
        description: 'The fourth Cupples & Leon book of Barney Google and Spark Plug, reprinting DeBeck\'s 1925 strips. From the original edition, hosted by Internet Archive.' },
    { identifier: 'myresolutionsbus00outc', title: 'My Resolutions, Buster Brown', author: 'R. F. Outcault', year: 1910,
        description: 'The 1910 Buster Brown comic-strip collection, digitized from the original edition and hosted by Internet Archive.' },
    { identifier: 'BringingUpFather003', title: 'Bringing Up Father, Third Series', author: 'George McManus', year: 1919,
        description: 'The third Cupples & Leon collection of Jiggs and Maggie strips (1919), scanned from an original copy and hosted by Internet Archive.' },
    { identifier: 'Bringing_Up_Father__1921__004', title: 'Bringing Up Father, Fourth Series', author: 'George McManus', year: 1921,
        description: 'The fourth Cupples & Leon collection of Jiggs and Maggie strips (1921), scanned from an original copy and hosted by Internet Archive.' },
    { identifier: 'BringingUpFather005', title: 'Bringing Up Father, Fifth Series', author: 'George McManus', year: 1921,
        description: 'The fifth Cupples & Leon collection of Jiggs and Maggie strips (1921), scanned from an original copy and hosted by Internet Archive.' },
    { identifier: 'BringingUpFather008', title: 'Bringing Up Father, Series 8', author: 'George McManus', year: 1924,
        description: 'Series 8 of the Cupples & Leon books (1924), collecting George McManus\'s 1923 Jiggs and Maggie strips. Scanned from an original copy, hosted by Internet Archive.' },
    { identifier: 'McGillLibrary-132334-5275', title: 'Bringing Up Father, Series 18', author: 'George McManus', year: 1930,
        description: 'Series 18 of the Cupples & Leon books (1930). Digitized by McGill University Library from the original edition, hosted by Internet Archive.' },
    { identifier: 'foxy-grandpa-shows-the-boys-up-to-date-sports', title: 'Foxy Grandpa Shows the Boys Up-to-Date Sports', author: 'Carl E. Schultze', year: 1908,
        description: 'A 1908 Foxy Grandpa "Sparklets" book: short sporting stories told one colour panel per page with rhyming captions. From an original M. A. Donohue edition, hosted by Internet Archive.' },
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
