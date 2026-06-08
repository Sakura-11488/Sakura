"use client";

import MangaCard from "@/components/MangaCard";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import { useState, useEffect } from "react";
import Link from "next/link";
import { getFavorites, type FavoriteManga } from "@/lib/supabase";
import { useDownloads } from "@/lib/downloads";
import { useMemo } from "react";
import LottieIcon from "@/components/LottieIcon";

export default function FavoritesPage() {
    const { publicKey } = useWallet();
    const { setVisible } = useSakuraWalletModal();
    const [favorites, setFavorites] = useState<FavoriteManga[]>([]);
    const [loading, setLoading] = useState(true);

    const downloads = useDownloads();

    // Extract downloaded local mangas
    const localMangas = useMemo(() => {
        const mangaMap = new Map<string, FavoriteManga>();
        Object.values(downloads)
            .filter(dl => dl.state === 'completed')
            .forEach(dl => {
                if (!mangaMap.has(dl.mangaId)) {
                    mangaMap.set(dl.mangaId, {
                        manga_id: dl.mangaId,
                        title: dl.title.split(' - ')[0] || "Downloaded Manga",
                        cover_url: dl.cover || "/placeholder.png"
                    } as FavoriteManga);
                }
            });
        return Array.from(mangaMap.values());
    }, [downloads]);

    // Merge cloud and local
    const mergedLibrary = useMemo(() => {
        const idSet = new Set<string>();
        const merged: FavoriteManga[] = [];

        favorites.forEach(f => {
            if (!idSet.has(f.manga_id)) {
                idSet.add(f.manga_id);
                merged.push(f);
            }
        });

        localMangas.forEach(l => {
            if (!idSet.has(l.manga_id)) {
                idSet.add(l.manga_id);
                merged.push(l);
            }
        });

        return merged;
    }, [favorites, localMangas]);

    // 1. Load from Local Cache immediately
    useEffect(() => {
        const { getLocal } = require("@/lib/storage");
        const cached = getLocal('sakura_favorites', []);
        if (cached.length > 0) {
            setFavorites(cached);
            setLoading(false); // Show cached content immediately
        }
    }, []);

    // 2. Sync with Cloud (Supabase)
    useEffect(() => {
        async function fetchFavorites() {
            if (!publicKey) {
                // If no wallet, stick to local or empty
                if (favorites.length === 0) setLoading(false);
                return;
            }

            try {
                // Background fetch
                const data = await getFavorites(publicKey.toBase58());

                // Update State
                setFavorites(data);

                // Update Local Cache
                const { setLocal } = require("@/lib/storage");
                setLocal('sakura_favorites', data);

                setLoading(false);
            } catch (error) {
                console.error("Failed to sync favorites:", error);
                setLoading(false);
            }
        }

        fetchFavorites();
    }, [publicKey]);

    return (
        <>
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40 }}>
                    <div className="section-header">
                        <h2 className="section-title">お気に入り Favorites</h2>
                        <p className="section-subtitle">Your Collection</p>
                    </div>

                    {!publicKey ? (
                        <div className="empty-state">
                            <div className="empty-icon">
                                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                </svg>
                            </div>
                            <h3 className="empty-title">ログイン — Sign Up / Login</h3>
                            <p className="empty-text">Sign up or login to see your favorites.</p>
                            <button
                                className="btn-primary"
                                onClick={() => setVisible(true)}
                                style={{ marginTop: 16 }}
                            >
                                <LottieIcon src="/icons/wired-outline-421-wallet-purse-hover-pinch.json" size={18} colorFilter="brightness(0) invert(1) opacity(0.7)" replayIntervalMs={3000} autoplay />
                                Sign Up / Login
                            </button>
                        </div>
                    ) : loading ? (
                        <div className="loading-container">
                            <div className="spinner"></div>
                        </div>
                    ) : mergedLibrary.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">💔</div>
                            <h3 className="empty-title">まだありません</h3>
                            <p className="empty-text">You haven&apos;t added any manga to favorites yet.</p>
                            <Link href="/manga" className="btn-primary" style={{ marginTop: 16 }}>
                                マンガを探す — Browse Manga
                            </Link>
                        </div>
                    ) : (
                        <div className="manga-grid">
                            {mergedLibrary.map((fav) => (
                                <MangaCard
                                    key={fav.manga_id}
                                    slug={fav.manga_id}
                                    title={fav.title}
                                    cover={fav.cover_url}
                                    genres={[]} // Favorites from DB might not have genres, handled gracefully
                                    follows={0} // Placeholder
                                    rating={0}  // Placeholder
                                />
                            ))}
                        </div>
                    )}
                </section>

            </main>
        </>
    );
}
