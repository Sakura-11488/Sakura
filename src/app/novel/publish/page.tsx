"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Header from "@/components/Header";
import Link from "next/link";
import {
    getNovelsByCreator, createNovel, updateNovel, deleteNovel, publishNovel,
    getChapters, getNovelStats, NOVEL_GENRES,
    type Novel, type NovelChapter, type NovelStats,
} from "@/lib/novel";

type View = "list" | "create" | "manage";

interface NovelWithStats {
    novel: Novel;
    stats: NovelStats;
    chapters: Omit<NovelChapter, "content">[];
}

export default function NovelPublishPage() {
    const { publicKey, connected } = useWallet();
    const wallet = publicKey?.toBase58() || null;

    const [view, setView] = useState<View>("list");
    const [novels, setNovels] = useState<NovelWithStats[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedNovel, setSelectedNovel] = useState<NovelWithStats | null>(null);

    // Create form state
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [coverUrl, setCoverUrl] = useState("");
    const [genres, setGenres] = useState<string[]>([]);
    const [freeUntil, setFreeUntil] = useState(3);
    const [pricePerChapter, setPricePerChapter] = useState(3);
    const [allowPass, setAllowPass] = useState(true);
    const [saving, setSaving] = useState(false);

    const loadNovels = useCallback(async () => {
        if (!wallet) return;
        setLoading(true);
        const myNovels = await getNovelsByCreator(wallet);
        const withStats = await Promise.all(
            myNovels.map(async (novel) => {
                const [stats, chapters] = await Promise.all([
                    getNovelStats(novel.id),
                    getChapters(novel.id),
                ]);
                return { novel, stats, chapters };
            })
        );
        setNovels(withStats);
        setLoading(false);
    }, [wallet]);

    useEffect(() => { loadNovels(); }, [loadNovels]);

    const handleCreate = async () => {
        if (!wallet || !title.trim()) return;
        setSaving(true);
        const novel = await createNovel(wallet, {
            title: title.trim(),
            description: description.trim(),
            cover_url: coverUrl.trim(),
            genres,
            free_until_chapter: freeUntil,
            paid_from_chapter: freeUntil + 1,
            price_per_chapter: pricePerChapter,
            allow_pass: allowPass,
        } as Partial<Novel>);
        setSaving(false);
        if (novel) {
            setTitle(""); setDescription(""); setCoverUrl(""); setGenres([]);
            setView("list");
            await loadNovels();
        }
    };

    const handlePublishNovel = async (novelId: string) => {
        if (!wallet) return;
        await publishNovel(novelId, wallet);
        await loadNovels();
    };

    const handleDeleteNovel = async (novelId: string) => {
        if (!wallet || !confirm("Delete this novel and all its chapters?")) return;
        await deleteNovel(novelId, wallet);
        setSelectedNovel(null);
        setView("list");
        await loadNovels();
    };

    const toggleGenre = (g: string) => {
        setGenres(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
    };

    if (!connected || !wallet) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <p style={{ fontSize: 48, margin: "0 0 16px" }}>✍️</p>
                        <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", margin: "0 0 8px" }}>Creator Dashboard</h2>
                        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>Connect your wallet to start publishing novels</p>
                    </section>
                </main>
            </>
        );
    }

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40 }}>
                    <div className="section-header">
                        <h2 className="section-title">✍️ 創作ダッシュボード</h2>
                        <p className="section-subtitle">Creator Dashboard</p>
                    </div>

                    {/* View Switcher */}
                    {view === "list" && (
                        <>
                            <button
                                onClick={() => setView("create")}
                                style={{
                                    width: "100%", padding: "14px", borderRadius: 14, border: "none",
                                    background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))",
                                    color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer",
                                    marginBottom: 24, boxShadow: "0 4px 20px rgba(255,107,157,0.3)",
                                }}
                            >
                                + Create New Novel
                            </button>

                            {loading ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                                    {[1, 2, 3].map(i => (
                                        <div key={i} className="loading-skeleton" style={{ height: 100, borderRadius: 16 }} />
                                    ))}
                                </div>
                            ) : novels.length === 0 ? (
                                <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                                    <p style={{ fontSize: 16 }}>No novels yet. Start writing!</p>
                                </div>
                            ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 100 }}>
                                    {novels.map(({ novel, stats, chapters }) => (
                                        <div key={novel.id}
                                            onClick={() => { setSelectedNovel({ novel, stats, chapters }); setView("manage"); }}
                                            style={{
                                                display: "flex", gap: 14, padding: 14, borderRadius: 16,
                                                background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
                                                cursor: "pointer", transition: "all 0.2s ease",
                                            }}
                                        >
                                            <div style={{ width: 60, flexShrink: 0, borderRadius: 10, overflow: "hidden" }}>
                                                {novel.cover_url ? (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={novel.cover_url} alt="" style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover", imageRendering: "auto" }} />
                                                ) : (
                                                    <div style={{ width: "100%", aspectRatio: "2/3", background: "var(--bg-surface)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>📚</div>
                                                )}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                                        {novel.title}
                                                    </p>
                                                    <span style={{
                                                        fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8,
                                                        background: novel.published ? "rgba(74,222,128,0.15)" : "rgba(251,191,36,0.15)",
                                                        color: novel.published ? "#4ade80" : "#fbbf24",
                                                    }}>
                                                        {novel.published ? "Published" : "Draft"}
                                                    </span>
                                                </div>
                                                <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--text-muted)" }}>
                                                    <span>{chapters.length} chapters</span>
                                                    <span>{stats.totalReaders} readers</span>
                                                    <span>{stats.totalEarnings.toFixed(0)} 🌸 earned</span>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {/* Create Novel Form */}
                    {view === "create" && (
                        <div style={{ paddingBottom: 100 }}>
                            <button onClick={() => setView("list")} style={{ background: "none", border: "none", color: "var(--sakura-pink)", fontSize: 14, cursor: "pointer", marginBottom: 16 }}>
                                ← Back
                            </button>
                            <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 20 }}>Create New Novel</h3>

                            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                                {/* Title */}
                                <div>
                                    <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, display: "block", marginBottom: 6 }}>Title *</label>
                                    <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="My Awesome Novel"
                                        style={{
                                            width: "100%", padding: "12px 14px", borderRadius: 12,
                                            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                                            color: "var(--text-primary)", fontSize: 14, outline: "none",
                                        }}
                                    />
                                </div>
                                {/* Description */}
                                <div>
                                    <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, display: "block", marginBottom: 6 }}>Synopsis</label>
                                    <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Write a compelling description..."
                                        rows={4}
                                        style={{
                                            width: "100%", padding: "12px 14px", borderRadius: 12, resize: "vertical",
                                            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                                            color: "var(--text-primary)", fontSize: 14, outline: "none", fontFamily: "inherit",
                                        }}
                                    />
                                </div>
                                {/* Cover URL */}
                                <div>
                                    <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, display: "block", marginBottom: 6 }}>Cover Image URL</label>
                                    <input type="text" value={coverUrl} onChange={e => setCoverUrl(e.target.value)} placeholder="https://..."
                                        style={{
                                            width: "100%", padding: "12px 14px", borderRadius: 12,
                                            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                                            color: "var(--text-primary)", fontSize: 14, outline: "none",
                                        }}
                                    />
                                </div>
                                {/* Genres */}
                                <div>
                                    <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, display: "block", marginBottom: 8 }}>Genres</label>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                        {NOVEL_GENRES.map(g => (
                                            <button key={g} onClick={() => toggleGenre(g)}
                                                style={{
                                                    padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                                                    border: genres.includes(g) ? "1px solid var(--sakura-pink)" : "1px solid rgba(255,255,255,0.1)",
                                                    background: genres.includes(g) ? "rgba(255,107,157,0.15)" : "rgba(255,255,255,0.04)",
                                                    color: genres.includes(g) ? "var(--sakura-pink)" : "var(--text-secondary)",
                                                }}
                                            >
                                                {g}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {/* Paywall Settings */}
                                <div style={{ padding: 16, borderRadius: 14, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                                    <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Paywall Settings</h4>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                            <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Free chapters</label>
                                            <input type="number" min={0} max={100} value={freeUntil} onChange={e => setFreeUntil(parseInt(e.target.value) || 0)}
                                                style={{
                                                    width: 70, padding: "6px 10px", borderRadius: 8, textAlign: "center",
                                                    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                                                    color: "var(--text-primary)", fontSize: 14,
                                                }}
                                            />
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                            <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Price per chapter ($SAKURA)</label>
                                            <input type="number" min={1} max={1000} value={pricePerChapter} onChange={e => setPricePerChapter(parseInt(e.target.value) || 1)}
                                                style={{
                                                    width: 70, padding: "6px 10px", borderRadius: 8, textAlign: "center",
                                                    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                                                    color: "var(--text-primary)", fontSize: 14,
                                                }}
                                            />
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                            <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Allow Premium Pass unlock</label>
                                            <button onClick={() => setAllowPass(!allowPass)}
                                                style={{
                                                    width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                                                    background: allowPass ? "var(--sakura-pink)" : "rgba(255,255,255,0.15)",
                                                    position: "relative", transition: "background 0.2s",
                                                }}
                                            >
                                                <span style={{
                                                    position: "absolute", top: 2, left: allowPass ? 22 : 2,
                                                    width: 20, height: 20, borderRadius: "50%", background: "#fff",
                                                    transition: "left 0.2s",
                                                }} />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                {/* Submit */}
                                <button
                                    onClick={handleCreate}
                                    disabled={!title.trim() || saving}
                                    style={{
                                        width: "100%", padding: "14px", borderRadius: 14, border: "none",
                                        background: title.trim() && !saving ? "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))" : "rgba(255,255,255,0.08)",
                                        color: title.trim() ? "#fff" : "var(--text-muted)", fontWeight: 700, fontSize: 15,
                                        cursor: title.trim() && !saving ? "pointer" : "default",
                                    }}
                                >
                                    {saving ? "Creating..." : "Create Novel"}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Manage Novel */}
                    {view === "manage" && selectedNovel && (
                        <div style={{ paddingBottom: 100 }}>
                            <button onClick={() => { setView("list"); setSelectedNovel(null); }} style={{ background: "none", border: "none", color: "var(--sakura-pink)", fontSize: 14, cursor: "pointer", marginBottom: 16 }}>
                                ← Back
                            </button>

                            {/* Novel Header */}
                            <div style={{ display: "flex", gap: 14, marginBottom: 20 }}>
                                <div style={{ width: 80, flexShrink: 0, borderRadius: 12, overflow: "hidden" }}>
                                    {selectedNovel.novel.cover_url ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={selectedNovel.novel.cover_url} alt="" style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover", imageRendering: "auto" }} />
                                    ) : (
                                        <div style={{ width: "100%", aspectRatio: "2/3", background: "var(--bg-surface)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32 }}>📚</div>
                                    )}
                                </div>
                                <div>
                                    <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: "var(--text-primary)" }}>{selectedNovel.novel.title}</h3>
                                    <span style={{
                                        display: "inline-block", fontSize: 10, fontWeight: 700, padding: "2px 10px", borderRadius: 8,
                                        background: selectedNovel.novel.published ? "rgba(74,222,128,0.15)" : "rgba(251,191,36,0.15)",
                                        color: selectedNovel.novel.published ? "#4ade80" : "#fbbf24",
                                    }}>
                                        {selectedNovel.novel.published ? "Published" : "Draft"}
                                    </span>
                                </div>
                            </div>

                            {/* Stats */}
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 20 }}>
                                {[
                                    { label: "Readers", value: selectedNovel.stats.totalReaders, icon: "👁" },
                                    { label: "Unlocks", value: selectedNovel.stats.totalUnlocks, icon: "🔓" },
                                    { label: "Earnings", value: `${selectedNovel.stats.totalEarnings.toFixed(0)} 🌸`, icon: "" },
                                    { label: "Chapters", value: selectedNovel.stats.totalChapters, icon: "📄" },
                                ].map(s => (
                                    <div key={s.label} style={{
                                        padding: "14px", borderRadius: 14, textAlign: "center",
                                        background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
                                    }}>
                                        <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "var(--sakura-pink)" }}>{s.icon} {s.value}</p>
                                        <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)" }}>{s.label}</p>
                                    </div>
                                ))}
                            </div>

                            {/* Actions */}
                            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                                {!selectedNovel.novel.published && (
                                    <button
                                        onClick={() => handlePublishNovel(selectedNovel.novel.id)}
                                        style={{
                                            flex: 1, padding: "12px", borderRadius: 12, border: "none",
                                            background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))",
                                            color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
                                        }}
                                    >
                                        Publish Novel
                                    </button>
                                )}
                                <button
                                    onClick={() => handleDeleteNovel(selectedNovel.novel.id)}
                                    style={{
                                        padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(239,68,68,0.3)",
                                        background: "rgba(239,68,68,0.1)", color: "#ef4444", fontWeight: 600, fontSize: 13, cursor: "pointer",
                                    }}
                                >
                                    Delete
                                </button>
                            </div>

                            {/* Chapters */}
                            <h4 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 12 }}>Chapters</h4>
                            <Link
                                href={`/novel/publish/editor?novel=${selectedNovel.novel.id}&chapter=${(selectedNovel.chapters.length > 0 ? Math.max(...selectedNovel.chapters.map(c => c.chapter_number)) : 0) + 1}`}
                                style={{
                                    display: "block", width: "100%", padding: "12px", borderRadius: 12,
                                    border: "1px dashed rgba(255,107,157,0.4)",
                                    background: "rgba(255,107,157,0.05)", textAlign: "center",
                                    color: "var(--sakura-pink)", fontWeight: 600, fontSize: 13, textDecoration: "none",
                                    marginBottom: 12,
                                }}
                            >
                                + Add New Chapter
                            </Link>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {selectedNovel.chapters.map(ch => (
                                    <Link
                                        key={ch.id}
                                        href={`/novel/publish/editor?novel=${selectedNovel.novel.id}&chapter=${ch.chapter_number}&edit=${ch.id}`}
                                        style={{ textDecoration: "none" }}
                                    >
                                        <div style={{
                                            display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
                                            borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                                        }}>
                                            <span style={{
                                                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                                                display: "flex", alignItems: "center", justifyContent: "center",
                                                background: "rgba(255,107,157,0.15)", color: "var(--sakura-pink)", fontSize: 12, fontWeight: 700,
                                            }}>
                                                {ch.chapter_number}
                                            </span>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {ch.title || `Chapter ${ch.chapter_number}`}
                                                </p>
                                                <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
                                                    {ch.word_count.toLocaleString()} words
                                                </p>
                                            </div>
                                            <span style={{
                                                fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8,
                                                background: ch.published ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.06)",
                                                color: ch.published ? "#4ade80" : "var(--text-muted)",
                                            }}>
                                                {ch.published ? "Live" : "Draft"}
                                            </span>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        </div>
                    )}
                </section>

                <footer className="footer">
                    <p className="footer-jp">桜 — 創作の場</p>
                    <p className="footer-text">© 2026 Sakura.</p>
                </footer>
            </main>
        </>
    );
}
