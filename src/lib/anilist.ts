const ANILIST_URL = 'https://graphql.anilist.co';

export interface SimpleAnime {
    mal_id: number;
    title: string;
    title_english: string | null;
    image: string;
    synopsis: string;
    status: string;
    type: string;
    year: number | null;
    episodes: number | null;
    score: number | null;
    genres: string[];
}

function escapeGql(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const FIELDS = `id idMal title{english romaji} coverImage{large extraLarge} description status genres averageScore episodes format seasonYear`;

let _lastDebug = '';
export function getLastAniListDebug(): string { return _lastDebug; }

async function runQuery(query: string): Promise<any> {
    let step = 'init';
    try {
        step = 'fetch';
        const res = await fetch(ANILIST_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query }),
        });

        step = `status:${res.status}`;
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            _lastDebug = `HTTP ${res.status}: ${errBody.slice(0, 150)}`;
            throw new Error(_lastDebug);
        }

        step = 'text';
        const raw = await res.text();
        step = `text:${raw.length}ch`;
        _lastDebug = `OK(${raw.length}ch): ${raw.slice(0, 150)}`;

        step = 'parse';
        const json = JSON.parse(raw);
        step = 'done';

        if (json?.errors?.length) {
            throw new Error(`GQL: ${json.errors[0]?.message || 'unknown'}`);
        }
        return json;
    } catch (e: any) {
        if (!_lastDebug) _lastDebug = `FAIL@${step}: ${e?.message || String(e)}`.slice(0, 250);
        throw e;
    }
}

function toSimple(m: any): SimpleAnime | null {
    if (!m || typeof m !== 'object') return null;
    // Only accept entries with a real MAL id. Falling back to AniList's `id`
    // here (the previous behaviour) caused the app to feed the wrong number
    // into Jikan and load a completely different series — see
    // "Classroom of the Elite 4S → The Outcast" report. Entries without a
    // MAL mapping are skipped; callers that still need them can use Jikan
    // search as a secondary path.
    const malId = m.idMal;
    if (!malId) return null;
    return {
        mal_id: malId,
        title: m.title?.english || m.title?.romaji || 'Unknown',
        title_english: m.title?.english || null,
        image: m.coverImage?.extraLarge || m.coverImage?.large || '',
        synopsis: m.description ? String(m.description).replace(/<[^>]+>/g, '') : '',
        status: m.status || 'Unknown',
        type: m.format || 'TV',
        year: m.seasonYear || null,
        episodes: m.episodes || null,
        score: m.averageScore ? +(m.averageScore / 10).toFixed(1) : null,
        genres: Array.isArray(m.genres) ? m.genres : [],
    };
}

function mapPage(data: any): SimpleAnime[] {
    const media = data?.data?.Page?.media;
    if (!Array.isArray(media)) return [];
    return media.map(toSimple).filter((x: SimpleAnime | null): x is SimpleAnime => x !== null);
}

// Lightweight title-similarity score in [0, 1]. Used to re-rank AniList
// search results so the closest title-match wins instead of the most
// popular hit. We strip punctuation, lowercase, and combine prefix-match
// with token-overlap and length penalty.
function similarity(query: string, candidate: string): number {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const q = norm(query);
    const c = norm(candidate);
    if (!q || !c) return 0;
    if (q === c) return 1;
    if (c.startsWith(q)) return 0.9;
    if (c.includes(q)) return 0.75;
    const qTokens = new Set(q.split(' '));
    const cTokens = new Set(c.split(' '));
    let overlap = 0;
    qTokens.forEach((t) => { if (cTokens.has(t)) overlap += 1; });
    const tokenScore = overlap / Math.max(qTokens.size, 1);
    const lenPenalty = 1 - Math.min(Math.abs(c.length - q.length) / Math.max(c.length, q.length, 1), 1);
    return Math.max(0, tokenScore * 0.7 + lenPenalty * 0.3);
}

function rerankByQuery(query: string, items: SimpleAnime[]): SimpleAnime[] {
    if (!items.length) return items;
    const scored = items.map((item) => {
        const eng = similarity(query, item.title_english || item.title);
        const rom = similarity(query, item.title);
        return { item, score: Math.max(eng, rom) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
}

export async function alTrending(): Promise<SimpleAnime[]> {
    const q = `{Page(page:1,perPage:15){media(type:ANIME,sort:TRENDING_DESC,status:RELEASING){${FIELDS}}}}`;
    const data = await runQuery(q);
    return mapPage(data);
}

export async function alPopular(): Promise<SimpleAnime[]> {
    const q = `{Page(page:1,perPage:15){media(type:ANIME,sort:POPULARITY_DESC){${FIELDS}}}}`;
    const data = await runQuery(q);
    return mapPage(data);
}

export async function alSearch(query: string): Promise<SimpleAnime[]> {
    // SEARCH_MATCH delegates relevance ordering to AniList; we then re-rank
    // locally by exact/prefix title similarity so a query like
    // "Classroom of the Elite 4th Season" doesn't get out-shouted by a
    // popular but unrelated hit.
    const q = `{Page(page:1,perPage:25){media(type:ANIME,search:"${escapeGql(query)}",sort:SEARCH_MATCH){${FIELDS}}}}`;
    const data = await runQuery(q);
    return rerankByQuery(query, mapPage(data)).slice(0, 15);
}

export async function alByGenre(genre: string): Promise<SimpleAnime[]> {
    const q = `{Page(page:1,perPage:15){media(type:ANIME,genre:"${escapeGql(genre)}",sort:POPULARITY_DESC){${FIELDS}}}}`;
    const data = await runQuery(q);
    return mapPage(data);
}

export async function alInfo(malId: number): Promise<SimpleAnime | null> {
    const q = `{Media(type:ANIME,idMal:${malId}){${FIELDS}}}`;
    const data = await runQuery(q);
    const m = data?.data?.Media || null;
    return m ? toSimple(m) : null;
}
