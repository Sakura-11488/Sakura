"use client";

import Header from "@/components/Header";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense, useMemo } from "react";
import { getSource } from "@/lib/sources";
import { type Manga, type Chapter } from "@/lib/sources/types";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import dynamic from "next/dynamic";

const TipModal = dynamic(() => import("@/components/TipModal"), { ssr: false });
import LottieIcon from "@/components/LottieIcon";
const SaveToLibraryModal = dynamic(() => import("@/components/SaveToLibraryModal"), { ssr: false });
import { getCreatorProfile } from "@/lib/creator";
import { getFavorites, addFavorite, removeFavorite } from "@/lib/supabase";
import { getLocal, setLocal, STORAGE_KEYS, setChapterProgress, getChapterProgress, getReadChapters, getAllChapterProgress, READ_THRESHOLD, isInLibrary, type LibraryItem } from "@/lib/storage";
import { useDownloads, downloadManager } from "@/lib/downloads";
import ChapterComments from "@/components/ChapterComments";

function FavoriteButton({ manga }: { manga: Manga }) {
    const [showLibraryModal, setShowLibraryModal] = useState(false);
    const [inLibrary, setInLibrary] = useState(false);

    useEffect(() => {
        setInLibrary(isInLibrary(manga.id, 'manga'));
    }, [manga.id, showLibraryModal]);

    const libraryItem: LibraryItem = {
        id: manga.id,
        title: manga.title,
        image: manga.cover,
        type: 'manga',
        addedAt: Date.now(),
    };

    return (
        <>
            <button
                onClick={() => setShowLibraryModal(true)}
                className="btn-secondary"
                style={{ color: inLibrary ? "#4ade80" : "currentColor", background: inLibrary ? "rgba(76,175,80,0.15)" : undefined, borderColor: inLibrary ? "rgba(76,175,80,0.3)" : undefined, display: "flex", alignItems: "center", gap: 6 }}
            >
                <LottieIcon
                    src={inLibrary ? "/icons/wired-outline-24-approved-checked-hover-loading.json" : "/icons/wired-outline-2620-bookmark-alt-hover-flutter.json"}
                    size={22}
                    playOnMount
                    colorFilter={inLibrary ? "brightness(0) saturate(100%) invert(62%) sepia(61%) saturate(483%) hue-rotate(79deg) brightness(96%) contrast(92%)" : undefined}
                />
                {inLibrary ? "Saved" : "Save"}
            </button>
            {showLibraryModal && (
                <SaveToLibraryModal
                    item={libraryItem}
                    onClose={() => { setShowLibraryModal(false); setInLibrary(isInLibrary(manga.id, 'manga')); }}
                />
            )}
        </>
    );
}

/* Summary Modal */
function SummaryModal({ description, onClose }: { description: string; onClose: () => void }) {
    return (
        <div className="summary-modal-overlay" onClick={onClose}>
            <div className="summary-modal" onClick={(e) => e.stopPropagation()}>
                <h3>あらすじ — Synopsis</h3>
                <p>{description}</p>
                <button className="close-btn" onClick={onClose}>
                    閉じる — Close
                </button>
            </div>
        </div>
    );
}

