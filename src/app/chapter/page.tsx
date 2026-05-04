"use client";

import Link from "next/link";
import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import { checkPassStatus, formatPassTimeRemaining } from "@/lib/pass-check";
import { getSource } from "@/lib/sources";
import { type Chapter } from "@/lib/sources/types";
import { Browser } from '@capacitor/browser';
import { getLocal, setLocal, STORAGE_KEYS, setChapterProgress as saveChapterProgress, getChapterProgress } from "@/lib/storage";
import { downloadManager } from "@/lib/downloads";
import ChapterComments from "@/components/ChapterComments";
import LottieIcon from "@/components/LottieIcon";
import TradeCheckModal from "@/components/TradeCheckModal";
import { getChapterNeighbors } from "@/lib/chapter-order";
import { getDefaultMangaSourceId, isComicSourceId, normalizeMangaSourceId } from "@/lib/sources/source-ids";
import { getChapterScopedKey, parseScopedKey } from "@/lib/sources/source-scope";

const COMIC_CACHE_VERSION_KEY = "sakura_comic_cache_version";
const CURRENT_COMIC_CACHE_VERSION = "4";

/**
 * One-time migration: comic chapter URLs used to be raw xoxocomic.com CDN
 * links, which Cloudflare sometimes serves as HTML at edge nodes far from
 * upstream. The reader now routes every page through the droplet's /img
 * proxy. Drop any cached entries that were saved before that change.
 */
function invalidateStaleComicChapterCache() {
    if (typeof window === "undefined") return;
    try {
        const stored = localStorage.getItem(COMIC_CACHE_VERSION_KEY);
        if (stored === CURRENT_COMIC_CACHE_VERSION) return;
        const cache = getLocal<Record<string, string[]>>(STORAGE_KEYS.CHAPTER_CACHE, {});
        const cleaned: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(cache)) {
            const { sourceId } = parseScopedKey(key);
            if (isComicSourceId(sourceId)) continue;
            cleaned[key] = value;
        }
        setLocal(STORAGE_KEYS.CHAPTER_CACHE, cleaned);
        localStorage.setItem(COMIC_CACHE_VERSION_KEY, CURRENT_COMIC_CACHE_VERSION);
    } catch (e) {
        console.warn("comic cache migration failed", e);
    }
}

type ReadingMode = 'scroll' | 'page';
type ReadingDirection = 'ltr' | 'rtl';

