"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";

import Header from "@/components/Header";
import { getCreatorWorksByCreator, getWorkReleases } from "@/lib/creator-works";
import type { CreatorWork, WorkRelease } from "@/lib/publishing";

interface WorkWithReleases {
    work: CreatorWork;
    releases: WorkRelease[];
}

const KIND_LABELS: Record<CreatorWork["kind"], string> = {
    novel: "Novel",
    manga: "Manga",
    anime: "Anime",
};

export default function CreatorWorksPage() {
    const { publicKey, connected } = useWallet();
    const wallet = publicKey?.toBase58() || "";

    const [items, setItems] = useState<WorkWithReleases[]>([]);
    const [loading, setLoading] = useState(true);

    const loadWorks = useCallback(async () => {
        if (!wallet) {
            setItems([]);
            setLoading(false);
            return;
        }

        setLoading(true);
        const works = await getCreatorWorksByCreator(wallet);
        const hydrated = await Promise.all(
            works.map(async (work) => ({
                work,
                releases: await getWorkReleases(work.id),
            }))
        );
        setItems(hydrated);
        setLoading(false);
    }, [wallet]);

    useEffect(() => {
        loadWorks();
    }, [loadWorks]);

    const stats = useMemo(() => ({
        total: items.length,
        novels: items.filter((item) => item.work.kind === "novel").length,
        manga: items.filter((item) => item.work.kind === "manga").length,
        anime: items.filter((item) => item.work.kind === "anime").length,
    }), [items]);

    if (!connected || !wallet) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <p style={{ fontSize: 48, margin: "0 0 16px" }}>🎬</p>
                        <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", margin: "0 0 8px" }}>
                            Creator Works
                        </h2>
                        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
                            Connect your wallet to manage novels, manga, and anime releases.
                        </p>
                    </section>
                </main>
            </>
        );
    }

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40, paddingBottom: 100 }}>
                    <div className="section-header" style={{ marginBottom: 14 }}>
                        <div>
                            <h2 className="section-title">Creator Works</h2>
                            <p className="section-subtitle">Unified publishing for novels, manga, and anime</p>
                        </div>
                        <Link
                            href="/creator/works/new"
                            style={{
                                padding: "10px 14px",
                                borderRadius: 12,
                                textDecoration: "none",
                                color: "#fff",
                                fontWeight: 700,
                                background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))",
                                whiteSpace: "nowrap",
                            }}
                        >
                            + New Work
                        </Link>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 18 }}>
                        {[
                            { label: "All", value: stats.total },
                            { label: "Novels", value: stats.novels },
                            { label: "Manga", value: stats.manga },
                            { label: "Anime", value: stats.anime },
                        ].map((stat) => (
                            <div
                                key={stat.label}
                                style={{
                                    padding: "14px 12px",
                                    borderRadius: 14,
                                    background: "rgba(255,255,255,0.03)",
                                    border: "1px solid rgba(255,255,255,0.06)",
                                    textAlign: "center",
                                }}
                            >
                                <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "var(--sakura-pink)" }}>{stat.value}</p>
                                <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-muted)" }}>{stat.label}</p>
                            </div>
                        ))}
                    </div>

                    <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
                        <Link
                            href="/novel/publish"
                            style={{
                                padding: "10px 12px",
                                borderRadius: 12,
                                textDecoration: "none",
                                background: "rgba(255,255,255,0.04)",
                                border: "1px solid rgba(255,255,255,0.08)",
                                color: "var(--text-primary)",
                                fontSize: 13,
                                fontWeight: 600,
                            }}
                        >
                            Legacy Novel Dashboard
                        </Link>
                    </div>

                    {loading ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {[1, 2, 3].map((idx) => (
                                <div key={idx} className="loading-skeleton" style={{ height: 104, borderRadius: 16 }} />
                            ))}
                        </div>
                    ) : items.length === 0 ? (
                        <div
                            style={{
                                textAlign: "center",
                                padding: 40,
                                borderRadius: 18,
                                background: "rgba(255,255,255,0.03)",
                                border: "1px solid rgba(255,255,255,0.06)",
                            }}
                        >
                            <p style={{ fontSize: 18, margin: "0 0 8px", color: "var(--text-primary)", fontWeight: 700 }}>
                                No creator works yet
                            </p>
                            <p style={{ margin: "0 0 20px", color: "var(--text-muted)" }}>
                                Start a novel, manga, or anime work and grow into releases from one workspace.
                            </p>
                            <Link
                                href="/creator/works/new"
                                style={{
                                    display: "inline-block",
                                    padding: "12px 16px",
                                    borderRadius: 14,
                                    textDecoration: "none",
                                    color: "#fff",
                                    fontWeight: 700,
                                    background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))",
                                }}
                            >
                                Create Your First Work
                            </Link>
                        </div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {items.map(({ work, releases }) => {
                                const coverUrl = String((work.release_metadata?.cover_url as string) || "");
                                return (
                                    <Link
                                        key={work.id}
                                        href={`/creator/works/manage?id=${encodeURIComponent(work.id)}`}
                                        style={{ textDecoration: "none" }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                gap: 14,
                                                padding: 14,
                                                borderRadius: 16,
                                                background: "rgba(255,255,255,0.03)",
                                                border: "1px solid rgba(255,255,255,0.06)",
                                            }}
                                        >
                                            <div style={{ width: 70, flexShrink: 0, borderRadius: 12, overflow: "hidden" }}>
                                                {coverUrl ? (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={coverUrl} alt="" style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover" }} />
                                                ) : (
                                                    <div style={{ width: "100%", aspectRatio: "2/3", background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>
                                                        {work.kind === "novel" ? "📚" : work.kind === "manga" ? "🖼️" : "🎬"}
                                                    </div>
                                                )}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                                                    <p style={{ margin: 0, color: "var(--text-primary)", fontWeight: 700, fontSize: 15 }}>
                                                        {work.title}
                                                    </p>
                                                    <span style={{
                                                        fontSize: 10,
                                                        fontWeight: 700,
                                                        padding: "3px 8px",
                                                        borderRadius: 999,
                                                        background: "rgba(255,255,255,0.08)",
                                                        color: "var(--text-secondary)",
                                                    }}>
                                                        {KIND_LABELS[work.kind]}
                                                    </span>
                                                    <span style={{
                                                        fontSize: 10,
                                                        fontWeight: 700,
                                                        padding: "3px 8px",
                                                        borderRadius: 999,
                                                        background: work.publication_status === "published" ? "rgba(74,222,128,0.14)" : "rgba(251,191,36,0.14)",
                                                        color: work.publication_status === "published" ? "#4ade80" : "#fbbf24",
                                                        textTransform: "capitalize",
                                                    }}>
                                                        {work.publication_status.replaceAll("_", " ")}
                                                    </span>
                                                </div>
                                                <p style={{ margin: "0 0 10px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                                                    {work.description || "No description yet."}
                                                </p>
                                                <div style={{ display: "flex", gap: 14, color: "var(--text-muted)", fontSize: 11, flexWrap: "wrap" }}>
                                                    <span>{releases.length} releases</span>
                                                    <span>{work.visibility}</span>
                                                    <span>{work.series_status}</span>
                                                    <span>{work.language.toUpperCase()}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                    )}
                </section>
            </main>
        </>
    );
}
