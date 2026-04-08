"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchEpisodeSources, type StreamingSource, fetchAnimeInfo, type AnimeInfo } from "@/lib/anime";
import Link from "next/link";
import { Capacitor } from '@capacitor/core';
import { getLocal, STORAGE_KEYS, saveAnimeWatchEntry } from "@/lib/storage";

function AnimeWatchInner() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const id = searchParams.get("id") || "";
    const episodeId = searchParams.get("ep") || "";

    const [anime, setAnime] = useState<AnimeInfo | null>(null);
    const [source, setSource] = useState<StreamingSource | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [nativePlaying, setNativePlaying] = useState(false);
    const [isNative] = useState(Capacitor.isNativePlatform());
    const [playTriggered, setPlayTriggered] = useState(false);

    const currentEpisodeIndex = anime?.episodes.findIndex(e => e.id === episodeId) ?? -1;
    const currentEpisode = currentEpisodeIndex >= 0 ? anime?.episodes[currentEpisodeIndex] : null;
    const nextEpisode = currentEpisodeIndex >= 0 && currentEpisodeIndex < (anime?.episodes.length || 0) - 1
        ? anime?.episodes[currentEpisodeIndex + 1]
        : null;

    useEffect(() => {
        setSource(null);
        setAnime(null);
        setError(null);
        setNativePlaying(false);
        setPlayTriggered(false);
        setLoading(true);
    }, [episodeId]);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const animeData = await fetchAnimeInfo(id);
                if (cancelled) return;
                if (animeData) setAnime(animeData);

                console.log(`[Watch] Fetching sources for ep=${episodeId}`);
                const sourceData = await fetchEpisodeSources(episodeId);
                if (cancelled) return;
                if (sourceData) {
                    console.log(`[Watch] Got source URL: ${sourceData.url?.substring(0, 80)}`);
                    setSource(sourceData);
                } else {
                    console.error(`[Watch] fetchEpisodeSources returned null for ${episodeId}`);
                    setError("Could not find a stream for this episode. Try another episode or check back later.");
                }
            } catch (e: any) {
                console.error('[Watch] Load error:', e);
                if (!cancelled) setError(e.message || "Failed to load episode.");
            }
            if (!cancelled) setLoading(false);
        }
        if (id && episodeId) {
            load();
        }
        return () => { cancelled = true; };
    }, [id, episodeId, isNative]);

    const playNative = useCallback(async () => {
        if (!anime) return;
        const epIdx = anime.episodes.findIndex(e => e.id === episodeId);
        const currentEp = epIdx >= 0 ? anime.episodes[epIdx] : null;
        const nextEp = epIdx >= 0 && epIdx < anime.episodes.length - 1 ? anime.episodes[epIdx + 1] : null;
        const title = currentEp?.title || `Episode ${currentEp?.number || "?"}`;

        try {
            setNativePlaying(true);
            setError(null);

            saveAnimeWatchEntry({
                animeId: id,
                episodeId,
                animeTitle: anime.title,
                episodeTitle: title,
                episodeNumber: currentEp?.number || 0,
                image: anime.image,
                timestamp: Date.now()
            });

            const { Anime } = await import("@/plugins/anime");

            const allDl = getLocal<Record<string, any>>(STORAGE_KEYS.ANIME_DOWNLOADS, {});
            const localEntry = allDl[episodeId];

            let result: { completed: boolean };
            if (localEntry?.state === 'completed' && localEntry?.filePath) {
                result = await Anime.playLocalEpisode({
                    filePath: localEntry.filePath,
                    title,
                    episodeId,
                    hasNext: !!nextEp,
                    nextEpisodeTitle: nextEp?.title || (nextEp ? `Episode ${nextEp.number}` : "")
                });
            } else {
                if (!source?.url) {
                    setError("No stream URL available. Try again.");
                    return;
                }
                result = await Anime.playEpisode({
                    streamUrl: source.url,
                    referer: source.referer || '',
                    title,
                    episodeId,
                    hasNext: !!nextEp,
                    nextEpisodeTitle: nextEp?.title || (nextEp ? `Episode ${nextEp.number}` : ""),
                });
            }

            if (result.completed && nextEp) {
                const nextTitle = nextEp.title || `Episode ${nextEp.number}`;
                saveAnimeWatchEntry({
                    animeId: id,
                    episodeId: nextEp.id,
                    animeTitle: anime.title,
                    episodeTitle: nextTitle,
                    episodeNumber: nextEp.number,
                    image: anime.image,
                    timestamp: Date.now()
                });
                router.push(`/anime/watch?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(nextEp.id)}`);
                return;
            }
        } catch (e: any) {
            console.error('[Anime] Native playback error:', e);
            setError(e.message || "Native playback failed. Try again.");
        } finally {
            setNativePlaying(false);
        }
    }, [anime, episodeId, id, router, source]);

    useEffect(() => {
        if (isNative && anime && source && !error && !nativePlaying && !playTriggered) {
            setPlayTriggered(true);
            playNative();
        }
    }, [isNative, anime, source, error, nativePlaying, playTriggered, playNative]);

    if (loading) {
        return (
            <main className="cinema-page" style={{ height: "100vh", display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
                <div className="spinner" style={{ color: "var(--sakura-pink)" }}>
                    {isNative ? "🌸 Preparing Native Player..." : "🌸 Locating Stream..."}
                </div>
            </main>
        );
    }

    if (error) {
        const copyLog = () => {
            navigator.clipboard?.writeText(error).then(() => {
                alert("Copied to clipboard!");
            }).catch(() => {
                const ta = document.createElement("textarea");
                ta.value = error;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                alert("Copied to clipboard!");
            });
        };

        return (
            <main className="cinema-page" style={{ height: "100vh", display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#fff', padding: 20 }}>
                <h2>Playback Error</h2>
                <pre style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '50vh', overflow: 'auto', fontSize: '0.7rem', textAlign: 'left', width: '100%', padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>{error}</pre>
                <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {isNative && (
                        <button onClick={playNative} className="btn-primary" style={{ padding: '12px 24px' }}>
                            Retry
                        </button>
                    )}
                    <button onClick={copyLog} style={{ padding: '12px 24px', background: '#333', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
                        Copy Log
                    </button>
                    <button onClick={() => router.back()} className="btn-secondary">
                        Go Back
                    </button>
                </div>
            </main>
        );
    }

    return (
        <main className="cinema-page" style={{
            minHeight: "100vh",
            background: "#000",
            color: "#fff",
            display: "flex",
            flexDirection: "column"
        }}>
            <header style={{
                position: "absolute",
                top: 0, left: 0, right: 0,
                padding: "20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)",
                zIndex: 10
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <button onClick={() => router.back()} aria-label="Go back" style={{
                        background: 'rgba(255,255,255,0.1)',
                        border: 'none', borderRadius: '50%',
                        width: 40, height: 40,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'white', cursor: 'pointer',
                        backdropFilter: 'blur(10px)'
                    }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    </button>
                    <div>
                        <h1 style={{ fontSize: 16, margin: 0, fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>
                            {anime?.title || "Anime"}
                        </h1>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--sakura-pink)' }}>
                            {currentEpisode?.title || `Episode ${currentEpisode?.number || "?"}`}
                        </p>
                    </div>
                </div>

                <Link href={`/anime/details?id=${encodeURIComponent(id)}`} style={{ color: 'white', textDecoration: 'none', fontSize: 14, opacity: 0.8 }}>
                    Series Details
                </Link>
            </header>

            <div style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
                width: "100%",
                paddingTop: "60px",
                paddingBottom: "10px"
            }}>
                {isNative ? (
                    <div style={{ textAlign: 'center', padding: '2rem' }}>
                        <div style={{ fontSize: '48px', marginBottom: '1rem' }}>🍿</div>
                        <h2 style={{ color: 'white', marginBottom: '1rem' }}>
                            {nativePlaying ? "Launching Player..." : "Native Player Ready"}
                        </h2>
                        <p style={{ color: 'var(--text-muted)', marginBottom: '2rem', maxWidth: '300px' }}>
                            Sakura uses a native Android video engine for the fastest ad-free playback.
                        </p>
                        <button
                            onClick={playNative}
                            disabled={nativePlaying}
                            className="btn-primary"
                            style={{ padding: '16px 32px', fontSize: '1.2rem', borderRadius: '25px', opacity: nativePlaying ? 0.5 : 1 }}
                        >
                            {nativePlaying ? "Loading..." : "▶ Watch Episode"}
                        </button>
                    </div>
                ) : (
                    <iframe
                        src={source?.url}
                        allowFullScreen
                        style={{
                            width: "100%",
                            height: "100%",
                            minHeight: "400px",
                            border: "none",
                            background: "black"
                        }}
                    />
                )}
            </div>

            <footer style={{
                padding: "20px",
                background: "linear-gradient(to top, rgba(0,0,0,0.9), transparent)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 16
            }}>
                <div style={{ flex: 1 }}>
                    <h3 style={{ margin: "0 0 4px 0", fontSize: 18 }}>{currentEpisode?.title || `Episode ${currentEpisode?.number}`}</h3>
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 14 }}>
                        {(() => {
                            const allDl = typeof window !== 'undefined' ? getLocal<Record<string, any>>(STORAGE_KEYS.ANIME_DOWNLOADS, {}) : {};
                            return allDl[episodeId]?.state === 'completed' ? "Playing offline" : "Streaming via Sakura Engine";
                        })()}
                    </p>
                </div>

                {nextEpisode && (
                    <Link
                        href={`/anime/watch?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(nextEpisode.id)}`}
                        className="btn-primary"
                        style={{ background: 'rgba(88, 101, 242, 0.2)', border: '1px solid rgba(88, 101, 242, 0.4)' }}
                    >
                        Next Episode {"→"}
                    </Link>
                )}
            </footer>
        </main>
    );
}

export default function AnimeWatchPage() {
    return (
        <Suspense fallback={<div style={{ height: "100vh", display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: 'white' }}>🌸 Buffering...</div>}>
            <AnimeWatchInner />
        </Suspense>
    );
}
