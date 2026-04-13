"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import Header from "@/components/Header";
import Link from "next/link";
import {
    getNovel, getChapters, getProgress, getUserUnlocks, canReadChapter,
    getMilestones, type Novel, type NovelChapter, type NovelMilestone,
} from "@/lib/novel";
import { parseNovelDetail, getHDCover, type AllNovelDetail, type AllNovelChapter } from "@/lib/allnovel";
import { checkPassStatus } from "@/lib/pass-check";
import { truncateAddress } from "@/lib/solana";
import {
    addNovelDownload, getNovelDownloadsIndex, removeNovelDownload,
    isInLibrary, type NovelDownloadEntry,
} from "@/lib/storage";
import LottieIcon from "@/components/LottieIcon";

const SaveToLibraryModal = dynamic(() => import("@/components/SaveToLibraryModal"), { ssr: false });
const NovelComments = dynamic(() => import("@/components/NovelComments"), { ssr: false });
const Lottie = dynamic(() => import("lottie-react"), { ssr: false });

function BookIcon({ size = 40 }: { size?: number }) {
    const [animData, setAnimData] = useState<object | null>(null);
    useEffect(() => {
        fetch("/icons/wired-outline-779-books-hover-hit.json").then(r => r.json()).then(setAnimData).catch(() => {});
    }, []);
    if (!animData) return null;
    return <Lottie animationData={animData} loop autoplay style={{ width: size, height: size, opacity: 0.4 }} />;
}

/* ═══════ External Novel Details ═══════ */

