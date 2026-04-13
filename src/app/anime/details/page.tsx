"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Header from "@/components/Header";
import { fetchAnimeInfo, getCachedAnimeInfo, refreshAnimeInfo, fetchEpisodeSources, type AnimeInfo } from "@/lib/anime";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { getLocal, setLocal, STORAGE_KEYS, getAnimeHistory, isInLibrary, type LibraryItem } from "@/lib/storage";
import type { DownloadProgressEvent } from "@/plugins/anime";
import { PSYOP_ID, PSYOP_INFO, PSYOP_STUDIO, PSYOP_CHARACTERS } from "@/lib/psyopAnime";
import dynamic from "next/dynamic";
import LottieIcon from "@/components/LottieIcon";
const SaveToLibraryModal = dynamic(() => import("@/components/SaveToLibraryModal"), { ssr: false });

interface AnimeDownloadEntry {
    episodeId: string;
    animeId: string;
    animeTitle: string;
    episodeTitle: string;
    episodeNumber: number;
    state: string;
    progress: number;
    filePath?: string;
    timestamp: number;
}

function PsyopAnimeShowcase() {
    const router = useRouter();
    return (
        <>
            <Header />
            <main className="main-content">
                <div className="series-hero" style={{ position: 'relative' }}>
                    <button className="back-button" onClick={() => router.back()} aria-label="Go back" style={{
                        position: 'absolute', top: 20, left: 20, zIndex: 10,
                        background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
                        width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'white', cursor: 'pointer', backdropFilter: 'blur(10px)'
                    }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    </button>

                    <div className="series-hero-bg">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/psyopanime.png" alt="" />
                    </div>
                    <div className="series-hero-content">
                        <div className="series-cover">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src="/psyopanime.png" alt="PsyopAnime" />
                        </div>
                        <div className="series-info">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <span style={{
                                    background: 'linear-gradient(135deg, #E91E7B, #9333ea)',
                                    color: '#fff', fontSize: 9, fontWeight: 800,
                                    padding: '4px 12px', borderRadius: 20,
                                    letterSpacing: 1.5, textTransform: 'uppercase',
                                }}>PsyopAnime × Sakura</span>
                                <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                    color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: 600,
                                }}>
                                    <span style={{
                                        width: 6, height: 6, borderRadius: '50%',
                                        background: '#4ade80', display: 'inline-block',
                                        boxShadow: '0 0 6px #4ade80',
                                    }} />
                                    Now streaming on Sakura
                                </span>
                            </div>
                            <h1>{PSYOP_INFO.title}</h1>

                            <div className="series-meta" style={{ marginBottom: 8 }}>
                                <span className="status ongoing">{PSYOP_INFO.status}</span>
                                <span style={{ color: '#facc15', fontSize: 13, fontWeight: 600 }}>
                                    ★ {PSYOP_INFO.score}
                                </span>
                            </div>

                            <p style={{ margin: '0 0 4px', color: 'var(--text-muted)', fontSize: 12 }}>
                                Studio: {PSYOP_STUDIO}
                            </p>

                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                                {PSYOP_INFO.genres?.map(g => (
                                    <span key={g} style={{
                                        background: 'rgba(233,30,123,0.15)',
                                        color: '#E91E7B',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        padding: '3px 10px',
                                        borderRadius: 12,
                                        border: '1px solid rgba(233,30,123,0.3)',
                                    }}>{g}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                <section className="section" style={{ padding: "0 20px 32px" }}>
                    <div className="section-header" style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--border-color)" }}>
                        <h2 className="section-title" style={{ fontSize: 20 }}>Synopsis</h2>
                    </div>
                    <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14, lineHeight: 1.7, margin: 0 }}>
                        {PSYOP_INFO.description}
                    </p>
                </section>

                <section className="section" style={{ padding: "0 20px 32px" }}>
                    <div className="section-header" style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--border-color)" }}>
                        <h2 className="section-title" style={{ fontSize: 20 }}>Key Characters</h2>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {PSYOP_CHARACTERS.map(c => (
                            <div key={c.name} style={{
                                background: 'rgba(255,255,255,0.03)',
                                border: '1px solid rgba(255,255,255,0.06)',
                                borderRadius: 12,
                                padding: '16px 20px',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                                    <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>{c.name}</span>
                                    <span style={{ color: '#E91E7B', fontSize: 12, fontWeight: 600 }}>{c.role}</span>
                                </div>
                                <p style={{ margin: 0, color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 1.5 }}>
                                    {c.description}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="section" style={{ padding: "0 20px 40px" }}>
                    <div style={{
                        textAlign: 'center',
                        padding: '40px 20px',
                        background: 'rgba(233,30,123,0.05)',
                        border: '1px solid rgba(233,30,123,0.15)',
                        borderRadius: 16,
                    }}>
                        <p style={{ fontSize: 32, margin: '0 0 12px' }}>🌸</p>
                        <h3 style={{ color: '#fff', margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>Episodes Coming Soon</h3>
                        <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13 }}>
                            Stay tuned for the premiere of PsyopAnime: The Series — a Sakura Original.
                        </p>
                    </div>
                </section>

                <footer className="footer" style={{ marginTop: 0 }}>
                    <p className="footer-jp">桜 — マンガの新しい形</p>
                    <p className="footer-text">© 2026 Sakura. Read manga on the blockchain.</p>
                </footer>
            </main>
        </>
    );
}

function AnimeDetailsInner() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const id = searchParams.get("id") || "";
    const isNative = Capacitor.isNativePlatform();

    const [anime, setAnime] = useState<AnimeInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dlMap, setDlMap] = useState<Record<string, AnimeDownloadEntry>>({});
    const listenerRef = useRef<{ remove: () => void } | null>(null);
    const [lastWatchedEpId, setLastWatchedEpId] = useState<string | null>(null);
    const [showLibraryModal, setShowLibraryModal] = useState(false);
    const [inLib, setInLib] = useState(false);

    useEffect(() => {
        setDlMap(getLocal<Record<string, AnimeDownloadEntry>>(STORAGE_KEYS.ANIME_DOWNLOADS, {}));
        const history = getAnimeHistory();
        const entry = history.find(h => h.animeId === id);
        if (entry) setLastWatchedEpId(entry.episodeId);
        setInLib(isInLibrary(id, 'anime'));
    }, [id]);

    useEffect(() => {
        if (!isNative) return;
        let handle: { remove: () => void } | null = null;
        (async () => {
            const { Anime } = await import("@/plugins/anime");
            handle = await Anime.addListener("downloadProgress", (event: DownloadProgressEvent) => {
                setDlMap(prev => {
                    const updated = { ...prev };
                    if (updated[event.episodeId]) {
                        updated[event.episodeId] = { ...updated[event.episodeId], state: event.state, progress: event.progress };
                        if (event.filePath) updated[event.episodeId].filePath = event.filePath;
                    }
                    setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
                    return updated;
                });
            });
            listenerRef.current = handle;
        })();
        return () => { handle?.remove(); };
    }, [isNative]);

    const handleDownload = useCallback(async (ep: { id: string; number: number; title: string }) => {
        if (!anime) return;
        const existing = dlMap[ep.id];
        if (existing?.state === 'downloading' || existing?.state === 'extracting') return;
        if (existing?.state === 'completed' && existing.filePath) {
            try {
                const { Anime } = await import("@/plugins/anime");
                await Anime.playLocalEpisode({ filePath: existing.filePath, title: ep.title || `Episode ${ep.number}` });
            } catch (e) { console.error(e); }
            return;
        }

        const entry: AnimeDownloadEntry = {
            episodeId: ep.id,
            animeId: id,
            animeTitle: anime.title,
            episodeTitle: ep.title || `Episode ${ep.number}`,
            episodeNumber: ep.number,
            state: 'extracting',
            progress: 0,
            timestamp: Date.now()
        };
        setDlMap(prev => {
            const updated = { ...prev, [ep.id]: entry };
            setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
            return updated;
        });

        try {
            const sourceData = await fetchEpisodeSources(ep.id);
            if (!sourceData?.url) {
                throw new Error("Could not resolve stream URL for download.");
            }
            const { Anime } = await import("@/plugins/anime");
            const result = await Anime.downloadEpisode({
                episodeId: ep.id,
                m3u8Url: sourceData.url,
                title: ep.title || `Episode ${ep.number}`,
                animeTitle: anime.title,
            });
            if (result.filePath) {
                setDlMap(prev => {
                    const updated = { ...prev };
                    if (updated[ep.id]) updated[ep.id] = { ...updated[ep.id], filePath: result.filePath!, state: 'completed', progress: 100 };
                    setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
                    return updated;
                });
            }
        } catch (e: any) {
            console.error("Download failed:", e);
            setDlMap(prev => {
                const updated = { ...prev };
                if (updated[ep.id]) updated[ep.id] = { ...updated[ep.id], state: 'error', progress: 0 };
                setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
                return updated;
            });
        }
    }, [anime, id, dlMap]);

    useEffect(() => {
        if (!id || id === PSYOP_ID) return;

        const cached = getCachedAnimeInfo(id);
        if (cached && cached.episodes?.length > 0) {
            setAnime(cached);
            setLoading(false);
            refreshAnimeInfo(id).then(fresh => {
                if (fresh) setAnime(fresh);
            }).catch(() => {});
            return;
        }

        setLoading(true);
        fetchAnimeInfo(id).then(data => {
            if (data) setAnime(data);
            else setError("Failed to resolve this Anime.");
        }).catch((e: any) => {
            setError(e.message || "Failed to load Anime details.");
        }).finally(() => setLoading(false));
    }, [id]);

    if (id === PSYOP_ID) return <PsyopAnimeShowcase />;

    if (loading) {
        return (
            <>
                <Header />
                <main className="main-content" style={{ padding: 40, textAlign: "center", color: "white" }}>
                    <div className="spinner">🌸 Loading Anime...</div>
                </main>
            </>
        );
    }

    if (error || !anime) {
        return (
            <>
                <Header />
                <main className="main-content" style={{ padding: 40, textAlign: "center", color: "white" }}>
                    <h2>Error loading Anime</h2>
                    <p>{error}</p>
                    <button onClick={() => router.back()} className="btn-secondary" style={{ marginTop: 24 }}>
                        Go Back
                    </button>
                </main>
            </>
        );
    }

    return (
        <>
            <Header />
            <main className="main-content">
                {/* Hero Banner */}
                <div className="series-hero" style={{ position: 'relative' }}>
                    <button className="back-button" onClick={() => router.back()} aria-label="Go back" style={{
                        position: 'absolute', top: 20, left: 20, zIndex: 10,
                        background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
                        width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'white', cursor: 'pointer', backdropFilter: 'blur(10px)'
                    }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    </button>

                    <div className="series-hero-bg">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={anime.image || "/sakura.png"} alt="" referrerPolicy="no-referrer" />
                    </div>
                    <div className="series-hero-content">
                        <div className="series-cover">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={anime.image || "/sakura.png"} alt={anime.title} referrerPolicy="no-referrer" />
                        </div>
                        <div className="series-info">
                            <h1>{anime.title}</h1>

                            <div className="series-meta" style={{ marginBottom: 16 }}>
                                <span className={`status ${anime.status === 'Finished Airing' || anime.status === 'Completed' ? 'completed' : 'ongoing'}`}>
                                    {anime.status || "Ongoing"}
                                </span>
                                {anime.score && (
                                    <span style={{ color: '#facc15', fontSize: 13, fontWeight: 600 }}>
                                        ★ {anime.score}
                                    </span>
                                )}
                                {anime.episodes?.length > 0 && (
                                    <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                                        {anime.episodes.length} Episodes
                                    </span>
                                )}
                            </div>

                            <p className="series-desc">
                                {anime.description
                                    ? anime.description.replace(/<[^>]+>/g, '')
                                    : "No description available."
                                }
                            </p>

                            <div className="series-actions">
                                {anime.episodes && anime.episodes.length > 0 && (() => {
                                    const lastEp = lastWatchedEpId
                                        ? anime.episodes.find(e => e.id === lastWatchedEpId)
                                        : null;
                                    const targetEp = lastEp || anime.episodes[0];
                                    const label = lastEp
                                        ? `Continue Ep ${lastEp.number}`
                                        : "Watch Ep 1";
                                    return (
                                        <Link
                                            href={`/anime/watch?id=${encodeURIComponent(anime.id)}&ep=${encodeURIComponent(targetEp.id)}`}
                                            className="btn-primary"
                                        >
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, display: 'inline-block', verticalAlign: 'middle' }}>
                                                <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                            </svg>
                                            {label}
                                        </Link>
                                    );
                                })()}
                                <button
                                    onClick={() => setShowLibraryModal(true)}
                                    className="btn-secondary"
                                    style={{ color: inLib ? "#4ade80" : "currentColor", background: inLib ? "rgba(76,175,80,0.15)" : undefined, borderColor: inLib ? "rgba(76,175,80,0.3)" : undefined, display: "flex", alignItems: "center", gap: 6 }}
                                >
                                    <LottieIcon
                                        src={inLib ? "/icons/wired-outline-24-approved-checked-hover-loading.json" : "/icons/wired-outline-2620-bookmark-alt-hover-flutter.json"}
                                        size={22}
                                        playOnMount
                                        colorFilter={inLib ? "brightness(0) saturate(100%) invert(62%) sepia(61%) saturate(483%) hue-rotate(79deg) brightness(96%) contrast(92%)" : undefined}
                                    />
                                    {inLib ? "Saved" : "Save"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {showLibraryModal && anime && (
                    <SaveToLibraryModal
                        item={{
                            id: anime.id,
                            title: anime.title,
                            image: anime.image,
                            type: 'anime',
                            addedAt: Date.now(),
                        }}
                        onClose={() => {
                            setShowLibraryModal(false);
                            setInLib(isInLibrary(id, 'anime'));
                        }}
                    />
                )}

                <section className="section" style={{ padding: "0 20px 40px" }}>
                    <div className="section-header" style={{ marginBottom: 24, paddingBottom: 16, borderBottom: "1px solid var(--border-color)" }}>
                        <h2 className="section-title" style={{ fontSize: 24 }}>エピソード Episodes</h2>
                        <span style={{ color: "var(--text-muted)" }}>{anime.episodes?.length || 0} Total</span>
                    </div>

                    <div className="chapters-list">
                        {anime.episodes && anime.episodes.length > 0 ? (
                            anime.episodes.map((ep) => {
                                const dl = dlMap[ep.id];
                                const isCompleted = dl?.state === 'completed';
                                const isActive = dl?.state === 'downloading' || dl?.state === 'extracting';
                                const pct = dl?.progress || 0;

                                return (
                                    <Link
                                        key={ep.id}
                                        href={`/anime/watch?id=${encodeURIComponent(anime.id)}&ep=${encodeURIComponent(ep.id)}`}
                                        className="chapter-item"
                                        style={{ textDecoration: 'none' }}
                                    >
                                        <div className="chapter-item-left">
                                            {ep.id === lastWatchedEpId && (
                                                <span style={{
                                                    width: 6, height: 6, borderRadius: '50%',
                                                    background: '#E91E7B', display: 'inline-block',
                                                    boxShadow: '0 0 6px #E91E7B', marginRight: 6, flexShrink: 0,
                                                }} />
                                            )}
                                            <span className="chapter-number" style={{ width: 80, color: isCompleted ? '#4CAF50' : ep.id === lastWatchedEpId ? '#E91E7B' : 'rgba(88, 101, 242, 1)' }}>
                                                Ep {ep.number}
                                            </span>
                                            <span className="chapter-title" style={{ color: 'white' }}>
                                                {ep.title || `Episode ${ep.number}`}
                                            </span>
                                            {isCompleted && (
                                                <span style={{ fontSize: 11, color: '#4CAF50', marginLeft: 8 }}>Offline</span>
                                            )}
                                        </div>
                                        <div className="chapter-item-right" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                            {isNative && (() => {
                                                if (isCompleted) {
                                                    return (
                                                        <button
                                                            className="dl-btn dl-completed"
                                                            title="Downloaded — tap to play offline"
                                                            onClick={(e) => { e.preventDefault(); handleDownload(ep); }}
                                                        >
                                                            <LottieIcon src="/icons/wired-outline-24-approved-checked-hover-loading.json" size={24} colorFilter="brightness(0) saturate(100%) invert(62%) sepia(61%) saturate(483%) hue-rotate(79deg) brightness(96%) contrast(92%)" playOnMount />
                                                        </button>
                                                    );
                                                }
                                                if (isActive) {
                                                    return (
                                                        <button className="dl-btn dl-active" title={`Downloading ${pct}%`} onClick={(e) => e.preventDefault()}>
                                                            <div className="dl-progress-circle" style={{ width: 28, height: 28, borderRadius: '50%', background: `conic-gradient(var(--sakura-pink) ${pct}%, rgba(255,255,255,0.1) 0)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                                <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-primary, #1a1a2e)' }} />
                                                            </div>
                                                        </button>
                                                    );
                                                }
                                                return (
                                                    <button
                                                        className="dl-btn"
                                                        title="Download"
                                                        onClick={(e) => { e.preventDefault(); handleDownload(ep); }}
                                                    >
                                                        <LottieIcon src="/icons/wired-outline-199-download-2-hover-pointing.json" size={24} colorFilter="brightness(0) saturate(100%) invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg) brightness(101%) contrast(98%)" />
                                                    </button>
                                                );
                                            })()}
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>
                                        </div>
                                    </Link>
                                );
                            })
                        ) : (
                            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                                No episodes found.
                            </div>
                        )}
                    </div>
                </section>

                <footer className="footer" style={{ marginTop: 0 }}>
                    <p className="footer-jp">桜 — マンガの新しい形</p>
                    <p className="footer-text">© 2026 Sakura. Read manga on the blockchain.</p>
                </footer>
            </main>
        </>
    );
}

export default function AnimeDetailsPage() {
    return (
        <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "white" }}>🌸 Loading...</div>}>
            <AnimeDetailsInner />
        </Suspense>
    );
}
