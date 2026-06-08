"use client";

import MangaCard from "@/components/MangaCard";
import { useState, useEffect, useCallback } from "react";
import { searchAllComics } from "@/lib/sources";
import { type Manga } from "@/lib/sources/types";
import { MANGA_SOURCE_IDS } from "@/lib/sources/source-ids";

function useDebounce(value: string, delay: number) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(handler);
    }, [value, delay]);
    return debouncedValue;
}

const COMIC_SOURCE = MANGA_SOURCE_IDS.XOXOCOMIC;

export default function ComicsBrowsePage() {
    const [mangaList, setMangaList] = useState<Manga[]>([]);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const debouncedSearch = useDebounce(search, 450);

    const fetchComics = useCallback(async (query: string) => {
        setLoading(true);
        setError(null);
        try {
            const results = await searchAllComics(query);
            setMangaList(results);
        } catch (e: unknown) {
            console.error("Comics browse failed", e);
            const msg = e instanceof Error ? e.message : "Could not load comics";
            setError(msg);
            setMangaList([]);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchComics(debouncedSearch);
    }, [debouncedSearch, fetchComics]);

    const renderCards = (list: Manga[]) =>
        list.map((manga) => (
            <MangaCard
                key={`${manga.sourceStr}:${manga.id}`}
                slug={manga.id}
                title={manga.title}
                cover={manga.cover}
                genres={manga.tags.slice(0, 3)}
                follows={manga.follows}
                rating={manga.rating}
                source={manga.sourceStr || COMIC_SOURCE}
            />
        ));

    return (
        <main className="main-content">
            <section className="section" style={{ paddingTop: 40 }}>
                <div className="section-header">
                    <h2 className="section-title">Comics</h2>
                    {loading ? (
                        <p className="section-subtitle">Loading…</p>
                    ) : null}
                </div>

                <div className="search-bar-wrapper">
                    <div className="search-bar">
                        <span className="search-icon">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="11" cy="11" r="8" />
                                <line x1="21" x2="16.65" y1="21" y2="16.65" />
                            </svg>
                        </span>
                        <input
                            type="text"
                            placeholder="Search comics…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        {search ? (
                            <button
                                type="button"
                                className="search-clear"
                                onClick={() => setSearch("")}
                                aria-label="Clear search"
                            >
                                ✕
                            </button>
                        ) : null}
                    </div>
                </div>
            </section>

            {error ? (
                <section className="section" style={{ paddingTop: 0 }}>
                    <div className="error-container" style={{ margin: "24px auto", maxWidth: 560 }}>
                        <p className="error-message">{error}</p>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>
                            Check your connection. Comics are loaded through the Sakura catalog service.
                        </p>
                    </div>
                </section>
            ) : null}

            {!error && loading ? (
                <section className="section" style={{ paddingTop: 0 }}>
                    <div className="manga-grid">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div
                                key={i}
                                className="loading-skeleton"
                                style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }}
                            />
                        ))}
                    </div>
                </section>
            ) : !error ? (
                <section className="section" style={{ paddingTop: 0 }}>
                    {mangaList.length > 0 ? (
                        <div className="manga-grid">{renderCards(mangaList)}</div>
                    ) : (
                        <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                            <p style={{ fontSize: 14 }}>No comics found.</p>
                        </div>
                    )}
                </section>
            ) : null}
        </main>
    );
}
