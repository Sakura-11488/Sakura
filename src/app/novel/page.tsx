"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import Link from "next/link";
import { getNovels, NOVEL_GENRES, type Novel } from "@/lib/novel";
import {
    fetchPopularNovels, searchNovels as searchExternal,
    enhanceCovers, ALLNOVEL_GENRES,
    type AllNovelItem,
} from "@/lib/allnovel";
import { getLocal, setLocalAndSyncSearches, STORAGE_KEYS } from "@/lib/storage";
import dynamic from "next/dynamic";

const Lottie = dynamic(() => import("lottie-react"), { ssr: false });

function useDebounce(value: string, delay: number) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(handler);
    }, [value, delay]);
    return debouncedValue;
}

const MAX_RECENT_SEARCHES = 8;

function BookIcon({ size = 48 }: { size?: number }) {
    const [animData, setAnimData] = useState<object | null>(null);
    useEffect(() => {
        fetch("/icons/wired-outline-779-books-hover-hit.json").then(r => r.json()).then(setAnimData).catch(() => {});
    }, []);
    if (!animData) return null;
    return <Lottie animationData={animData} loop autoplay style={{ width: size, height: size, opacity: 0.4 }} />;
}

interface UnifiedNovel {
    id: string;
    title: string;
    cover?: string;
    originalCover?: string;
    status?: string;
    genres: string[];
    href: string;
}

function toUnified(novel: Novel): UnifiedNovel {
    return { id: novel.id, title: novel.title, cover: novel.cover_url, status: novel.status, genres: novel.genres, href: `/novel/details?id=${novel.id}` };
}

function externalToUnified(item: AllNovelItem): UnifiedNovel {
    return { id: `ext_${item.path}`, title: item.name, cover: item.cover, originalCover: item.originalCover || item.cover, genres: [], href: `/novel/details?source=external&path=${encodeURIComponent(item.path)}` };
}

