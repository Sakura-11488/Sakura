"use client";

import Header from "@/components/Header";
import MangaCard from "@/components/MangaCard";
import { useState, useEffect } from "react";
import Link from "next/link";
import { getLocal, removeLocal, STORAGE_KEYS, getAnimeHistory, type AnimeHistoryEntry } from "@/lib/storage";

interface HistoryItem {
    mangaId: string;
    chapterId: string;
    title: string;
    cover: string;
    lastReadAt: number;
    chapterNum?: string;
}

export default function HistoryPage() {
    const [tab, setTab] = useState<'manga' | 'anime'>('manga');
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [animeHistory, setAnimeHistory] = useState<AnimeHistoryEntry[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const cached = getLocal<HistoryItem[]>(STORAGE_KEYS.HISTORY, []);
        setHistory(cached.sort((a, b) => b.lastReadAt - a.lastReadAt));
        setAnimeHistory(getAnimeHistory());
        setLoading(false);
    }, []);

    const clearHistory = () => {
        if (!confirm("Clear history?")) return;
        if (tab === 'manga') {
            removeLocal(STORAGE_KEYS.HISTORY);
            setHistory([]);
        } else {
            removeLocal(STORAGE_KEYS.ANIME_HISTORY);
            setAnimeHistory([]);
        }
    };

    const tabStyle = (active: boolean): React.CSSProperties => ({
        flex: 1,
        padding: '10px 0',
        border: 'none',
        borderBottom: active ? '2px solid var(--sakura-pink)' : '2px solid transparent',
        background: 'transparent',
        color: active ? 'var(--sakura-pink)' : 'var(--text-muted)',
        fontWeight: active ? 700 : 500,
        fontSize: 14,
        cursor: 'pointer',
        transition: 'all 0.2s ease'
    });

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40 }}>
                    <div className="section-header">
                        <h2 className="section-title">閲覧履歴 History</h2>
                        <p className="section-subtitle">{tab === 'manga' ? 'Recently Read Manga' : 'Recently Watched Anime'}</p>
                    </div>

                    <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid var(--border-color)' }}>
                        <button style={tabStyle(tab === 'manga')} onClick={() => setTab('manga')}>Manga</button>
                        <button style={tabStyle(tab === 'anime')} onClick={() => setTab('anime')}>Anime</button>
                    </div>

                    {loading ? (
                        <div className="loading-container">
                            <div className="spinner"></div>
                        </div>
                    ) : tab === 'manga' ? (
                        history.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon">📚</div>
                                <h3 className="empty-title">履歴がありません</h3>
                                <p className="empty-text">You haven&apos;t read any manga yet.</p>
                                <Link href="/manga" className="btn-primary" style={{ marginTop: 16 }}>
                                    マンガを探す — Start Reading
                                </Link>
                            </div>
                        ) : (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
                                    <button onClick={clearHistory} className="btn-secondary" style={{ fontSize: 12 }}>Clear History</button>
                                </div>
                                <div className="manga-grid">
                                    {history.map((item) => (
                                        <MangaCard
                                            key={item.mangaId}
                                            slug={item.mangaId}
                                            title={item.title}
                                            cover={item.cover}
                                            genres={[]}
                                            follows={0}
                                            rating={0}
                                            source="mangadex"
                                        />
                                    ))}
                                </div>
                            </>
                        )
                    ) : (
                        animeHistory.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon">🍿</div>
                                <h3 className="empty-title">視聴履歴がありません</h3>
                                <p className="empty-text">You haven&apos;t watched any anime yet.</p>
                                <Link href="/anime" className="btn-primary" style={{ marginTop: 16 }}>
                                    アニメを探す — Start Watching
                                </Link>
                            </div>
                        ) : (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
                                    <button onClick={clearHistory} className="btn-secondary" style={{ fontSize: 12 }}>Clear History</button>
                                </div>
                                <div className="chapters-list">
                                    {animeHistory.map((entry) => (
                                        <Link
                                            key={entry.animeId}
                                            href={`/anime/watch?id=${encodeURIComponent(entry.animeId)}&ep=${encodeURIComponent(entry.episodeId)}`}
                                            className="chapter-item"
                                            style={{ textDecoration: 'none' }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                                                <div style={{
                                                    width: 48, height: 64, borderRadius: 6, overflow: 'hidden',
                                                    background: 'rgba(255,255,255,0.05)', flexShrink: 0
                                                }}>
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={entry.image || '/sakura.png'}
                                                        alt=""
                                                        referrerPolicy="no-referrer"
                                                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                    />
                                                </div>
                                                <div style={{ minWidth: 0, flex: 1 }}>
                                                    <p style={{ margin: 0, color: '#fff', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {entry.animeTitle}
                                                    </p>
                                                    <p style={{ margin: '2px 0 0', color: 'var(--sakura-pink)', fontSize: 12 }}>
                                                        Ep {entry.episodeNumber} — {entry.episodeTitle}
                                                    </p>
                                                    <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: 11 }}>
                                                        {new Date(entry.timestamp).toLocaleDateString()}
                                                    </p>
                                                </div>
                                            </div>
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                            </svg>
                                        </Link>
                                    ))}
                                </div>
                            </>
                        )
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
