"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import Header from "@/components/Header";
import {
    getNovel, getChapterContent, createChapter, updateChapter,
    publishChapter, deleteChapter, type Novel,
} from "@/lib/novel";

function ChapterEditorContent() {
    const params = useSearchParams();
    const router = useRouter();
    const novelId = params.get("novel") || "";
    const chapterNum = parseInt(params.get("chapter") || "1", 10);
    const editId = params.get("edit") || null;
    const { publicKey } = useWallet();
    const wallet = publicKey?.toBase58() || null;

    const [novel, setNovel] = useState<Novel | null>(null);
    const [title, setTitle] = useState("");
    const [content, setContent] = useState("");
    const [loading, setLoading] = useState(!!editId);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [chapterId, setChapterId] = useState(editId);

    const wordCount = content.trim().split(/\s+/).filter(Boolean).length;

    useEffect(() => {
        if (novelId) getNovel(novelId).then(setNovel);
    }, [novelId]);

    useEffect(() => {
        if (editId && novelId) {
            setLoading(true);
            getChapterContent(novelId, chapterNum).then(ch => {
                if (ch) {
                    setTitle(ch.title);
                    setContent(ch.content);
                    setChapterId(ch.id);
                }
                setLoading(false);
            });
        }
    }, [editId, novelId, chapterNum]);

    const handleSave = useCallback(async (andPublish = false) => {
        if (!wallet || !novelId) return;
        setSaving(true);
        setSaved(false);

        if (chapterId) {
            await updateChapter(chapterId, wallet, { title, content } as any);
            if (andPublish) await publishChapter(chapterId, wallet);
        } else {
            const ch = await createChapter(novelId, wallet, { chapter_number: chapterNum, title, content });
            if (ch) {
                setChapterId(ch.id);
                if (andPublish) await publishChapter(ch.id, wallet);
            }
        }
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    }, [wallet, novelId, chapterId, chapterNum, title, content]);

    const handleDelete = async () => {
        if (!wallet || !chapterId || !confirm("Delete this chapter?")) return;
        await deleteChapter(chapterId, wallet);
        router.push(`/novel/publish?manage=${novelId}`);
    };

    if (!wallet) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <p style={{ color: "var(--text-muted)" }}>Connect wallet to edit</p>
                    </section>
                </main>
            </>
        );
    }

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 32 }}>
                    {/* Top bar */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                        <button
                            onClick={() => router.back()}
                            style={{ background: "none", border: "none", color: "var(--sakura-pink)", fontSize: 14, cursor: "pointer" }}
                        >
                            ← Back
                        </button>
                        <div style={{ flex: 1 }}>
                            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{novel?.title}</p>
                            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
                                {editId ? "Edit" : "New"} Chapter {chapterNum}
                            </p>
                        </div>
                        <span style={{
                            fontSize: 11, color: "var(--text-muted)",
                            background: "rgba(255,255,255,0.04)", padding: "4px 10px", borderRadius: 8,
                        }}>
                            {wordCount.toLocaleString()} words
                        </span>
                    </div>

                    {loading ? (
                        <div className="loading-skeleton" style={{ height: 400, borderRadius: 16 }} />
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {/* Chapter Title */}
                            <input
                                type="text"
                                value={title}
                                onChange={e => setTitle(e.target.value)}
                                placeholder="Chapter title..."
                                style={{
                                    width: "100%", padding: "14px 16px", borderRadius: 14,
                                    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                                    color: "var(--text-primary)", fontSize: 16, fontWeight: 600, outline: "none",
                                }}
                            />

                            {/* Content Editor */}
                            <textarea
                                value={content}
                                onChange={e => setContent(e.target.value)}
                                placeholder="Start writing your chapter..."
                                style={{
                                    width: "100%", minHeight: 400, padding: "16px",
                                    borderRadius: 14, resize: "vertical",
                                    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
                                    color: "var(--text-primary)", fontSize: 15, lineHeight: 1.8,
                                    fontFamily: "'Noto Serif JP', Georgia, serif",
                                    outline: "none",
                                }}
                            />

                            {/* Action Buttons */}
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <button
                                    onClick={() => handleSave(false)}
                                    disabled={saving}
                                    style={{
                                        flex: 1, padding: "12px", borderRadius: 12,
                                        background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                                        color: "var(--text-primary)", fontWeight: 600, fontSize: 13, cursor: "pointer",
                                    }}
                                >
                                    {saving ? "Saving..." : saved ? "✓ Saved" : "Save Draft"}
                                </button>
                                <button
                                    onClick={() => handleSave(true)}
                                    disabled={saving || !content.trim()}
                                    style={{
                                        flex: 1, padding: "12px", borderRadius: 12, border: "none",
                                        background: content.trim() && !saving ? "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))" : "rgba(255,255,255,0.08)",
                                        color: content.trim() ? "#fff" : "var(--text-muted)", fontWeight: 700, fontSize: 13, cursor: "pointer",
                                    }}
                                >
                                    {saving ? "Publishing..." : "Save & Publish"}
                                </button>
                            </div>

                            {chapterId && (
                                <button
                                    onClick={handleDelete}
                                    style={{
                                        padding: "10px", borderRadius: 12,
                                        border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)",
                                        color: "#ef4444", fontWeight: 600, fontSize: 12, cursor: "pointer",
                                    }}
                                >
                                    Delete Chapter
                                </button>
                            )}
                        </div>
                    )}
                </section>
            </main>
        </>
    );
}

export default function ChapterEditorPage() {
    return (
        <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "white" }}>🌸 Loading...</div>}>
            <ChapterEditorContent />
        </Suspense>
    );
}
