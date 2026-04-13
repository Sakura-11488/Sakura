"use client";

import Header from "@/components/Header";
import MangaCard from "@/components/MangaCard";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { getFeaturedManga, searchManga, searchMangaByGenre, MANGA_GENRES, type Manga } from "@/lib/content-source";
import { useRouter } from "next/navigation";
import { getLocal, setLocal, STORAGE_KEYS } from "@/lib/storage";
import LottieIcon from "@/components/LottieIcon";

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

  useEffect(() => {
    async function loadFeatured() {
      const data = await getFeaturedManga();
      setFeatured(data);
      setLoading(false);
    }
    loadFeatured();
  }, []);

  // Debounced search
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
        const results = await searchManga(searchQuery);
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
    const results = await searchMangaByGenre(tagId);
    setGenreResults(results);
    setGenreLoading(false);
  }, []);

  return (
    <>
      <Header />
      <main className="main-content">
        {/* Compact Hero Banner */}
        <section className="home-hero-compact">
          <div className="home-hero-inner">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/sakura.png" alt="Sakura" className="home-hero-logo" />
            <div className="home-hero-text">
              <h1>桜 <span>Sakura</span></h1>
              <p>読む。集める。所有する。— Read. Collect. Own.</p>
            </div>
          </div>
        </section>

        {/* Search Bar */}
        <section className="section" style={{ paddingTop: 8, paddingBottom: 0 }}>
          <div className="search-bar" style={{ marginBottom: 0 }}>
            <span className="search-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /></svg>
            </span>
            <input
              type="text"
              placeholder="マンガを検索... Search manga..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </section>

        {/* Search Results (conditionally shown) */}
        {showSearch && (
          <section className="section" style={{ paddingTop: 12 }}>
            <div className="section-header">
              <h2 className="section-title">検索結果</h2>
              <p className="section-subtitle">{searching ? "Searching..." : `${searchResults.length} Results`}</p>
            </div>
            {searching ? (
              <div className="manga-grid">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="loading-skeleton" style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }} />
                ))}
              </div>
            ) : searchResults.length > 0 ? (
              <div className="manga-grid">
                {searchResults.map((series) => (
                  <MangaCard
                    key={series.id}
                    slug={series.id}
                    title={series.title}
                    cover={series.cover}
                    genres={series.tags.slice(0, 3)}
                    follows={series.follows}
                    rating={series.rating}
                    source="mangadex"
                  />
                ))}
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                <p>No results found for &ldquo;{searchQuery}&rdquo;</p>
              </div>
            )}
          </section>
        )}

        {/* Genre Filter Chips */}
        {!showSearch && (
          <section className="section" style={{ paddingTop: 12, paddingBottom: 0 }}>
            <div className="genre-filters" style={{ maxWidth: 700, margin: '0 auto' }}>
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
              <div className="manga-grid">
                {genreResults.map((series) => (
                  <MangaCard
                    key={series.id}
                    slug={series.id}
                    title={series.title}
                    cover={series.cover}
                    genres={series.tags.slice(0, 3)}
                    follows={series.follows}
                    rating={series.rating}
                    source="mangadex"
                  />
                ))}
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                <p>No manga found for this genre.</p>
              </div>
            )}
          </section>
        )}

        {/* Recommended Manga — Main Focus (Hidden during search and genre filter) */}
        {!showSearch && !selectedGenre && (
          <section className="section" style={{ paddingTop: 12 }}>
            <div className="section-header">
              <h2 className="section-title">おすすめ</h2>
              <p className="section-subtitle">Recommended For You</p>
            </div>

            {loading ? (
              <div className="manga-grid">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="loading-skeleton"
                    style={{ aspectRatio: "2/3", borderRadius: "var(--radius-md)" }}
                  />
                ))}
              </div>
            ) : (
              <div className="manga-grid">
                {featured.map((series) => (
                  <MangaCard
                    key={series.id}
                    slug={series.id}
                    title={series.title}
                    cover={series.cover}
                    genres={series.tags.slice(0, 3)}
                    follows={series.follows}
                    rating={series.rating}
                    source="mangadex"
                  />
                ))}
              </div>
            )}

            <div style={{ textAlign: "center", marginTop: 32 }}>
              <Link href="/manga" className="btn-secondary">
                全てのマンガを見る — View All Manga →
              </Link>
            </div>
          </section>
        )}

        {/* Create on Sakura CTA */}
        {!showSearch && (
          <section style={{
            margin: "40px 16px 0",
            borderRadius: 20,
            overflow: "hidden",
            background: "linear-gradient(160deg, rgba(255,183,197,0.1) 0%, rgba(138,43,226,0.12) 50%, rgba(10,10,20,0.95) 100%)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}>
            <div style={{ height: 3, background: "linear-gradient(90deg, var(--sakura-pink), var(--purple-accent), var(--sakura-pink))" }} />
            <div style={{ padding: "28px 24px", textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                <LottieIcon src="/icons/wired-outline-674-painter-hover-pinch.json" size={48} colorFilter="brightness(0) saturate(100%) invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg) brightness(101%) contrast(98%)" replayIntervalMs={3000} autoplay />
              </div>
              <h2 style={{ fontSize: "1.4rem", margin: "0 0 8px", fontWeight: 800 }}>Create on Sakura</h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", lineHeight: 1.6, maxWidth: 420, margin: "0 auto 20px" }}>
                Artists and animators — publish your work on Sakura and earn a share of revenue. Join our growing creator community.
              </p>
              <a
                href={`mailto:sakuramanga162@gmail.com?subject=${encodeURIComponent("Creator Application — Sakura")}&body=${encodeURIComponent("Hi Sakura team,\n\nI'd like to apply as a creator on Sakura.\n\nName: \nPortfolio / Social Links: \nType (Artist / Animator / Writer): \nBrief Description of Work: \n\nThank you!")}`}
                className="btn-primary"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 28px",
                  borderRadius: 14,
                  fontWeight: 700,
                  textDecoration: "none",
                  background: "linear-gradient(90deg, var(--sakura-pink), var(--purple-accent))",
                  boxShadow: "0 4px 20px rgba(138,43,226,0.3)",
                }}
              >
                <LottieIcon src="/icons/wired-outline-145-envelope-mail-hover-pinch.json" size={20} colorFilter="brightness(0) invert(1)" replayIntervalMs={3000} autoplay />
                Apply Now
              </a>
              <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: 14 }}>
                sakuramanga162@gmail.com
              </p>
            </div>
          </section>
        )}

        {/* Footer */}
        <footer className="footer">
          <p className="footer-jp">桜 — マンガの新しい形</p>
          <p className="footer-text">
            © 2026 Sakura. Read manga on the blockchain.
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
            <Link href="/privacy" style={{ color: "var(--sakura-pink)", textDecoration: "none", fontSize: "0.85rem" }}>
              Privacy Policy
            </Link>
            <Link href="/terms" style={{ color: "var(--sakura-pink)", textDecoration: "none", fontSize: "0.85rem" }}>
              Terms of Service
            </Link>
          </div>
          <div className="footer-solana">
            <span className="sol-dot" />
            Built on Solana
          </div>
        </footer>
      </main>
    </>
  );
}
