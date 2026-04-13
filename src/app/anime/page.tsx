"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import AnimeCard from "@/components/AnimeCard";
import { searchAnime, fetchAiringAnime, fetchAnimeByGenre, ANIME_GENRES, type AnimeResult } from "@/lib/anime";
import { getLocal, setLocal, setLocalAndSyncSearches, STORAGE_KEYS, getAnimeHistory, type AnimeHistoryEntry } from "@/lib/storage";
import { PSYOP_SEARCH_RESULT, matchesPsyopQuery } from "@/lib/psyopAnime";
import Link from "next/link";

// Debounce hook
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
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);
    const [airingLoading, setAiringLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const debouncedSearch = useDebounce(search, 800);
    const [continueWatching, setContinueWatching] = useState<AnimeHistoryEntry[]>([]);
    const [selectedGenre, setSelectedGenre] = useState<number | null>(null);
    const [genreResults, setGenreResults] = useState<AnimeResult[]>([]);
    const [genreLoading, setGenreLoading] = useState(false);

    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [showRecent, setShowRecent] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setContinueWatching(getAnimeHistory());
        fetchAiringAnime().then(data => {
            setAiringAnime(data);
            setAiringLoading(false);
        }).catch(() => setAiringLoading(false));
    }, []);

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

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40 }}>
                    <div className="section-header">
                        <h2 className="section-title">アニメ一覧</h2>
                        <p className="section-subtitle">
                            {isSearching
                                ? (loading ? "Searching..." : `${searchResults.length} Results`)
                                : "Browse & Discover Anime"
                            }
                        </p>
                    </div>

                    {/* PsyopAnime Featured Banner — blurred / disabled */}
                    {!isSearching && (
                        <div style={{ marginBottom: 24, filter: 'blur(8px)', opacity: 0.25, pointerEvents: 'none', userSelect: 'none' }}>
                            <div style={{
                                position: 'relative',
                                borderRadius: 20,
                                overflow: 'hidden',
                                height: 200,
                                background: '#0a0a1a',
                                border: '1px solid rgba(233,30,123,0.2)',
                                boxShadow: '0 0 40px rgba(233,30,123,0.15), 0 8px 32px rgba(0,0,0,0.4)',
                            }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src="/psyopanime.png"
                                    alt="PsyopAnime"
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        objectFit: 'cover',
                                        opacity: 0.45,
                                        filter: 'saturate(1.2)',
                                    }}
                                />
                                <div style={{
                                    position: 'absolute',
                                    inset: 0,
                                    background: 'linear-gradient(160deg, rgba(147,51,234,0.5) 0%, rgba(233,30,123,0.3) 30%, rgba(10,10,26,0.92) 70%)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'flex-end',
                                    padding: '24px 24px',
                                }}>
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        marginBottom: 10,
                                    }}>
                                        <span style={{
                                            display: 'inline-block',
                                            background: 'linear-gradient(135deg, #E91E7B, #9333ea)',
                                            color: '#fff',
                                            fontSize: 9,
                                            fontWeight: 800,
                                            padding: '4px 12px',
                                            borderRadius: 20,
                                            letterSpacing: 1.5,
                                            textTransform: 'uppercase',
                                        }}>
                                            PsyopAnime × Sakura
                                        </span>
                                        <span style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 4,
                                            color: 'rgba(255,255,255,0.5)',
                                            fontSize: 10,
                                            fontWeight: 600,
                                        }}>
                                            <span style={{
                                                width: 6, height: 6, borderRadius: '50%',
                                                background: '#4ade80',
                                                display: 'inline-block',
                                                boxShadow: '0 0 6px #4ade80',
                                            }} />
                                            Now streaming
                                        </span>
                                    </div>
                                    <h3 style={{
                                        margin: 0,
                                        color: '#fff',
                                        fontSize: 24,
                                        fontWeight: 900,
                                        lineHeight: 1.15,
                                        letterSpacing: -0.5,
                                        textShadow: '0 2px 20px rgba(233,30,123,0.4)',
                                    }}>
                                        PsyopAnime: The Series
                                    </h3>
                                    <p style={{
                                        margin: '6px 0 0',
                                        color: 'rgba(255,255,255,0.5)',
                                        fontSize: 12,
                                        fontWeight: 500,
                                        letterSpacing: 0.3,
                                    }}>
                                        Sci-Fi Action · Psychological Thriller · Satire
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Search */}
                    <div className="search-bar-wrapper" ref={searchRef}>
                        <div className="search-bar" style={{ borderColor: "rgba(88, 101, 242, 0.4)" }}>
                            <span className="search-icon">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(88, 101, 242, 1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg>
                            </span>
                            <input
                                type="text"
                                placeholder="アニメを検索... Search anime..."
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

                    {/* Genre Filter Chips */}
                    {!isSearching && (
                        <div className="genre-filters" style={{ maxWidth: 700, margin: '0 auto 24px' }}>
                            <button
                                className={`genre-chip ${selectedGenre === null ? 'active' : ''}`}
                                onClick={() => handleGenreSelect(null)}
                            >
                                All
                            </button>
                            {ANIME_GENRES.map(g => (
                                <button
                                    key={g.id}
                                    className={`genre-chip ${selectedGenre === g.id ? 'active' : ''}`}
                                    onClick={() => handleGenreSelect(g.id)}
                                >
                                    {g.name}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Error */}
                    {error && (
                        <div className="error-container" style={{ margin: "40px auto", maxWidth: 600 }}>
                            <p className="error-message">{error}</p>
                        </div>
                    )}

                    {/* Search Results */}
                    {isSearching && (
                        <>
                            {loading ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {Array.from({ length: 6 }).map((_, i) => (
                                        <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                                    ))}
                                </div>
                            ) : searchResults.length > 0 ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {searchResults.map((anime) => (
                                        <AnimeCard key={anime.id} id={anime.id} title={anime.title} image={anime.image} type={anime.type} />
                                    ))}
                                </div>
                            ) : !error ? (
                                <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                    <p style={{ fontFamily: "var(--font-jp)", fontSize: 18 }}>アニメが見つかりませんでした</p>
                                    <p style={{ fontSize: 14 }}>No results found.</p>
                                </div>
                            ) : null}
                        </>
                    )}

                    {/* Genre Results — shown when a genre is selected */}
                    {!isSearching && selectedGenre !== null && (
                        <>
                            <div className="section-header" style={{ marginTop: 8 }}>
                                <h2 className="section-title" style={{ fontSize: 20 }}>
                                    {ANIME_GENRES.find(g => g.id === selectedGenre)?.name}
                                </h2>
                                <p className="section-subtitle">Filtered by genre</p>
                            </div>
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
                        </>
                    )}

                    {/* Continue Watching + Airing/Trending — shown when not searching and no genre filter */}
                    {!isSearching && selectedGenre === null && (
                        <>
                            {continueWatching.length > 0 && (
                                <>
                                    <div className="section-header" style={{ marginTop: 24 }}>
                                        <h2 className="section-title" style={{ fontSize: 20 }}>▶ 視聴を続ける</h2>
                                        <p className="section-subtitle">Continue Watching</p>
                                    </div>
                                    <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, WebkitOverflowScrolling: 'touch' }}>
                                        {continueWatching.map(entry => (
                                            <Link
                                                key={entry.animeId}
                                                href={`/anime/watch?id=${encodeURIComponent(entry.animeId)}&ep=${encodeURIComponent(entry.episodeId)}`}
                                                style={{ textDecoration: 'none', flexShrink: 0, width: 140 }}
                                            >
                                                <div style={{ position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', aspectRatio: '2/3', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={entry.image || '/sakura.png'}
                                                        alt={entry.animeTitle}
                                                        referrerPolicy="no-referrer"
                                                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                    />
                                                    <div style={{
                                                        position: 'absolute', bottom: 0, left: 0, right: 0,
                                                        background: 'linear-gradient(transparent, rgba(0,0,0,0.9))',
                                                        padding: '24px 8px 8px'
                                                    }}>
                                                        <span style={{
                                                            display: 'inline-block',
                                                            background: 'var(--sakura-pink)',
                                                            color: '#fff',
                                                            fontSize: 11,
                                                            fontWeight: 700,
                                                            padding: '2px 6px',
                                                            borderRadius: 4,
                                                            marginBottom: 4
                                                        }}>
                                                            Ep {entry.episodeNumber}
                                                        </span>
                                                        <p style={{ margin: 0, color: '#fff', fontSize: 12, fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {entry.animeTitle}
                                                        </p>
                                                    </div>
                                                </div>
                                            </Link>
                                        ))}
                                    </div>
                                </>
                            )}

                            <div className="section-header" style={{ marginTop: 24 }}>
                                <h2 className="section-title" style={{ fontSize: 20 }}>🔥 放送中</h2>
                                <p className="section-subtitle">Currently Airing</p>
                            </div>

                            {airingLoading ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {Array.from({ length: 6 }).map((_, i) => (
                                        <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                                    ))}
                                </div>
                            ) : airingAnime.length > 0 ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {airingAnime.map((anime) => (
                                        <AnimeCard key={anime.id} id={anime.id} title={anime.title} image={anime.image} type={anime.type} />
                                    ))}
                                </div>
                            ) : (
                                <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                    <p style={{ fontSize: 14 }}>Could not load airing anime. Try searching instead.</p>
                                </div>
                            )}
                        </>
                    )}
                </section>

                <footer className="footer">
                    <p className="footer-jp">桜 — マンガの新しい形</p>
                    <p className="footer-text">© 2026 Sakura. Read manga on the blockchain.</p>
                    <div className="footer-solana">
                        <span className="sol-dot" />
                        Built on Solana
                    </div>
                </footer>
            </main>
        </>
    );
}
