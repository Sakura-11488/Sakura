"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import novelIcon from "../../../../../wired-flat-3140-book-open-hover-pinch.json";
import mangaIcon from "../../../../../wired-flat-771-artist-painting-color-palette-hover-pinch.json";
import animeIcon from "../../../../../wired-flat-2440-goku-hover-pinch.json";

import Header from "@/components/Header";
import LottieIcon from "@/components/LottieIcon";
import { createCreatorWork, updateCreatorWork } from "@/lib/creator-works";
import { uploadCreatorAsset } from "@/lib/publisher-assets";
import {
    type WorkKind,
    validateWorkDraft,
    slugifyWorkTitle,
} from "@/lib/publishing";
import { buildWalletAuthHeaders, generateWalletAuthMessage } from "@/lib/wallet-auth";

const KIND_OPTIONS: Array<{ kind: WorkKind; animationData: object; label: string; description: string }> = [
    { kind: "novel", animationData: novelIcon, label: "Novel", description: "Text-first series with chapter releases" },
    { kind: "manga", animationData: mangaIcon, label: "Manga", description: "Image-based chapters with page ordering" },
    { kind: "anime", animationData: animeIcon, label: "Anime", description: "Episode-based video and subtitle publishing" },
];

export default function NewCreatorWorkPage() {
    const router = useRouter();
    const { publicKey, connected, signMessage } = useWallet();
    const wallet = publicKey?.toBase58() || "";
    const coverInputRef = useRef<HTMLInputElement | null>(null);

    const [kind, setKind] = useState<WorkKind>("novel");
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [genresText, setGenresText] = useState("");
    const [language, setLanguage] = useState("en");
    const [visibility, setVisibility] = useState<"private" | "unlisted" | "public">("private");
    const [coverUrl, setCoverUrl] = useState("");
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const [coverPreviewUrl, setCoverPreviewUrl] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [uploadState, setUploadState] = useState<"idle" | "uploading" | "error">("idle");

    const genres = useMemo(() => genresText.split(",").map((genre) => genre.trim()).filter(Boolean), [genresText]);

    useEffect(() => {
        return () => {
            if (coverPreviewUrl.startsWith("blob:")) {
                URL.revokeObjectURL(coverPreviewUrl);
            }
        };
    }, [coverPreviewUrl]);

    const signPublisherAction = useCallback(async (action: string) => {
        if (!publicKey || !signMessage) throw new Error("Wallet signing is unavailable.");
        const message = generateWalletAuthMessage(action);
        const sigBytes = await signMessage(new TextEncoder().encode(message));
        return buildWalletAuthHeaders(publicKey.toBase58(), bs58.encode(sigBytes), message);
    }, [publicKey, signMessage]);

    const clearCoverFile = useCallback(() => {
        if (coverPreviewUrl.startsWith("blob:")) {
            URL.revokeObjectURL(coverPreviewUrl);
        }
        setCoverFile(null);
        setCoverPreviewUrl("");
        if (coverInputRef.current) {
            coverInputRef.current.value = "";
        }
    }, [coverPreviewUrl]);

    const onSelectCover = useCallback((file: File | null) => {
        if (!file) return;
        clearCoverFile();
        setCoverFile(file);
        setCoverPreviewUrl(URL.createObjectURL(file));
    }, [clearCoverFile]);

    const handleCreate = useCallback(async () => {
        if (!wallet) {
            setError("Connect your wallet first.");
            return;
        }
        if (!title.trim()) {
            setError("Title is required.");
            return;
        }

        const issues = validateWorkDraft({
            kind,
            title,
            description,
            genres,
            language,
            visibility,
        });

        if (issues.length > 0) {
            setError(issues[0].message);
            return;
        }

        setSaving(true);
        setError(null);

        try {
            const slugBase = slugifyWorkTitle(title);
            const work = await createCreatorWork(wallet, {
                kind,
                title,
                slug: slugBase ? `${slugBase}-${Date.now().toString(36)}` : null,
                description,
                genres,
                language,
                visibility,
                release_metadata: coverFile ? {} : (coverUrl.trim() ? { cover_url: coverUrl.trim() } : {}),
            });

            if (!work) {
                setError("Failed to create the creator work.");
                return;
            }

            if (coverFile) {
                setUploadState("uploading");
                try {
                    const authHeaders = await signPublisherAction("creator-asset-upload");
                    const uploaded = await uploadCreatorAsset({
                        file: coverFile,
                        kind: kind === "anime" ? "poster" : "cover",
                        workId: work.id,
                        role: kind === "anime" ? "poster" : "cover",
                        isPrimary: true,
                        isPublic: true,
                        keepOriginal: true,
                    }, authHeaders);

                    const detailVariant = uploaded.variants.find((variant) => variant.variantKey === "detail" && variant.publicUrl);
                    const fallbackVariant = uploaded.variants.find((variant) => variant.publicUrl);
                    const resolvedCoverUrl = detailVariant?.publicUrl || fallbackVariant?.publicUrl || uploaded.asset.publicUrl || "";
                    if (resolvedCoverUrl) {
                        await updateCreatorWork(work.id, wallet, {
                            release_metadata: {
                                ...(work.release_metadata || {}),
                                cover_url: resolvedCoverUrl,
                            },
                        });
                    }
                    setUploadState("idle");
                } catch (uploadError: any) {
                    console.error("Initial work cover upload failed:", uploadError);
                    setUploadState("error");
                    setError(uploadError?.message || "Work created, but cover upload failed.");
                }
            }

            router.push(`/creator/works/manage?id=${encodeURIComponent(work.id)}`);
        } finally {
            setSaving(false);
        }
    }, [wallet, title, kind, description, genres, language, visibility, coverFile, coverUrl, signPublisherAction, router]);

    if (!connected || !wallet) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <section className="section" style={{ paddingTop: 80, textAlign: "center" }}>
                        <p style={{ fontSize: 48, margin: "0 0 16px" }}>🌸</p>
                        <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", margin: "0 0 8px" }}>
                            Start a Creator Work
                        </h2>
                        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
                            Connect your wallet to create a novel, manga, or anime work.
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
                    <div className="title-header" style={{ marginBottom: 20 }}>
                        <Link href="/creator/works" className="back-btn">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                        </Link>
                        <div className="title-header-text">New Creator Work</div>
                        <div style={{ width: 40 }} />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                        <div>
                            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>
                                Work Type
                            </label>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                                {KIND_OPTIONS.map((option) => (
                                    <button
                                        key={option.kind}
                                        type="button"
                                        onClick={() => setKind(option.kind)}
                                        style={{
                                            padding: "14px 12px",
                                            borderRadius: 16,
                                            border: kind === option.kind ? "1px solid var(--sakura-pink)" : "1px solid rgba(255,255,255,0.08)",
                                            background: kind === option.kind ? "rgba(255,107,157,0.12)" : "rgba(255,255,255,0.03)",
                                            color: kind === option.kind ? "var(--sakura-pink)" : "var(--text-primary)",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
                                            <LottieIcon
                                                animationData={option.animationData}
                                                size={34}
                                                playOnMount
                                                replayIntervalMs={4000}
                                            />
                                        </div>
                                        <div style={{ fontSize: 13, fontWeight: 700 }}>{option.label}</div>
                                    </button>
                                ))}
                            </div>
                            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                                {KIND_OPTIONS.find((option) => option.kind === kind)?.description}
                            </p>
                        </div>

                        <div>
                            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>
                                Title
                            </label>
                            <input
                                type="text"
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                placeholder={kind === "anime" ? "Studio Sakura Originals" : "My New Story"}
                                style={inputStyle}
                            />
                        </div>

                        <div>
                            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>
                                Description
                            </label>
                            <textarea
                                value={description}
                                onChange={(event) => setDescription(event.target.value)}
                                rows={4}
                                placeholder="Give readers a quick reason to care."
                                style={{ ...inputStyle, resize: "vertical", minHeight: 110, fontFamily: "inherit" }}
                            />
                        </div>

                        <div>
                            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>
                                Genres
                            </label>
                            <input
                                type="text"
                                value={genresText}
                                onChange={(event) => setGenresText(event.target.value)}
                                placeholder="Fantasy, Action, Romance"
                                style={inputStyle}
                            />
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                            <div>
                                <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>
                                    Language
                                </label>
                                <input
                                    type="text"
                                    value={language}
                                    onChange={(event) => setLanguage(event.target.value)}
                                    placeholder="en"
                                    style={inputStyle}
                                />
                            </div>
                            <div>
                                <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>
                                    Visibility
                                </label>
                                <select
                                    value={visibility}
                                    onChange={(event) => setVisibility(event.target.value as typeof visibility)}
                                    style={inputStyle}
                                >
                                    <option value="private">Private</option>
                                    <option value="unlisted">Unlisted</option>
                                    <option value="public">Public</option>
                                </select>
                            </div>
                        </div>

                        <div>
                            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>
                                Cover Or Poster
                            </label>
                            <input
                                ref={coverInputRef}
                                type="file"
                                accept="image/jpeg,image/png,image/webp,image/avif,image/*"
                                onChange={(event) => onSelectCover(event.target.files?.[0] || null)}
                                style={{ display: "none" }}
                            />
                            <div style={{
                                display: "flex",
                                gap: 12,
                                alignItems: "center",
                                padding: 12,
                                borderRadius: 16,
                                background: "rgba(255,255,255,0.03)",
                                border: "1px solid rgba(255,255,255,0.06)",
                                marginBottom: 10,
                            }}>
                                <div style={{
                                    width: 74,
                                    aspectRatio: "2/3",
                                    borderRadius: 10,
                                    overflow: "hidden",
                                    background: "rgba(255,255,255,0.04)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                }}>
                                    {(coverFile ? coverPreviewUrl : coverUrl) ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={coverFile ? coverPreviewUrl : coverUrl} alt="Work cover preview" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                    ) : (
                                        <LottieIcon
                                            animationData={kind === "novel" ? novelIcon : kind === "manga" ? mangaIcon : animeIcon}
                                            size={34}
                                            playOnMount
                                            replayIntervalMs={4000}
                                        />
                                    )}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
                                        {coverFile ? coverFile.name : "Choose from your device"}
                                    </p>
                                    <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                                        Sakura will normalize the asset after the work is created.
                                    </p>
                                </div>
                            </div>
                            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                                <button type="button" onClick={() => coverInputRef.current?.click()} style={secondaryButtonStyle}>
                                    {coverFile ? "Choose Another Image" : "Choose From Device"}
                                </button>
                                {coverFile && (
                                    <button type="button" onClick={clearCoverFile} style={{ ...secondaryButtonStyle, flex: "0 0 auto" }}>
                                        Clear
                                    </button>
                                )}
                            </div>
                            <input
                                type="text"
                                value={coverUrl}
                                onChange={(event) => setCoverUrl(event.target.value)}
                                placeholder="Or paste a cover/poster URL"
                                style={inputStyle}
                            />
                        </div>

                        {error && (
                            <div style={{
                                padding: 12,
                                borderRadius: 12,
                                background: "rgba(248,113,113,0.12)",
                                border: "1px solid rgba(248,113,113,0.25)",
                                color: "#fca5a5",
                                fontSize: 13,
                            }}>
                                {error}
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={handleCreate}
                            disabled={!title.trim() || saving}
                            style={{
                                padding: "14px 16px",
                                borderRadius: 16,
                                border: "none",
                                background: title.trim() && !saving
                                    ? "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))"
                                    : "rgba(255,255,255,0.08)",
                                color: title.trim() ? "#fff" : "var(--text-muted)",
                                fontWeight: 700,
                                fontSize: 15,
                                cursor: title.trim() && !saving ? "pointer" : "default",
                            }}
                        >
                            {uploadState === "uploading" ? "Uploading Cover..." : saving ? "Creating..." : `Create ${KIND_OPTIONS.find((option) => option.kind === kind)?.label}`}
                        </button>
                    </div>
                </section>
            </main>
        </>
    );
}

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
    flex: 1,
    padding: "12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
};
