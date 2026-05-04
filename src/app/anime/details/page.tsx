"use client";

import { useState, useEffect, useRef, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Header from "@/components/Header";
import { fetchAnimeInfo, getCachedAnimeInfo, refreshAnimeInfo, fetchEpisodeSources, type AnimeInfo } from "@/lib/anime";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { getLocal, setLocal, STORAGE_KEYS, getAnimeHistory, isInLibrary } from "@/lib/storage";
import type { DownloadProgressEvent } from "@/plugins/anime";
import { PSYOP_ID, PSYOP_INFO, PSYOP_STUDIO, PSYOP_CHARACTERS } from "@/lib/psyopAnime";
import { imageOrPlaceholder, SAKURA_PLACEHOLDER_IMAGE } from "@/lib/media-fallback";
import { buildSakuraShareUrl, shareOrCopyLink } from "@/lib/share";
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

const EPISODES_PER_RANGE = 50;

function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return "";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m` : `${s}s`;
}

function AnimeDetailsInner() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const id = searchParams.get("id") || "";
    const isNative = Capacitor.isNativePlatform();
    const isPsyop = id === PSYOP_ID;

    const [anime, setAnime] = useState<AnimeInfo | null>(isPsyop ? PSYOP_INFO : null);
    const [loading, setLoading] = useState(!isPsyop);
    const [error, setError] = useState<string | null>(null);
    const [dlMap, setDlMap] = useState<Record<string, AnimeDownloadEntry>>({});
    const listenerRef = useRef<{ remove: () => void } | null>(null);
    const [lastWatchedEpId, setLastWatchedEpId] = useState<string | null>(null);
    const [showLibraryModal, setShowLibraryModal] = useState(false);
    const [inLib, setInLib] = useState(false);
    const [activeTab, setActiveTab] = useState<"episodes" | "info">("episodes");
    const [descExpanded, setDescExpanded] = useState(false);
    const [episodeRange, setEpisodeRange] = useState(0);
    const [retrying, setRetrying] = useState(false);
    const [statusToast, setStatusToast] = useState<string | null>(null);

    const showToast = useCallback((message: string) => {
        setStatusToast(message);
        window.setTimeout(() => setStatusToast(null), 3500);
    }, []);

    const retryEpisodeLookup = useCallback(async () => {
        if (!id || retrying) return;
        setRetrying(true);
        try {
            const fresh = await refreshAnimeInfo(id);
            if (fresh) setAnime(fresh);
        } finally {
            setRetrying(false);
        }
    }, [id, retrying]);

    useEffect(() => {
        setDlMap(getLocal<Record<string, AnimeDownloadEntry>>(STORAGE_KEYS.ANIME_DOWNLOADS, {}));
        const history = getAnimeHistory();
        const entry = history.find(h => h.animeId === id);
        if (entry) setLastWatchedEpId(entry.episodeId);
        setInLib(isInLibrary(id, "anime"));
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
                        if (event.state === "completed") showToast(`Download complete: ${updated[event.episodeId].episodeTitle}`);
                        if (event.state === "error") showToast(`Download failed: ${updated[event.episodeId].episodeTitle}`);
                        if (event.state === "cancelled") showToast(`Download cancelled: ${updated[event.episodeId].episodeTitle}`);
                    }
                    setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
                    return updated;
                });
            });
            listenerRef.current = handle;
        })();
        return () => { handle?.remove(); };
    }, [isNative, showToast]);

    const handleCancelDownload = useCallback(async (episodeId: string) => {
        try {
            const { Anime } = await import("@/plugins/anime");
            await Anime.cancelDownload({ episodeId });
        } catch {
            // The native listener updates state when available; keep UI responsive either way.
        }
        setDlMap(prev => {
            const updated = { ...prev };
            if (updated[episodeId]) updated[episodeId] = { ...updated[episodeId], state: "cancelled", progress: 0 };
            setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
            return updated;
        });
    }, []);

    const handleDownload = useCallback(async (ep: { id: string; number: number; title: string }) => {
        if (!anime) return;
        const existing = dlMap[ep.id];
        if (existing?.state === "downloading" || existing?.state === "extracting") return;
        if (existing?.state === "completed" && existing.filePath) {
            try {
                const { Anime } = await import("@/plugins/anime");
                await Anime.playLocalEpisode({ filePath: existing.filePath, title: ep.title || `Episode ${ep.number}` });
            } catch (e) { console.error(e); }
            return;
        }

        const entry: AnimeDownloadEntry = {
            episodeId: ep.id, animeId: id, animeTitle: anime.title,
            episodeTitle: ep.title || `Episode ${ep.number}`, episodeNumber: ep.number,
            state: "extracting", progress: 0, timestamp: Date.now()
        };
        setDlMap(prev => {
            const updated = { ...prev, [ep.id]: entry };
            setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
            return updated;
        });

        try {
            const sourceData = await fetchEpisodeSources(ep.id);
            if (!sourceData?.url) throw new Error("Could not resolve stream URL for download.");
            const { Anime } = await import("@/plugins/anime");
            showToast(`Download started: ${ep.title || `Episode ${ep.number}`}`);
            const result = await Anime.downloadEpisode({
                episodeId: ep.id, m3u8Url: sourceData.url,
                title: ep.title || `Episode ${ep.number}`, animeTitle: anime.title,
                referer: sourceData.referer,
                isM3U8: sourceData.isM3U8,
            });
            if (result.filePath) {
                setDlMap(prev => {
                    const updated = { ...prev };
                    if (updated[ep.id]) updated[ep.id] = { ...updated[ep.id], filePath: result.filePath!, state: "completed", progress: 100 };
                    setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
                    return updated;
                });
                showToast(`Download complete: ${ep.title || `Episode ${ep.number}`}`);
            }
        } catch (e: any) {
            console.error("Download failed:", e);
            const cancelled = /cancel/i.test(e?.message || "");
            setDlMap(prev => {
                const updated = { ...prev };
                if (updated[ep.id]) updated[ep.id] = { ...updated[ep.id], state: cancelled ? "cancelled" : "error", progress: 0 };
                setLocal(STORAGE_KEYS.ANIME_DOWNLOADS, updated);
                return updated;
            });
            showToast(`${cancelled ? "Download cancelled" : "Download failed"}: ${ep.title || `Episode ${ep.number}`}`);
        }
    }, [anime, id, dlMap, showToast]);

    useEffect(() => {
        if (!id || isPsyop) return;
        const cached = getCachedAnimeInfo(id);
        if (cached && cached.episodes?.length > 0) {
            setAnime(cached);
            setLoading(false);
            refreshAnimeInfo(id).then(fresh => { if (fresh) setAnime(fresh); }).catch(() => {});
            return;
        }
        setLoading(true);
        fetchAnimeInfo(id).then(data => {
            if (data) setAnime(data);
            else setError("Failed to resolve this Anime.");
        }).catch((e: any) => {
            setError(e.message || "Failed to load Anime details.");
        }).finally(() => setLoading(false));
    }, [id, isPsyop]);

    const episodes = anime?.episodes || [];
    const totalEps = episodes.length;
    const needsRangeNav = totalEps > EPISODES_PER_RANGE;

    const ranges = useMemo(() => {
        if (!needsRangeNav) return [];
        const r = [];
        for (let i = 0; i < totalEps; i += EPISODES_PER_RANGE) {
            const start = i + 1;
            const end = Math.min(i + EPISODES_PER_RANGE, totalEps);
            r.push({ start, end, offset: i });
        }
        return r;
    }, [totalEps, needsRangeNav]);

    const visibleEpisodes = useMemo(() => {
        if (!needsRangeNav) return episodes;
        const start = episodeRange * EPISODES_PER_RANGE;
        return episodes.slice(start, start + EPISODES_PER_RANGE);
    }, [episodes, episodeRange, needsRangeNav]);

    const lastEp = lastWatchedEpId ? episodes.find(e => e.id === lastWatchedEpId) : null;
    const targetEp = lastEp || episodes[0];
    const ctaLabel = lastEp ? `Continue Ep ${lastEp.number}` : "Start Watching E1";

    if (loading) {
        return (
            <>
                <Header />
                <main style={{ minHeight: "100vh", background: "#0a0a0f", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                    <div className="spinner">Loading...</div>
                </main>
            </>
        );
    }

    if (error || !anime) {
        return (
            <>
                <Header />
                <main style={{ minHeight: "100vh", background: "#0a0a0f", padding: 40, textAlign: "center", color: "#fff" }}>
                    <h2>Error loading Anime</h2>
                    <p style={{ color: "var(--text-muted)" }}>{error}</p>
                    <button onClick={() => router.back()} className="btn-secondary" style={{ marginTop: 24 }}>Go Back</button>
                </main>
            </>
        );
    }

    return (
        <>
            {/* Full-screen hero */}
            {statusToast && <div className="sakura-toast" role="status">{statusToast}</div>}
            <div className="anime-details-hero">
                <div className="anime-hero-bg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageOrPlaceholder(anime.cover || anime.image)} alt="" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).src = SAKURA_PLACEHOLDER_IMAGE; }} />
                </div>
                <button className="anime-details-close" onClick={() => router.back()} aria-label="Go back">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
                <div className="anime-hero-content">
                    <h1 className="anime-details-title">{anime.title}</h1>
                </div>
            </div>

            {/* Body */}
            <div className="anime-details-body">
                {/* Meta */}
                <div className="anime-details-meta">
                    {anime.status && (
                        <span className="rating-badge">{anime.status}</span>
                    )}
                    {isPsyop && <span className="rating-badge" style={{ background: "rgba(233,30,123,0.2)", color: "#E91E7B" }}>Sakura Original</span>}
                    {anime.score && (
                        <span className="star-rating">★ {anime.score}</span>
                    )}
                    <span style={{ color: "rgba(255,255,255,0.5)" }}>{totalEps} Episodes</span>
                </div>

                {/* Star rating row (Crunchyroll-style) */}
                {anime.score && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0 8px" }}>
                        {Array.from({ length: 5 }).map((_, i) => {
                            const filled = i < Math.round((anime.score || 0) / 2);
                            return (
                                <svg key={i} width="16" height="16" viewBox="0 0 24 24" fill={filled ? "#facc15" : "rgba(255,255,255,0.12)"} stroke="none">
                                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                </svg>
                            );
                        })}
                        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginLeft: 4 }}>
                            Average <strong style={{ color: "#facc15" }}>{anime.score}</strong>
                        </span>
                    </div>
                )}

                {/* Genres */}
                {anime.genres && anime.genres.length > 0 && (
                    <div className="anime-details-genres">
                        {anime.genres.map(g => <span key={g}>{g}</span>)}
                    </div>
                )}

                {/* Action Bar */}
                <div className="anime-action-bar">
                    <button
                        className={`anime-action-btn ${inLib ? "active" : ""}`}
                        onClick={() => setShowLibraryModal(true)}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill={inLib ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                        My List
                    </button>
                    <button
                        className="anime-action-btn"
                        onClick={async () => {
                            const url = buildSakuraShareUrl({ kind: "anime", id: anime.id });
                            const result = await shareOrCopyLink({ title: anime.title, url });
                            if (result === "copied") showToast("Share link copied");
                        }}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>
                        Share
                    </button>
                </div>

                {showLibraryModal && anime && (
                    <SaveToLibraryModal
                        item={{ id: anime.id, title: anime.title, image: anime.image, type: "anime", addedAt: Date.now() }}
                        onClose={() => { setShowLibraryModal(false); setInLib(isInLibrary(id, "anime")); }}
                    />
                )}

                {/* Description */}
                <p className={`anime-description ${descExpanded ? "" : "collapsed"}`}>
                    {anime.description ? anime.description.replace(/<[^>]+>/g, "") : "No description available."}
                </p>
                {anime.description && anime.description.length > 120 && (
                    <button className="anime-more-details" onClick={() => setDescExpanded(!descExpanded)}>
                        {descExpanded ? "Less" : "More Details"}
                    </button>
                )}

                {/* Tabs */}
                <div className="anime-tabs">
                    <button className={`anime-tab ${activeTab === "episodes" ? "active" : ""}`} onClick={() => setActiveTab("episodes")}>Episodes</button>
                    <button className={`anime-tab ${activeTab === "info" ? "active" : ""}`} onClick={() => setActiveTab("info")}>
                        {isPsyop ? "Characters" : "More Info"}
                    </button>
                </div>

                {/* Episodes Tab */}
                {activeTab === "episodes" && (
                    <>
                        {/* Range Selector */}
                        {needsRangeNav && (
                            <div className="anime-range-bar">
                                <select
                                    className="anime-range-select"
                                    value={episodeRange}
                                    onChange={(e) => setEpisodeRange(Number(e.target.value))}
                                >
                                    {ranges.map((r, idx) => (
                                        <option key={idx} value={idx}>Episodes {r.start}-{r.end}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Episode List */}
                        <div className="anime-episode-list">
                            {visibleEpisodes.length > 0 ? visibleEpisodes.map((ep) => {
                                const dl = dlMap[ep.id];
                                const isCompleted = dl?.state === "completed";
                                const isActive = dl?.state === "downloading" || dl?.state === "extracting";
                                const pct = dl?.progress || 0;
                                const isLast = ep.id === lastWatchedEpId;

                                return (
                                    <Link
                                        key={ep.id}
                                        href={`/anime/watch?id=${encodeURIComponent(anime.id)}&ep=${encodeURIComponent(ep.id)}`}
                                        className="anime-episode-item"
                                    >
                                        {/* Thumbnail */}
                                        <div className="anime-episode-thumb">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={imageOrPlaceholder(ep.image || anime.cover || anime.image)}
                                                alt=""
                                                loading="lazy"
                                                referrerPolicy="no-referrer"
                                                onError={(e) => {
                                                    const img = e.target as HTMLImageElement;
                                                    if (!img.dataset.fallback) {
                                                        img.dataset.fallback = "1";
                                                        img.src = SAKURA_PLACEHOLDER_IMAGE;
                                                    }
                                                }}
                                            />
                                            <div className="play-overlay">
                                                <svg width="10" height="10" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                            </div>
                                        </div>

                                        {/* Info */}
                                        <div className="anime-episode-info">
                                            <div className="anime-episode-number" style={isLast ? { color: "var(--sakura-pink)" } : undefined}>
                                                {isLast && <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--sakura-pink)", marginRight: 4, boxShadow: "0 0 6px var(--sakura-pink)" }} />}
                                                Episode {ep.number}
                                            </div>
                                            <div className="anime-episode-title">{ep.title || `Episode ${ep.number}`}</div>
                                            {isCompleted && <div className="anime-episode-sub" style={{ color: "#4CAF50" }}>Downloaded</div>}
                                        </div>

                                        {/* Actions */}
                                        <div className="anime-episode-actions">
                                            {isNative && (
                                                <>
                                                    {isCompleted ? (
                                                        <button className="anime-episode-dl" title="Downloaded" onClick={(e) => { e.preventDefault(); handleDownload(ep); }}>
                                                            <LottieIcon src="/icons/wired-outline-24-approved-checked-hover-loading.json" size={22} colorFilter="brightness(0) saturate(100%) invert(62%) sepia(61%) saturate(483%) hue-rotate(79deg) brightness(96%) contrast(92%)" playOnMount />
                                                        </button>
                                                    ) : isActive ? (
                                                        <button className="anime-episode-dl" title={`Cancel download (${pct}%)`} onClick={(e) => { e.preventDefault(); handleCancelDownload(ep.id); }}>
                                                            <div style={{ width: 22, height: 22, borderRadius: "50%", background: `conic-gradient(var(--sakura-pink) ${pct}%, rgba(255,255,255,0.1) 0)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                                                <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#0a0a0f", color: "#fff", fontSize: 10, lineHeight: "14px", textAlign: "center" }}>×</div>
                                                            </div>
                                                        </button>
                                                    ) : (
                                                        <button className="anime-episode-dl" title="Download" onClick={(e) => { e.preventDefault(); handleDownload(ep); }}>
                                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                                                        </button>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </Link>
                                );
                            }) : (
                                <div style={{
                                    margin: "16px 0 32px",
                                    padding: "20px 18px",
                                    borderRadius: 12,
                                    background: "rgba(233, 30, 123, 0.06)",
                                    border: "1px solid rgba(233, 30, 123, 0.18)",
                                    textAlign: "center",
                                }}>
                                    <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 6 }}>
                                        No streaming source found for this title
                                    </div>
                                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.5, marginBottom: 14 }}>
                                        {anime.episodeLoadError
                                            ? `${anime.episodeLoadError}. Try again — sometimes the provider is just slow.`
                                            : "Try again — sometimes the provider is just slow, or check back later."}
                                    </div>
                                    <button
                                        onClick={retryEpisodeLookup}
                                        disabled={retrying}
                                        className="btn-secondary"
                                        style={{ minWidth: 160 }}
                                    >
                                        {retrying ? "Searching…" : "Try search again"}
                                    </button>
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* Info / Characters Tab */}
                {activeTab === "info" && (
                    <div style={{ padding: "0 0 200px" }}>
                        {isPsyop ? (
                            <>
                                <div style={{ marginBottom: 16 }}>
                                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 600 }}>Studio</span>
                                    <p style={{ margin: "4px 0 0", color: "#fff", fontSize: 14 }}>{PSYOP_STUDIO}</p>
                                </div>
                                <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Key Characters</h3>
                                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                                    {PSYOP_CHARACTERS.map(c => (
                                        <div key={c.name} style={{
                                            background: "rgba(255,255,255,0.03)",
                                            border: "1px solid rgba(255,255,255,0.06)",
                                            borderRadius: 10, padding: "14px 16px",
                                        }}>
                                            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                                                <span style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>{c.name}</span>
                                                <span style={{ color: "var(--sakura-pink)", fontSize: 12, fontWeight: 600 }}>{c.role}</span>
                                            </div>
                                            <p style={{ margin: 0, color: "rgba(255,255,255,0.5)", fontSize: 12, lineHeight: 1.5 }}>
                                                {c.description}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            </>
                        ) : (
                            <div style={{ padding: "20px 0" }}>
                                <div style={{ marginBottom: 16 }}>
                                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 600 }}>Status</span>
                                    <p style={{ margin: "4px 0 0", color: "#fff", fontSize: 14 }}>{anime.status || "Unknown"}</p>
                                </div>
                                {anime.score && (
                                    <div style={{ marginBottom: 16 }}>
                                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 600 }}>Score</span>
                                        <p style={{ margin: "4px 0 0", color: "#facc15", fontSize: 14, fontWeight: 700 }}>★ {anime.score}</p>
                                    </div>
                                )}
                                {anime.genres && anime.genres.length > 0 && (
                                    <div style={{ marginBottom: 16 }}>
                                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 600 }}>Genres</span>
                                        <p style={{ margin: "4px 0 0", color: "#fff", fontSize: 14 }}>{anime.genres.join(", ")}</p>
                                    </div>
                                )}
                                <div>
                                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 600 }}>Total Episodes</span>
                                    <p style={{ margin: "4px 0 0", color: "#fff", fontSize: 14 }}>{totalEps}</p>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Sticky CTA */}
            {targetEp && (
                <div className="anime-sticky-cta">
                    <Link href={`/anime/watch?id=${encodeURIComponent(anime.id)}&ep=${encodeURIComponent(targetEp.id)}`} className="cta-play">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                        {ctaLabel}
                    </Link>
                    <button
                        className="cta-save"
                        onClick={() => setShowLibraryModal(true)}
                        aria-label="Save to library"
                        style={inLib ? { background: "rgba(76,175,80,0.15)", borderColor: "rgba(76,175,80,0.3)" } : undefined}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill={inLib ? "#4ade80" : "none"} stroke={inLib ? "#4ade80" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
                    </button>
                </div>
            )}
        </>
    );
}

export default function AnimeDetailsPage() {
    return (
        <Suspense fallback={<div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0f", color: "white" }}>Loading...</div>}>
            <AnimeDetailsInner />
        </Suspense>
    );
}
