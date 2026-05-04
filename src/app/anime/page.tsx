"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import AnimeCard from "@/components/AnimeCard";
import { searchAnime, fetchAiringAnime, fetchPopularAnime, fetchAnimeByGenre, ANIME_GENRES, type AnimeResult } from "@/lib/anime";
import { getLastAniListDebug } from "@/lib/anilist";
import { getLocal, setLocal, setLocalAndSyncSearches, STORAGE_KEYS, getAnimeHistory, type AnimeHistoryEntry } from "@/lib/storage";
import { PSYOP_ID, PSYOP_INFO, PSYOP_EPISODES } from "@/lib/psyopAnime";
import Link from "next/link";

function useDebounce(value: string, delay: number) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(handler);
    }, [value, delay]);
    return debouncedValue;
}

const MAX_RECENT_SEARCHES = 8;

export default function AnimeBrowsePage() {
    const [searchResults, setSearchResults] = useState<AnimeResult[]>([]);
    const [airingAnime, setAiringAnime] = useState<AnimeResult[]>([]);
    const [popularAnime, setPopularAnime] = useState<AnimeResult[]>([]);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);
    const [airingLoading, setAiringLoading] = useState(true);
    const [popularLoading, setPopularLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const debouncedSearch = useDebounce(search, 800);
    const [continueWatching, setContinueWatching] = useState<AnimeHistoryEntry[]>([]);
    const [selectedGenre, setSelectedGenre] = useState<number | null>(null);
    const [genreResults, setGenreResults] = useState<AnimeResult[]>([]);
    const [genreLoading, setGenreLoading] = useState(false);
    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [showRecent, setShowRecent] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    const [apiError, setApiError] = useState<string | null>(null);

    const loadRows = useCallback(async () => {
        setAiringLoading(true);
        setPopularLoading(true);
        setApiError(null);

        let gotAny = false;
        const errors: string[] = [];

        try {
            const airing = await fetchAiringAnime();
            setAiringAnime(airing);
            if (airing.length > 0) gotAny = true;
            else errors.push("trending:empty");
        } catch (e: any) {
            errors.push(`trending:${e?.message || "error"}`);
        }
        setAiringLoading(false);

        try {
            const popular = await fetchPopularAnime();
            setPopularAnime(popular);
            if (popular.length > 0) gotAny = true;
            else errors.push("popular:empty");
        } catch (e: any) {
            errors.push(`popular:${e?.message || "error"}`);
        }
        setPopularLoading(false);

        if (!gotAny) {
            const dbg = getLastAniListDebug();
            setApiError(`${errors.join(" | ")}. DBG: ${dbg.slice(0, 180)}. Tap to retry`);
        }
    }, []);

    useEffect(() => {
        setContinueWatching(getAnimeHistory());
        loadRows();
    }, [loadRows]);

    useEffect(() => {
        setRecentSearches(getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES + "_ANIME", []));
    }, []);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
                setShowRecent(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    const saveRecentSearch = useCallback((query: string) => {
        const trimmed = query.trim();
        if (!trimmed || trimmed.length < 2) return;
        const existing = getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES + "_ANIME", []);
        const filtered = existing.filter(s => s.toLowerCase() !== trimmed.toLowerCase());
        const updated = [trimmed, ...filtered].slice(0, MAX_RECENT_SEARCHES);
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES + "_ANIME", updated);
        setRecentSearches(updated);
    }, []);

    const removeRecentSearch = useCallback((query: string) => {
        const existing = getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES + "_ANIME", []);
        const updated = existing.filter(s => s !== query);
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES + "_ANIME", updated);
        setRecentSearches(updated);
    }, []);

    const clearRecentSearches = useCallback(() => {
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES + "_ANIME", []);
        setRecentSearches([]);
    }, []);

    const fetchAnimeData = useCallback(async (query: string) => {
        if (!query.trim()) {
            setSearchResults([]);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const results = await searchAnime(query);
            setSearchResults(results);
            if (query.trim().length >= 2) saveRecentSearch(query);
        } catch (e: any) {
            console.error("Search failed", e);
            setError(e.message || "Search failed.");
        }
        setLoading(false);
    }, [saveRecentSearch]);

    useEffect(() => {
        fetchAnimeData(debouncedSearch);
    }, [debouncedSearch, fetchAnimeData]);

    const handleRecentClick = (query: string) => {
        setSearch(query);
        setShowRecent(false);
    };

    const handleGenreSelect = useCallback(async (genreId: number | null) => {
        setSelectedGenre(genreId);
        if (!genreId) {
            setGenreResults([]);
            return;
        }
        setGenreLoading(true);
        const results = await fetchAnimeByGenre(genreId);
        setGenreResults(results);
        setGenreLoading(false);
    }, []);

    const isSearching = search.trim().length > 0;
    const firstEp = PSYOP_EPISODES[0];

    return (
        <>
            <Header />
            <main style={{ background: "#0a0a0f", minHeight: "100vh", paddingBottom: 140 }}>

                {/* Hero Banner */}
                {!isSearching && (
                    <div className="anime-hero">
                        <div className="anime-hero-bg">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src="/psyopanime.png" alt="" />
                        </div>
                        <div className="anime-hero-content">
                            <span className="anime-hero-badge">PsyopAnime × Sakura</span>
                            <h1 className="anime-hero-title">{PSYOP_INFO.title}</h1>
                            <div className="anime-hero-meta">
                                <span style={{ color: "#4ade80", fontWeight: 700 }}>Ongoing</span>
                                <span>·</span>
                                {PSYOP_INFO.genres?.map(g => <span key={g}>{g}</span>)}
                            </div>
                            <p className="anime-hero-desc">{PSYOP_INFO.description}</p>
                            <div className="anime-hero-actions">
                                <Link
                                    href={`/anime/watch?id=${PSYOP_ID}&ep=${encodeURIComponent(firstEp.id)}`}
                                    className="anime-hero-play"
                                >
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                    Start Watching
                                </Link>
                                <Link href={`/anime/details?id=${PSYOP_ID}`} className="anime-hero-save" aria-label="Details">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                                </Link>
                            </div>
                        </div>
                    </div>
                )}

                {/* Continue Watching */}
                {!isSearching && continueWatching.length > 0 && (
                    <div className="anime-row">
                        <div className="anime-row-header">
                            <h2 className="anime-row-title">Continue Watching</h2>
                        </div>
                        <div className="anime-row-scroll">
                            {continueWatching.map(entry => (
                                <Link
                                    key={entry.animeId}
                                    href={`/anime/watch?id=${encodeURIComponent(entry.animeId)}&ep=${encodeURIComponent(entry.episodeId)}`}
                                    className="anime-cw-card"
                                >
                                    <div className="anime-cw-card-img">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={entry.image || "/sakura.png"} alt={entry.animeTitle} referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).src = "/sakura.png"; }} />
                                        <div className="anime-cw-overlay">
                                            <div className="cw-play">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="anime-cw-ep">{entry.animeTitle}</div>
                                    <div className="anime-cw-title">Episode {entry.episodeNumber} · {entry.episodeTitle}</div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}

                {/* Search */}
                <div className="sticky-search-wrap" style={{ padding: "16px 20px 0" }}>
                    <div className="search-bar-wrapper" ref={searchRef}>
                        <div className="search-bar" style={{ borderColor: "rgba(88, 101, 242, 0.4)", maxWidth: "100%" }}>
                            <span className="search-icon">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(88, 101, 242, 1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg>
                            </span>
                            <input
                                type="text"
                                placeholder="Search anime..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                onFocus={() => setShowRecent(true)}
                            />
                            {search && (
                                <button className="search-clear" onClick={() => { setSearch(""); setShowRecent(true); }} aria-label="Clear">
                                    ✕
                                </button>
                            )}
                        </div>

                        {showRecent && recentSearches.length > 0 && !search && (
                            <div className="recent-searches">
                                <div className="recent-searches-header">
                                    <span className="recent-searches-title">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                                        Recent
                                    </span>
                                    <button className="recent-searches-clear" onClick={clearRecentSearches}>Clear All</button>
                                </div>
                                {recentSearches.map((q) => (
                                    <div key={q} className="recent-search-item">
                                        <button className="recent-search-text" onClick={() => handleRecentClick(q)}>{q}</button>
                                        <button className="recent-search-remove" onClick={(e) => { e.stopPropagation(); removeRecentSearch(q); }}>✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {isSearching && (
                        <div className="active-query-pill">
                            <span className="active-query-label">Searching for</span>
                            <span className="active-query-value">{search.trim()}</span>
                        </div>
                    )}
                </div>

                {/* Genre Chips */}
                {!isSearching && (
                    <div style={{ padding: "8px 20px 0" }}>
                        <div className="genre-filters" style={{ maxWidth: "100%", margin: 0 }}>
                            <button className={`genre-chip ${selectedGenre === null ? "active" : ""}`} onClick={() => handleGenreSelect(null)}>All</button>
                            {ANIME_GENRES.map(g => (
                                <button key={g.id} className={`genre-chip ${selectedGenre === g.id ? "active" : ""}`} onClick={() => handleGenreSelect(g.id)}>{g.name}</button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)" }}>
                        <p>{error}</p>
                    </div>
                )}

                {/* API connection error + retry */}
                {apiError && !isSearching && (
                    <button
                        onClick={loadRows}
                        style={{
                            display: "block",
                            margin: "12px 20px",
                            padding: "12px 20px",
                            width: "calc(100% - 40px)",
                            background: "rgba(233,30,123,0.1)",
                            border: "1px solid rgba(233,30,123,0.25)",
                            borderRadius: 12,
                            color: "var(--sakura-pink)",
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: "pointer",
                            textAlign: "center",
                        }}
                    >
                        {apiError}
                    </button>
                )}

                {/* Search Results */}
                {isSearching && (
                    <div style={{ padding: "16px 20px" }}>
                        {loading ? (
                            <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                                ))}
                            </div>
                        ) : searchResults.length > 0 ? (
                            <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                {searchResults.map((anime) => (
                                    <AnimeCard key={anime.id} id={anime.id} title={anime.title} image={anime.image} type={anime.type} year={anime.year} showMeta />
                                ))}
                            </div>
                        ) : !error ? (
                            <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                <p style={{ fontSize: 14 }}>No results found.</p>
                            </div>
                        ) : null}
                    </div>
                )}

                {/* Genre Results */}
                {!isSearching && selectedGenre !== null && (
                    <div style={{ padding: "16px 20px" }}>
                        <h3 className="anime-row-title" style={{ marginBottom: 16 }}>
                            {ANIME_GENRES.find(g => g.id === selectedGenre)?.name}
                        </h3>
                        {genreLoading ? (
                            <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                                ))}
                            </div>
                        ) : genreResults.length > 0 ? (
                            <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                {genreResults.map((anime) => (
                                    <AnimeCard key={anime.id} id={anime.id} title={anime.title} image={anime.image} type={anime.type} />
                                ))}
                            </div>
                        ) : (
                            <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                <p style={{ fontSize: 14 }}>No anime found for this genre.</p>
                            </div>
                        )}
                    </div>
                )}

                {/* Currently Airing Row */}
                {!isSearching && selectedGenre === null && (
                    <div className="anime-row" style={{ paddingTop: 8 }}>
                        <div className="anime-row-header">
                            <h2 className="anime-row-title">Currently Airing</h2>
                        </div>
                        {airingLoading ? (
                            <div className="anime-row-scroll">
                                {Array.from({ length: 5 }).map((_, i) => (
                                    <div key={i} className="anime-row-card">
                                        <div className="loading-skeleton" style={{ width: 130, height: 185, borderRadius: 8 }} />
                                    </div>
                                ))}
                            </div>
                        ) : airingAnime.length > 0 ? (
                            <div className="anime-row-scroll">
                                {airingAnime.map((anime) => (
                                    <Link key={anime.id} href={`/anime/details?id=${encodeURIComponent(anime.id)}`} className="anime-row-card">
                                        <div className="anime-row-card-img">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={anime.image || "/sakura.png"} alt={anime.title} referrerPolicy="no-referrer" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).src = "/sakura.png"; }} />
                                        </div>
                                        {anime.score && <div className="anime-row-card-label">★ {anime.score}</div>}
                                        <div className="anime-row-card-title">{anime.title}</div>
                                    </Link>
                                ))}
                            </div>
                        ) : (
                            <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                                Could not load airing anime — check your connection.
                            </div>
                        )}
                    </div>
                )}

                {/* Popular / Top Picks Row */}
                {!isSearching && selectedGenre === null && (
                    <div className="anime-row" style={{ paddingTop: 0 }}>
                        <div className="anime-row-header">
                            <h2 className="anime-row-title">Top Picks</h2>
                        </div>
                        {popularLoading ? (
                            <div className="anime-row-scroll">
                                {Array.from({ length: 5 }).map((_, i) => (
                                    <div key={i} className="anime-row-card">
                                        <div className="loading-skeleton" style={{ width: 130, height: 185, borderRadius: 8 }} />
                                    </div>
                                ))}
                            </div>
                        ) : popularAnime.length > 0 ? (
                            <div className="anime-row-scroll">
                                {popularAnime.map((anime) => (
                                    <Link key={anime.id} href={`/anime/details?id=${encodeURIComponent(anime.id)}`} className="anime-row-card">
                                        <div className="anime-row-card-img">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={anime.image || "/sakura.png"} alt={anime.title} referrerPolicy="no-referrer" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).src = "/sakura.png"; }} />
                                        </div>
                                        {anime.score && <div className="anime-row-card-label">★ {anime.score}</div>}
                                        <div className="anime-row-card-title">{anime.title}</div>
                                    </Link>
                                ))}
                            </div>
                        ) : (
                            <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                                Could not load popular anime.
                            </div>
                        )}
                    </div>
                )}
            </main>
        </>
    );
}
