"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import MangaCard from "@/components/MangaCard";
import { searchAllSources, searchAllComics } from "@/lib/sources";
import { type Manga } from "@/lib/sources/types";
import { getLocal, setLocal, setLocalAndSyncSearches, STORAGE_KEYS } from "@/lib/storage";
import { MANGA_GENRES, searchMangaByGenre } from "@/lib/content-source";
import { getDefaultMangaSourceId } from "@/lib/sources/source-ids";
import { sourceSupportsStats } from "@/lib/sources/source-meta";

type BrowseMode = "manga" | "comic";
const BROWSE_MODE_KEY = "sakura_browse_mode";

// Debounce hook for search
function useDebounce(value: string, delay: number) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(handler);
    }, [value, delay]);
    return debouncedValue;
}

const ITEMS_PER_PAGE = 4;
const MAX_RECENT_SEARCHES = 8;

export default function BrowsePage() {
    const [mangaList, setMangaList] = useState<Manga[]>([]);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const debouncedSearch = useDebounce(search, 500);
    const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
    const [genreResults, setGenreResults] = useState<Manga[]>([]);
    const [genreLoading, setGenreLoading] = useState(false);

    // Manga / Comics mode toggle
    const [mode, setMode] = useState<BrowseMode>("manga");

    // Recent searches
    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [showRecent, setShowRecent] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    // Load recent searches + persisted mode on mount
    useEffect(() => {
        setRecentSearches(getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES, []));
        const savedMode = getLocal<BrowseMode>(BROWSE_MODE_KEY, "manga");
        if (savedMode === "comic" || savedMode === "manga") {
            setMode(savedMode);
        }
    }, []);

    const handleModeChange = useCallback((next: BrowseMode) => {
        setMode(next);
        setLocal(BROWSE_MODE_KEY, next);
        setSearch("");
        setSelectedGenre(null);
        setGenreResults([]);
        setCurrentPage(1);
    }, []);

    // Close recent dropdown on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
                setShowRecent(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    // Save a search to recent
    const saveRecentSearch = useCallback((query: string) => {
        const trimmed = query.trim();
        if (!trimmed || trimmed.length < 2) return;

        const existing = getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES, []);
        const filtered = existing.filter(s => s.toLowerCase() !== trimmed.toLowerCase());
        const updated = [trimmed, ...filtered].slice(0, MAX_RECENT_SEARCHES);
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES, updated);
        setRecentSearches(updated);
    }, []);

    const removeRecentSearch = useCallback((query: string) => {
        const existing = getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES, []);
        const updated = existing.filter(s => s !== query);
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES, updated);
        setRecentSearches(updated);
    }, []);

    const clearRecentSearches = useCallback(() => {
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES, []);
        setRecentSearches([]);
    }, []);

    const totalPages = Math.max(1, Math.ceil(mangaList.length / ITEMS_PER_PAGE));
    const startIdx = (currentPage - 1) * ITEMS_PER_PAGE;
    const visibleManga = mangaList.slice(startIdx, startIdx + ITEMS_PER_PAGE);

    const fetchManga = useCallback(async (query: string, browseMode: BrowseMode) => {
        setLoading(true);
        setError(null);
        setCurrentPage(1); // Reset to page 1 on new search
        try {
            const results = browseMode === "comic"
                ? await searchAllComics(query)
                : await searchAllSources(query);
            setMangaList(results);

            // Save non-empty queries to recent searches (shared across both modes)
            if (query.trim().length >= 2) {
                saveRecentSearch(query);
            }

            // Fetch manga-only stats (ratings/follows). Comics sources don't expose them.
            if (browseMode === "manga") {
                const sourceIds = results.filter(m => sourceSupportsStats(m.sourceStr)).map(m => m.id);
                if (sourceIds.length > 0) {
                    const { getMangaStatistics } = await import("@/lib/content-source");
                    const stats = await getMangaStatistics(sourceIds);
                    setMangaList(prev => prev.map(m => {
                        if (!sourceSupportsStats(m.sourceStr)) return m;
                        const stat = stats[m.id];
                        return {
                            ...m,
                            rating: stat?.rating?.average,
                            follows: stat?.follows
                        };
                    }));
                }
            }
        } catch (e: any) {
            console.error(`${browseMode} search failed`, e);
            setError(e.message || "Search failed");
        }
        setLoading(false);
    }, [saveRecentSearch]);

    useEffect(() => {
        fetchManga(debouncedSearch, mode);
    }, [debouncedSearch, mode, fetchManga]);

    const handleRecentClick = (query: string) => {
        setSearch(query);
        setShowRecent(false);
    };

    const handleGenreSelect = useCallback(async (tagId: string | null) => {
        setSelectedGenre(tagId);
        if (!tagId) {
            setGenreResults([]);
            return;
        }
        setGenreLoading(true);
        const results = await searchMangaByGenre(tagId);
        setGenreResults(results.map(m => ({ ...m, sourceStr: getDefaultMangaSourceId() })) as Manga[]);
        setGenreLoading(false);
    }, []);

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40 }}>
                    <div className="section-header">
                        <h2 className="section-title">
                            {mode === "comic" ? "Comics" : "マンガ一覧"}
                        </h2>
                        <p className="section-subtitle">
                            {mode === "comic" ? "Browse Comics" : "Browse Series"} — {loading ? "Loading..." : `${mangaList.length} Results`}
                        </p>
                    </div>

                    {/* Manga / Comics segmented toggle */}
                    <div
                        role="tablist"
                        aria-label="Content type"
                        style={{
                            display: "flex",
                            margin: "0 auto 20px",
                            maxWidth: 320,
                            padding: 4,
                            borderRadius: 999,
                            background: "rgba(255,255,255,0.04)",
                            border: "1px solid rgba(255,255,255,0.08)",
                        }}
                    >
                        {(["manga", "comic"] as BrowseMode[]).map((m) => {
                            const active = mode === m;
                            return (
                                <button
                                    key={m}
                                    role="tab"
                                    aria-selected={active}
                                    onClick={() => handleModeChange(m)}
                                    style={{
                                        flex: 1,
                                        padding: "10px 16px",
                                        borderRadius: 999,
                                        border: "none",
                                        cursor: "pointer",
                                        fontWeight: 700,
                                        fontSize: 13,
                                        letterSpacing: 0.3,
                                        color: active ? "#fff" : "var(--text-muted)",
                                        background: active
                                            ? (m === "comic"
                                                ? "linear-gradient(135deg, rgba(14,165,233,0.85), rgba(34,211,238,0.85))"
                                                : "linear-gradient(135deg, rgba(255,107,157,0.85), rgba(236,72,153,0.85))")
                                            : "transparent",
                                        transition: "all 0.2s ease",
                                    }}
                                >
                                    {m === "comic" ? "Comics" : "Manga"}
                                </button>
                            );
                        })}
                    </div>

                    {/* Search with Recent Searches */}
                    <div className="sticky-search-wrap">
                    <div className="search-bar-wrapper" ref={searchRef}>
                        <div className="search-bar">
                            <span className="search-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg></span>
                            <input
                                type="text"
                                placeholder={mode === "comic"
                                    ? "Search for Marvel, DC, Image, and more..."
                                    : "マンガを検索... Search for your favorite manga..."}
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                onFocus={() => setShowRecent(true)}
                            />
                            {search && (
                                <button
                                    className="search-clear"
                                    onClick={() => { setSearch(""); setShowRecent(true); }}
                                    aria-label="Clear search"
                                >
                                    ✕
                                </button>
                            )}
                        </div>

                        {/* Recent Searches Dropdown */}
                        {showRecent && recentSearches.length > 0 && !search && (
                            <div className="recent-searches">
                                <div className="recent-searches-header">
                                    <span className="recent-searches-title">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                                        最近の検索 Recent
                                    </span>
                                    <button className="recent-searches-clear" onClick={clearRecentSearches}>
                                        Clear All
                                    </button>
                                </div>
                                {recentSearches.map((q) => (
                                    <div key={q} className="recent-search-item">
                                        <button
                                            className="recent-search-text"
                                            onClick={() => handleRecentClick(q)}
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg>
                                            {q}
                                        </button>
                                        <button
                                            className="recent-search-remove"
                                            onClick={(e) => { e.stopPropagation(); removeRecentSearch(q); }}
                                            aria-label={`Remove ${q}`}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {search.trim().length > 0 && (
                        <div className="active-query-pill">
                            <span className="active-query-label">Searching for</span>
                            <span className="active-query-value">{search.trim()}</span>
                        </div>
                    )}
                    </div>

                    {/* Genre Filter Chips — manga only; ComicExtra uses a different genre taxonomy */}
                    {mode === "manga" && (
                        <div className="genre-filters" style={{ maxWidth: 700, margin: '0 auto 24px' }}>
                            <button
                                className={`genre-chip ${selectedGenre === null ? 'active' : ''}`}
                                onClick={() => handleGenreSelect(null)}
                            >
                                All
                            </button>
                            {MANGA_GENRES.map(g => (
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

                    {/* Genre Results */}
                    {selectedGenre && (
                        <>
                            {genreLoading ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {Array.from({ length: ITEMS_PER_PAGE }).map((_, i) => (
                                        <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                                    ))}
                                </div>
                            ) : genreResults.length > 0 ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {genreResults.map((manga) => (
                                        <MangaCard
                                            key={manga.id}
                                            slug={manga.id}
                                            title={manga.title}
                                            cover={manga.cover}
                                            genres={manga.tags.slice(0, 3)}
                                            follows={manga.follows}
                                            rating={manga.rating}
                                            source={manga.sourceStr}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                    <p style={{ fontSize: 14 }}>No manga found for this genre.</p>
                                </div>
                            )}
                        </>
                    )}

                    {/* Error State */}
                    {error && !selectedGenre && (
                        <div className="error-container" style={{ margin: "40px auto", maxWidth: 600 }}>
                            <p className="error-message">{error}</p>
                            <p style={{ fontSize: 14, marginTop: 8, color: "var(--text-muted)" }}>
                                If you are on Web, this is likely a CORS issue. Please use the Mobile App.
                            </p>
                        </div>
                    )}

                    {/* Grid — shown when no genre is selected */}
                    {!selectedGenre && loading ? (
                        <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                            {Array.from({ length: ITEMS_PER_PAGE }).map((_, i) => (
                                <div
                                    key={i}
                                    className="loading-skeleton"
                                    style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }}
                                />
                            ))}
                        </div>
                    ) : !selectedGenre ? (
                        <>
                            {!error && (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {visibleManga.map((manga) => (
                                        <MangaCard
                                            key={manga.id}
                                            slug={manga.id}
                                            title={manga.title}
                                            cover={manga.cover}
                                            genres={manga.tags.slice(0, 3)}
                                            follows={manga.follows}
                                            rating={manga.rating}
                                            source={manga.sourceStr}
                                        />
                                    ))}
                                </div>
                            )}

                            {/* Pagination Controls */}
                            {!error && mangaList.length > 0 && (
                                <div className="pagination-controls">
                                    <button
                                        className="pagination-arrow"
                                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                        disabled={currentPage <= 1}
                                    >
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                                    </button>
                                    <span className="pagination-info">
                                        Page {currentPage} of {totalPages}
                                    </span>
                                    <button
                                        className="pagination-arrow"
                                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                        disabled={currentPage >= totalPages}
                                    >
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                                    </button>
                                </div>
                            )}

                            {mangaList.length === 0 && !loading && !error && (
                                <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                    <div style={{ fontSize: 48, marginBottom: 16 }}><svg width="48" height="48" viewBox="0 0 24 24" fill="var(--sakura-pink)" stroke="none" opacity="0.5"><path d="M12 2C9.5 5 7 8 7 11a5 5 0 0 0 10 0c0-3-2.5-6-5-9z" /></svg></div>
                                    {mode === "comic" ? (
                                        <p style={{ fontSize: 14 }}>No comics found.</p>
                                    ) : (
                                        <>
                                            <p style={{ fontFamily: "var(--font-jp)", fontSize: 18 }}>見つかりませんでした</p>
                                            <p style={{ fontSize: 14 }}>No manga found.</p>
                                        </>
                                    )}
                                </div>
                            )}
                        </>
                    ) : null}
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
