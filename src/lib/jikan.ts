import { Capacitor, CapacitorHttp } from '@capacitor/core';

const JIKAN_API = 'https://api.jikan.moe/v4';

export interface JikanAnime {
    mal_id: number;
    title: string;
    title_english: string | null;
    title_japanese?: string | null;
    title_synonyms?: string[];
    images: {
        webp: {
            image_url: string;
            large_image_url: string;
        }
    };
    synopsis: string;
    status: string;
    type: string;
    year: number | null;
    episodes?: number | null;
    score: number | null;
    genres: { name: string }[];
}

const memCache = new Map<string, { data: any; exp: number }>();

let _lastJikanCall = 0;
const JIKAN_MIN_INTERVAL = 350;

async function requestJikan(url: string) {
    const now = Date.now();
    const hit = memCache.get(url);
    if (hit && now < hit.exp) return hit.data;

    // Respect Jikan rate limit (~3 req/s)
    const wait = JIKAN_MIN_INTERVAL - (now - _lastJikanCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastJikanCall = Date.now();

    let data: any;
    if (Capacitor.isNativePlatform()) {
        const response = await CapacitorHttp.get({ url });
        if (response.status === 429) {
            await new Promise(r => setTimeout(r, 1500));
            return requestJikan(url);
        }
        if (response.status >= 400) throw new Error(`HTTP Error: ${response.status}`);
        data = response.data;
    } else {
        const res = await fetch(url);
        if (res.status === 429) {
            await new Promise(r => setTimeout(r, 1500));
            return requestJikan(url);
        }
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        data = await res.json();
    }

    // Jikan sometimes returns HTTP 200 with a JSON error body
    if (data && typeof data.status === "number" && data.status >= 400) {
        throw new Error(`Jikan API Error: ${data.message || data.status}`);
    }

    memCache.set(url, { data, exp: now + 10 * 60 * 1000 });
    return data;
}

export async function fetchJikanSearch(query: string): Promise<JikanAnime[]> {
    try {
        const data = await requestJikan(`${JIKAN_API}/anime?q=${encodeURIComponent(query)}&order_by=popularity&sort=asc&sfw=true`);
        return data.data || [];
    } catch (e) {
        console.error("Jikan Search Error", e);
        return [];
    }
}

export async function fetchJikanTrending(): Promise<JikanAnime[]> {
    try {
        const data = await requestJikan(`${JIKAN_API}/top/anime?filter=airing&limit=12`);
        return data.data || [];
    } catch (e) {
        console.error("Jikan Trending Error", e);
        return [];
    }
}

export async function fetchJikanPopular(): Promise<JikanAnime[]> {
    try {
        const data = await requestJikan(`${JIKAN_API}/top/anime?filter=bypopularity&limit=15`);
        return data.data || [];
    } catch (e) {
        console.error("Jikan Popular Error", e);
        return [];
    }
}

export const ANIME_GENRES: { id: number; name: string }[] = [
    { id: 1, name: "Action" },
    { id: 2, name: "Adventure" },
    { id: 4, name: "Comedy" },
    { id: 8, name: "Drama" },
    { id: 10, name: "Fantasy" },
    { id: 14, name: "Horror" },
    { id: 7, name: "Mystery" },
    { id: 22, name: "Romance" },
    { id: 24, name: "Sci-Fi" },
    { id: 36, name: "Slice of Life" },
    { id: 30, name: "Sports" },
    { id: 37, name: "Supernatural" },
];

export async function fetchJikanByGenre(genreId: number): Promise<JikanAnime[]> {
    try {
        const data = await requestJikan(
            `${JIKAN_API}/anime?genres=${genreId}&order_by=popularity&sort=asc&sfw=true&limit=12`
        );
        return data.data || [];
    } catch (e) {
        console.error("Jikan Genre Error", e);
        return [];
    }
}

export async function fetchJikanInfo(id: string | number): Promise<JikanAnime | null> {
    try {
        const data = await requestJikan(`${JIKAN_API}/anime/${id}/full`);
        return data.data || null;
    } catch (e) {
        console.error("Jikan Info Error", e);
        return null;
    }
}
