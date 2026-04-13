"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import novelIcon from "../../../../../wired-flat-3140-book-open-hover-pinch.json";
import mangaIcon from "../../../../../wired-flat-771-artist-painting-color-palette-hover-pinch.json";
import animeIcon from "../../../../../wired-flat-2440-goku-hover-pinch.json";

import Header from "@/components/Header";
import LottieIcon from "@/components/LottieIcon";
import { createCompressedMintSetupOnChain } from "@/lib/compressed-mint-setup";
import { getWorkMintRecords } from "@/lib/creator-mints";
import {
    createWorkRelease,
    deleteCreatorWork,
    deleteWorkRelease,
    getCreatorWork,
    getReleaseAssetsForReleases,
    getWorkReleases,
    updateCreatorWork,
    updateWorkRelease,
} from "@/lib/creator-works";
import { uploadCreatorAsset } from "@/lib/publisher-assets";
import { verifyCreatorMintIntent } from "@/lib/publisher-mints";
import {
    getDefaultContentTypeForWorkKind,
    MINT_TYPES,
    sortNamedItemsNaturally,
    type CreatorWork,
    type LinkedCreatorAsset,
    type MintType,
    type WorkKind,
    type WorkMintRecord,
    type WorkRelease,
    validateMintIntentDraft,
    validateReleaseDraft,
} from "@/lib/publishing";
import { buildWalletAuthHeaders, generateWalletAuthMessage } from "@/lib/wallet-auth";

type ReleaseDraftState = Record<string, { title: string; summary: string; bodyText: string }>;
type ReleaseAssetJob = {
    releaseId: string;
    kind: "subtitle" | "video_manifest" | "manga_page";
    current: number;
    total: number;
};

const KIND_ICONS: Record<WorkKind, object> = {
    novel: novelIcon,
    manga: mangaIcon,
    anime: animeIcon,
};

function buildReleaseDrafts(releases: WorkRelease[]): ReleaseDraftState {
    return Object.fromEntries(
        releases.map((release) => [
            release.id,
            {
                title: release.title,
                summary: release.summary,
                bodyText: release.body_text,
            },
        ])
    );
}

