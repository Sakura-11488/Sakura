"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";

import Header from "@/components/Header";
import {
    createWorkRelease,
    deleteCreatorWork,
    getCreatorWork,
    getWorkReleases,
    updateCreatorWork,
} from "@/lib/creator-works";
import { uploadCreatorAsset } from "@/lib/publisher-assets";
import type { CreatorWork, WorkRelease } from "@/lib/publishing";
import { buildWalletAuthHeaders, generateWalletAuthMessage } from "@/lib/wallet-auth";

export default function CreatorWorkManagePage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const workId = searchParams.get("id") || "";
    const { publicKey, connected, signMessage } = useWallet();
    const wallet = publicKey?.toBase58() || "";
    const coverInputRef = useRef<HTMLInputElement | null>(null);

    const [work, setWork] = useState<CreatorWork | null>(null);
    const [releases, setReleases] = useState<WorkRelease[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [infoMessage, setInfoMessage] = useState<string | null>(null);
    const [coverState, setCoverState] = useState<"idle" | "uploading" | "error">("idle");
    const [releaseState, setReleaseState] = useState<"idle" | "saving" | "error">("idle");
    const [actionState, setActionState] = useState<"idle" | "saving">("idle");
    const [releaseAssetState, setReleaseAssetState] = useState<string | null>(null);

    const [releaseTitle, setReleaseTitle] = useState("");
    const [releaseSummary, setReleaseSummary] = useState("");
    const [releaseBody, setReleaseBody] = useState("");

    const loadWork = useCallback(async () => {
        if (!workId) {
            setLoading(false);
            setError("Missing work ID.");
            return;
        }

        setLoading(true);
        const [workData, releaseData] = await Promise.all([
            getCreatorWork(workId),
            getWorkReleases(workId),
        ]);

        setWork(workData);
        setReleases(releaseData);
        setLoading(false);
    }, [workId]);

    useEffect(() => {
        loadWork();
    }, [loadWork]);

    const isOwner = Boolean(work && wallet && work.creator_wallet === wallet);
    const defaultContentType = useMemo(() => {
        if (!work) return "novel_chapter";
        if (work.kind === "manga") return "manga_chapter";
        if (work.kind === "anime") return "anime_episode";
        return "novel_chapter";
    }, [work]);

    const signPublisherAction = useCallback(async (action: string) => {
        if (!publicKey || !signMessage) throw new Error("Wallet signing is unavailable.");
        const message = generateWalletAuthMessage(action);
        const sigBytes = await signMessage(new TextEncoder().encode(message));
        return buildWalletAuthHeaders(publicKey.toBase58(), bs58.encode(sigBytes), message);
    }, [publicKey, signMessage]);

    const handleReplaceCover = useCallback(async (file: File | null) => {
        if (!file || !work || !wallet) return;

        setCoverState("uploading");
        setError(null);
        setInfoMessage(null);
        try {
            const authHeaders = await signPublisherAction("creator-asset-upload");
            const uploaded = await uploadCreatorAsset({
                file,
                kind: work.kind === "anime" ? "poster" : "cover",
                workId: work.id,
                role: work.kind === "anime" ? "poster" : "cover",
                isPrimary: true,
                isPublic: true,
                keepOriginal: true,
            }, authHeaders);

            const detailVariant = uploaded.variants.find((variant) => variant.variantKey === "detail" && variant.publicUrl);
            const fallbackVariant = uploaded.variants.find((variant) => variant.publicUrl);
            const resolvedCoverUrl = detailVariant?.publicUrl || fallbackVariant?.publicUrl || uploaded.asset.publicUrl || "";
            if (!resolvedCoverUrl) {
                throw new Error("No public cover URL returned.");
            }

            const updated = await updateCreatorWork(work.id, wallet, {
                release_metadata: {
                    ...(work.release_metadata || {}),
                    cover_url: resolvedCoverUrl,
                },
            });

            if (!updated) {
                throw new Error("Cover uploaded, but updating the work failed.");
            }

            setWork((prev) => prev ? {
                ...prev,
                release_metadata: {
                    ...(prev.release_metadata || {}),
                    cover_url: resolvedCoverUrl,
                },
            } : prev);
            setCoverState("idle");
        } catch (uploadError: any) {
            console.error("Replacing work cover failed:", uploadError);
            setCoverState("error");
            setError(uploadError?.message || "Failed to replace cover.");
        } finally {
            if (coverInputRef.current) {
                coverInputRef.current.value = "";
            }
        }
    }, [signPublisherAction, wallet, work]);

    const handleCreateRelease = useCallback(async () => {
        if (!work || !wallet || !releaseTitle.trim()) return;

        setReleaseState("saving");
        setError(null);
        setInfoMessage(null);

        const nextNumber = (releases[releases.length - 1]?.sequence_number || 0) + 1;
        const created = await createWorkRelease(work.id, wallet, {
            sequence_number: nextNumber,
            title: releaseTitle,
            summary: releaseSummary,
            body_text: work.kind === "novel" ? releaseBody : "",
            content_type: defaultContentType,
            visibility: work.visibility,
            publication_status: "draft",
        });

        if (!created) {
            setReleaseState("error");
            setError("Failed to create release.");
            return;
        }

        setReleaseTitle("");
        setReleaseSummary("");
        setReleaseBody("");
        setReleaseState("idle");
        await loadWork();
    }, [defaultContentType, loadWork, releaseBody, releaseSummary, releaseTitle, releases, wallet, work]);

    const handleReleaseAssetUpload = useCallback(async (
        releaseId: string,
        kind: "subtitle" | "video_manifest",
        file: File | null
    ) => {
        if (!file || !work) return;

        setReleaseAssetState(`${releaseId}:${kind}`);
        setError(null);
        setInfoMessage(null);

        try {
            const authHeaders = await signPublisherAction("creator-asset-upload");
            await uploadCreatorAsset({
                file,
                kind,
                releaseId,
                role: kind === "subtitle" ? "subtitle" : "video_manifest",
                isPrimary: false,
                isPublic: false,
                keepOriginal: true,
            }, authHeaders);

            setInfoMessage(kind === "subtitle"
                ? "Subtitle uploaded for this release."
                : "Video manifest uploaded for this release.");
            setReleaseAssetState(null);
        } catch (uploadError: any) {
            console.error("Release asset upload failed:", uploadError);
            setReleaseAssetState(null);
            setError(uploadError?.message || "Failed to upload release asset.");
        }
    }, [signPublisherAction, work]);

    const updateWorkStatus = useCallback(async (status: CreatorWork["publication_status"]) => {
        if (!work || !wallet) return;
        setActionState("saving");
        setError(null);
        setInfoMessage(null);

        const updated = await updateCreatorWork(work.id, wallet, {
            publication_status: status,
            visibility: status === "published" ? "public" : work.visibility,
        });

        if (!updated) {
            setError("Failed to update work status.");
            setActionState("idle");
            return;
        }

        setWork((prev) => prev ? { ...prev, publication_status: status, visibility: status === "published" ? "public" : prev.visibility } : prev);
        setActionState("idle");
    }, [wallet, work]);

    const handleDeleteWork = useCallback(async () => {
        if (!work || !wallet) return;
        if (!confirm(`Delete "${work.title}" and its releases?`)) return;

        setActionState("saving");
        const deleted = await deleteCreatorWork(work.id, wallet);
        setActionState("idle");
        if (!deleted) {
            setError("Failed to delete work.");
            return;
        }
        router.push("/creator/works");
    }, [router, wallet, work]);

    if (!connected || !wallet) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", margin: "0 0 8px" }}>
                            Creator Work
                        </h2>
                        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
                            Connect your wallet to manage this work.
                        </p>
                    </section>
                </main>
            </>
        );
    }

    if (loading) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80 }}>
                        <div className="loading-skeleton" style={{ height: 220, borderRadius: 20 }} />
                    </section>
                </main>
            </>
        );
    }

    if (!work) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", margin: "0 0 8px" }}>
                            Work not found
                        </h2>
                        <Link href="/creator/works" className="btn-primary">Back to Creator Works</Link>
                    </section>
                </main>
            </>
        );
    }

    if (!isOwner) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", margin: "0 0 8px" }}>
                            Access denied
                        </h2>
                        <p style={{ color: "var(--text-secondary)", marginBottom: 20 }}>
                            This creator work belongs to another wallet.
                        </p>
                        <Link href="/creator/works" className="btn-primary">Back to Creator Works</Link>
                    </section>
                </main>
            </>
        );
    }

    const coverUrl = String((work.release_metadata?.cover_url as string) || "");

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40, paddingBottom: 100 }}>
                    <div className="title-header" style={{ marginBottom: 20 }}>
                        <Link href="/creator/works" className="back-btn">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                        </Link>
                        <div className="title-header-text">Manage Work</div>
                        <div style={{ width: 40 }} />
                    </div>

                    <div style={{
                        display: "flex",
                        gap: 14,
                        padding: 16,
                        borderRadius: 18,
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        marginBottom: 18,
                    }}>
                        <div style={{ width: 96, flexShrink: 0, borderRadius: 14, overflow: "hidden" }}>
                            {coverUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={coverUrl} alt="" style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover" }} />
                            ) : (
                                <div style={{ width: "100%", aspectRatio: "2/3", background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34 }}>
                                    {work.kind === "novel" ? "📚" : work.kind === "manga" ? "🖼️" : "🎬"}
                                </div>
                            )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                                <span style={pillStyle}>{work.kind}</span>
                                <span style={pillStyle}>{work.publication_status.replaceAll("_", " ")}</span>
                                <span style={pillStyle}>{work.visibility}</span>
                            </div>
                            <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: "var(--text-primary)" }}>{work.title}</h2>
                            <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5 }}>
                                {work.description || "No description yet."}
                            </p>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                                <input
                                    ref={coverInputRef}
                                    type="file"
                                    accept="image/jpeg,image/png,image/webp,image/avif,image/*"
                                    onChange={(event) => handleReplaceCover(event.target.files?.[0] || null)}
                                    style={{ display: "none" }}
                                />
                                <button type="button" onClick={() => coverInputRef.current?.click()} style={secondaryButtonStyle} disabled={coverState === "uploading"}>
                                    {coverState === "uploading" ? "Uploading..." : "Replace Cover"}
                                </button>
                                {work.publication_status !== "submitted" && (
                                    <button type="button" onClick={() => updateWorkStatus("submitted")} style={secondaryButtonStyle} disabled={actionState === "saving"}>
                                        Submit For Review
                                    </button>
                                )}
                                <button type="button" onClick={() => updateWorkStatus("published")} style={secondaryButtonStyle} disabled={actionState === "saving"}>
                                    Publish Now
                                </button>
                                <button type="button" onClick={handleDeleteWork} style={{ ...secondaryButtonStyle, color: "#fca5a5", borderColor: "rgba(248,113,113,0.25)" }} disabled={actionState === "saving"}>
                                    Delete
                                </button>
                            </div>
                            <div style={{ display: "flex", gap: 14, color: "var(--text-muted)", fontSize: 12, flexWrap: "wrap" }}>
                                <span>{releases.length} releases</span>
                                <span>{work.series_status}</span>
                                <span>{work.language.toUpperCase()}</span>
                            </div>
                        </div>
                    </div>

                    {error && (
                        <div style={{
                            padding: 12,
                            borderRadius: 12,
                            background: "rgba(248,113,113,0.12)",
                            border: "1px solid rgba(248,113,113,0.25)",
                            color: "#fca5a5",
                            fontSize: 13,
                            marginBottom: 16,
                        }}>
                            {error}
                        </div>
                    )}

                    {infoMessage && (
                        <div style={{
                            padding: 12,
                            borderRadius: 12,
                            background: "rgba(74,222,128,0.12)",
                            border: "1px solid rgba(74,222,128,0.25)",
                            color: "#86efac",
                            fontSize: 13,
                            marginBottom: 16,
                        }}>
                            {infoMessage}
                        </div>
                    )}

                    <div style={{
                        padding: 16,
                        borderRadius: 18,
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        marginBottom: 18,
                    }}>
                        <h3 style={{ margin: "0 0 12px", color: "var(--text-primary)", fontWeight: 800 }}>Create Release</h3>
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <input
                                type="text"
                                value={releaseTitle}
                                onChange={(event) => setReleaseTitle(event.target.value)}
                                placeholder={work.kind === "anime" ? "Episode title" : "Release title"}
                                style={inputStyle}
                            />
                            <textarea
                                value={releaseSummary}
                                onChange={(event) => setReleaseSummary(event.target.value)}
                                rows={2}
                                placeholder="Release summary"
                                style={{ ...inputStyle, resize: "vertical", minHeight: 82, fontFamily: "inherit" }}
                            />
                            {work.kind === "novel" && (
                                <textarea
                                    value={releaseBody}
                                    onChange={(event) => setReleaseBody(event.target.value)}
                                    rows={8}
                                    placeholder="Chapter text"
                                    style={{ ...inputStyle, resize: "vertical", minHeight: 220, fontFamily: "inherit" }}
                                />
                            )}
                            <button
                                type="button"
                                onClick={handleCreateRelease}
                                disabled={!releaseTitle.trim() || releaseState === "saving"}
                                style={{
                                    padding: "13px 14px",
                                    borderRadius: 14,
                                    border: "none",
                                    background: releaseTitle.trim() && releaseState !== "saving"
                                        ? "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))"
                                        : "rgba(255,255,255,0.08)",
                                    color: releaseTitle.trim() ? "#fff" : "var(--text-muted)",
                                    fontWeight: 700,
                                    fontSize: 14,
                                    cursor: releaseTitle.trim() && releaseState !== "saving" ? "pointer" : "default",
                                }}
                            >
                                {releaseState === "saving" ? "Creating Release..." : "Create Release"}
                            </button>
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {releases.length === 0 ? (
                            <div style={{
                                padding: 20,
                                borderRadius: 16,
                                textAlign: "center",
                                background: "rgba(255,255,255,0.03)",
                                border: "1px solid rgba(255,255,255,0.06)",
                                color: "var(--text-muted)",
                            }}>
                                No releases yet. Create the first one above.
                            </div>
                        ) : (
                            releases.map((release) => (
                                <div
                                    key={release.id}
                                    style={{
                                        padding: 14,
                                        borderRadius: 16,
                                        background: "rgba(255,255,255,0.03)",
                                        border: "1px solid rgba(255,255,255,0.06)",
                                    }}
                                >
                                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                                        <span style={pillStyle}>#{release.sequence_number}</span>
                                        <span style={pillStyle}>{release.content_type.replaceAll("_", " ")}</span>
                                        <span style={pillStyle}>{release.publication_status.replaceAll("_", " ")}</span>
                                    </div>
                                    <p style={{ margin: "0 0 6px", color: "var(--text-primary)", fontWeight: 700 }}>{release.title}</p>
                                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                                        {release.summary || (work.kind === "novel" ? `${release.body_text.length} characters of chapter text` : "No summary yet.")}
                                    </p>
                                    {work.kind === "anime" && (
                                        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                                            <label style={uploadLabelStyle}>
                                                {releaseAssetState === `${release.id}:subtitle` ? "Uploading Subtitle..." : "Upload Subtitle"}
                                                <input
                                                    type="file"
                                                    accept=".vtt,.srt,text/vtt,application/x-subrip,text/plain"
                                                    style={{ display: "none" }}
                                                    onChange={(event) => handleReleaseAssetUpload(release.id, "subtitle", event.target.files?.[0] || null)}
                                                />
                                            </label>
                                            <label style={uploadLabelStyle}>
                                                {releaseAssetState === `${release.id}:video_manifest` ? "Uploading Manifest..." : "Upload Manifest"}
                                                <input
                                                    type="file"
                                                    accept=".m3u8,.mpd,application/vnd.apple.mpegurl,application/x-mpegurl,application/dash+xml,text/plain"
                                                    style={{ display: "none" }}
                                                    onChange={(event) => handleReleaseAssetUpload(release.id, "video_manifest", event.target.files?.[0] || null)}
                                                />
                                            </label>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </main>
        </>
    );
}

const pillStyle: CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    padding: "3px 8px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.08)",
    color: "var(--text-secondary)",
    textTransform: "capitalize",
};

const inputStyle: CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "var(--text-primary)",
    fontSize: 14,
    outline: "none",
};

const secondaryButtonStyle: CSSProperties = {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)",
    color: "var(--text-primary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
};

const uploadLabelStyle: CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)",
    color: "var(--text-primary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
};
