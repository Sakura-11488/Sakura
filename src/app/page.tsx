"use client";

import MangaCard from "@/components/MangaCard";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { searchMangaByGenre, MANGA_GENRES } from "@/lib/content-source";
import { getPrimarySource, getDetailsSource, searchAllSources } from "@/lib/sources";
import { type Manga } from "@/lib/sources/types";
import { fetchAiringAnime, type AnimeResult } from "@/lib/anime";
import { fetchPopularNovels, type AllNovelItem } from "@/lib/allnovel";
import { getAnimeHistory, type AnimeHistoryEntry } from "@/lib/storage";
import { imageOrPlaceholder } from "@/lib/media-fallback";

import { useRouter } from "next/navigation";

async function enrichSpotlight(items: Manga[]): Promise<Manga[]> {
  const detailsSrc = getDetailsSource();
  const results = await Promise.allSettled(
    items.map(async (m) => {
      try {
        const matches = await detailsSrc.searchManga(m.title);
        if (matches[0]?.description) {
          return { ...m, description: matches[0].description, rating: matches[0].rating ?? m.rating, tags: matches[0].tags.length > 0 ? matches[0].tags : m.tags };
        }
      } catch {}
      return m;
    })
  );
  return results.map((r, i) => r.status === "fulfilled" ? r.value : items[i]);
}

function SpotlightCarousel({ items }: { items: Manga[] }) {
  const [current, setCurrent] = useState(0);
  const timerRef = useRef<any>(null);
  const spotlightItems = items.slice(0, 5);

  useEffect(() => {
    if (spotlightItems.length <= 1) return;
    timerRef.current = setInterval(() => {
      setCurrent(prev => (prev + 1) % spotlightItems.length);
    }, 5000);
    return () => clearInterval(timerRef.current);
  }, [spotlightItems.length]);

  if (spotlightItems.length === 0) return null;
  const manga = spotlightItems[current];

  const coverUrl = imageOrPlaceholder(manga.cover);
  return (
    <div className="spotlight-carousel">
      <div className="spotlight-bg" style={{ backgroundImage: `url(${coverUrl})` }} />
      <div className="spotlight-content">
        <div className="spotlight-cover">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coverUrl} alt={manga.title} referrerPolicy="no-referrer" />
        </div>
        <div className="spotlight-info">
          <h2 className="spotlight-title">{manga.title}</h2>
          {manga.description && (
            <p style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.7)", margin: "4px 0 8px", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {manga.description}
            </p>
          )}
          <div className="spotlight-tags">
            {manga.tags.slice(0, 3).map(t => (
              <span key={t} className="spotlight-tag">{t}</span>
            ))}
            {manga.rating != null && (
              <span className="spotlight-tag" style={{ background: "rgba(255,200,50,0.2)", color: "#ffc832" }}>
                ★ {manga.rating.toFixed(1)}
              </span>
            )}
          </div>
          <Link
            href={`/title?id=${manga.id}&source=${manga.sourceStr || "atsumaru"}`}
            className="spotlight-btn"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            Info
          </Link>
        </div>
      </div>
      <div className="spotlight-dots">
        {spotlightItems.map((_, i) => (
          <button
            key={i}
            className={`spotlight-dot ${i === current ? "active" : ""}`}
            onClick={() => { setCurrent(i); clearInterval(timerRef.current); }}
          />
        ))}
      </div>
    </div>
  );
}

function HorizontalScroll({ title, linkText, linkHref, children }: {
  title: string;
  linkText?: string;
  linkHref?: string;
  children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: dir * 320, behavior: "smooth" });
    }
  };

  return (
    <section className="hscroll-section">
      <div className="hscroll-header">
        <h2 className="hscroll-title">{title}</h2>
        <div className="hscroll-controls">
          {linkText && linkHref && (
            <Link href={linkHref} className="hscroll-link">{linkText}</Link>
          )}
          <button className="hscroll-arrow" onClick={() => scroll(-1)} aria-label="Scroll left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button className="hscroll-arrow" onClick={() => scroll(1)} aria-label="Scroll right">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
      <div className="hscroll-track" ref={scrollRef}>
        {children}
      </div>
    </section>
  );
}