function formatBytes(sizeBytes: number): string {
    if (sizeBytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const power = Math.min(Math.floor(Math.log(sizeBytes) / Math.log(1024)), units.length - 1);
    const value = sizeBytes / 1024 ** power;
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}

function formatRole(value: string): string {
    return value.replaceAll("_", " ");
}

export default function CreatorWorkManagePage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const workId = searchParams.get("id") || "";
    const { publicKey, connected, signMessage, signTransaction, signAllTransactions } = useWallet();
    const wallet = publicKey?.toBase58() || "";
    const coverInputRef = useRef<HTMLInputElement | null>(null);

    const [work, setWork] = useState<CreatorWork | null>(null);
    const [releases, setReleases] = useState<WorkRelease[]>([]);
    const [releaseDrafts, setReleaseDrafts] = useState<ReleaseDraftState>({});
    const [releaseAssets, setReleaseAssets] = useState<Record<string, LinkedCreatorAsset[]>>({});
    const [mintRecords, setMintRecords] = useState<WorkMintRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [infoMessage, setInfoMessage] = useState<string | null>(null);
    const [coverState, setCoverState] = useState<"idle" | "uploading" | "error">("idle");
    const [releaseState, setReleaseState] = useState<"idle" | "saving" | "error">("idle");
    const [actionState, setActionState] = useState<"idle" | "saving">("idle");
    const [releaseActionState, setReleaseActionState] = useState<string | null>(null);
    const [releaseAssetState, setReleaseAssetState] = useState<ReleaseAssetJob | null>(null);
    const [mintState, setMintState] = useState<"idle" | "saving">("idle");

    const [releaseTitle, setReleaseTitle] = useState("");
    const [releaseSummary, setReleaseSummary] = useState("");
    const [releaseBody, setReleaseBody] = useState("");

    const [mintType, setMintType] = useState<MintType>("collectible");
    const [mintPrice, setMintPrice] = useState("0");
    const [maxSupply, setMaxSupply] = useState("");
    const [metadataUri, setMetadataUri] = useState("");
    const [txSignature, setTxSignature] = useState("");
    const [collectionAddress, setCollectionAddress] = useState("");
    const [treeAddress, setTreeAddress] = useState("");
    const [mintAddress, setMintAddress] = useState("");

    const hydrateWork = useCallback(async (targetWorkId: string) => {
        const workData = await getCreatorWork(targetWorkId);
        if (!workData) {
            setWork(null);
            setReleases([]);
            setReleaseDrafts({});
            setReleaseAssets({});
            setMintRecords([]);
            return;
        }

        const [releaseData, mintData] = await Promise.all([
            getWorkReleases(targetWorkId),
            getWorkMintRecords({ workId: targetWorkId }),
        ]);
        const assetData = await getReleaseAssetsForReleases(releaseData.map((release) => release.id));

        setWork(workData);
        setReleases(releaseData);
        setReleaseDrafts(buildReleaseDrafts(releaseData));
        setReleaseAssets(assetData);
        setMintRecords(mintData);
    }, []);

    const loadWork = useCallback(async () => {
        if (!workId) {
            setLoading(false);
            setError("Missing work ID.");
            return;
        }

        setLoading(true);
        setError(null);
        try {
            await hydrateWork(workId);
        } finally {
            setLoading(false);
        }
    }, [hydrateWork, workId]);

    useEffect(() => {
        loadWork();
    }, [loadWork]);

    useEffect(() => {
        if (mintRecords.length === 0) return;
        const latest = mintRecords[0];
        setMetadataUri((prev) => prev || latest.metadata_uri);
        setMintPrice((prev) => prev || String(latest.mint_price));
        setMaxSupply((prev) => prev || (latest.max_supply != null ? String(latest.max_supply) : ""));
        setCollectionAddress((prev) => prev || latest.collection_address || "");
        setTreeAddress((prev) => prev || latest.tree_address || "");
        setMintAddress((prev) => prev || latest.mint_address || "");
        setTxSignature((prev) => prev || latest.setup_tx_signature || "");
        setMintType((prev) => prev || latest.mint_type);
    }, [mintRecords]);

    const isOwner = Boolean(work && wallet && work.creator_wallet === wallet);
    const defaultContentType = useMemo(
        () => getDefaultContentTypeForWorkKind(work?.kind || "novel"),
        [work]
    );
    const legacyNovelId = String(work?.release_metadata?.legacy_novel_id || "");

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
            setInfoMessage("Cover updated.");
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

        const nextNumber = (releases[releases.length - 1]?.sequence_number || 0) + 1;
        const issues = validateReleaseDraft({
            workKind: work.kind,
            sequenceNumber: nextNumber,
            title: releaseTitle,
            bodyText: releaseBody,
            visibility: work.visibility,
        });

        if (issues.length > 0) {
            setError(issues[0].message);
            return;
        }

        setReleaseState("saving");
        setError(null);
        setInfoMessage(null);

        const created = await createWorkRelease(work.id, wallet, {
            sequence_number: nextNumber,
            title: releaseTitle,
            summary: releaseSummary,
            body_text: work.kind === "novel" ? releaseBody : "",
            content_type: defaultContentType,
            visibility: work.visibility,
            publication_status: "draft",
            release_metadata: work.kind === "manga"
                ? { page_count: 0, page_sort_strategy: "filename" }
                : work.kind === "anime"
                    ? { subtitle_count: 0, manifest_count: 0 }
                    : {},
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
        setInfoMessage("Release created.");
        await hydrateWork(work.id);
    }, [defaultContentType, hydrateWork, releaseBody, releaseSummary, releaseTitle, releases, wallet, work]);

    const handleReleaseDraftChange = useCallback((
        releaseId: string,
        field: "title" | "summary" | "bodyText",
        value: string
    ) => {
        setReleaseDrafts((prev) => ({
            ...prev,
            [releaseId]: {
                title: prev[releaseId]?.title || "",
                summary: prev[releaseId]?.summary || "",
                bodyText: prev[releaseId]?.bodyText || "",
                [field]: value,
            },
        }));
    }, []);

    const handleSaveRelease = useCallback(async (release: WorkRelease) => {
        if (!wallet || !work) return;
        const draft = releaseDrafts[release.id];
        if (!draft) return;

        const issues = validateReleaseDraft({
            workKind: work.kind,
            sequenceNumber: release.sequence_number,
            title: draft.title,
            bodyText: draft.bodyText,
            visibility: release.visibility,
        });

        if (issues.length > 0) {
            setError(issues[0].message);
            return;
        }

        setReleaseActionState(`save:${release.id}`);
        setError(null);
        setInfoMessage(null);
        const updated = await updateWorkRelease(release.id, wallet, {
            title: draft.title.trim(),
            summary: draft.summary.trim(),
            body_text: work.kind === "novel" ? draft.bodyText : release.body_text,
        });
        setReleaseActionState(null);

        if (!updated) {
            setError("Failed to save release changes.");
            return;
        }

        setInfoMessage(`Saved ${draft.title.trim()}.`);
        await hydrateWork(work.id);
    }, [hydrateWork, releaseDrafts, wallet, work]);

    const handleUpdateReleaseStatus = useCallback(async (
        release: WorkRelease,
        status: WorkRelease["publication_status"]
    ) => {
        if (!wallet || !work) return;

        setReleaseActionState(`status:${release.id}:${status}`);
        setError(null);
        setInfoMessage(null);
        const updated = await updateWorkRelease(release.id, wallet, {
            publication_status: status,
            visibility: status === "published" ? "public" : release.visibility,
            published_at: status === "published" ? new Date().toISOString() : release.published_at,
        });
        setReleaseActionState(null);

        if (!updated) {
            setError("Failed to update release status.");
            return;
        }

        setInfoMessage(`Release moved to ${status.replaceAll("_", " ")}.`);
        await hydrateWork(work.id);
    }, [hydrateWork, wallet, work]);

    const handleDeleteRelease = useCallback(async (release: WorkRelease) => {
        if (!wallet || !work) return;
        if (!confirm(`Delete release "${release.title}"?`)) return;

        setReleaseActionState(`delete:${release.id}`);
        setError(null);
        setInfoMessage(null);
        const deleted = await deleteWorkRelease(release.id, wallet);
        setReleaseActionState(null);

        if (!deleted) {
            setError("Failed to delete release.");
            return;
        }

        setInfoMessage(`Deleted ${release.title}.`);
        await hydrateWork(work.id);
    }, [hydrateWork, wallet, work]);

    const handleReleaseAssetUpload = useCallback(async (
        release: WorkRelease,
        kind: "subtitle" | "video_manifest",
        file: File | null
    ) => {
        if (!file || !work || !wallet) return;

        setReleaseAssetState({ releaseId: release.id, kind, current: 1, total: 1 });
        setError(null);
        setInfoMessage(null);

        try {
            const authHeaders = await signPublisherAction("creator-asset-upload");
            await uploadCreatorAsset({
                file,
                kind,
                releaseId: release.id,
                role: kind === "subtitle" ? "subtitle" : "video_manifest",
                isPrimary: false,
                isPublic: false,
                keepOriginal: true,
            }, authHeaders);

            const nextAssets = releaseAssets[release.id] || [];
            const updated = await updateWorkRelease(release.id, wallet, {
                release_metadata: {
                    ...(release.release_metadata || {}),
                    subtitle_count: kind === "subtitle"
                        ? nextAssets.filter((asset) => asset.role === "subtitle").length + 1
                        : Number(release.release_metadata?.subtitle_count || 0),
                    manifest_count: kind === "video_manifest"
                        ? nextAssets.filter((asset) => asset.role === "video_manifest").length + 1
                        : Number(release.release_metadata?.manifest_count || 0),
                    asset_manifest_updated_at: new Date().toISOString(),
                },
            });

            if (!updated) {
                throw new Error("Asset uploaded, but release metadata could not be updated.");
            }

            setInfoMessage(kind === "subtitle"
                ? "Subtitle uploaded for this release."
                : "Video manifest uploaded for this release.");
            setReleaseAssetState(null);
            await hydrateWork(work.id);
        } catch (uploadError: any) {
            console.error("Release asset upload failed:", uploadError);
            setReleaseAssetState(null);
            setError(uploadError?.message || "Failed to upload release asset.");
        }
    }, [hydrateWork, releaseAssets, signPublisherAction, wallet, work]);

    const handleMangaPageBatchUpload = useCallback(async (release: WorkRelease, files: FileList | null) => {
        if (!files || files.length === 0 || !work || !wallet) return;

        const orderedFiles = sortNamedItemsNaturally(Array.from(files));
        const existingPages = (releaseAssets[release.id] || []).filter((asset) => asset.role === "manga_page").length;
        setReleaseAssetState({ releaseId: release.id, kind: "manga_page", current: 0, total: orderedFiles.length });
        setError(null);
        setInfoMessage(null);

        try {
            const authHeaders = await signPublisherAction("creator-asset-upload");
            for (const [index, file] of orderedFiles.entries()) {
                setReleaseAssetState({
                    releaseId: release.id,
                    kind: "manga_page",
                    current: index + 1,
                    total: orderedFiles.length,
                });
                await uploadCreatorAsset({
                    file,
                    kind: "manga_page",
                    releaseId: release.id,
                    role: "manga_page",
                    sortOrder: existingPages + index,
                    isPrimary: false,
                    isPublic: false,
                    keepOriginal: true,
                }, authHeaders);
            }

            const updated = await updateWorkRelease(release.id, wallet, {
                release_metadata: {
                    ...(release.release_metadata || {}),
                    page_count: existingPages + orderedFiles.length,
                    page_sort_strategy: "filename",
                    page_manifest_updated_at: new Date().toISOString(),
                },
            });

            if (!updated) {
                throw new Error("Pages uploaded, but release metadata could not be updated.");
            }

            setInfoMessage(`${orderedFiles.length} manga pages uploaded in filename order.`);
            setReleaseAssetState(null);
            await hydrateWork(work.id);
        } catch (uploadError: any) {
            console.error("Manga page upload failed:", uploadError);
            setReleaseAssetState(null);
            setError(uploadError?.message || "Failed to upload manga pages.");
        }
    }, [hydrateWork, releaseAssets, signPublisherAction, wallet, work]);

    const updateWorkStatus = useCallback(async (status: CreatorWork["publication_status"]) => {
        if (!work || !wallet) return;
        setActionState("saving");
        setError(null);
        setInfoMessage(null);

        const updated = await updateCreatorWork(work.id, wallet, {
            publication_status: status,
            visibility: status === "published" ? "public" : work.visibility,
            published_at: status === "published" ? new Date().toISOString() : work.published_at,
        });

        if (!updated) {
            setError("Failed to update work status.");
            setActionState("idle");
            return;
        }

        setWork((prev) => prev ? {
            ...prev,
            publication_status: status,
            visibility: status === "published" ? "public" : prev.visibility,
            published_at: status === "published" ? new Date().toISOString() : prev.published_at,
        } : prev);
        setInfoMessage(`Work moved to ${status.replaceAll("_", " ")}.`);
        setActionState("idle");
    }, [wallet, work]);

    const handleToggleMinting = useCallback(async (enabled: boolean) => {
        if (!work || !wallet) return;

        setActionState("saving");
        setError(null);
        const updated = await updateCreatorWork(work.id, wallet, {
            minting_enabled: enabled,
        });
        setActionState("idle");

        if (!updated) {
            setError("Failed to update minting settings.");
            return;
        }

        setWork((prev) => prev ? { ...prev, minting_enabled: enabled } : prev);
        setInfoMessage(enabled ? "Minting enabled for this work." : "Minting disabled for this work.");
    }, [wallet, work]);

    const handleCreateOnChainMintSetup = useCallback(async () => {
        if (!work || !wallet || !publicKey || !signTransaction) {
            setError("Wallet transaction signing is required for on-chain mint setup.");
            return;
        }

        const parsedMintPrice = Number.parseFloat(mintPrice || "0");
        const parsedMaxSupply = maxSupply.trim() ? Number.parseInt(maxSupply.trim(), 10) : null;
        const issues = validateMintIntentDraft({
            mintType,
            metadataUri,
            txSignature: "pending-onchain-setup",
            mintPrice: parsedMintPrice,
            maxSupply: parsedMaxSupply,
            collectionAddress,
            treeAddress,
            mintAddress,
        });

        if (issues.length > 0) {
            setError(issues[0].message);
            return;
        }

        setMintState("saving");
        setError(null);
        setInfoMessage(null);

        try {
            const createdSetup = await createCompressedMintSetupOnChain({
                walletAdapter: {
                    publicKey,
                    signMessage,
                    signTransaction,
                    signAllTransactions,
                },
            });

            setTreeAddress(createdSetup.treeAddress);
            setTxSignature(createdSetup.signature);

            const authHeaders = await signPublisherAction("creator-mint-verify");
            await verifyCreatorMintIntent({
                workId: work.id,
                mintScope: "work",
                mintType,
                metadataUri: metadataUri.trim(),
                txSignature: createdSetup.signature,
                mintPrice: parsedMintPrice,
                maxSupply: parsedMaxSupply,
                currency: "SAKURA",
                collectionAddress: collectionAddress.trim() || undefined,
                treeAddress: createdSetup.treeAddress,
                mintAddress: mintAddress.trim() || undefined,
            }, authHeaders);

            if (!work.minting_enabled) {
                await updateCreatorWork(work.id, wallet, { minting_enabled: true });
                setWork((prev) => prev ? { ...prev, minting_enabled: true } : prev);
            }

            setInfoMessage("On-chain compressed mint setup created and verified.");
            setMintState("idle");
            await hydrateWork(work.id);
        } catch (mintError: any) {
            console.error("On-chain mint setup failed:", mintError);
            setMintState("idle");
            setError(mintError?.message || "Failed to create on-chain mint setup.");
        }
    }, [collectionAddress, hydrateWork, maxSupply, metadataUri, mintAddress, mintPrice, mintType, publicKey, signAllTransactions, signMessage, signPublisherAction, signTransaction, treeAddress, wallet, work]);

    const handleVerifyMint = useCallback(async () => {
        if (!work || !wallet) return;

        const parsedMintPrice = Number.parseFloat(mintPrice || "0");
        const parsedMaxSupply = maxSupply.trim() ? Number.parseInt(maxSupply.trim(), 10) : null;
        const issues = validateMintIntentDraft({
            mintType,
            metadataUri,
            txSignature,
            mintPrice: parsedMintPrice,
            maxSupply: parsedMaxSupply,
            collectionAddress,
            treeAddress,
            mintAddress,
        });

        if (issues.length > 0) {
            setError(issues[0].message);
            return;
        }

        setMintState("saving");
        setError(null);
        setInfoMessage(null);

        try {
            const authHeaders = await signPublisherAction("creator-mint-verify");
            await verifyCreatorMintIntent({
                workId: work.id,
                mintScope: "work",
                mintType,
                metadataUri: metadataUri.trim(),
                txSignature: txSignature.trim(),
                mintPrice: parsedMintPrice,
                maxSupply: parsedMaxSupply,
                currency: "SAKURA",
                collectionAddress: collectionAddress.trim() || undefined,
                treeAddress: treeAddress.trim() || undefined,
                mintAddress: mintAddress.trim() || undefined,
            }, authHeaders);

            if (!work.minting_enabled) {
                await updateCreatorWork(work.id, wallet, { minting_enabled: true });
                setWork((prev) => prev ? { ...prev, minting_enabled: true } : prev);
            }

            setInfoMessage("Existing on-chain mint setup verified and submitted for review.");
            setMintState("idle");
            await hydrateWork(work.id);
        } catch (mintError: any) {
            console.error("Mint intent verification failed:", mintError);
            setMintState("idle");
            setError(mintError?.message || "Failed to verify mint intent.");
        }
    }, [collectionAddress, hydrateWork, maxSupply, metadataUri, mintAddress, mintPrice, mintType, signPublisherAction, treeAddress, txSignature, wallet, work]);

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

                    <div style={panelStyle}>
                        <div style={{ width: 96, flexShrink: 0, borderRadius: 14, overflow: "hidden" }}>
                            {coverUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={coverUrl} alt="" style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover" }} />
                            ) : (
                                <div style={{ width: "100%", aspectRatio: "2/3", background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <LottieIcon
                                        animationData={KIND_ICONS[work.kind]}
                                        size={46}
                                        playOnMount
                                        replayIntervalMs={4000}
                                    />
                                </div>
                            )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                                <span style={pillStyle}>{work.kind}</span>
                                <span style={pillStyle}>{work.publication_status.replaceAll("_", " ")}</span>
                                <span style={pillStyle}>{work.visibility}</span>
                                <span style={pillStyle}>{work.minting_enabled ? "minting on" : "minting off"}</span>
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
                                <button type="button" onClick={() => handleToggleMinting(!work.minting_enabled)} style={secondaryButtonStyle} disabled={actionState === "saving"}>
                                    {work.minting_enabled ? "Disable Minting" : "Enable Minting"}
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

                    {legacyNovelId && (
                        <div style={noteStyle}>
                            This work is synced from the legacy novel dashboard. Use the bridge-safe workspace for release metadata and mint prep, and use the legacy novel editor for deep chapter writing until full parity is done.
                            <div style={{ marginTop: 10 }}>
                                <Link href="/novel/publish" style={linkButtonStyle}>
                                    Open Legacy Novel Dashboard
                                </Link>
                            </div>
                        </div>
                    )}

                    {error && (
                        <div style={errorStyle}>
                            {error}
                        </div>
                    )}

                    {infoMessage && (
                        <div style={successStyle}>
                            {infoMessage}
                        </div>
                    )}

                    <div style={{ ...panelStyle, display: "block", marginBottom: 18 }}>
                        <h3 style={{ margin: "0 0 12px", color: "var(--text-primary)", fontWeight: 800 }}>Create Release</h3>
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <input
                                type="text"
                                value={releaseTitle}
                                onChange={(event) => setReleaseTitle(event.target.value)}
                                placeholder={work.kind === "anime" ? "Episode title" : work.kind === "manga" ? "Chapter title" : "Release title"}
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
                            {work.kind !== "novel" && (
                                <p style={helperTextStyle}>
                                    {work.kind === "manga"
                                        ? "Create the chapter first, then batch-upload the page images in filename order."
                                        : "Create the episode first, then attach subtitles and playback manifests per release."}
                                </p>
                            )}
                            <button
                                type="button"
                                onClick={handleCreateRelease}
                                disabled={!releaseTitle.trim() || releaseState === "saving"}
                                style={primaryButtonStyle(!releaseTitle.trim() || releaseState === "saving")}
                            >
                                {releaseState === "saving" ? "Creating Release..." : "Create Release"}
                            </button>
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
                        {releases.length === 0 ? (
                            <div style={emptyStateStyle}>
                                No releases yet. Create the first one above.
                            </div>
                        ) : (
                            releases.map((release) => {
                                const draft = releaseDrafts[release.id] || {
                                    title: release.title,
                                    summary: release.summary,
                                    bodyText: release.body_text,
                                };
                                const assets = releaseAssets[release.id] || [];
                                const mangaPages = assets.filter((asset) => asset.role === "manga_page");
                                const subtitles = assets.filter((asset) => asset.role === "subtitle");
                                const manifests = assets.filter((asset) => asset.role === "video_manifest");
                                const otherAssets = assets.filter((asset) => !["manga_page", "subtitle", "video_manifest"].includes(asset.role));
                                const uploadStateForRelease = releaseAssetState?.releaseId === release.id ? releaseAssetState : null;
                                const isSavingRelease = releaseActionState === `save:${release.id}`;

                                return (
                                    <div key={release.id} style={{ ...panelStyle, display: "block", padding: 14 }}>
                                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                                            <span style={pillStyle}>#{release.sequence_number}</span>
                                            <span style={pillStyle}>{release.content_type.replaceAll("_", " ")}</span>
                                            <span style={pillStyle}>{release.publication_status.replaceAll("_", " ")}</span>
                                            {mangaPages.length > 0 && <span style={pillStyle}>{mangaPages.length} pages</span>}
                                            {subtitles.length > 0 && <span style={pillStyle}>{subtitles.length} subtitle{subtitles.length === 1 ? "" : "s"}</span>}
                                            {manifests.length > 0 && <span style={pillStyle}>{manifests.length} manifest{manifests.length === 1 ? "" : "s"}</span>}
                                        </div>

                                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                            <input
                                                type="text"
                                                value={draft.title}
                                                onChange={(event) => handleReleaseDraftChange(release.id, "title", event.target.value)}
                                                style={inputStyle}
                                            />
                                            <textarea
                                                value={draft.summary}
                                                onChange={(event) => handleReleaseDraftChange(release.id, "summary", event.target.value)}
                                                rows={2}
                                                placeholder="Release summary"
                                                style={{ ...inputStyle, resize: "vertical", minHeight: 90, fontFamily: "inherit" }}
                                            />
                                            {work.kind === "novel" && (
                                                <textarea
                                                    value={draft.bodyText}
                                                    onChange={(event) => handleReleaseDraftChange(release.id, "bodyText", event.target.value)}
                                                    rows={8}
                                                    placeholder="Chapter text"
                                                    style={{ ...inputStyle, resize: "vertical", minHeight: 220, fontFamily: "inherit" }}
                                                />
                                            )}
                                            {work.kind !== "novel" && (
                                                <p style={helperTextStyle}>
                                                    {draft.summary || "Add a short release summary so reviewers know what this entry contains."}
                                                </p>
                                            )}
                                        </div>

                                        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                                            <button
                                                type="button"
                                                onClick={() => handleSaveRelease(release)}
                                                style={secondaryButtonStyle}
                                                disabled={Boolean(releaseActionState)}
                                            >
                                                {isSavingRelease ? "Saving..." : "Save Release"}
                                            </button>
                                            {release.publication_status !== "submitted" && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleUpdateReleaseStatus(release, "submitted")}
                                                    style={secondaryButtonStyle}
                                                    disabled={Boolean(releaseActionState)}
                                                >
                                                    Submit
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => handleUpdateReleaseStatus(release, "published")}
                                                style={secondaryButtonStyle}
                                                disabled={Boolean(releaseActionState)}
                                            >
                                                Publish
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleDeleteRelease(release)}
                                                style={{ ...secondaryButtonStyle, color: "#fca5a5", borderColor: "rgba(248,113,113,0.25)" }}
                                                disabled={Boolean(releaseActionState)}
                                            >
                                                Delete
                                            </button>
                                        </div>

                                        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                                            {work.kind === "anime" && (
                                                <>
                                                    <label style={uploadLabelStyle}>
                                                        {uploadStateForRelease?.kind === "subtitle" ? "Uploading Subtitle..." : "Upload Subtitle"}
                                                        <input
                                                            type="file"
                                                            accept=".vtt,.srt,text/vtt,application/x-subrip,text/plain"
                                                            style={{ display: "none" }}
                                                            onChange={(event) => handleReleaseAssetUpload(release, "subtitle", event.target.files?.[0] || null)}
                                                        />
                                                    </label>
                                                    <label style={uploadLabelStyle}>
                                                        {uploadStateForRelease?.kind === "video_manifest" ? "Uploading Manifest..." : "Upload Manifest"}
                                                        <input
                                                            type="file"
                                                            accept=".m3u8,.mpd,application/vnd.apple.mpegurl,application/x-mpegurl,application/dash+xml,text/plain"
                                                            style={{ display: "none" }}
                                                            onChange={(event) => handleReleaseAssetUpload(release, "video_manifest", event.target.files?.[0] || null)}
                                                        />
                                                    </label>
                                                </>
                                            )}
                                            {work.kind === "manga" && (
                                                <label style={uploadLabelStyle}>
                                                    {uploadStateForRelease?.kind === "manga_page"
                                                        ? `Uploading Pages ${uploadStateForRelease.current}/${uploadStateForRelease.total}`
                                                        : "Upload Manga Pages"}
                                                    <input
                                                        type="file"
                                                        accept="image/jpeg,image/png,image/webp,image/avif,image/*"
                                                        multiple
                                                        style={{ display: "none" }}
                                                        onChange={(event) => {
                                                            void handleMangaPageBatchUpload(release, event.target.files);
                                                            event.currentTarget.value = "";
                                                        }}
                                                    />
                                                </label>
                                            )}
                                        </div>

                                        {(assets.length > 0 || work.kind !== "novel") && (
                                            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                                                {work.kind === "manga" && (
                                                    <div style={assetSectionStyle}>
                                                        <p style={assetSectionTitleStyle}>Manga Pages</p>
                                                        <p style={assetSectionBodyStyle}>
                                                            {mangaPages.length > 0
                                                                ? `${mangaPages.length} page assets linked to this chapter.`
                                                                : "No pages uploaded yet."}
                                                        </p>
                                                        {mangaPages.length > 0 && (
                                                            <div style={chipWrapStyle}>
                                                                {mangaPages.slice(0, 8).map((asset) => (
                                                                    <div key={asset.id} style={assetChipStyle}>
                                                                        <span>{asset.file.original_filename}</span>
                                                                        <span>{formatBytes(asset.file.size_bytes)}</span>
                                                                    </div>
                                                                ))}
                                                                {mangaPages.length > 8 && (
                                                                    <div style={assetChipStyle}>+{mangaPages.length - 8} more pages</div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                {work.kind === "anime" && (
                                                    <>
                                                        <div style={assetSectionStyle}>
                                                            <p style={assetSectionTitleStyle}>Subtitles</p>
                                                            <p style={assetSectionBodyStyle}>
                                                                {subtitles.length > 0 ? `${subtitles.length} subtitle files attached.` : "No subtitles uploaded yet."}
                                                            </p>
                                                            {subtitles.length > 0 && (
                                                                <div style={chipWrapStyle}>
                                                                    {subtitles.map((asset) => (
                                                                        <div key={asset.id} style={assetChipStyle}>
                                                                            <span>{asset.file.original_filename}</span>
                                                                            <span>{asset.file.mime_type}</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div style={assetSectionStyle}>
                                                            <p style={assetSectionTitleStyle}>Playback Manifests</p>
                                                            <p style={assetSectionBodyStyle}>
                                                                {manifests.length > 0 ? `${manifests.length} manifests attached.` : "No manifests uploaded yet."}
                                                            </p>
                                                            {manifests.length > 0 && (
                                                                <div style={chipWrapStyle}>
                                                                    {manifests.map((asset) => (
                                                                        <div key={asset.id} style={assetChipStyle}>
                                                                            <span>{asset.file.original_filename}</span>
                                                                            <span>{asset.file.mime_type}</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </>
                                                )}

                                                {otherAssets.length > 0 && (
                                                    <div style={assetSectionStyle}>
                                                        <p style={assetSectionTitleStyle}>Other Linked Assets</p>
                                                        <div style={chipWrapStyle}>
                                                            {otherAssets.map((asset) => (
                                                                <div key={asset.id} style={assetChipStyle}>
                                                                    <span>{formatRole(asset.role)}</span>
                                                                    <span>{asset.file.original_filename}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div style={{ ...panelStyle, display: "block" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                            <div>
                                <h3 style={{ margin: 0, color: "var(--text-primary)", fontWeight: 800 }}>Minting Setup</h3>
                                <p style={{ margin: "6px 0 0", color: "var(--text-muted)", fontSize: 12 }}>
                                    Creator-opt-in mint setup stays separate from publishing state and is verified on-chain before Sakura stores it.
                                </p>
                            </div>
                            <span style={pillStyle}>{work.minting_enabled ? "enabled" : "disabled"}</span>
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginBottom: 10 }}>
                            <select value={mintType} onChange={(event) => setMintType(event.target.value as MintType)} style={inputStyle}>
                                {MINT_TYPES.map((type) => (
                                    <option key={type} value={type}>{type.replaceAll("_", " ")}</option>
                                ))}
                            </select>
                            <input
                                type="number"
                                min="0"
                                step="0.0001"
                                value={mintPrice}
                                onChange={(event) => setMintPrice(event.target.value)}
                                placeholder="Mint price"
                                style={inputStyle}
                            />
                            <input
                                type="number"
                                min="1"
                                step="1"
                                value={maxSupply}
                                onChange={(event) => setMaxSupply(event.target.value)}
                                placeholder="Max supply (optional)"
                                style={inputStyle}
                            />
                            <input
                                type="text"
                                value={txSignature}
                                onChange={(event) => setTxSignature(event.target.value)}
                                placeholder="Verified setup transaction signature"
                                style={inputStyle}
                            />
                        </div>

                        <input
                            type="text"
                            value={metadataUri}
                            onChange={(event) => setMetadataUri(event.target.value)}
                            placeholder="https://.../metadata.json"
                            style={{ ...inputStyle, marginBottom: 10 }}
                        />

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginBottom: 10 }}>
                            <input
                                type="text"
                                value={collectionAddress}
                                onChange={(event) => setCollectionAddress(event.target.value)}
                                placeholder="Collection address"
                                style={inputStyle}
                            />
                            <input
                                type="text"
                                value={treeAddress}
                                onChange={(event) => setTreeAddress(event.target.value)}
                                placeholder="Tree address"
                                style={inputStyle}
                            />
                            <input
                                type="text"
                                value={mintAddress}
                                onChange={(event) => setMintAddress(event.target.value)}
                                placeholder="Mint address"
                                style={inputStyle}
                            />
                        </div>

                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            <button
                                type="button"
                                onClick={handleCreateOnChainMintSetup}
                                disabled={mintState === "saving" || !signTransaction}
                                style={primaryButtonStyle(mintState === "saving" || !signTransaction)}
                            >
                                {mintState === "saving" ? "Creating On-Chain Setup..." : "Create On-Chain Mint Setup"}
                            </button>
                            <button
                                type="button"
                                onClick={handleVerifyMint}
                                disabled={mintState === "saving"}
                                style={secondaryButtonStyle}
                            >
                                Verify Existing Setup
                            </button>
                        </div>
                        <p style={{ ...helperTextStyle, marginTop: 10 }}>
                            The primary action creates a real compressed NFT merkle tree on Solana with your wallet, then verifies and stores the setup in Sakura.
                        </p>

                        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                            {mintRecords.length === 0 ? (
                                <p style={helperTextStyle}>No mint intents submitted yet.</p>
                            ) : (
                                mintRecords.map((record) => (
                                    <div key={record.id} style={assetSectionStyle}>
                                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                                            <span style={pillStyle}>{record.mint_type.replaceAll("_", " ")}</span>
                                            <span style={pillStyle}>{record.status.replaceAll("_", " ")}</span>
                                            <span style={pillStyle}>{record.mint_price} {record.currency}</span>
                                        </div>
                                        <p style={assetSectionBodyStyle}>
                                            {record.metadata_uri}
                                        </p>
                                        <p style={{ ...assetSectionBodyStyle, marginTop: 6 }}>
                                            {record.setup_tx_signature || "No setup signature saved yet."}
                                        </p>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </section>
            </main>
        </>
    );
}

const panelStyle: CSSProperties = {
    display: "flex",
    gap: 14,
    padding: 16,
    borderRadius: 18,
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.06)",
};

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

const helperTextStyle: CSSProperties = {
    margin: 0,
    fontSize: 12,
    color: "var(--text-muted)",
    lineHeight: 1.5,
};

const noteStyle: CSSProperties = {
    padding: 12,
    borderRadius: 12,
    background: "rgba(251,191,36,0.1)",
    border: "1px solid rgba(251,191,36,0.25)",
    color: "#fde68a",
    fontSize: 13,
    marginBottom: 16,
};

const linkButtonStyle: CSSProperties = {
    display: "inline-block",
    padding: "10px 12px",
    borderRadius: 12,
    textDecoration: "none",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "var(--text-primary)",
    fontSize: 12,
    fontWeight: 600,
};

const errorStyle: CSSProperties = {
    padding: 12,
    borderRadius: 12,
    background: "rgba(248,113,113,0.12)",
    border: "1px solid rgba(248,113,113,0.25)",
    color: "#fca5a5",
    fontSize: 13,
    marginBottom: 16,
};

const successStyle: CSSProperties = {
    padding: 12,
    borderRadius: 12,
    background: "rgba(74,222,128,0.12)",
    border: "1px solid rgba(74,222,128,0.25)",
    color: "#86efac",
    fontSize: 13,
    marginBottom: 16,
};

const emptyStateStyle: CSSProperties = {
    padding: 20,
    borderRadius: 16,
    textAlign: "center",
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.06)",
    color: "var(--text-muted)",
};

const assetSectionStyle: CSSProperties = {
    padding: 12,
    borderRadius: 12,
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.06)",
};

const assetSectionTitleStyle: CSSProperties = {
    margin: "0 0 6px",
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 700,
};

const assetSectionBodyStyle: CSSProperties = {
    margin: 0,
    color: "var(--text-muted)",
    fontSize: 12,
    lineHeight: 1.5,
    overflowWrap: "anywhere",
};

const chipWrapStyle: CSSProperties = {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 10,
};

const assetChipStyle: CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "var(--text-secondary)",
    fontSize: 11,
};

function primaryButtonStyle(disabled: boolean): CSSProperties {
    return {
        padding: "13px 14px",
        borderRadius: 14,
        border: "none",
        background: !disabled
            ? "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))"
            : "rgba(255,255,255,0.08)",
        color: !disabled ? "#fff" : "var(--text-muted)",
        fontWeight: 700,
        fontSize: 14,
        cursor: !disabled ? "pointer" : "default",
    };
}
