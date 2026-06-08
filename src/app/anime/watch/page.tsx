"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchEpisodeSources, type StreamingSource, fetchAnimeInfo, refreshAnimeInfo, type AnimeInfo } from "@/lib/anime";
import { PSYOP_ID, isPsyopEpisode } from "@/lib/psyopAnime";
import { TWO_HE_ANIME_ID, isTwoHeAnimeEpisode } from "@/lib/2heAnime";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { getLocal, STORAGE_KEYS, saveAnimeWatchEntry } from "@/lib/storage";

const CATEGORY_STORAGE_KEY = "sakura_anime_category";

interface WatchErrorState {
    message: string;
    code?: string;
    stage?: string;
    details?: Record<string, unknown>;
}

function getSavedCategory(): "sub" | "dub" {
    if (typeof window === "undefined") return "sub";
    const saved = localStorage.getItem(CATEGORY_STORAGE_KEY);
    return saved === "dub" ? "dub" : "sub";
}

function parseEpisodeNumber(episodeId: string): number | null {
    const match = episodeId.match(/^hi-\d+-(\d+)$/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function toWatchError(error: unknown): WatchErrorState {
    if (error && typeof error === "object") {
        const source = error as {
            message?: string;
            code?: string;
            stage?: string;
            details?: Record<string, unknown>;
        };
        return {
            message: source.message || "Playback failed.",
            code: source.code,
            stage: source.stage,
            details: source.details,
        };
    }
    return { message: "Playback failed." };
}

function getErrorGuidance(error: WatchErrorState): string {
    if (error.stage === "mapping" || error.stage === "episodes") {
        return "This usually means Sakura matched the wrong HiAnime entry. Use Rematch Series to force a fresh lookup.";
    }
    if (error.stage === "servers") {
        return "The episode matched, but HiAnime has no usable servers for it yet. Retry later or try the other audio track if available.";
    }
    if (error.stage === "embed" || error.stage === "extractor") {
        return "The series matched, but the current host failed while resolving the embed or playlist. Retry the stream first, then rematch if it keeps happening.";
    }
    return "Retry the stream first. If the episode list still looks wrong, rematch the series to refresh the provider binding.";
}

function AnimeWatchInner() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const id = searchParams.get("id") || "";
    const episodeId = searchParams.get("ep") || "";

    const [anime, setAnime] = useState<AnimeInfo | null>(null);
    const [source, setSource] = useState<StreamingSource | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<WatchErrorState | null>(null);
    const [nativePlaying, setNativePlaying] = useState(false);
    const [isNative] = useState(Capacitor.isNativePlatform());
    const [playTriggered, setPlayTriggered] = useState(false);
    const [category, setCategory] = useState<"sub" | "dub">(getSavedCategory);
    const [availableCategories, setAvailableCategories] = useState<string[]>(["sub"]);
    const [categoryLoading, setCategoryLoading] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);
    const [rematching, setRematching] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<any>(null);

    const currentEpisodeIndex = anime?.episodes.findIndex((episode) => episode.id === episodeId) ?? -1;
    const currentEpisode = currentEpisodeIndex >= 0 ? anime?.episodes[currentEpisodeIndex] : null;
    const nextEpisode = currentEpisodeIndex >= 0 && currentEpisodeIndex < (anime?.episodes.length || 0) - 1
        ? anime?.episodes[currentEpisodeIndex + 1]
        : null;
    const errorGuidance = error ? getErrorGuidance(error) : null;
    const canRematch = !!error && !isPsyopEpisode(episodeId) && !isTwoHeAnimeEpisode(episodeId) && (
        error.stage === "mapping"
        || error.stage === "episodes"
        || error.code === "MISSING_SLUG"
        || error.code === "EPISODE_NOT_FOUND"
    );

    const applyResolvedCategory = useCallback((resolvedCategory?: string) => {
        const nextCategory = resolvedCategory === "dub" ? "dub" : "sub";
        if (nextCategory !== category) {
            localStorage.setItem(CATEGORY_STORAGE_KEY, nextCategory);
            setCategory(nextCategory);
        }
    }, [category]);

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

                if (animeData) {
                    setAnime(animeData);
                    const isPsyop = id === PSYOP_ID;
                    const isTwoHeAnime = id === TWO_HE_ANIME_ID;
                    if (!isPsyop && !isTwoHeAnime && !animeData.episodes.some((episode) => episode.id === episodeId)) {
                        const currentNumber = parseEpisodeNumber(episodeId);
                        throw {
                            message: "The current episode is missing from the matched provider list.",
                            code: "EPISODE_NOT_FOUND",
                            stage: "episodes",
                            details: {
                                requestedEpisodeId: episodeId,
                                requestedEpisodeNumber: currentNumber,
                                matchedEpisodeCount: animeData.episodes.length,
                            },
                        };
                    }
                }

                console.log(`[Watch] Fetching sources for ep=${episodeId} category=${category}`);
                const sourceData = await fetchEpisodeSources(episodeId, category);
                if (cancelled) return;

                if (sourceData) {
                    console.log(`[Watch] Got source URL: ${sourceData.url?.substring(0, 80)}`);
                    setSource(sourceData);
                    if (sourceData.availableCategories) setAvailableCategories(sourceData.availableCategories);
                    applyResolvedCategory(sourceData.category);
                } else {
                    setError({
                        message: "Could not find a stream for this episode. Try another episode or check back later.",
                        code: "NO_STREAM_SOURCES",
                        stage: "extractor",
                    });
                }
            } catch (loadError) {
                console.error("[Watch] Load error:", loadError);
                if (!cancelled) setError(toWatchError(loadError));
            }

            if (!cancelled) setLoading(false);
        }

        if (id && episodeId) {
            load();
        }

        return () => {
            cancelled = true;
        };
    }, [id, episodeId, isNative, category, reloadToken, applyResolvedCategory]);

    const retryStream = useCallback(() => {
        setPlayTriggered(false);
        setNativePlaying(false);
        setSource(null);
        setError(null);
        setReloadToken((value) => value + 1);
    }, []);

    const toggleCategory = useCallback(async () => {
        const next = category === "sub" ? "dub" : "sub";
        if (!availableCategories.includes(next)) return;

        localStorage.setItem(CATEGORY_STORAGE_KEY, next);
        setCategory(next);
        setPlayTriggered(false);
        setNativePlaying(false);
        setCategoryLoading(true);
        setError(null);

        try {
            const sourceData = await fetchEpisodeSources(episodeId, next);
            if (sourceData) {
                setSource(sourceData);
                if (sourceData.availableCategories) setAvailableCategories(sourceData.availableCategories);
                applyResolvedCategory(sourceData.category);
            } else {
                setError({
                    message: `No ${next.toUpperCase()} stream available for this episode.`,
                    code: "NO_STREAM_SOURCES",
                    stage: "extractor",
                });
            }
        } catch (toggleError) {
            setError(toWatchError(toggleError));
        } finally {
            setCategoryLoading(false);
        }
    }, [category, availableCategories, episodeId, applyResolvedCategory]);

    const rematchSeries = useCallback(async () => {
        if (!id || !episodeId) return;

        setRematching(true);
        setError(null);
        setSource(null);

        try {
            const currentNumber = parseEpisodeNumber(episodeId);
            const freshAnime = await refreshAnimeInfo(id, { forceSourceRefresh: true });
            if (!freshAnime || freshAnime.episodes.length === 0) {
                throw new Error("Rematch completed, but HiAnime still returned no episodes.");
            }

            setAnime(freshAnime);
            const replacementEpisode =
                (currentNumber != null ? freshAnime.episodes.find((episode) => episode.number === currentNumber) : null)
                || freshAnime.episodes[0];

            if (!replacementEpisode) {
                throw new Error("Rematch completed, but the requested episode still could not be found.");
            }

            if (replacementEpisode.id !== episodeId) {
                router.replace(`/anime/watch?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(replacementEpisode.id)}`);
                return;
            }

            retryStream();
        } catch (rematchError) {
            setError(toWatchError(rematchError));
        } finally {
            setRematching(false);
        }
    }, [episodeId, id, retryStream, router]);

    const playNative = useCallback(async () => {
        if (!anime) return;

        const episodeIndex = anime.episodes.findIndex((episode) => episode.id === episodeId);
        const currentEp = episodeIndex >= 0 ? anime.episodes[episodeIndex] : null;
        const nextEp = episodeIndex >= 0 && episodeIndex < anime.episodes.length - 1 ? anime.episodes[episodeIndex + 1] : null;
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
                timestamp: Date.now(),
            });

            const { Anime } = await import("@/plugins/anime");
            const allDownloads = getLocal<Record<string, any>>(STORAGE_KEYS.ANIME_DOWNLOADS, {});
            const localEntry = allDownloads[episodeId];

            let result: { completed: boolean };
            if (localEntry?.state === "completed" && localEntry?.filePath) {
                result = await Anime.playLocalEpisode({
                    filePath: localEntry.filePath,
                    title,
                    episodeId,
                    hasNext: !!nextEp,
                    nextEpisodeTitle: nextEp?.title || (nextEp ? `Episode ${nextEp.number}` : ""),
                });
            } else {
                if (!source?.url) {
                    setError({
                        message: "No stream URL is available yet. Retry the stream first.",
                        code: "NO_STREAM_URL",
                        stage: "extractor",
                    });
                    return;
                }

                result = await Anime.playEpisode({
                    streamUrl: source.url,
                    referer: source.referer || "",
                    title,
                    episodeId,
                    hasNext: !!nextEp,
                    nextEpisodeTitle: nextEp?.title || (nextEp ? `Episode ${nextEp.number}` : ""),
                    ...(source.intro != null
                    && typeof source.intro.start === "number"
                    && typeof source.intro.end === "number"
                    && source.intro.end > source.intro.start
                        ? { introStart: source.intro.start, introEnd: source.intro.end }
                        : {}),
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
                    timestamp: Date.now(),
                });
                // Auto-advance: replace the current entry instead of pushing
                // a new one. Otherwise a binge of N episodes leaves N entries
                // in the back stack and the user has to tap Back N times to
                // get back to the details page they came from.
                router.replace(`/anime/watch?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(nextEp.id)}`);
            }
        } catch (playError) {
            console.error("[Anime] Native playback error:", playError);
            setError(toWatchError(playError));
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

    useEffect(() => {
        if (isNative || !source?.url) return;
        const video = videoRef.current;
        if (!video) return;

        let hls: any = null;
        let disposed = false;

        const startWebPlayback = async () => {
            if ((window as any).electronAPI?.setStreamReferer) {
                await (window as any).electronAPI.setStreamReferer(source.referer || "");
            }
            if (disposed) return;

            if (!source.isM3U8) {
                video.src = source.url;
                video.play().catch(() => {});
                return;
            }

            const Hls = (await import("hls.js")).default;
            if (Hls.isSupported()) {
                hls = new Hls({
                    enableWorker: false,
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60,
                });
                hlsRef.current = hls;
                hls.loadSource(source.url);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play().catch(() => {});
                });
                hls.on(Hls.Events.ERROR, (_: any, data: any) => {
                    if (!data?.fatal) return;
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                    else {
                        setError({
                            message: "Fatal playback error.",
                            code: "HLS_FATAL",
                            stage: "extractor",
                            details: {
                                hlsDetails: data?.details,
                                hlsError: String(data?.error?.message || data?.error || ""),
                            },
                        });
                    }
                });
                return;
            }

            if (video.canPlayType("application/vnd.apple.mpegurl")) {
                video.src = source.url;
                video.play().catch(() => {});
                return;
            }

            setError({
                message: "This device cannot play the current HLS stream.",
                code: "HLS_NOT_SUPPORTED",
                stage: "extractor",
            });
        };

        startWebPlayback();

        return () => {
            disposed = true;
            if (hls) hls.destroy();
            hlsRef.current = null;
        };
    }, [isNative, source]);

    // Suppress duplicate Space-bar pause/play on web. The embedded iframe
    // player already handles Space; if focus passes to the parent document,
    // the page would also fire its own scroll/play handler, so we swallow
    // the keystroke and forward it to the iframe.
    useEffect(() => {
        if (isNative) return;
        if (typeof window === "undefined") return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.code !== "Space" && e.key !== " ") return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
            e.preventDefault();
            const iframe = document.querySelector("iframe") as HTMLIFrameElement | null;
            if (iframe) {
                try { iframe.focus(); } catch { /* ignore */ }
            }
        };
        window.addEventListener("keydown", onKeyDown, { capture: true });
        return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
    }, [isNative]);

    if (loading) {
        return (
            <main className="cinema-page" style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000" }}>
                <div className="spinner" style={{ color: "var(--sakura-pink)" }}>
                    {isNative ? "🌸 Preparing Native Player..." : "🌸 Locating Stream..."}
                </div>
            </main>
        );
    }

    if (error) {
        const copyLog = () => {
            const payload = JSON.stringify(error, null, 2);
            navigator.clipboard?.writeText(payload).then(() => {
                alert("Copied to clipboard!");
            }).catch(() => {
                const textArea = document.createElement("textarea");
                textArea.value = payload;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand("copy");
                document.body.removeChild(textArea);
                alert("Copied to clipboard!");
            });
        };

        return (
            <main className="cinema-page" style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#000", color: "#fff", padding: 20 }}>
                <h2>Playback Error</h2>
                {errorGuidance && (
                    <p style={{ color: "rgba(255,255,255,0.78)", textAlign: "center", maxWidth: 460, marginBottom: 16 }}>
                        {errorGuidance}
                    </p>
                )}
                <pre style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "50vh", overflow: "auto", fontSize: "0.7rem", textAlign: "left", width: "100%", padding: "8px", background: "rgba(255,255,255,0.05)", borderRadius: "8px" }}>
                    {JSON.stringify(error, null, 2)}
                </pre>
                <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap", justifyContent: "center" }}>
                    <button onClick={retryStream} className="btn-primary" style={{ padding: "12px 24px" }}>
                        Retry Stream
                    </button>
                    {canRematch && (
                        <button
                            onClick={rematchSeries}
                            className="btn-secondary"
                            disabled={rematching}
                            style={{ padding: "12px 24px", opacity: rematching ? 0.6 : 1 }}
                        >
                            {rematching ? "Rematching..." : "Rematch Series"}
                        </button>
                    )}
                    {isNative && source?.url && (
                        <button onClick={playNative} className="btn-secondary" style={{ padding: "12px 24px" }}>
                            Retry Native Player
                        </button>
                    )}
                    <button onClick={copyLog} style={{ padding: "12px 24px", background: "#333", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
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
            flexDirection: "column",
        }}>
            <header style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                padding: "20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)",
                zIndex: 10,
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <button onClick={() => router.back()} aria-label="Go back" style={{
                        background: "rgba(255,255,255,0.1)",
                        border: "none",
                        borderRadius: "50%",
                        width: 40,
                        height: 40,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "white",
                        cursor: "pointer",
                        backdropFilter: "blur(10px)",
                    }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    </button>
                    <div>
                        <h1 style={{ fontSize: 16, margin: 0, fontWeight: 600, color: "rgba(255,255,255,0.9)" }}>
                            {anime?.title || "Anime"}
                        </h1>
                        <p style={{ margin: 0, fontSize: 13, color: "var(--sakura-pink)" }}>
                            {currentEpisode?.title || `Episode ${currentEpisode?.number || "?"}`}
                        </p>
                    </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {!isPsyopEpisode(episodeId) && availableCategories.length > 1 && (
                        <button
                            onClick={toggleCategory}
                            disabled={categoryLoading}
                            style={{
                                background: category === "sub"
                                    ? "linear-gradient(135deg, #e91e63, #c2185b)"
                                    : "linear-gradient(135deg, #5865f2, #4752c4)",
                                color: "#fff",
                                border: "none",
                                borderRadius: 20,
                                padding: "6px 16px",
                                fontSize: 12,
                                fontWeight: 700,
                                letterSpacing: "0.5px",
                                cursor: categoryLoading ? "wait" : "pointer",
                                opacity: categoryLoading ? 0.6 : 1,
                                textTransform: "uppercase",
                                transition: "all 0.2s ease",
                            }}
                        >
                            {categoryLoading ? "..." : category === "sub" ? "SUB" : "DUB"}
                        </button>
                    )}
                    <Link href={`/anime/details?id=${encodeURIComponent(id)}`} style={{ color: "white", textDecoration: "none", fontSize: 14, opacity: 0.8 }}>
                        Series Details
                    </Link>
                </div>
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
                paddingBottom: "10px",
            }}>
                {isNative ? (
                    <div style={{ textAlign: "center", padding: "2rem" }}>
                        <div style={{ fontSize: "48px", marginBottom: "1rem" }}>🍿</div>
                        <h2 style={{ color: "white", marginBottom: "1rem" }}>
                            {nativePlaying ? "Launching Player..." : "Native Player Ready"}
                        </h2>
                        <p style={{ color: "var(--text-muted)", marginBottom: "2rem", maxWidth: "300px" }}>
                            Sakura uses a native Android video engine for the fastest ad-free playback.
                        </p>
                        <button
                            onClick={playNative}
                            disabled={nativePlaying}
                            className="btn-primary"
                            style={{ padding: "16px 32px", fontSize: "1.2rem", borderRadius: "25px", opacity: nativePlaying ? 0.5 : 1 }}
                        >
                            {nativePlaying ? "Loading..." : "▶ Watch Episode"}
                        </button>
                    </div>
                ) : (
                    <video
                        ref={videoRef}
                        controls
                        playsInline
                        style={{
                            width: "100%",
                            height: "100%",
                            minHeight: "400px",
                            border: "none",
                            background: "black",
                            objectFit: "contain",
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
                gap: 16,
            }}>
                <div style={{ flex: 1 }}>
                    <h3 style={{ margin: "0 0 4px 0", fontSize: 18 }}>{currentEpisode?.title || `Episode ${currentEpisode?.number}`}</h3>
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 14 }}>
                        {(() => {
                            if (isPsyopEpisode(episodeId)) return "PsyopAnime \u00d7 Sakura";
                            if (isTwoHeAnimeEpisode(episodeId)) return "2heAnime x Sakura";
                            const allDownloads = typeof window !== "undefined" ? getLocal<Record<string, any>>(STORAGE_KEYS.ANIME_DOWNLOADS, {}) : {};
                            return allDownloads[episodeId]?.state === "completed" ? "Playing offline" : "Streaming via Sakura Engine";
                        })()}
                    </p>
                </div>

                {nextEpisode && (
                    <Link
                        href={`/anime/watch?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(nextEpisode.id)}`}
                        className="btn-primary"
                        style={{ background: "rgba(88, 101, 242, 0.2)", border: "1px solid rgba(88, 101, 242, 0.4)" }}
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
        <Suspense fallback={<div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", color: "white" }}>🌸 Buffering...</div>}>
            <AnimeWatchInner />
        </Suspense>
    );
}
