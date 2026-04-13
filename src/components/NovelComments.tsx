"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { truncateAddress } from "@/lib/solana";
import { getNovelComments, postNovelComment, deleteNovelComment, type NovelComment } from "@/lib/novel";

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
}

interface Props {
    novelId: string;
    chapterNumber?: number;
}

export default function NovelComments({ novelId, chapterNumber }: Props) {
    const { publicKey } = useWallet();
    const wallet = publicKey?.toBase58() || null;
    const [comments, setComments] = useState<NovelComment[]>([]);
    const [loading, setLoading] = useState(true);
    const [text, setText] = useState("");
    const [posting, setPosting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        const data = await getNovelComments(novelId, chapterNumber);
        setComments(data);
        setLoading(false);
    }, [novelId, chapterNumber]);

    useEffect(() => { load(); }, [load]);

    const handlePost = async () => {
        if (!wallet || !text.trim()) return;
        setPosting(true);
        const comment = await postNovelComment(wallet, novelId, text.trim(), chapterNumber);
        if (comment) {
            setComments(prev => [comment, ...prev]);
            setText("");
        }
        setPosting(false);
    };

    const handleDelete = async (id: string) => {
        if (!wallet) return;
        const ok = await deleteNovelComment(id, wallet);
        if (ok) setComments(prev => prev.filter(c => c.id !== id));
    };

    return (
        <div style={{ marginTop: 32, padding: "20px 0" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 16 }}>
                💬 {chapterNumber ? "Chapter Comments" : "Novel Comments"}
            </h3>

            {/* Input */}
            {wallet ? (
                <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                    <input
                        type="text"
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handlePost()}
                        placeholder="Write a comment..."
                        style={{
                            flex: 1, padding: "10px 14px", borderRadius: 12,
                            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                            color: "var(--text-primary)", fontSize: 13, outline: "none",
                        }}
                    />
                    <button
                        onClick={handlePost}
                        disabled={posting || !text.trim()}
                        style={{
                            padding: "10px 16px", borderRadius: 12, border: "none",
                            background: text.trim() ? "var(--sakura-pink)" : "rgba(255,255,255,0.06)",
                            color: text.trim() ? "#fff" : "var(--text-muted)",
                            fontWeight: 600, fontSize: 13, cursor: text.trim() ? "pointer" : "default",
                        }}
                    >
                        {posting ? "..." : "Post"}
                    </button>
                </div>
            ) : (
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>Connect wallet to comment</p>
            )}

            {/* Comments List */}
            {loading ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[1, 2, 3].map(i => (
                        <div key={i} className="loading-skeleton" style={{ height: 60, borderRadius: 12 }} />
                    ))}
                </div>
            ) : comments.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", padding: 24 }}>
                    No comments yet. Be the first!
                </p>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {comments.map(c => (
                        <div key={c.id} style={{
                            padding: "12px 14px", borderRadius: 12,
                            background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)",
                        }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sakura-pink)" }}>
                                    {truncateAddress(c.user_wallet)}
                                </span>
                                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{timeAgo(c.created_at)}</span>
                                {wallet === c.user_wallet && (
                                    <button
                                        onClick={() => handleDelete(c.id)}
                                        style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", fontSize: 10, cursor: "pointer" }}
                                    >
                                        ✕
                                    </button>
                                )}
                            </div>
                            <p style={{ margin: 0, fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5 }}>{c.content}</p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
