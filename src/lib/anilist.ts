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
    const numericId = m.idMal || m.id;
    if (!numericId) return null;
    return {
        mal_id: numericId,
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
    const q = `{Page(page:1,perPage:15){media(type:ANIME,search:"${escapeGql(query)}",sort:POPULARITY_DESC){${FIELDS}}}}`;
    const data = await runQuery(q);
    return mapPage(data);
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