export default function Home() {
  const router = useRouter();
  const [featured, setFeatured] = useState<Manga[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Manga[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const searchTimerRef = useRef<any>(null);
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
  const [genreResults, setGenreResults] = useState<Manga[]>([]);
  const [genreLoading, setGenreLoading] = useState(false);

  const [airingAnime, setAiringAnime] = useState<AnimeResult[]>([]);
  const [continueWatching, setContinueWatching] = useState<AnimeHistoryEntry[]>([]);
  const [novels, setNovels] = useState<AllNovelItem[]>([]);

  useEffect(() => {
    async function loadAll() {
      try {
        const [manga, anime, novelData] = await Promise.allSettled([
          getPrimarySource().getTrending(),
          fetchAiringAnime(),
          fetchPopularNovels(),
        ]);
        if (manga.status === "fulfilled") {
          const trending = manga.value;
          setFeatured(trending);
          enrichSpotlight(trending.slice(0, 5)).then(enriched => {
            setFeatured(prev => [...enriched, ...prev.slice(5)]);
          }).catch(() => {});
        }
        if (anime.status === "fulfilled") setAiringAnime(anime.value);
        if (novelData.status === "fulfilled") setNovels(novelData.value);
      } catch (e) {
        console.error("Failed to load home data:", e);
      }
      try {
        setContinueWatching(getAnimeHistory());
      } catch (_) {}
      setLoading(false);
    }
    loadAll();
  }, []);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setShowSearch(false);
      return;
    }
    setShowSearch(true);
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchAllSources(searchQuery);
        setSearchResults(results);
      } catch (e) {
        console.error(e);
      }
      setSearching(false);
    }, 600);
    return () => clearTimeout(searchTimerRef.current);
  }, [searchQuery]);

  const handleGenreSelect = useCallback(async (tagId: string | null) => {
    setSelectedGenre(tagId);
    if (!tagId) { setGenreResults([]); return; }
    setGenreLoading(true);
    try {
      const results = await searchMangaByGenre(tagId);
      setGenreResults(results);
    } catch (e) {
      console.error("Genre search failed", e);
      setGenreResults([]);
    }
    setGenreLoading(false);
  }, []);

  const renderMangaCards = (list: Manga[]) =>
    list.map((series) => (
      <MangaCard
        key={series.id}
        slug={series.id}
        title={series.title}
        cover={series.cover}
        genres={series.tags.slice(0, 3)}
        follows={series.follows}
        rating={series.rating}
        source={series.sourceStr || "atsumaru"}
      />
    ));

  const defaultBrowse = !showSearch && !selectedGenre && !loading;

  return (
    <main className="main-content home-page">
      {/* Spotlight Carousel */}
      {!showSearch && !loading && featured.length > 0 && (
        <SpotlightCarousel items={featured} />
      )}

      {/* Search Bar */}
      <div className="home-search-wrap">
        <div className="search-bar">
          <span className="search-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/></svg>
          </span>
          <input
            type="text"
            placeholder="Search manga..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery("")} aria-label="Clear search">✕</button>
          )}
        </div>
      </div>

      {/* Genre Filter Chips */}
      {!showSearch && (
        <div className="genre-filters" style={{ maxWidth: 700, margin: "0 auto 8px", padding: "0 16px" }}>
          <button className={`genre-chip ${selectedGenre === null ? "active" : ""}`} onClick={() => handleGenreSelect(null)}>All</button>
          {MANGA_GENRES.map(g => (
            <button key={g.id} className={`genre-chip ${selectedGenre === g.id ? "active" : ""}`} onClick={() => handleGenreSelect(g.id)}>{g.name}</button>
          ))}
        </div>
      )}

      {/* Search Results */}
      {showSearch && (
        <section className="section" style={{ paddingTop: 12 }}>
          <div className="section-header">
            <h2 className="section-title">Search Results</h2>
            <p className="section-subtitle">{searching ? "Searching..." : `${searchResults.length} results`}</p>
          </div>
          {searching ? (
            <div className="manga-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
              ))}
            </div>
          ) : searchResults.length > 0 ? (
            <div className="manga-grid">{renderMangaCards(searchResults)}</div>
          ) : (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
              <p>No results found for &ldquo;{searchQuery}&rdquo;</p>
            </div>
          )}
        </section>
      )}

      {/* Genre Results */}
      {!showSearch && selectedGenre && (
        <section className="section" style={{ paddingTop: 12 }}>
          <div className="section-header">
            <h2 className="section-title">{MANGA_GENRES.find(g => g.id === selectedGenre)?.name}</h2>
            <p className="section-subtitle">Browse by genre</p>
          </div>
          {genreLoading ? (
            <div className="manga-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
              ))}
            </div>
          ) : genreResults.length > 0 ? (
            <div className="manga-grid">{renderMangaCards(genreResults)}</div>
          ) : (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
              <p>No manga found for this genre.</p>
            </div>
          )}
        </section>
      )}

      {/* Trending Manga — horizontal scroll */}
      {defaultBrowse && featured.length > 0 && (
        <HorizontalScroll title="Trending Manga" linkText="View more ›" linkHref="/manga">
          {renderMangaCards(featured)}
        </HorizontalScroll>
      )}

      {/* Continue Watching — anime history */}
      {defaultBrowse && continueWatching.length > 0 && (
        <HorizontalScroll title="Continue Watching" linkText="See all ›" linkHref="/anime">
          {continueWatching.map(entry => (
            <Link
              key={entry.animeId}
              href={`/anime/watch?id=${encodeURIComponent(entry.animeId)}&ep=${encodeURIComponent(entry.episodeId)}`}
              className="continue-card"
            >
              <div className="continue-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={entry.image || "/placeholder.png"} alt={entry.animeTitle} referrerPolicy="no-referrer" />
                <span className="continue-ep-badge">EP {entry.episodeNumber}</span>
              </div>
              <div className="continue-info">
                <p className="continue-title">{entry.animeTitle}</p>
              </div>
            </Link>
          ))}
        </HorizontalScroll>
      )}

      {/* Popular Anime — horizontal scroll */}
      {defaultBrowse && airingAnime.length > 0 && (
        <HorizontalScroll title="Popular Anime" linkText="View more ›" linkHref="/anime">
          {airingAnime.slice(0, 20).map(anime => (
            <Link
              key={anime.id}
              href={`/anime/details?id=${encodeURIComponent(anime.id)}`}
              className="continue-card"
            >
              <div className="continue-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={anime.image || "/placeholder.png"} alt={anime.title} referrerPolicy="no-referrer" />
                {anime.score != null && (
                  <span className="continue-ep-badge" style={{ background: "rgba(0,0,0,0.7)" }}>★ {anime.score}</span>
                )}
              </div>
              <div className="continue-info">
                <p className="continue-title">{anime.title}</p>
              </div>
            </Link>
          ))}
        </HorizontalScroll>
      )}

      {/* Novels — horizontal scroll */}
      {defaultBrowse && novels.length > 0 && (
        <HorizontalScroll title="Novels" linkText="View more ›" linkHref="/novel">
          {novels.slice(0, 20).map(novel => (
            <Link
              key={novel.path}
              href={`/novel/details?path=${encodeURIComponent(novel.path)}`}
              className="novel-sm-card"
            >
              <div className="novel-sm-cover">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={novel.cover || novel.originalCover || "/placeholder.png"} alt={novel.name} referrerPolicy="no-referrer" />
              </div>
              <p className="novel-sm-title">{novel.name}</p>
            </Link>
          ))}
        </HorizontalScroll>
      )}

      {/* Loading State */}
      {loading && (
        <div className="manga-grid" style={{ padding: "24px 16px" }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
          ))}
        </div>
      )}
    </main>
  );
}