function NovelCard({ novel }: { novel: UnifiedNovel }) {
    const [imgSrc, setImgSrc] = useState(novel.cover || "");
    const [errored, setErrored] = useState(false);

    useEffect(() => { setImgSrc(novel.cover || ""); setErrored(false); }, [novel.cover]);

    const handleError = () => {
        if (!errored && novel.originalCover && novel.originalCover !== imgSrc) {
            setImgSrc(novel.originalCover);
            setErrored(true);
        }
    };

    const hasCover = !!imgSrc;

    return (
        <Link href={novel.href} style={{ textDecoration: "none" }}>
            <div className="glass-card" style={{ borderRadius: "var(--radius-md)", overflow: "hidden", transition: "transform 0.3s ease, box-shadow 0.3s ease" }}>
                <div style={{ position: "relative", aspectRatio: "2/3", background: "linear-gradient(135deg, #1a0a2e, #0a0812)" }}>
                    {hasCover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={imgSrc}
                            alt={novel.title}
                            loading="lazy"
                            onError={handleError}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                    ) : (
                        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <BookIcon size={32} />
                        </div>
                    )}
                    {novel.status && (
                        <div style={{ position: "absolute", top: 6, right: 6, background: novel.status === "completed" ? "rgba(74,222,128,0.9)" : novel.status === "hiatus" ? "rgba(251,191,36,0.9)" : "var(--sakura-pink)", color: "#fff", fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, textTransform: "capitalize" }}>
                            {novel.status}
                        </div>
                    )}
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "linear-gradient(transparent, rgba(0,0,0,0.85))", padding: "32px 10px 10px" }}>
                        <p style={{ margin: 0, color: "#fff", fontSize: 13, fontWeight: 700, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                            {novel.title}
                        </p>
                        {novel.genres.length > 0 && (
                            <p style={{ margin: "4px 0 0", color: "rgba(255,255,255,0.5)", fontSize: 10 }}>
                                {novel.genres.slice(0, 2).join(" · ")}
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </Link>
    );
}

const COMBINED_GENRES = [
    ...NOVEL_GENRES.map(g => ({ label: g, value: g, source: "sakura" as const })),
    ...ALLNOVEL_GENRES.map(g => ({ ...g, source: "external" as const })),
];
const uniqueGenres = Array.from(new Map(COMBINED_GENRES.map(g => [g.label, g])).values());

export default function NovelBrowsePage() {
    const [sakuraNovels, setSakuraNovels] = useState<Novel[]>([]);
    const [externalNovels, setExternalNovels] = useState<AllNovelItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [searchResults, setSearchResults] = useState<UnifiedNovel[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
    const [genreResults, setGenreResults] = useState<UnifiedNovel[]>([]);
    const [genreLoading, setGenreLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [loadingMore, setLoadingMore] = useState(false);
    const debouncedSearch = useDebounce(search, 600);

    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [showRecent, setShowRecent] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        Promise.all([
            getNovels({ limit: 50 }),
            fetchPopularNovels(1).catch(() => [] as AllNovelItem[]),
        ]).then(async ([sakura, external]) => {
            setSakuraNovels(sakura);
            setExternalNovels(external);
            setLoading(false);
            const enhanced = await enhanceCovers(external);
            setExternalNovels(enhanced);
        });
    }, []);

    useEffect(() => {
        setRecentSearches(getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES + "_NOVEL", []));
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
        const existing = getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES + "_NOVEL", []);
        const filtered = existing.filter(s => s.toLowerCase() !== trimmed.toLowerCase());
        const updated = [trimmed, ...filtered].slice(0, MAX_RECENT_SEARCHES);
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES + "_NOVEL", updated);
        setRecentSearches(updated);
    }, []);

    const removeRecentSearch = useCallback((query: string) => {
        const existing = getLocal<string[]>(STORAGE_KEYS.RECENT_SEARCHES + "_NOVEL", []);
        const updated = existing.filter(s => s !== query);
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES + "_NOVEL", updated);
        setRecentSearches(updated);
    }, []);

    const clearRecentSearches = useCallback(() => {
        setLocalAndSyncSearches(STORAGE_KEYS.RECENT_SEARCHES + "_NOVEL", []);
        setRecentSearches([]);
    }, []);

    useEffect(() => {
        if (!debouncedSearch.trim()) { setSearchResults([]); return; }
        setSearchLoading(true);
        Promise.all([
            getNovels({ search: debouncedSearch }),
            searchExternal(debouncedSearch, 1).catch(() => [] as AllNovelItem[]),
        ]).then(async ([sakura, external]) => {
            const unified = [
                ...sakura.map(toUnified),
                ...external.map(externalToUnified),
            ];
            setSearchResults(unified);
            setSearchLoading(false);
            if (debouncedSearch.trim().length >= 2) saveRecentSearch(debouncedSearch);
            const enhanced = await enhanceCovers(external);
            setSearchResults([...sakura.map(toUnified), ...enhanced.map(externalToUnified)]);
        });
    }, [debouncedSearch, saveRecentSearch]);

    const handleGenreSelect = useCallback(async (genre: string | null) => {
        setSelectedGenre(genre);
        if (!genre) { setGenreResults([]); return; }
        setGenreLoading(true);
        const genreMeta = uniqueGenres.find(g => g.label === genre);
        const [sakura, external] = await Promise.all([
            getNovels({ genre }),
            genreMeta?.source === "external"
                ? fetchPopularNovels(1, { genre: genreMeta.value }).catch(() => [] as AllNovelItem[])
                : Promise.resolve([] as AllNovelItem[]),
        ]);
        setGenreResults([...sakura.map(toUnified), ...external.map(externalToUnified)]);
        setGenreLoading(false);
        if (external.length > 0) {
            const enhanced = await enhanceCovers(external);
            setGenreResults([...sakura.map(toUnified), ...enhanced.map(externalToUnified)]);
        }
    }, []);

    const handleRecentClick = (query: string) => { setSearch(query); setShowRecent(false); };

    const loadMore = async () => {
        const next = page + 1;
        setLoadingMore(true);
        try {
            const more = await fetchPopularNovels(next);
            setExternalNovels(prev => [...prev, ...more]);
            setPage(next);
            enhanceCovers(more).then(enhanced => {
                setExternalNovels(prev => {
                    const base = prev.slice(0, prev.length - more.length);
                    return [...base, ...enhanced];
                });
            });
        } catch { /* */ }
        setLoadingMore(false);
    };

    const isSearching = search.trim().length > 0;
    const allNovels: UnifiedNovel[] = [
        ...sakuraNovels.map(toUnified),
        ...externalNovels.map(externalToUnified),
    ];
    const featured = sakuraNovels.slice(0, 3);

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40 }}>
                    <div className="section-header">
                        <h2 className="section-title">小説</h2>
                        <p className="section-subtitle">Browse & Discover Novels</p>
                    </div>

                    {!isSearching && selectedGenre === null && featured.length > 0 && (
                        <div style={{ marginBottom: 24 }}>
                            <Link href={`/novel/details?id=${featured[0].id}`} style={{ textDecoration: "none" }}>
                                <div style={{ position: "relative", borderRadius: 20, overflow: "hidden", height: 200, background: "#0a0a1a", border: "1px solid rgba(233,30,123,0.2)", boxShadow: "0 0 40px rgba(233,30,123,0.15), 0 8px 32px rgba(0,0,0,0.4)" }}>
                                    {featured[0].cover_url && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={featured[0].cover_url} alt={featured[0].title} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.45, filter: "saturate(1.2)" }} />
                                    )}
                                    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(160deg, rgba(147,51,234,0.5) 0%, rgba(233,30,123,0.3) 30%, rgba(10,10,26,0.92) 70%)", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "24px" }}>
                                        <span style={{ display: "inline-block", width: "fit-content", background: "linear-gradient(135deg, #E91E7B, #9333ea)", color: "#fff", fontSize: 9, fontWeight: 800, padding: "4px 12px", borderRadius: 20, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>
                                            Featured Novel
                                        </span>
                                        <h3 style={{ margin: 0, color: "#fff", fontSize: 22, fontWeight: 900, lineHeight: 1.15, textShadow: "0 2px 20px rgba(233,30,123,0.4)" }}>
                                            {featured[0].title}
                                        </h3>
                                        <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
                                            {featured[0].genres.slice(0, 3).join(" · ")}
                                        </p>
                                    </div>
                                </div>
                            </Link>
                        </div>
                    )}

                    <div className="search-bar-wrapper" ref={searchRef}>
                        <div className="search-bar" style={{ borderColor: "rgba(255, 107, 157, 0.4)" }}>
                            <span className="search-icon">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg>
                            </span>
                            <input type="text" placeholder="Search novels..." value={search} onChange={(e) => setSearch(e.target.value)} onFocus={() => setShowRecent(true)} />
                            {search && (<button className="search-clear" onClick={() => { setSearch(""); setShowRecent(true); }} aria-label="Clear">✕</button>)}
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

                    {!isSearching && (
                        <div className="genre-filters" style={{ maxWidth: 700, margin: "0 auto 24px" }}>
                            <button className={`genre-chip ${selectedGenre === null ? "active" : ""}`} onClick={() => handleGenreSelect(null)}>All</button>
                            {uniqueGenres.map(g => (
                                <button key={g.label} className={`genre-chip ${selectedGenre === g.label ? "active" : ""}`} onClick={() => handleGenreSelect(g.label)}>{g.label}</button>
                            ))}
                        </div>
                    )}

                    {isSearching && (
                        searchLoading ? (
                            <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                {Array.from({ length: 6 }).map((_, i) => (<div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />))}
                            </div>
                        ) : searchResults.length > 0 ? (
                            <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                {searchResults.map((novel) => <NovelCard key={novel.id} novel={novel} />)}
                            </div>
                        ) : (
                            <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                <p style={{ fontSize: 14 }}>No results found.</p>
                            </div>
                        )
                    )}

                    {!isSearching && selectedGenre !== null && (
                        <>
                            <div className="section-header" style={{ marginTop: 8 }}>
                                <h2 className="section-title" style={{ fontSize: 20 }}>{selectedGenre}</h2>
                            </div>
                            {genreLoading ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {Array.from({ length: 6 }).map((_, i) => (<div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />))}
                                </div>
                            ) : genreResults.length > 0 ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {genreResults.map((novel) => <NovelCard key={novel.id} novel={novel} />)}
                                </div>
                            ) : (
                                <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                    <p style={{ fontSize: 14 }}>No novels found for this genre.</p>
                                </div>
                            )}
                        </>
                    )}

                    {!isSearching && selectedGenre === null && (
                        <>
                            <div className="section-header" style={{ marginTop: 8 }}>
                                <h2 className="section-title" style={{ fontSize: 20 }}>Novels</h2>
                            </div>
                            {loading ? (
                                <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                    {Array.from({ length: 8 }).map((_, i) => (<div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />))}
                                </div>
                            ) : allNovels.length > 0 ? (
                                <>
                                    <div className="manga-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                                        {allNovels.map((novel) => <NovelCard key={novel.id} novel={novel} />)}
                                    </div>
                                    <div style={{ textAlign: "center", marginTop: 24 }}>
                                        <button
                                            onClick={loadMore}
                                            disabled={loadingMore}
                                            style={{
                                                padding: "12px 32px", borderRadius: 14, border: "1px solid rgba(255,107,157,0.3)",
                                                background: "rgba(255,107,157,0.1)", color: "var(--sakura-pink)",
                                                fontWeight: 700, fontSize: 14, cursor: loadingMore ? "wait" : "pointer",
                                            }}
                                        >
                                            {loadingMore ? "Loading..." : "Load More"}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                    <BookIcon size={64} />
                                    <p style={{ fontSize: 14, marginTop: 8, color: "var(--text-secondary)" }}>No novels yet. Be the first to publish!</p>
                                    <Link href="/novel/publish" style={{ display: "inline-block", marginTop: 16, background: "var(--sakura-pink)", color: "#fff", padding: "10px 24px", borderRadius: 12, fontSize: 14, fontWeight: 600, textDecoration: "none" }}>
                                        Start Writing
                                    </Link>
                                </div>
                            )}
                        </>
                    )}

                    <div style={{ textAlign: "center", marginTop: 40, paddingBottom: 24 }}>
                        <Link href="/novel/publish" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))", color: "#fff", padding: "12px 28px", borderRadius: 16, fontSize: 14, fontWeight: 700, textDecoration: "none", boxShadow: "0 4px 20px rgba(255,107,157,0.3)" }}>
                            Publish Your Novel
                        </Link>
                    </div>
                </section>

                <footer className="footer">
                    <p className="footer-jp">桜 — 物語の新しい形</p>
                    <p className="footer-text">© 2026 Sakura. Read novels on the blockchain.</p>
                    <div className="footer-solana"><span className="sol-dot" />Built on Solana</div>
                </footer>
            </main>
        </>
    );
}