/* ─── Mode Selection Modal ─── */
function ModeSelectionModal({ onSelect }: { onSelect: (mode: ReadingMode) => void }) {
    return (
        <div className="reading-mode-modal-overlay">
            <div className="reading-mode-modal">
                <h2>読み方を選んでください</h2>
                <p>How would you like to read?</p>
                <div className="reading-mode-options">
                    <button className="reading-mode-option" onClick={() => onSelect('scroll')}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
                        </svg>
                        <span className="mode-title">スクロール</span>
                        <span className="mode-subtitle">Infinite Scroll</span>
                        <span className="mode-desc">Scroll through all pages continuously</span>
                    </button>
                    <button className="reading-mode-option" onClick={() => onSelect('page')}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--purple-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                        </svg>
                        <span className="mode-title">ページめくり</span>
                        <span className="mode-subtitle">Page by Page</span>
                        <span className="mode-desc">Swipe or tap to turn pages like a book</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

/* ─── Next Chapter Prompt (Page Mode Overlay) ─── */
function NextChapterOverlay({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
    return (
        <div className="next-chapter-overlay">
            <div className="next-chapter-overlay-content">
                <h2>章が終わりました</h2>
                <p>Chapter Complete!</p>
                <button className="btn-primary next-chapter-btn" onClick={onNext}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 4 15 12 5 20 5 4" /><line x1="19" x2="19" y1="5" y2="19" />
                    </svg>
                    次の章 — Next Chapter
                </button>
                <button className="btn-secondary" onClick={onBack} style={{ marginTop: 12 }}>
                    ← シリーズに戻る — Back to Series
                </button>
            </div>
        </div>
    );
}

/* ─── Reader Overlay (double-tap to show/hide) ─── */
function ReaderOverlay({
    visible,
    chapterTitle,
    currentPage,
    totalPages,
    onPageChange,
    onBack,
    onPrevChapter,
    onNextChapter,
    hasPrevChapter,
    hasNextChapter,
    readingMode,
    onReadingModeChange,
    readingDirection,
    onReadingDirectionChange,
    onOrientationToggle,
    orientation,
    onCheckTrade,
}: {
    visible: boolean;
    chapterTitle: string;
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    onBack: () => void;
    onPrevChapter: () => void;
    onNextChapter: () => void;
    hasPrevChapter: boolean;
    hasNextChapter: boolean;
    readingMode: ReadingMode;
    onReadingModeChange: (mode: ReadingMode) => void;
    readingDirection: ReadingDirection;
    onReadingDirectionChange: (dir: ReadingDirection) => void;
    onOrientationToggle: () => void;
    orientation: 'portrait' | 'landscape';
    onCheckTrade?: () => void;
}) {
    return (
        <div className={`reader-overlay ${visible ? 'visible' : ''}`} onClick={(e) => e.stopPropagation()}>
            {/* Overlay Header */}
            <div className="reader-overlay-header">
                <button className="reader-overlay-back" onClick={onBack}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <div className="reader-overlay-title">{chapterTitle}</div>
                <div className="reader-overlay-page-info">{currentPage}/{totalPages}</div>
            </div>

            {/* Overlay Footer */}
            <div className="reader-overlay-footer">
                {/* Page Navigation Slider Row */}
                <div className="reader-overlay-slider-row">
                    <button
                        className="reader-overlay-skip-btn"
                        onClick={onPrevChapter}
                        disabled={!hasPrevChapter}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" x2="5" y1="5" y2="19" /><polygon points="19 20 9 12 19 4 19 20" /></svg>
                    </button>
                    <span className="reader-overlay-page-num">{currentPage}</span>
                    <input
                        type="range"
                        className="reader-overlay-slider"
                        min={1}
                        max={totalPages}
                        value={currentPage}
                        onChange={(e) => onPageChange(Number(e.target.value))}
                    />
                    <span className="reader-overlay-page-num">{totalPages}</span>
                    <button
                        className="reader-overlay-skip-btn"
                        onClick={onNextChapter}
                        disabled={!hasNextChapter}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" x2="19" y1="5" y2="19" /></svg>
                    </button>
                </div>

                {/* Settings Row */}
                <div className="reader-overlay-settings">
                    <button
                        className={`reader-overlay-setting-btn ${orientation === 'landscape' ? 'active' : ''}`}
                        onClick={onOrientationToggle}
                        title={orientation === 'portrait' ? 'Switch to Landscape' : 'Switch to Portrait'}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            {orientation === 'portrait' ? (
                                <><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" y1="18" x2="12" y2="18" /></>
                            ) : (
                                <><rect x="2" y="5" width="20" height="14" rx="2" ry="2" /><line x1="18" y1="12" x2="18" y2="12" /></>
                            )}
                        </svg>
                        <span>{orientation === 'portrait' ? 'Portrait' : 'Landscape'}</span>
                    </button>

                    <button
                        className={`reader-overlay-setting-btn ${readingDirection === 'rtl' ? 'active' : ''}`}
                        onClick={() => onReadingDirectionChange(readingDirection === 'ltr' ? 'rtl' : 'ltr')}
                        title={readingDirection === 'ltr' ? 'Switch to RTL' : 'Switch to LTR'}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            {readingDirection === 'ltr' ? (
                                <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>
                            ) : (
                                <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>
                            )}
                        </svg>
                        <span>{readingDirection === 'ltr' ? 'LTR' : 'RTL'}</span>
                    </button>

                    <button
                        className="reader-overlay-setting-btn"
                        onClick={() => onReadingModeChange(readingMode === 'scroll' ? 'page' : 'scroll')}
                    >
                        {readingMode === 'scroll' ? (
                            <LottieIcon src="/icons/wired-outline-1384-page-view-array-hover-pinch.json" size={20} colorFilter="brightness(0) invert(1)" playOnMount />
                        ) : (
                            <LottieIcon src="/icons/wired-outline-3411-chevron-down-circle-hover-scale.json" size={20} colorFilter="brightness(0) invert(1)" playOnMount />
                        )}
                        <span>{readingMode === 'scroll' ? 'Page' : 'Scroll'}</span>
                    </button>

                    {onCheckTrade && (
                        <button className="reader-overlay-setting-btn" onClick={onCheckTrade}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                            </svg>
                            <span>Trade</span>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

/* ─── Page-by-Page Reader (Book Mode) ─── */
function PageReader({ pages, currentPage, setCurrentPage, onLastPagePass, onPlaceholderDetected, onDoubleTap }: {
    pages: string[];
    currentPage: number;
    setCurrentPage: (p: number) => void;
    onLastPagePass?: () => void;
    onPlaceholderDetected?: () => void;
    onDoubleTap?: () => void;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [animDir, setAnimDir] = useState<'forward' | 'backward' | null>(null);
    const [animating, setAnimating] = useState(false);
    const lastTapTime = useRef(0);

    const touchStartX = useRef(0);
    const touchStartY = useRef(0);
    const isSwiping = useRef(false);

    useEffect(() => {
        const toPreload = [
            currentPage, currentPage + 1, currentPage + 2, currentPage - 1,
        ].filter(p => p >= 1 && p <= pages.length);
        toPreload.forEach(p => {
            const img = new Image();
            img.src = pages[p - 1];
        });
    }, [currentPage, pages]);

    const goNext = useCallback(() => {
        if (animating) return;
        if (currentPage < pages.length) {
            setAnimating(true);
            setAnimDir('forward');
            setTimeout(() => {
                setCurrentPage(currentPage + 1);
                setAnimDir(null);
                setAnimating(false);
            }, 350);
        } else if (onLastPagePass) {
            onLastPagePass();
        }
    }, [currentPage, pages.length, setCurrentPage, onLastPagePass, animating]);

    const goPrev = useCallback(() => {
        if (animating) return;
        if (currentPage > 1) {
            setAnimating(true);
            setAnimDir('backward');
            setTimeout(() => {
                setCurrentPage(currentPage - 1);
                setAnimDir(null);
                setAnimating(false);
            }, 350);
        }
    }, [currentPage, setCurrentPage, animating]);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        touchStartX.current = e.touches[0].clientX;
        touchStartY.current = e.touches[0].clientY;
        isSwiping.current = false;
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        const dx = Math.abs(e.touches[0].clientX - touchStartX.current);
        const dy = Math.abs(e.touches[0].clientY - touchStartY.current);
        if (dx > dy && dx > 15) {
            isSwiping.current = true;
        }
    }, []);

    const handleTouchEnd = useCallback((e: React.TouchEvent) => {
        if (!isSwiping.current) return;
        const diff = touchStartX.current - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 40) {
            if (diff > 0) goNext();
            else goPrev();
        }
    }, [goNext, goPrev]);

    const handleTap = useCallback((e: React.MouseEvent) => {
        const now = Date.now();
        if (now - lastTapTime.current < 300) {
            onDoubleTap?.();
            lastTapTime.current = 0;
            return;
        }
        lastTapTime.current = now;

        setTimeout(() => {
            if (lastTapTime.current === 0) return;
            if (animating) return;
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const pct = x / rect.width;
            if (pct < 0.3) goPrev();
            else if (pct > 0.7) goNext();
        }, 310);
    }, [goNext, goPrev, animating, onDoubleTap]);

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') goPrev();
            if (e.key === 'ArrowRight') goNext();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [goNext, goPrev]);

    const pageClass = animDir === 'forward'
        ? 'page-turn-forward'
        : animDir === 'backward'
            ? 'page-turn-backward'
            : '';

    return (
        <div
            ref={containerRef}
            className="page-reader"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onClick={handleTap}
        >
            <div className={`page-reader-page ${pageClass}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={pages[currentPage - 1]}
                    alt={`Page ${currentPage}`}
                    draggable={false}
                    referrerPolicy="no-referrer"
                    onLoad={(e) => {
                        const img = e.currentTarget;
                        if (img.naturalWidth === 679 && img.naturalHeight === 5975 && onPlaceholderDetected) {
                            onPlaceholderDetected();
                        }
                    }}
                />
            </div>

            <div className="page-reader-counter">
                {currentPage} / {pages.length}
            </div>

            <button
                className="page-nav-arrow page-nav-prev"
                onClick={(e) => { e.stopPropagation(); goPrev(); }}
                disabled={currentPage <= 1}
                aria-label="Previous page"
            >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <button
                className="page-nav-arrow page-nav-next"
                onClick={(e) => { e.stopPropagation(); goNext(); }}
                disabled={currentPage >= pages.length && !onLastPagePass}
                aria-label="Next page"
            >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
        </div>
    );
}

function ReaderContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const chapterId = searchParams.get("id");
    const mangaId = searchParams.get("manga");
    const sourceStr = normalizeMangaSourceId(searchParams.get("source") || getDefaultMangaSourceId());

    const { publicKey } = useWallet();
    const { setVisible } = useSakuraWalletModal();

    const [pages, setPages] = useState<string[]>([]);
    const [headerVisible, setHeaderVisible] = useState(true);
    const [currentPage, setCurrentPage] = useState(1);
    const [hasAccess, setHasAccess] = useState<boolean | null>(null);
    const [passExpiry, setPassExpiry] = useState<Date | null>(null);
    const [loading, setLoading] = useState(true);
    const [isPremiumChapter, setIsPremiumChapter] = useState(false);
    const [externalUrl, setExternalUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [readingMode, setReadingMode] = useState<ReadingMode | null>(null);
    const [showModeModal, setShowModeModal] = useState(false);

    const [allChapters, setAllChapters] = useState<Chapter[]>([]);
    const [nextChapter, setNextChapter] = useState<Chapter | null>(null);
    const [prevChapter, setPrevChapter] = useState<Chapter | null>(null);
    const [currentChapterInfo, setCurrentChapterInfo] = useState<Chapter | null>(null);
    const [showNextChapterOverlay, setShowNextChapterOverlay] = useState(false);

    const [showPageIndicator, setShowPageIndicator] = useState(false);
    const pageIndicatorTimer = useRef<NodeJS.Timeout | null>(null);

    const [resumeToast, setResumeToast] = useState<string | null>(null);

    // Overlay state
    const [overlayVisible, setOverlayVisible] = useState(false);
    const [showTradeModal, setShowTradeModal] = useState(false);
    const overlayAutoHideTimer = useRef<NodeJS.Timeout | null>(null);

    // Reading settings
    const [readingDirection, setReadingDirection] = useState<ReadingDirection>(() =>
        (getLocal<string>('sakura_reading_direction', 'ltr') as ReadingDirection) || 'ltr'
    );
    const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(() =>
        (getLocal<string>('sakura_reading_orientation', 'portrait') as 'portrait' | 'landscape') || 'portrait'
    );

    // Double-tap for scroll mode
    const lastScrollTap = useRef(0);

    const toggleOverlay = useCallback(() => {
        setOverlayVisible(prev => {
            const next = !prev;
            if (overlayAutoHideTimer.current) clearTimeout(overlayAutoHideTimer.current);
            if (next) {
                overlayAutoHideTimer.current = setTimeout(() => setOverlayVisible(false), 5000);
            }
            return next;
        });
    }, []);

    const resetAutoHide = useCallback(() => {
        if (overlayAutoHideTimer.current) clearTimeout(overlayAutoHideTimer.current);
        overlayAutoHideTimer.current = setTimeout(() => setOverlayVisible(false), 5000);
    }, []);

    const handleScrollDoubleTap = useCallback((e: React.MouseEvent) => {
        const now = Date.now();
        if (now - lastScrollTap.current < 300) {
            toggleOverlay();
            lastScrollTap.current = 0;
        } else {
            lastScrollTap.current = now;
        }
    }, [toggleOverlay]);

    // Orientation lock
    const toggleOrientation = useCallback(() => {
        const next = orientation === 'portrait' ? 'landscape' : 'portrait';
        setOrientation(next);
        setLocal('sakura_reading_orientation', next);
        resetAutoHide();
        try {
            const screenAny = screen as any;
            if (screenAny.orientation?.lock) {
                screenAny.orientation.lock(next === 'landscape' ? 'landscape-primary' : 'portrait-primary').catch(() => {});
            }
        } catch {}
    }, [orientation, resetAutoHide]);

    const handleReadingDirectionChange = useCallback((dir: ReadingDirection) => {
        setReadingDirection(dir);
        setLocal('sakura_reading_direction', dir);
        resetAutoHide();
    }, [resetAutoHide]);

    const handleOverlayModeChange = useCallback((mode: ReadingMode) => {
        setReadingMode(mode);
        setLocal(STORAGE_KEYS.READING_MODE, mode);
        resetAutoHide();
    }, [resetAutoHide]);

    const handleOverlayPageChange = useCallback((page: number) => {
        setCurrentPage(page);
        resetAutoHide();
        if (readingMode === 'scroll') {
            const images = document.querySelectorAll(".reader-page");
            if (images[page - 1]) {
                images[page - 1].scrollIntoView({ behavior: 'smooth' });
            }
        }
    }, [readingMode, resetAutoHide]);

    // Load reading mode preference
    useEffect(() => {
        const saved = getLocal<string | null>(STORAGE_KEYS.READING_MODE, null);
        if (saved === 'scroll' || saved === 'page') {
            setReadingMode(saved);
        } else {
            setShowModeModal(true);
        }
    }, []);

    const handleModeSelect = (mode: ReadingMode) => {
        setReadingMode(mode);
        setLocal(STORAGE_KEYS.READING_MODE, mode);
        setShowModeModal(false);
    };

    // Check Access & Fetch Content
    useEffect(() => {
        let isMounted = true;

        async function checkAccessAndLoad() {
            if (!chapterId) {
                if (isMounted) setError("No Chapter ID provided.");
                return;
            }

            try {
                setLoading(true);
                setError(null);
                setExternalUrl(null);

                invalidateStaleComicChapterCache();

                const cacheKey = getChapterScopedKey(chapterId, sourceStr);
                const cache = getLocal<Record<string, string[]>>(STORAGE_KEYS.CHAPTER_CACHE, {});
                const isCached = cache[cacheKey] && cache[cacheKey].length > 0;

                const source = getSource(sourceStr);
                let requiresPass = false;
                let manga: any = null;

                let chapterList: Chapter[] = [];
                if (mangaId) {
                    try {
                        chapterList = await source.getChapters(mangaId, 500, 0);
                        const neighbors = getChapterNeighbors(chapterList, chapterId);
                        if (isMounted) {
                            setAllChapters(neighbors.ordered);
                            setCurrentChapterInfo(neighbors.current);
                            setNextChapter(neighbors.next);
                            setPrevChapter(neighbors.prev);
                        }
                    } catch (e) { console.warn("Failed to fetch chapter list", e); }
                }

                if (isCached) {
                    if (isMounted) {
                        setPages(cache[cacheKey]);
                        setHasAccess(true);
                        setLoading(false);
                    }
                    return;
                }

                if (sourceStr === 'mangadex') {
                    const { getChapterDetails } = await import("@/lib/content-source");
                    const chapterDetails = await getChapterDetails(chapterId);

                    if (chapterDetails?.externalUrl) {
                        if (isMounted) {
                            setExternalUrl(chapterDetails.externalUrl);
                            setLoading(false);
                        }
                        return;
                    }

                    if (mangaId) {
                        const mangaDetails = await source.getMangaDetails(mangaId);
                        manga = mangaDetails;

                        if (manga?.status === "ongoing") {
                            const latestChapters = [...chapterList]
                                .sort((a, b) => new Date(b.publishAt || 0).getTime() - new Date(a.publishAt || 0).getTime())
                                .slice(0, 3);
                            const isLatest = latestChapters.some(ch => ch.id === chapterId);
                            if (isLatest) requiresPass = true;
                        }
                    }
                } else if (mangaId) {
                    try {
                        manga = await source.getMangaDetails(mangaId);
                    } catch (e) { console.warn("Failed to fetch manga details", e); }
                }

                let userHasPass = false;
                if (requiresPass) {
                    setIsPremiumChapter(true);
                    if (publicKey) {
                        const status = await checkPassStatus(publicKey.toBase58());
                        userHasPass = status.valid;
                        if (status.expiresAt && isMounted) setPassExpiry(status.expiresAt);
                    }
                } else {
                    userHasPass = true;
                }

                if (isMounted) setHasAccess(userHasPass);

                if (userHasPass) {
                    let urls: string[] = [];
                    const dlTask = downloadManager.getTask(chapterId);
                    if (dlTask && dlTask.state === 'completed') {
                        for (let i = 0; i < dlTask.pages.length; i++) {
                            const localUrl = await downloadManager.getLocalPageUrl(mangaId!, chapterId!, i);
                            if (localUrl) urls.push(localUrl);
                        }
                    }

                    if (urls.length === 0) {
                        urls = await source.getChapterPages(chapterId);
                    }

                    if (isMounted) {
                        if (urls.length > 0) {
                            setPages(urls);

                            try {
                                const existingCache = getLocal<Record<string, string[]>>(STORAGE_KEYS.CHAPTER_CACHE, {});
                                const entries = Object.entries(existingCache);
                                if (entries.length > 20) {
                                    const trimmed = Object.fromEntries(entries.slice(-19));
                                    trimmed[cacheKey] = urls;
                                    setLocal(STORAGE_KEYS.CHAPTER_CACHE, trimmed);
                                } else {
                                    existingCache[cacheKey] = urls;
                                    setLocal(STORAGE_KEYS.CHAPTER_CACHE, existingCache);
                                }
                            } catch (e) { console.warn("Cache save failed", e); }

                            try {
                                const history = getLocal(STORAGE_KEYS.HISTORY, []);
                                const newEntry = {
                                    mangaId,
                                    chapterId,
                                    sourceId: sourceStr,
                                    title: manga?.title || "Unknown Title",
                                    cover: manga?.cover || "/placeholder.png",
                                    lastReadAt: Date.now()
                                };
                                const filtered = history.filter((h: any) => !(h.mangaId === mangaId && normalizeMangaSourceId(h.sourceId) === sourceStr));
                                setLocal(STORAGE_KEYS.HISTORY, [newEntry, ...filtered].slice(0, 50));
                            } catch (e) { console.error("Failed to save history", e); }
                        } else {
                            throw new Error("No pages returned from Source.");
                        }
                    }
                }

            } catch (err: any) {
                console.error("Error loading chapter:", err);
                if (isMounted) setError(err.message || "Failed to load chapter.");
            } finally {
                if (isMounted) setLoading(false);
            }
        }

        checkAccessAndLoad();
        return () => { isMounted = false; };
    }, [chapterId, mangaId, publicKey, sourceStr]);

    const goToNextChapter = useCallback(() => {
        if (nextChapter && mangaId) {
            window.scrollTo({ top: 0 });
            setCurrentPage(1);
            setShowNextChapterOverlay(false);
            setOverlayVisible(false);
            router.push(`/chapter?id=${nextChapter.id}&manga=${mangaId}&source=${sourceStr}`);
        }
    }, [nextChapter, mangaId, sourceStr, router]);

    const goToPrevChapter = useCallback(() => {
        if (prevChapter && mangaId) {
            window.scrollTo({ top: 0 });
            setCurrentPage(1);
            setOverlayVisible(false);
            router.push(`/chapter?id=${prevChapter.id}&manga=${mangaId}&source=${sourceStr}`);
        }
    }, [prevChapter, mangaId, sourceStr, router]);

    const goBackToSeries = useCallback(() => {
        router.push(`/title?id=${mangaId}&source=${sourceStr}`);
    }, [mangaId, sourceStr, router]);

    // Scroll-mode header hide + progress tracking + page indicator
    const scrollThrottleRef = useRef(false);
    // Track scroll direction so the header reveals on scroll-up and hides
    // on scroll-down — instead of the old "only visible in the first 100px"
    // behaviour, which made the chapter navbar effectively unreachable
    // mid-chapter unless the user scrolled all the way back up.
    const lastScrollYRef = useRef(0);
    const handleScroll = useCallback(() => {
        if (scrollThrottleRef.current) return;
        scrollThrottleRef.current = true;
        setTimeout(() => { scrollThrottleRef.current = false; }, 100);

        const scrollY = window.scrollY;
        const last = lastScrollYRef.current;
        if (scrollY < 100) {
            setHeaderVisible(true);
        } else if (scrollY < last - 4) {
            setHeaderVisible(true);
        } else if (scrollY > last + 8) {
            setHeaderVisible(false);
        }
        lastScrollYRef.current = scrollY;

        if (readingMode === 'scroll') {
            const images = document.querySelectorAll(".reader-page");
            images.forEach((img, idx) => {
                const rect = img.getBoundingClientRect();
                if (rect.top < window.innerHeight / 2 && rect.bottom > 0) {
                    setCurrentPage(idx + 1);
                }
            });

            setShowPageIndicator(true);
            if (pageIndicatorTimer.current) clearTimeout(pageIndicatorTimer.current);
            pageIndicatorTimer.current = setTimeout(() => setShowPageIndicator(false), 2000);

            const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
            if (scrollHeight > 0 && mangaId && chapterId) {
                const progress = (scrollY / scrollHeight) * 100;
                saveChapterProgress(mangaId, chapterId, progress, sourceStr);
            }
        }
    }, [readingMode, mangaId, chapterId]);

    useEffect(() => {
        window.addEventListener("scroll", handleScroll, { passive: true });
        return () => window.removeEventListener("scroll", handleScroll);
    }, [handleScroll]);

    useEffect(() => {
        if (readingMode === 'page' && pages.length > 0 && mangaId && chapterId) {
            const progress = (currentPage / pages.length) * 100;
            saveChapterProgress(mangaId, chapterId, progress, sourceStr);
        }
    }, [currentPage, pages.length, readingMode, mangaId, chapterId]);

    // Auto-resume reading position
    useEffect(() => {
        if (!pages.length || !mangaId || !chapterId || !readingMode) return;

        const savedProgress = getChapterProgress(mangaId, chapterId, sourceStr);
        if (savedProgress > 5 && savedProgress < 95) {
            if (readingMode === 'scroll') {
                const timer = setTimeout(() => {
                    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
                    const targetScroll = (savedProgress / 100) * scrollHeight;
                    window.scrollTo({ top: targetScroll, behavior: 'smooth' });

                    const resumePage = Math.ceil((savedProgress / 100) * pages.length);
                    setResumeToast(`Resumed at page ${resumePage} / ${pages.length}`);
                    setTimeout(() => setResumeToast(null), 3000);
                }, 800);
                return () => clearTimeout(timer);
            } else {
                const resumePage = Math.max(1, Math.ceil((savedProgress / 100) * pages.length));
                setCurrentPage(resumePage);
                setResumeToast(`Resumed at page ${resumePage} / ${pages.length}`);
                setTimeout(() => setResumeToast(null), 3000);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pages.length, readingMode]);

    // Cleanup orientation lock on unmount
    useEffect(() => {
        return () => {
            try {
                const screenAny = screen as any;
                if (screenAny.orientation?.unlock) screenAny.orientation.unlock();
            } catch {}
        };
    }, []);

    if (!chapterId) return null;

    if (showModeModal) {
        return <ModeSelectionModal onSelect={handleModeSelect} />;
    }

    if (showNextChapterOverlay && nextChapter) {
        return (
            <NextChapterOverlay
                onNext={goToNextChapter}
                onBack={goBackToSeries}
            />
        );
    }

    if (error) {
        return (
            <div className="error-container" style={{ height: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 16 }}>
                <h3>Error Loading Chapter</h3>
                <p style={{ color: "var(--love)", textAlign: "center", maxWidth: "80%" }}>{error}</p>
                <button className="btn-primary" onClick={() => window.location.reload()}>Retry</button>
                <button className="btn-secondary" onClick={() => router.back()}>← Go Back</button>
            </div>
        );
    }

    if (externalUrl && hasAccess) {
        return (
            <div className="pass-gate">
                <div className="pass-gate-content">
                    <div className="pass-gate-icon">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" x2="21" y1="14" y2="3" />
                        </svg>
                    </div>
                    <div className="premium-badge">External Source</div>
                    <h2 style={{ fontFamily: "var(--font-jp)", fontSize: 24, marginBottom: 8 }}>Official Source Only</h2>
                    <p style={{ fontSize: 16, color: "var(--text-secondary)", marginBottom: 16, textAlign: "center" }}>
                        This content is hosted on an official site (e.g. MangaPlus).<br />
                        Your <strong>Sakura Premium</strong> allows you to access it.
                    </p>
                    <button onClick={() => Browser.open({ url: externalUrl })} className="btn-primary" style={{ minWidth: 280, justifyContent: "center" }}>Open Official Site</button>
                    <button onClick={() => router.back()} style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 16, background: "none", border: "none", cursor: "pointer" }}>← Go Back</button>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="reader">
                <div className="loading-container" style={{ height: "100vh" }}>
                    <div className="spinner" />
                    <p>Loading Chapter...</p>
                </div>
            </div>
        );
    }

    if (!hasAccess && isPremiumChapter) {
        return (
            <div className="pass-gate">
                <div className="pass-gate-content">
                    <div className="pass-gate-icon">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                    </div>
                    <div className="premium-badge">Sakura Premium</div>
                    <h2 style={{ fontFamily: "var(--font-jp)", fontSize: 28, marginBottom: 8 }}>最新話はプレミアム限定です</h2>
                    <p style={{ fontSize: 16, color: "var(--text-secondary)", marginBottom: 8 }}>
                        This is one of the latest chapters. <br /><strong>Sakura Premium</strong> is required to read it.
                    </p>
                    <div style={{ display: "flex", gap: 12, flexDirection: "column", alignItems: "center" }}>
                        <Link href="/pass" className="btn-primary" style={{ minWidth: 280, justifyContent: "center" }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="5" rx="2" /><line x1="2" x2="22" y1="10" y2="10" /></svg>
                            プレミアムに参加 — Get Premium ($10/mo)
                        </Link>
                        {!publicKey && (
                            <button className="btn-secondary" style={{ minWidth: 280, justifyContent: "center" }} onClick={() => setVisible(true)}>
                                <LottieIcon src="/icons/wired-outline-421-wallet-purse-hover-pinch.json" size={18} colorFilter="brightness(0) invert(1) opacity(0.7)" replayIntervalMs={3000} autoplay />
                                ログイン — Sign Up / Login
                            </button>
                        )}
                        <button onClick={() => router.back()} style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, background: "none", border: "none", cursor: "pointer" }}>← 戻る — Go Back</button>
                    </div>
                </div>
            </div>
        );
    }

    const chapterTitle = currentChapterInfo
        ? `Ch. ${currentChapterInfo.chapter || '?'}${currentChapterInfo.title ? ` — ${currentChapterInfo.title}` : ''}`
        : `Chapter`;

    return (
        <div className="reader">
            {/* Old Header (hidden when overlay is active) */}
            <div className={`reader-header ${headerVisible && !overlayVisible ? "" : "hidden"}`}>
                <button onClick={() => router.back()} className="reader-back">
                    ← 戻る Back
                </button>
                <span className="reader-title">
                    {readingMode === 'page' ? 'ページめくり Page Mode' : 'スクロール Scroll Mode'}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button
                        onClick={() => {
                            const newMode: ReadingMode = readingMode === 'scroll' ? 'page' : 'scroll';
                            setReadingMode(newMode);
                            setLocal(STORAGE_KEYS.READING_MODE, newMode);
                        }}
                        style={{
                            background: "none", border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--radius-sm)", padding: "4px 8px",
                            color: "var(--text-muted)", cursor: "pointer", fontSize: 11
                        }}
                    >
                        {readingMode === 'scroll' ? <><LottieIcon src="/icons/wired-outline-1384-page-view-array-hover-pinch.json" size={14} colorFilter="brightness(0) invert(1) opacity(0.6)" /> Page</> : <><LottieIcon src="/icons/wired-outline-3411-chevron-down-circle-hover-scale.json" size={14} colorFilter="brightness(0) invert(1) opacity(0.6)" /> Scroll</>}
                    </button>
                    {passExpiry && (
                        <span style={{ fontSize: 11, color: "#4ade80" }}>
                            🎴 {formatPassTimeRemaining(passExpiry)}
                        </span>
                    )}
                    <span className="reader-progress">
                        {currentPage} / {pages.length} ページ
                    </span>
                </div>
            </div>

            {/* Reader Content */}
            {readingMode === 'page' ? (
                <PageReader
                    pages={pages}
                    currentPage={currentPage}
                    setCurrentPage={setCurrentPage}
                    onLastPagePass={() => setShowNextChapterOverlay(true)}
                    onPlaceholderDetected={() => setExternalUrl("https://mangadex.org")}
                    onDoubleTap={toggleOverlay}
                />
            ) : (
                <div className="scroll-reader" onClick={handleScrollDoubleTap}>
                    {pages.map((url, index) => (
                        <div key={index} className="reader-page" id={`page-${index + 1}`}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={url}
                                alt={`Page ${index + 1}`}
                                loading={index < 3 ? "eager" : "lazy"}
                                referrerPolicy="no-referrer"
                                onLoad={(e) => {
                                    const img = e.currentTarget;
                                    if (img.naturalWidth === 679 && img.naturalHeight === 5975) {
                                        setExternalUrl("https://mangadex.org");
                                    }
                                }}
                            />
                        </div>
                    ))}
                </div>
            )}

            {/* Reader Overlay */}
            <ReaderOverlay
                visible={overlayVisible}
                chapterTitle={chapterTitle}
                currentPage={currentPage}
                totalPages={pages.length}
                onPageChange={handleOverlayPageChange}
                onBack={goBackToSeries}
                onPrevChapter={goToPrevChapter}
                onNextChapter={goToNextChapter}
                hasPrevChapter={!!prevChapter}
                hasNextChapter={!!nextChapter}
                readingMode={readingMode || 'scroll'}
                onReadingModeChange={handleOverlayModeChange}
                readingDirection={readingDirection}
                onReadingDirectionChange={handleReadingDirectionChange}
                onOrientationToggle={toggleOrientation}
                orientation={orientation}
                onCheckTrade={() => { setShowTradeModal(true); if (overlayAutoHideTimer.current) clearTimeout(overlayAutoHideTimer.current); }}
            />

            <TradeCheckModal isOpen={showTradeModal} onClose={() => setShowTradeModal(false)} />

            {/* Floating Page Indicator (scroll mode) */}
            {readingMode === 'scroll' && pages.length > 0 && (
                <div className={`floating-page-indicator ${showPageIndicator ? 'visible' : ''}`}>
                    {currentPage} / {pages.length}
                </div>
            )}

            {/* Resume Toast */}
            {resumeToast && (
                <div className="resume-toast">
                    🌸 {resumeToast}
                </div>
            )}

            {/* End of Chapter — Next Chapter Prompt */}
            {pages.length > 0 && readingMode === 'scroll' && (
                <div className="next-chapter-prompt">
                    <h3>おわり — End of Chapter</h3>
                    {nextChapter ? (
                        <>
                            <button className="btn-primary next-chapter-btn" onClick={goToNextChapter}>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="5 4 15 12 5 20 5 4" /><line x1="19" x2="19" y1="5" y2="19" />
                                </svg>
                                次の章 — Next Chapter
                            </button>
                            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                                Ch. {nextChapter.chapter}{nextChapter.title ? ` — ${nextChapter.title}` : ''}
                            </p>
                        </>
                    ) : (
                        <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 8 }}>
                            No more chapters available.
                        </p>
                    )}
                    <button className="btn-secondary" onClick={goBackToSeries} style={{ marginTop: 16 }}>
                        ← シリーズに戻る — Back to Series
                    </button>
                </div>
            )}

            {/* Chapter Comments */}
            {pages.length > 0 && mangaId && chapterId && (
                <ChapterComments mangaId={mangaId} chapterId={chapterId} />
            )}
        </div>
    );
}

export default function ReaderPage() {
    return (
        <Suspense fallback={<div className="loading-container"><div className="spinner" /></div>}>
            <ReaderContent />
        </Suspense>
    );
}