function SeriesContent() {
    const searchParams = useSearchParams();
    const id = searchParams.get("id"); // Series ID
    const sourceStr = searchParams.get("source") || "weebcentral";

    const [series, setSeries] = useState<Manga | null>(null);
    const [chapters, setChapters] = useState<Chapter[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showSummary, setShowSummary] = useState(false);
    const [showBatchDownload, setShowBatchDownload] = useState(false);
    const [showTipModal, setShowTipModal] = useState(false);
    const [creatorWallet, setCreatorWallet] = useState<string | null>(null);
    const [isBatchQueuing, setIsBatchQueuing] = useState(false);
    const downloads = useDownloads();
    const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
    const [readChapterIds, setReadChapterIds] = useState<string[]>([]);
    const [chapterProgress, setChapterProgress] = useState<Record<string, number>>({});

    const source = useMemo(() => getSource(sourceStr), [sourceStr]);

    useEffect(() => {
        if (!id) return;

        async function loadData() {
            setLoading(true);
            setError(null);
            try {
                const [mangaData, chaptersData] = await Promise.all([
                    source.getMangaDetails(id!),
                    source.getChapters(id!)
                ]);
                setSeries(mangaData);
                setChapters(chaptersData);
            } catch (error: any) {
                console.error("Failed to load series:", error);
                setError(error.message || "Failed to load series.");
            }
            setLoading(false);
        }

        loadData();
    }, [id, sourceStr]);

    useEffect(() => {
        if (!series?.authorId || sourceStr !== "mangadex") return;
        getCreatorProfile(series.authorId).then((profile) => {
            if (profile?.is_verified && profile.wallet_address) {
                setCreatorWallet(profile.wallet_address);
            }
        });
    }, [series?.authorId, sourceStr]);

    // Load read chapters + progress from local storage (and refresh on window focus)
    useEffect(() => {
        if (!id) return;

        const refresh = () => {
            setReadChapterIds(getReadChapters(id));
            setChapterProgress(getAllChapterProgress(id));
        };

        refresh();
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [id]);

    // Sort chapters based on sortOrder
    const sortedChapters = useMemo(() => {
        const sorted = [...chapters];
        if (sortOrder === "asc") {
            sorted.reverse(); // API returns newest first, so reverse for oldest first
        }
        return sorted;
    }, [chapters, sortOrder]);

    if (!id) {
        return (
            <div className="error-container">
                <p>Invalid Series ID.</p>
                <Link href="/manga" className="btn-primary">Back to Browse</Link>
            </div>
        )
    }

    if (loading) {
        return (
            <div className="loading-container">
                <div className="spinner" />
                <p>Loading Series...</p>
            </div>
        );
    }

    if (error || !series) {
        return (
            <div className="error-container">
                <p>{error || "Manga not found."}</p>
                <Link href="/manga" className="btn-primary">Back to Browse</Link>
            </div>
        );
    }

    const handleDownloadChapter = async (chapterId: string, title: string) => {
        const task = downloads[chapterId];
        if (task) {
            if (task.state === 'downloading') downloadManager.pause(chapterId);
            else if (task.state === 'paused' || task.state === 'error') downloadManager.resume(chapterId);
            return;
        }

        try {
            const pages = await source.getChapterPages(chapterId);
            if (!pages || pages.length === 0) throw new Error("No pages found");
            downloadManager.addDownload(id, chapterId, title, series.cover, pages);
        } catch (e) {
            console.error("Failed to queue download", e);
            alert("Failed to queue download. Check network.");
        }
    };

    const handleBatchDownload = async () => {
        setIsBatchQueuing(true);
        // Only queue chapters that aren't downloaded
        const toDownload = sortedChapters.filter(c => !downloads[c.id] || downloads[c.id].state !== 'completed');

        // Fetch pages sequentially to avoid overloading the source API
        for (const chap of toDownload) {
            try {
                // Skip if already in manager
                if (downloads[chap.id]) continue;

                const pages = await source.getChapterPages(chap.id);
                if (pages && pages.length > 0) {
                    downloadManager.addDownload(id, chap.id, chap.title || `Chapter ${chap.chapter}`, series.cover, pages);
                }
            } catch (e) {
                console.error(`Failed to get pages for ${chap.id}`, e);
            }
        }
        setIsBatchQueuing(false);
        setShowBatchDownload(false);
    };

    return (
        <main className="main-content">
            {/* Tip Modal */}
            {showTipModal && (
                <TipModal
                    onClose={() => setShowTipModal(false)}
                    header={creatorWallet ? "Tip Creator" : "Support Sakura"}
                    subtitle={creatorWallet ? "Send $SAKURA directly to this creator" : "Donate $SAKURA to the Sakura treasury"}
                    receiverAddress={creatorWallet || undefined}
                />
            )}

            {/* Summary Modal */}
            {showSummary && (
                <SummaryModal
                    description={series.description}
                    onClose={() => setShowSummary(false)}
                />
            )}

            {/* Hero Banner */}
            <div className="series-hero">
                <div className="series-hero-bg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={series.cover} alt="" referrerPolicy="no-referrer" />
                </div>
                <div className="series-hero-content">
                    <div className="series-cover">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={series.cover} alt={series.title} referrerPolicy="no-referrer" />
                    </div>
                    <div className="series-info">
                        <h1>{series.title}</h1>

                        {series.author && (
                            <div className="series-author" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ color: "var(--text-muted)" }}>By</span>
                                {sourceStr === 'mangadex' && series.authorId ? (
                                    <Link href={`/creator?id=${series.authorId}`} style={{ color: "var(--sakura-pink)", fontWeight: "bold", textDecoration: "none" }}>
                                        {series.author}
                                    </Link>
                                ) : (
                                    <span style={{ color: "var(--text-secondary)", fontWeight: "bold" }}>
                                        {series.author}
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Tags — limited to 5 */}
                        <div className="genre-tags">
                            {series.tags.slice(0, 5).map((g) => (
                                <span key={g} className="genre-tag">{g}</span>
                            ))}
                            {series.tags.length > 5 && (
                                <span className="genre-tag" style={{ opacity: 0.5 }}>+{series.tags.length - 5}</span>
                            )}
                        </div>

                        {/* Synopsis — short preview + "Read More" button */}
                        <p className="series-synopsis">
                            {series.description.slice(0, 120)}...
                            {series.description.length > 120 && (
                                <button
                                    onClick={() => setShowSummary(true)}
                                    style={{
                                        background: "none",
                                        border: "none",
                                        color: "var(--sakura-pink)",
                                        cursor: "pointer",
                                        fontSize: "inherit",
                                        fontWeight: 600,
                                        marginLeft: 6,
                                        padding: 0,
                                    }}
                                >
                                    Read More
                                </button>
                            )}
                        </p>

                        <div style={{ display: "flex", gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
                            <div>
                                <span style={{ fontSize: 20, fontWeight: 700, color: "var(--sakura-pink)" }}>
                                    {chapters.length}
                                </span>
                                <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 4 }}>
                                    章 Chapters
                                </span>
                            </div>
                            <div>
                                <span style={{ fontSize: 20, fontWeight: 700, color: "var(--purple-accent)" }}>
                                    {series.year || "Unknown"}
                                </span>
                                <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 4 }}>
                                    Year
                                </span>
                            </div>
                        </div>
                        <div className="series-actions">
                            {chapters.length > 0 && (
                                <Link
                                    href={`/chapter?id=${chapters[chapters.length - 1].id}&manga=${id}&source=${sourceStr}`}
                                    className="btn-primary"
                                >
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></svg> 読む — Read First
                                </Link>
                            )}
                            <FavoriteButton manga={series} />
                            <button
                                className="btn-secondary"
                                onClick={() => setShowTipModal(true)}
                                style={{ display: "flex", alignItems: "center", gap: 6 }}
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
                                Tip Creator
                            </button>
                            <Link href="/pass" className="btn-secondary">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="5" rx="2" /><line x1="2" x2="22" y1="10" y2="10" /></svg> 週間パス — Get Pass
                            </Link>
                        </div>
                    </div>
                </div>
            </div>

            {/* Chapter List */}
            <div className="chapter-list">
                <div className="chapter-list-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 className="chapter-list-title">
                        Chapters <span className="jp">チャプター一覧</span>
                    </h2>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            className="btn-secondary"
                            style={{ padding: '6px 12px', fontSize: '13px', background: 'rgba(255, 105, 180, 0.1)', borderColor: 'rgba(255, 105, 180, 0.3)', color: 'var(--sakura-pink)' }}
                            onClick={() => setShowBatchDownload(true)}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></svg>
                            Batch DL
                        </button>
                        <button
                            className="chapter-sort-btn"
                            onClick={() => setSortOrder(prev => prev === "desc" ? "asc" : "desc")}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m3 8 4-4 4 4" /><path d="M7 4v16" /><path d="m17 16 4 4" /><path d="m21 16-4 4" /><path d="M17 20V4" />
                            </svg>
                            {sortOrder === "desc" ? "New → Old" : "Old → New"}
                        </button>
                    </div>
                </div>

                {/* Batch Download Modal */}
                {showBatchDownload && (
                    <div className="reading-mode-modal-overlay" onClick={() => !isBatchQueuing && setShowBatchDownload(false)}>
                        <div className="reading-mode-modal" onClick={e => e.stopPropagation()}>
                            <h2>Download Multiple Chapters</h2>
                            <p>Queue all un-downloaded chapters for offline reading?</p>
                            <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
                                <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setShowBatchDownload(false)} disabled={isBatchQueuing}>
                                    Cancel
                                </button>
                                <button className="btn-primary" style={{ flex: 1 }} onClick={handleBatchDownload} disabled={isBatchQueuing}>
                                    {isBatchQueuing ? "Queuing..." : "Start Downloading"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {sortedChapters.length === 0 && !loading && (
                    <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)" }}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, marginBottom: 12 }}>
                            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                            <line x1="9" y1="10" x2="15" y2="10" />
                        </svg>
                        <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>No readable chapters available</p>
                        <p style={{ fontSize: 13 }}>This title&apos;s chapters may have been removed or are only available on the official publisher&apos;s site.</p>
                    </div>
                )}

                {sortedChapters.map((chapter, idx) => {
                    const isRead = readChapterIds.includes(chapter.id);
                    const progress = chapterProgress[chapter.id] || 0;
                    // "Continue" = first in-progress but unfinished chapter in display order
                    const prevChapter = sortedChapters[idx - 1];
                    const isContinue = !isRead && progress > 0;
                    // Also show continue if prev chapter is read/in-progress and this one isn't started
                    const isNextUp = !isRead && !isContinue && prevChapter && readChapterIds.includes(prevChapter.id);

                    return (
                        <Link
                            key={chapter.id}
                            href={`/chapter?id=${chapter.id}&manga=${id}&source=${sourceStr}`}
                            className={`chapter-item ${isRead ? 'chapter-read' : 'chapter-unread'} ${isContinue || isNextUp ? 'chapter-continue' : ''}`}
                        >
                            <div className="chapter-item-left">
                                <span className="chapter-number">
                                    {isRead && <span style={{ color: 'var(--sakura-pink)', marginRight: 4 }}>✓</span>}
                                    Vol.{chapter.volume} Ch.{chapter.chapter}
                                </span>
                                <div>
                                    <div className="chapter-title">
                                        {chapter.title || `Chapter ${chapter.chapter}`}
                                    </div>
                                    <div className="chapter-pages">
                                        {new Date(chapter.publishAt).toLocaleDateString()}
                                        {isContinue && <span className="continue-badge">Continue ▶</span>}
                                        {isNextUp && <span className="continue-badge">Next ▶</span>}
                                    </div>
                                </div>
                            </div>

                            {/* Download Action */}
                            {(() => {
                                const dl = downloads[chapter.id];
                                const dlIconSize = "24";

                                if (!dl) {
                                    // Not downloaded
                                    return (
                                        <button
                                            className="dl-btn"
                                            onClick={(e) => { e.preventDefault(); handleDownloadChapter(chapter.id, chapter.title || `Chapter ${chapter.chapter}`); }}
                                            title="Download"
                                        >
                                            <LottieIcon src="/icons/wired-outline-199-download-2-hover-pointing.json" size={24} colorFilter="brightness(0) saturate(100%) invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg) brightness(101%) contrast(98%)" />
                                        </button>
                                    );
                                }

                                if (dl.state === 'completed') {
                                    return (
                                        <button className="dl-btn dl-completed" title="Downloaded" onClick={e => e.preventDefault()}>
                                            <LottieIcon src="/icons/wired-outline-24-approved-checked-hover-loading.json" size={24} colorFilter="brightness(0) saturate(100%) invert(62%) sepia(61%) saturate(483%) hue-rotate(79deg) brightness(96%) contrast(92%)" playOnMount />
                                        </button>
                                    );
                                }

                                // Downloading, queued, or paused
                                const pct = dl.pages.length > 0 ? (dl.downloadedPages / dl.pages.length) * 100 : 0;
                                const isDownloading = dl.state === 'downloading';

                                return (
                                    <button
                                        className={`dl-btn ${isDownloading ? 'dl-active' : 'dl-paused'}`}
                                        onClick={(e) => { e.preventDefault(); handleDownloadChapter(chapter.id, chapter.title); }}
                                        title={isDownloading ? "Pause" : "Resume"}
                                    >
                                        <div className="dl-progress-circle" style={{ background: `conic-gradient(var(--sakura-pink) ${pct}%, transparent 0)` }}>
                                            <div className="dl-progress-inner">
                                                {isDownloading ? (
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                                                ) : (
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                                )}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })()}

                            {/* Netflix-style progress bar */}
                            {progress > 0 && (
                                <div className="chapter-progress-bar">
                                    <div
                                        className="chapter-progress-fill"
                                        style={{ width: `${progress}%` }}
                                    />
                                </div>
                            )}
                        </Link>
                    );
                })}
            </div>

            <footer className="footer">
                <p className="footer-jp">桜 — マンガの新しい形</p>
                <p className="footer-text">© 2026 Sakura. Read manga on the blockchain.</p>
                <div className="footer-solana">
                    <span className="sol-dot" />
                    Built on Solana
                </div>
            </footer>
        </main>
    );
}

export default function SeriesPage() {
    return (
        <>
            <Header />
            <Suspense fallback={<div className="loading-container"><div className="spinner" /></div>}>
                <SeriesContent />
            </Suspense>
        </>
    );
}