function ExternalDetailsContent() {
    const params = useSearchParams();
    const path = params.get("path") || "";

    const [detail, setDetail] = useState<AllNovelDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [showLibrary, setShowLibrary] = useState(false);
    const [inLibrary, setInLibrary] = useState(false);
    const [downloadedSet, setDownloadedSet] = useState<Set<string>>(new Set());
    const [downloading, setDownloading] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (path) setInLibrary(isInLibrary(path, 'novel'));
    }, [path]);

    useEffect(() => {
        if (!path) return;
        setLoading(true);
        parseNovelDetail(path).then(async (d) => {
            setDetail(d);
            setLoading(false);
            if (d.name) {
                const hd = await getHDCover(d.name);
                if (hd) setDetail(prev => prev ? { ...prev, cover: hd } : prev);
            }
        }).catch(() => setLoading(false));
    }, [path]);

    useEffect(() => {
        const index = getNovelDownloadsIndex();
        const set = new Set(index.filter(e => e.source === "sakura" && e.novelId === path).map(e => e.chapterId));
        setDownloadedSet(set);
    }, [path]);

    const handleDownloadChapter = async (ch: AllNovelChapter) => {
        if (!detail) return;
        setDownloading(prev => new Set(prev).add(ch.path));
        try {
            const { parseChapterContent } = await import("@/lib/allnovel");
            const content = await parseChapterContent(ch.path);
            const entry: NovelDownloadEntry = {
                novelId: path, chapterId: ch.path, chapterNumber: ch.chapterNumber,
                chapterName: ch.name, novelTitle: detail.name, coverUrl: detail.cover,
                source: "sakura", downloadedAt: Date.now(), sizeBytes: new Blob([content]).size,
            };
            addNovelDownload(entry, content);
            setDownloadedSet(prev => new Set(prev).add(ch.path));
        } catch (e) { console.error("Download failed:", e); }
        setDownloading(prev => { const n = new Set(prev); n.delete(ch.path); return n; });
    };

    const handleRemoveDownload = (ch: AllNovelChapter) => {
        removeNovelDownload("sakura", path, ch.path);
        setDownloadedSet(prev => { const n = new Set(prev); n.delete(ch.path); return n; });
    };

    if (loading) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 60, textAlign: "center" }}>
                        <div className="loading-skeleton" style={{ width: "100%", maxWidth: 400, height: 300, borderRadius: 20, margin: "0 auto" }} />
                        <div className="loading-skeleton" style={{ width: 200, height: 24, borderRadius: 8, margin: "16px auto" }} />
                    </section>
                </main>
            </>
        );
    }

    if (!detail) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <p style={{ color: "var(--text-muted)", fontSize: 16 }}>Novel not found.</p>
                        <Link href="/novel" style={{ color: "var(--sakura-pink)", fontSize: 14, marginTop: 16, display: "inline-block" }}>Back to Browse</Link>
                    </section>
                </main>
            </>
        );
    }

    return (
        <>
            <Header />
            <main className="main-content">
                <div style={{ position: "relative", width: "100%", height: 280, overflow: "hidden" }}>
                    {detail.cover && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={detail.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(20px) brightness(0.4)", transform: "scale(1.1)" }} />
                    )}
                    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 0%, var(--bg-deep) 100%)" }} />
                    <div style={{ position: "absolute", bottom: 20, left: 20, right: 20, display: "flex", gap: 16, alignItems: "flex-end" }}>
                        <div style={{ width: 120, flexShrink: 0, borderRadius: 12, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
                            {detail.cover ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={detail.cover} alt={detail.name} style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover", imageRendering: "auto" }} />
                            ) : (
                                <div style={{ width: "100%", aspectRatio: "2/3", background: "var(--bg-surface)", display: "flex", alignItems: "center", justifyContent: "center" }}><BookIcon size={40} /></div>
                            )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <h1 style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.2, margin: 0, color: "#fff" }}>{detail.name}</h1>
                            {detail.author && <p style={{ margin: "4px 0", fontSize: 12, color: "var(--text-secondary)" }}>by {detail.author}</p>}
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                                {detail.status && (
                                    <span style={{ padding: "2px 10px", borderRadius: 12, fontSize: 10, fontWeight: 700, background: "rgba(255,107,157,0.2)", color: "var(--sakura-pink)", textTransform: "capitalize" }}>
                                        {detail.status}
                                    </span>
                                )}
                                {detail.genres?.split(",").slice(0, 3).map(g => (
                                    <span key={g.trim()} style={{ padding: "2px 10px", borderRadius: 12, fontSize: 10, background: "rgba(255,255,255,0.08)", color: "var(--text-secondary)" }}>{g.trim()}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                <section className="section" style={{ paddingTop: 16 }}>
                    <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                        <div style={{ flex: 1, textAlign: "center", padding: "10px 4px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--sakura-pink)" }}>{detail.chapters.length}</p>
                            <p style={{ margin: 0, fontSize: 10, color: "var(--text-muted)" }}>Chapters</p>
                        </div>
                        <div style={{ flex: 1, textAlign: "center", padding: "10px 4px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#4ade80" }}>FREE</p>
                            <p style={{ margin: 0, fontSize: 10, color: "var(--text-muted)" }}>All Chapters</p>
                        </div>
                    </div>

                    <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                        {detail.chapters.length > 0 && (
                            <Link
                                href={`/novel/read?source=external&path=${encodeURIComponent(path)}&chapter=1`}
                                style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 16px", borderRadius: 14, textDecoration: "none", background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))", color: "#fff", fontWeight: 700, fontSize: 14, boxShadow: "0 4px 20px rgba(255,107,157,0.3)" }}
                            >
                                Start Reading
                            </Link>
                        )}
                        <button onClick={() => setShowLibrary(true)} style={{ padding: "10px 14px", borderRadius: 14, background: inLibrary ? "rgba(76,175,80,0.15)" : "rgba(255,255,255,0.06)", border: `1px solid ${inLibrary ? "rgba(76,175,80,0.3)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <LottieIcon
                                src={inLibrary ? "/icons/wired-outline-24-approved-checked-hover-loading.json" : "/icons/wired-outline-2620-bookmark-alt-hover-flutter.json"}
                                size={24}
                                playOnMount
                                colorFilter={inLibrary ? "brightness(0) saturate(100%) invert(62%) sepia(61%) saturate(483%) hue-rotate(79deg) brightness(96%) contrast(92%)" : undefined}
                            />
                        </button>
                    </div>

                    {detail.summary && (
                        <div style={{ marginBottom: 20, padding: "16px", borderRadius: 14, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Synopsis</h3>
                            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{detail.summary}</p>
                        </div>
                    )}

                    <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: "var(--text-primary)" }}>Chapters</h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 100 }}>
                        {detail.chapters.map(ch => {
                            const isDownloaded = downloadedSet.has(ch.path);
                            const isDownloading = downloading.has(ch.path);
                            return (
                                <div key={ch.path} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <Link
                                        href={`/novel/read?source=external&path=${encodeURIComponent(path)}&chapter=${ch.chapterNumber}&chapterPath=${encodeURIComponent(ch.path)}`}
                                        style={{ textDecoration: "none", flex: 1, minWidth: 0 }}
                                    >
                                        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", transition: "all 0.2s ease" }}>
                                            <span style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,107,157,0.15)", color: "var(--sakura-pink)", fontSize: 12, fontWeight: 700 }}>
                                                {ch.chapterNumber}
                                            </span>
                                            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                                {ch.name || `Chapter ${ch.chapterNumber}`}
                                            </p>
                                        </div>
                                    </Link>
                                    <button
                                        onClick={() => isDownloaded ? handleRemoveDownload(ch) : handleDownloadChapter(ch)}
                                        disabled={isDownloading}
                                        style={{ width: 36, height: 36, borderRadius: 10, border: "none", background: isDownloaded ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.04)", color: isDownloaded ? "#4ade80" : "var(--text-muted)", cursor: isDownloading ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 14 }}
                                        title={isDownloaded ? "Remove download" : "Download for offline"}
                                    >
                                        {isDownloading ? "..." : isDownloaded ? "✓" : "↓"}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </section>

                {showLibrary && (
                    <SaveToLibraryModal
                        item={{ id: path, title: detail.name, image: detail.cover, type: "novel", source: "external", addedAt: Date.now() }}
                        onClose={() => { setShowLibrary(false); setInLibrary(isInLibrary(path, 'novel')); }}
                    />
                )}

                <footer className="footer">
                    <p className="footer-jp">桜 — 物語の新しい形</p>
                    <p className="footer-text">© 2026 Sakura.</p>
                </footer>
            </main>
        </>
    );
}

/* ═══════ Sakura (Creator) Details ═══════ */

function SakuraDetailsContent() {
    const params = useSearchParams();
    const novelId = params.get("id") || "";
    const { publicKey } = useWallet();
    const wallet = publicKey?.toBase58() || null;

    const [novel, setNovel] = useState<Novel | null>(null);
    const [chapters, setChapters] = useState<Omit<NovelChapter, "content">[]>([]);
    const [loading, setLoading] = useState(true);
    const [progress, setProgress] = useState<{ chapter_number: number; scroll_position: number } | null>(null);
    const [unlockedChapters, setUnlockedChapters] = useState<Set<number>>(new Set());
    const [hasPass, setHasPass] = useState(false);
    const [showLibrary, setShowLibrary] = useState(false);
    const [inLibrary, setInLibrary] = useState(false);
    const [accessMap, setAccessMap] = useState<Map<number, boolean>>(new Map());
    const [milestones, setMilestones] = useState<NovelMilestone[]>([]);
    const [downloadedSet, setDownloadedSet] = useState<Set<string>>(new Set());
    const [downloading, setDownloading] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (novelId) setInLibrary(isInLibrary(novelId, 'novel'));
    }, [novelId]);

    const load = useCallback(async () => {
        if (!novelId) return;
        setLoading(true);
        const [n, ch] = await Promise.all([getNovel(novelId), getChapters(novelId)]);
        setNovel(n);
        setChapters(ch.filter(c => c.published));
        if (wallet) {
            const [prog, unlocks, pass, mils] = await Promise.all([
                getProgress(wallet, novelId), getUserUnlocks(wallet, novelId),
                checkPassStatus(wallet), getMilestones(wallet, novelId),
            ]);
            setProgress(prog);
            setUnlockedChapters(new Set(unlocks));
            setHasPass(pass.valid);
            setMilestones(mils);
            const published = ch.filter(c => c.published);
            const accessChecks = await Promise.all(
                published.map(c => canReadChapter(wallet, novelId, c.chapter_number).then(ok => [c.chapter_number, ok] as [number, boolean]))
            );
            setAccessMap(new Map(accessChecks));
        }
        setLoading(false);
    }, [novelId, wallet]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        const index = getNovelDownloadsIndex();
        setDownloadedSet(new Set(index.filter(e => e.source === "sakura" && e.novelId === novelId).map(e => e.chapterId)));
    }, [novelId]);

    const handleDownloadChapter = async (ch: Omit<NovelChapter, "content">) => {
        if (!novel) return;
        setDownloading(prev => new Set(prev).add(String(ch.chapter_number)));
        try {
            const { getChapterContent } = await import("@/lib/novel");
            const full = await getChapterContent(novelId, ch.chapter_number);
            if (full) {
                const entry: NovelDownloadEntry = {
                    novelId, chapterId: String(ch.chapter_number), chapterNumber: ch.chapter_number,
                    chapterName: ch.title, novelTitle: novel.title, coverUrl: novel.cover_url,
                    source: "sakura", downloadedAt: Date.now(), sizeBytes: new Blob([full.content]).size,
                };
                addNovelDownload(entry, full.content);
                setDownloadedSet(prev => new Set(prev).add(String(ch.chapter_number)));
            }
        } catch (e) { console.error("Download failed:", e); }
        setDownloading(prev => { const n = new Set(prev); n.delete(String(ch.chapter_number)); return n; });
    };

    if (loading) {
        return (<><Header /><main className="main-content"><section className="section" style={{ paddingTop: 60, textAlign: "center" }}><div className="loading-skeleton" style={{ width: "100%", maxWidth: 400, height: 300, borderRadius: 20, margin: "0 auto" }} /><div className="loading-skeleton" style={{ width: 200, height: 24, borderRadius: 8, margin: "16px auto" }} /></section></main></>);
    }

    if (!novel) {
        return (<><Header /><main className="main-content"><section className="section" style={{ paddingTop: 80, textAlign: "center" }}><p style={{ color: "var(--text-muted)", fontSize: 16 }}>Novel not found.</p><Link href="/novel" style={{ color: "var(--sakura-pink)", fontSize: 14, marginTop: 16, display: "inline-block" }}>Back to Browse</Link></section></main></>);
    }

    const totalWords = chapters.reduce((sum, c) => sum + (c.word_count || 0), 0);
    const continueChapter = progress ? progress.chapter_number : 1;

    return (
        <>
            <Header />
            <main className="main-content">
                <div style={{ position: "relative", width: "100%", height: 280, overflow: "hidden" }}>
                    {novel.cover_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={novel.cover_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(20px) brightness(0.4)", transform: "scale(1.1)" }} />
                    )}
                    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 0%, var(--bg-deep) 100%)" }} />
                    <div style={{ position: "absolute", bottom: 20, left: 20, right: 20, display: "flex", gap: 16, alignItems: "flex-end" }}>
                        <div style={{ width: 120, flexShrink: 0, borderRadius: 12, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
                            {novel.cover_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={novel.cover_url} alt={novel.title} style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover", imageRendering: "auto" }} />
                            ) : (
                                <div style={{ width: "100%", aspectRatio: "2/3", background: "var(--bg-surface)", display: "flex", alignItems: "center", justifyContent: "center" }}><BookIcon size={40} /></div>
                            )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <h1 style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.2, margin: 0, color: "#fff" }}>{novel.title}</h1>
                            <p style={{ margin: "4px 0", fontSize: 12, color: "var(--text-secondary)" }}>by {truncateAddress(novel.creator_wallet)}</p>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                                <span style={{ padding: "2px 10px", borderRadius: 12, fontSize: 10, fontWeight: 700, background: novel.status === "completed" ? "rgba(74,222,128,0.2)" : novel.status === "hiatus" ? "rgba(251,191,36,0.2)" : "rgba(255,107,157,0.2)", color: novel.status === "completed" ? "#4ade80" : novel.status === "hiatus" ? "#fbbf24" : "var(--sakura-pink)", textTransform: "capitalize" }}>
                                    {novel.status}
                                </span>
                                {novel.genres.slice(0, 3).map(g => (
                                    <span key={g} style={{ padding: "2px 10px", borderRadius: 12, fontSize: 10, background: "rgba(255,255,255,0.08)", color: "var(--text-secondary)" }}>{g}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                <section className="section" style={{ paddingTop: 16 }}>
                    <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                        {[
                            { label: "Chapters", value: chapters.length },
                            { label: "Words", value: totalWords > 1000 ? `${(totalWords / 1000).toFixed(1)}k` : totalWords },
                            { label: "Free", value: novel.free_until_chapter },
                            { label: "Price", value: `${novel.price_per_chapter} 🌸` },
                        ].map(s => (
                            <div key={s.label} style={{ flex: 1, textAlign: "center", padding: "10px 4px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                                <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--sakura-pink)" }}>{s.value}</p>
                                <p style={{ margin: 0, fontSize: 10, color: "var(--text-muted)" }}>{s.label}</p>
                            </div>
                        ))}
                    </div>

                    <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                        <Link href={`/novel/read?novel=${novel.id}&chapter=${continueChapter}`}
                            style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 16px", borderRadius: 14, textDecoration: "none", background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))", color: "#fff", fontWeight: 700, fontSize: 14, boxShadow: "0 4px 20px rgba(255,107,157,0.3)" }}
                        >
                            {progress ? "Continue Reading" : "Start Reading"}
                        </Link>
                        <button onClick={() => setShowLibrary(true)} style={{ padding: "10px 14px", borderRadius: 14, background: inLibrary ? "rgba(76,175,80,0.15)" : "rgba(255,255,255,0.06)", border: `1px solid ${inLibrary ? "rgba(76,175,80,0.3)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <LottieIcon
                                src={inLibrary ? "/icons/wired-outline-24-approved-checked-hover-loading.json" : "/icons/wired-outline-2620-bookmark-alt-hover-flutter.json"}
                                size={24}
                                playOnMount
                                colorFilter={inLibrary ? "brightness(0) saturate(100%) invert(62%) sepia(61%) saturate(483%) hue-rotate(79deg) brightness(96%) contrast(92%)" : undefined}
                            />
                        </button>
                    </div>

                    {novel.description && (
                        <div style={{ marginBottom: 20, padding: "16px", borderRadius: 14, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Synopsis</h3>
                            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{novel.description}</p>
                        </div>
                    )}

                    {hasPass && (
                        <div style={{ marginBottom: 16, padding: "8px 14px", borderRadius: 12, background: "rgba(245,197,66,0.1)", border: "1px solid rgba(245,197,66,0.3)", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--gold)" }}>
                            Premium Pass — All chapters unlocked
                        </div>
                    )}

                    {milestones.length > 0 && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                            {milestones.map(m => {
                                const badges: Record<string, { icon: string; label: string; color: string }> = {
                                    unlock: { icon: "🔓", label: "Supporter", color: "rgba(255,107,157,0.15)" },
                                    complete: { icon: "✅", label: "Completed", color: "rgba(74,222,128,0.15)" },
                                    support: { icon: "💝", label: "Tipper", color: "rgba(255,107,157,0.15)" },
                                    early_reader: { icon: "⚡", label: "Early Reader", color: "rgba(251,191,36,0.15)" },
                                    first_100: { icon: "🏆", label: "First 100", color: "rgba(245,197,66,0.15)" },
                                };
                                const b = badges[m.milestone_type] || { icon: "🎖", label: m.milestone_type, color: "rgba(255,255,255,0.06)" };
                                return (
                                    <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 10, background: b.color, fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>
                                        {b.icon} {b.label}
                                    </span>
                                );
                            })}
                        </div>
                    )}

                    <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: "var(--text-primary)" }}>Chapters</h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 100 }}>
                        {chapters.map(ch => {
                            const isFree = ch.chapter_number <= novel.free_until_chapter || ch.is_free_override;
                            const isUnlocked = unlockedChapters.has(ch.chapter_number);
                            const canRead = accessMap.get(ch.chapter_number) ?? isFree;
                            const isDownloaded = downloadedSet.has(String(ch.chapter_number));
                            const isDownloading = downloading.has(String(ch.chapter_number));
                            return (
                                <div key={ch.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <Link href={`/novel/read?novel=${novel.id}&chapter=${ch.chapter_number}`} style={{ textDecoration: "none", flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 12, background: progress?.chapter_number === ch.chapter_number ? "rgba(255,107,157,0.08)" : "rgba(255,255,255,0.02)", border: `1px solid ${progress?.chapter_number === ch.chapter_number ? "rgba(255,107,157,0.3)" : "rgba(255,255,255,0.06)"}`, transition: "all 0.2s ease" }}>
                                            <span style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: canRead ? "rgba(255,107,157,0.15)" : "rgba(255,255,255,0.05)", color: canRead ? "var(--sakura-pink)" : "var(--text-muted)", fontSize: 12, fontWeight: 700 }}>
                                                {canRead ? ch.chapter_number : "🔒"}
                                            </span>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: canRead ? "var(--text-primary)" : "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {ch.title || `Chapter ${ch.chapter_number}`}
                                                </p>
                                                <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
                                                    {ch.word_count ? `${ch.word_count.toLocaleString()} words` : ""}
                                                </p>
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                                                {isFree && <span style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", background: "rgba(74,222,128,0.15)", padding: "2px 8px", borderRadius: 8 }}>FREE</span>}
                                                {!isFree && isUnlocked && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sakura-pink)", background: "rgba(255,107,157,0.15)", padding: "2px 8px", borderRadius: 8 }}>UNLOCKED</span>}
                                                {!isFree && !canRead && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{novel.price_per_chapter} 🌸</span>}
                                            </div>
                                        </div>
                                    </Link>
                                    {canRead && (
                                        <button
                                            onClick={() => isDownloaded ? removeNovelDownload("sakura", novelId, String(ch.chapter_number)) : handleDownloadChapter(ch)}
                                            disabled={isDownloading}
                                            style={{ width: 36, height: 36, borderRadius: 10, border: "none", background: isDownloaded ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.04)", color: isDownloaded ? "#4ade80" : "var(--text-muted)", cursor: isDownloading ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 14 }}
                                        >
                                            {isDownloading ? "..." : isDownloaded ? "✓" : "↓"}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <NovelComments novelId={novel.id} />
                </section>

                {showLibrary && (
                    <SaveToLibraryModal
                        item={{ id: novel.id, title: novel.title, image: novel.cover_url, type: "novel", addedAt: Date.now() }}
                        onClose={() => { setShowLibrary(false); setInLibrary(isInLibrary(novelId, 'novel')); }}
                    />
                )}

                <footer className="footer">
                    <p className="footer-jp">桜 — 物語の新しい形</p>
                    <p className="footer-text">© 2026 Sakura.</p>
                </footer>
            </main>
        </>
    );
}

/* ═══════ Router ═══════ */

function DetailsRouter() {
    const params = useSearchParams();
    const source = params.get("source");
    if (source === "external") return <ExternalDetailsContent />;
    return <SakuraDetailsContent />;
}

export default function NovelDetailsPage() {
    return (
        <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "white" }}>Loading...</div>}>
            <DetailsRouter />
        </Suspense>
    );
}
