"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import MangaCard from "@/components/MangaCard";
import Link from "next/link";
import { searchAllSources, getPrimarySource, getDetailsSource } from "@/lib/sources";
import { type Manga } from "@/lib/sources/types";
import { getLocal, setLocalAndSyncSearches, STORAGE_KEYS } from "@/lib/storage";

function useDebounce(value: string, delay: number) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(handler);
    }, [value, delay]);
    return debouncedValue;
}

const MANGA_GENRES = [
    "Action", "Adventure", "Comedy", "Drama", "Fantasy",
    "Horror", "Mystery", "Romance", "Sci-Fi", "Slice of Life",
    "Sports", "Supernatural", "Thriller", "Isekai", "Martial Arts",
    "School", "Mecha", "Historical", "Psychological",
];
const MAX_RECENT_SEARCHES = 8;

function MangaSpotlightCarousel({ items }: { items: Manga[] }) {
    const [current, setCurrent] = useState(0);
    const timerRef = useRef<any>(null);
    const slides = items.slice(0, 5);

    useEffect(() => {
        if (slides.length <= 1) return;
        timerRef.current = setInterval(() => setCurrent(p => (p + 1) % slides.length), 5000);
        return () => clearInterval(timerRef.current);
    }, [slides.length]);

    if (slides.length === 0) return null;
    const m = slides[current];

    return (
        <div className="spotlight-carousel">
            <div className="spotlight-bg" style={{ backgroundImage: `url(${m.cover})` }} />
            <div className="spotlight-content">
                <div className="spotlight-cover">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.cover} alt={m.title} referrerPolicy="no-referrer" />
                </div>
                <div className="spotlight-info">
                    <h2 className="spotlight-title">{m.title}</h2>
                    {m.description && (
                        <p style={{ fontSize: "0.78rem", color: "rgba(255,255,255,0.7)", margin: "4px 0 8px", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {m.description}
                        </p>
                    )}
                    <div className="spotlight-tags">
                        {m.tags.slice(0, 4).map(t => (
                            <span key={t} className="spotlight-tag">{t}</span>
                        ))}
                        {m.rating != null && (
                            <span className="spotlight-tag" style={{ background: "rgba(255,200,50,0.2)", color: "#ffc832" }}>★ {m.rating.toFixed(1)}</span>
                        )}
                    </div>
                    <Link href={`/title?id=${m.id}&source=${m.sourceStr || "atsumaru"}`} className="spotlight-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                        Info
                    </Link>
                </div>
            </div>
            {slides.length > 1 && (
                <>
                    <button className="spotlight-arrow spotlight-arrow-left" onClick={() => { setCurrent(p => (p - 1 + slides.length) % slides.length); clearInterval(timerRef.current); }} aria-label="Previous">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <button className="spotlight-arrow spotlight-arrow-right" onClick={() => { setCurrent(p => (p + 1) % slides.length); clearInterval(timerRef.current); }} aria-label="Next">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                    <div className="spotlight-dots">
                        {slides.map((_, i) => (
                            <button key={i} className={`spotlight-dot ${i === current ? "active" : ""}`} onClick={() => { setCurrent(i); clearInterval(timerRef.current); }} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

function HorizontalScroll({ title, linkText, linkHref, children }: {
    title: string; linkText?: string; linkHref?: string; children: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 320, behavior: "smooth" });
    return (
        <section className="hscroll-section">
            <div className="hscroll-header">
                <h2 className="hscroll-title">{title}</h2>
                <div className="hscroll-controls">
                    {linkText && linkHref && <Link href={linkHref} className="hscroll-link">{linkText}</Link>}
                    <button className="hscroll-arrow" onClick={() => scroll(-1)} aria-label="Scroll left">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <button className="hscroll-arrow" onClick={() => scroll(1)} aria-label="Scroll right">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                </div>
            </div>
            <div className="hscroll-track" ref={ref}>{children}</div>
        </section>
    );
}

export default function BrowsePage() {
    const [mangaList, setMangaList] = useState<Manga[]>([]);
    const [trending, setTrending] = useState<Manga[]>([]);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const debouncedSearch = useDebounce(search, 500);
    const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
    const [genreResults, setGenreResults] = useState<Manga[]>([]);
    const [genreLoading, setGenreLoading] = useState(false);

    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [showRecent, setShowRecent] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setRecentSearches(getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES, []));
    }, []);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowRecent(false);
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

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

    useEffect(() => {
        async function loadTrending() {
            try {
                const data = await getPrimarySource().getTrending();
                setTrending(data);
                // Enrich top 5 for spotlight with description/rating
                const detailsSrc = getDetailsSource();
                Promise.allSettled(
                    data.slice(0, 5).map(async (m) => {
                        try {
                            const matches = await detailsSrc.searchManga(m.title);
                            if (matches[0]?.description) {
                                return { ...m, description: matches[0].description, rating: matches[0].rating ?? m.rating, tags: matches[0].tags.length > 0 ? matches[0].tags : m.tags };
                            }
                        } catch {}
                        return m;
                    })
                ).then(results => {
                    const enriched = results.map((r, i) => r.status === "fulfilled" ? r.value : data[i]);
                    setTrending(prev => [...enriched, ...prev.slice(5)]);
                }).catch(() => {});
            } catch (_) {}
        }
        loadTrending();
    }, []);

    const fetchManga = useCallback(async (query: string) => {
        setLoading(true);
        setError(null);
        try {
            const results = await searchAllSources(query);
            setMangaList(results);
            if (query.trim().length >= 2) saveRecentSearch(query);
        } catch (e: any) {
            console.error("Search failed", e);
            setError(e.message || "Search failed");
        }
        setLoading(false);
    }, [saveRecentSearch]);

    useEffect(() => {
        fetchManga(debouncedSearch);
    }, [debouncedSearch, fetchManga]);

    const handleRecentClick = (query: string) => { setSearch(query); setShowRecent(false); };

    const handleGenreSelect = useCallback(async (tagId: string | null) => {
        setSelectedGenre(tagId);
        if (!tagId) { setGenreResults([]); return; }
        setGenreLoading(true);
        try {
            const results = await getPrimarySource().searchManga(tagId);
            setGenreResults(results);
        } catch (e) {
            console.error("Genre search failed", e);
            setGenreResults([]);
        }
        setGenreLoading(false);
    }, []);

    const isDefaultBrowse = !search.trim() && !selectedGenre && !loading;

    const renderCards = (list: Manga[]) => list.map((manga) => (
        <MangaCard key={manga.id} slug={manga.id} title={manga.title} cover={manga.cover}
            genres={manga.tags.slice(0, 3)} follows={manga.follows} rating={manga.rating} source={manga.sourceStr} />
    ));

    return (
        <main className="main-content">
            {/* Spotlight Carousel — only on default browse */}
            {isDefaultBrowse && trending.length > 0 && (
                <MangaSpotlightCarousel items={trending} />
            )}

            <section className="section" style={{ paddingTop: isDefaultBrowse && trending.length > 0 ? 16 : 40 }}>
                <div className="section-header">
                    <h2 className="section-title">マンガ一覧</h2>
                    <p className="section-subtitle">Browse Series — {loading ? "Loading..." : `${mangaList.length} Results`}</p>
                </div>

                {/* Search with Recent Searches */}
                <div className="search-bar-wrapper" ref={searchRef}>
                    <div className="search-bar">
                        <span className="search-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg></span>
                        <input type="text" placeholder="Search manga..." value={search}
                            onChange={(e) => setSearch(e.target.value)} onFocus={() => setShowRecent(true)} />
                        {search && (
                            <button className="search-clear" onClick={() => { setSearch(""); setShowRecent(true); }} aria-label="Clear search">✕</button>
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
                                    <button className="recent-search-text" onClick={() => handleRecentClick(q)}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg>
                                        {q}
                                    </button>
                                    <button className="recent-search-remove" onClick={(e) => { e.stopPropagation(); removeRecentSearch(q); }} aria-label={`Remove ${q}`}>✕</button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Genre Filter Chips */}
                <div className="genre-filters" style={{ maxWidth: 700, margin: "0 auto 24px" }}>
                    <button className={`genre-chip ${selectedGenre === null ? "active" : ""}`} onClick={() => handleGenreSelect(null)}>All</button>
                    {MANGA_GENRES.map(g => (
                        <button key={g} className={`genre-chip ${selectedGenre === g ? "active" : ""}`} onClick={() => handleGenreSelect(g)}>{g}</button>
                    ))}
                </div>
            </section>

            {/* Recommended — horizontal scroll (default browse only) */}
            {isDefaultBrowse && trending.length > 0 && (
                <HorizontalScroll title="Recommended">
                    {renderCards(trending.slice(0, 20))}
                </HorizontalScroll>
            )}

            {/* Genre Results */}
            {selectedGenre && (
                <section className="section" style={{ paddingTop: 0 }}>
                    {genreLoading ? (
                        <div className="manga-grid">
                            {Array.from({ length: 6 }).map((_, i) => (
                                <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                            ))}
                        </div>
                    ) : genreResults.length > 0 ? (
                        <div className="manga-grid">{renderCards(genreResults)}</div>
                    ) : (
                        <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                            <p style={{ fontSize: 14 }}>No manga found for this genre.</p>
                        </div>
                    )}
                </section>
            )}

            {/* Error */}
            {error && !selectedGenre && (
                <div className="error-container" style={{ margin: "40px auto", maxWidth: 600 }}>
                    <p className="error-message">{error}</p>
                </div>
            )}

            {/* All results grid (when searching or default, no pagination) */}
            {!selectedGenre && loading ? (
                <section className="section" style={{ paddingTop: 0 }}>
                    <div className="manga-grid">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                        ))}
                    </div>
                </section>
            ) : !selectedGenre && !error ? (
                <section className="section" style={{ paddingTop: 0 }}>
                    {mangaList.length > 0 ? (
                        <div className="manga-grid">{renderCards(mangaList)}</div>
                    ) : !loading && (
                        <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                            <p style={{ fontSize: 14 }}>No manga found.</p>
                        </div>
                    )}
                </section>
            ) : null}
        </main>
    );
}
