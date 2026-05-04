"use client";

import { useEffect, useState, Suspense, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { getAuthorDetails, getMangaByAuthor, type Manga } from "@/lib/content-source";
import { getCreatorProfile, getCreatorTips, type CreatorProfile, type TipRecord } from "@/lib/creator";
import { getCreatorWorksByCreator } from "@/lib/creator-works";
import { getWalletSakuraBalance } from "@/lib/treasury";
import { truncateAddress } from "@/lib/solana";
import MangaCard from "@/components/MangaCard";
import Link from "next/link";
import TipButton from "./TipButton";
import { getDefaultMangaSourceId } from "@/lib/sources/source-ids";

function CreatorPageContent() {
    const searchParams = useSearchParams();
    const id = searchParams?.get("id");
    const { publicKey } = useWallet();
    const walletAddress = publicKey?.toBase58() ?? null;
    const [hasCreatorState, setHasCreatorState] = useState(false);

    useEffect(() => {
        if (!walletAddress) {
            setHasCreatorState(false);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const [profile, works] = await Promise.all([
                    getCreatorProfile(walletAddress),
                    getCreatorWorksByCreator(walletAddress),
                ]);
                if (!cancelled) {
                    setHasCreatorState(Boolean(profile) || (works?.length ?? 0) > 0);
                }
            } catch {
                if (!cancelled) setHasCreatorState(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [walletAddress]);

    const [author, setAuthor] = useState<any>(null);
    const [creator, setCreator] = useState<CreatorProfile | null>(null);
    const [mangaList, setMangaList] = useState<Manga[]>([]);
    const [tips, setTips] = useState<TipRecord[]>([]);
    const [walletBalance, setWalletBalance] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadTips = useCallback(async (walletAddress: string) => {
        const [tipsData, balance] = await Promise.all([
            getCreatorTips(walletAddress),
            getWalletSakuraBalance(walletAddress),
        ]);
        setTips(tipsData);
        setWalletBalance(balance);
    }, []);

    useEffect(() => {
        if (!id) {
            setLoading(false);
            setError("No creator ID provided.");
            return;
        }

        async function loadProfile() {
            setLoading(true);
            try {
                const [authorData, creatorData, worksData] = await Promise.all([
                    getAuthorDetails(id!),
                    getCreatorProfile(id!),
                    getMangaByAuthor(id!)
                ]);

                if (!authorData && !creatorData) {
                    setError("Creator not found.");
                } else {
                    setAuthor(authorData);
                    setCreator(creatorData);
                    setMangaList(worksData || []);

                    if (creatorData?.wallet_address) {
                        loadTips(creatorData.wallet_address);
                    }
                }
            } catch (err: any) {
                console.error("Profile load error:", err);
                setError("Failed to load creator profile.");
            } finally {
                setLoading(false);
            }
        }

        loadProfile();
    }, [id, loadTips]);

    if (loading) {
        return (
            <div className="page-container" style={{ paddingBottom: 100, display: "flex", justifyContent: "center", paddingTop: 100 }}>
                <div className="spinner" />
            </div>
        );
    }

    if (error || (!author && !creator)) {
        const showWorkspaceCta = walletAddress && hasCreatorState;
        const isLanding = !id;
        return (
            <div className="page-container" style={{ paddingBottom: 100, textAlign: "center", paddingTop: 100 }}>
                <h2 style={{ marginBottom: 16 }}>
                    {isLanding ? "Creator" : (error || "Creator Not Found")}
                </h2>
                {isLanding && (
                    <p style={{ color: "var(--text-secondary)", maxWidth: 480, margin: "0 auto 20px", lineHeight: 1.5 }}>
                        Publish novels, manga, or anime from the Sakura creator workspace.
                    </p>
                )}
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                    {showWorkspaceCta && (
                        <Link href="/creator/works" className="btn-primary">
                            Open My Workspace
                        </Link>
                    )}
                    {walletAddress && !hasCreatorState && (
                        <Link href="/creator/works/new" className="btn-primary">
                            Start a Work
                        </Link>
                    )}
                    <Link href="/" className={showWorkspaceCta || walletAddress ? "btn-secondary" : "btn-primary"}>
                        Return Home
                    </Link>
                </div>
            </div>
        );
    }

    const displayName = creator?.display_name || author?.name || "Unknown Creator";
    const bio = creator?.bio || author?.biography || null;
    const isVerified = creator?.is_verified === true;
    const avatarUrl = creator?.avatar_url || `https://robohash.org/${id}?set=set4&bgset=bg1`;
    const isOwnerProfile = Boolean(creator?.wallet_address && publicKey?.toBase58() === creator.wallet_address);

    const totalTipAmount = tips.reduce((sum, t) => sum + (t.amount_sol ?? 0), 0);
    const uniqueSupporters = new Set(tips.map((t) => t.sender_address)).size;
    const memberSince = creator?.created_at
        ? new Date(creator.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" })
        : null;

    return (
        <div className="page-container" style={{ paddingBottom: 100 }}>
            <div className="title-header" style={{ marginBottom: 20 }}>
                <Link href="/" className="back-btn">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </Link>
                <div className="title-header-text">Creator Profile</div>
                <div style={{ width: 40 }} />
            </div>

            {/* Hero Card */}
            <div style={{
                position: "relative",
                borderRadius: 24,
                overflow: "hidden",
                marginBottom: 24,
                background: "linear-gradient(160deg, rgba(255,183,197,0.18) 0%, rgba(138,43,226,0.14) 50%, rgba(20,20,30,0.9) 100%)",
                border: "1px solid rgba(255,255,255,0.08)",
            }}>
                {/* Decorative top gradient bar */}
                <div style={{
                    height: 4,
                    background: "linear-gradient(90deg, var(--sakura-pink), var(--purple-accent), var(--sakura-pink))",
                }} />

                <div style={{ padding: "32px 24px 28px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 16 }}>
                    {/* Avatar */}
                    <div style={{ position: "relative" }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={avatarUrl}
                            alt={displayName}
                            style={{
                                width: 110,
                                height: 110,
                                borderRadius: "50%",
                                objectFit: "cover",
                                border: "3px solid var(--sakura-pink)",
                                boxShadow: "0 8px 32px rgba(255,183,197,0.25)",
                            }}
                        />
                        {isVerified && (
                            <div style={{
                                position: "absolute",
                                bottom: 2,
                                right: 2,
                                background: "var(--sakura-pink)",
                                borderRadius: "50%",
                                width: 30,
                                height: 30,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
                                border: "2px solid var(--bg-dark)",
                            }} title="Verified Creator">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                            </div>
                        )}
                    </div>

                    {/* Name + Badge */}
                    <div>
                        <h1 style={{ fontSize: "1.7rem", margin: 0, lineHeight: 1.3 }}>{displayName}</h1>
                        {isVerified && (
                            <span style={{
                                display: "inline-block",
                                marginTop: 6,
                                padding: "3px 10px",
                                borderRadius: 20,
                                fontSize: "0.75rem",
                                fontWeight: 600,
                                background: "rgba(255,183,197,0.15)",
                                color: "var(--sakura-pink)",
                                border: "1px solid rgba(255,183,197,0.2)",
                            }}>
                                Verified Creator
                            </span>
                        )}
                    </div>

                    {/* Socials */}
                    <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                        {author?.twitter && (
                            <a href={`https://twitter.com/${author.twitter}`} target="_blank" rel="noopener noreferrer"
                                style={{ color: "var(--text-muted)", transition: "color 0.2s" }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--sakura-pink)")}
                                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z" /></svg>
                            </a>
                        )}
                        {author?.pixiv && (
                            <a href={`https://www.pixiv.net/en/users/${author.pixiv}`} target="_blank" rel="noopener noreferrer"
                                style={{ color: "var(--text-muted)", transition: "color 0.2s" }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--sakura-pink)")}
                                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                            </a>
                        )}
                        {creator?.wallet_address && (
                            <a href={`https://solscan.io/account/${creator.wallet_address}`} target="_blank" rel="noopener noreferrer"
                                style={{ color: "var(--text-muted)", transition: "color 0.2s", fontSize: "0.8rem", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 4 }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--sakura-pink)")}
                                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M22 10H2" /></svg>
                                {truncateAddress(creator.wallet_address)}
                            </a>
                        )}
                    </div>

                    {/* Bio */}
                    {bio && (
                        <p style={{
                            color: "var(--text-secondary)",
                            maxWidth: 520,
                            margin: 0,
                            lineHeight: 1.6,
                            fontSize: "0.92rem",
                        }}>
                            {bio}
                        </p>
                    )}

                    {/* Tip Button */}
                    {isVerified && creator?.wallet_address && (
                        <div style={{ marginTop: 4 }}>
                            <TipButton receiverAddress={creator.wallet_address} />
                        </div>
                    )}

                    {(isOwnerProfile || (walletAddress && hasCreatorState)) && (
                        <Link
                            href="/creator/works"
                            className="btn-primary"
                            style={{ marginTop: 4, fontSize: "0.9rem" }}
                        >
                            Open My Workspace
                        </Link>
                    )}

                    {/* Claim Button */}
                    {!isVerified && !creator && id && (
                        <Link
                            href={`/creator/apply?authorId=${id}`}
                            className="btn-secondary"
                            style={{ marginTop: 4, fontSize: "0.9rem" }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" x2="19" y1="8" y2="14" /><line x1="22" x2="16" y1="11" y2="11" /></svg>
                            Claim this profile
                        </Link>
                    )}

                    {/* Pending badge */}
                    {creator && !isVerified && (
                        <span style={{
                            display: "inline-block",
                            padding: "4px 12px",
                            borderRadius: 20,
                            fontSize: "0.78rem",
                            background: "rgba(255,193,7,0.12)",
                            color: "#ffc107",
                            border: "1px solid rgba(255,193,7,0.2)",
                        }}>
                            Pending Verification
                        </span>
                    )}
                </div>
            </div>

            {/* Stats Row */}
            {isVerified && (
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 10,
                    marginBottom: 28,
                }}>
                    <StatBox
                        label="Works"
                        value={mangaList.length.toString()}
                        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></svg>}
                    />
                    <StatBox
                        label="Tips"
                        value={tips.length.toString()}
                        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>}
                    />
                    <StatBox
                        label="Supporters"
                        value={uniqueSupporters.toString()}
                        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>}
                    />
                    <StatBox
                        label="Earned"
                        value={totalTipAmount >= 1_000_000
                            ? `${(totalTipAmount / 1_000_000).toFixed(1)}M`
                            : totalTipAmount >= 1_000
                                ? `${(totalTipAmount / 1_000).toFixed(0)}K`
                                : totalTipAmount.toLocaleString()}
                        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--sakura-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /><path d="M12 18V6" /></svg>}
                        suffix=" $SAKURA"
                    />
                </div>
            )}

            {/* Wallet Balance for verified */}
            {isVerified && walletBalance !== null && walletBalance > 0 && (
                <div style={{
                    background: "rgba(255,183,197,0.06)",
                    border: "1px solid rgba(255,183,197,0.12)",
                    borderRadius: 16,
                    padding: "14px 18px",
                    marginBottom: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                }}>
                    <span style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>Wallet Balance</span>
                    <span style={{ color: "var(--sakura-pink)", fontWeight: 700, fontSize: "1rem" }}>
                        {walletBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} $SAKURA
                    </span>
                </div>
            )}

            {/* Recent Tips */}
            {isVerified && tips.length > 0 && (
                <div style={{ marginBottom: 28 }}>
                    <div className="section-header" style={{ marginBottom: 12 }}>
                        <h2>Recent Tips</h2>
                        <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                            {tips.length} total
                        </span>
                    </div>
                    <div style={{
                        background: "rgba(0,0,0,0.2)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 16,
                        overflow: "hidden",
                    }}>
                        {tips.slice(0, 10).map((tip, i) => (
                            <div
                                key={tip.id}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    padding: "12px 16px",
                                    borderBottom: i < Math.min(tips.length, 10) - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <div style={{
                                        width: 32,
                                        height: 32,
                                        borderRadius: "50%",
                                        background: "linear-gradient(135deg, rgba(255,183,197,0.2), rgba(138,43,226,0.2))",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        fontSize: "0.7rem",
                                        fontFamily: "monospace",
                                        color: "var(--sakura-pink)",
                                        fontWeight: 600,
                                    }}>
                                        {tip.sender_address.slice(0, 2)}
                                    </div>
                                    <div>
                                        <div style={{ fontSize: "0.88rem", color: "var(--text-primary)" }}>
                                            {truncateAddress(tip.sender_address)}
                                        </div>
                                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                            {new Date(tip.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                        </div>
                                    </div>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontWeight: 700, color: "var(--sakura-pink)", fontSize: "0.92rem" }}>
                                        {(tip.amount_sol ?? 0).toLocaleString()}
                                    </span>
                                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>$SAKURA</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Published Works */}
            <div className="section-header" style={{ marginBottom: 12 }}>
                <h2>Published Works</h2>
                <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>{mangaList.length} Series</span>
            </div>

            {mangaList.length > 0 ? (
                <div className="manga-grid">
                    {mangaList.map((manga) => (
                        <MangaCard
                            key={manga.id}
                            slug={manga.id}
                            title={manga.title}
                            cover={manga.cover}
                            genres={manga.tags}
                            follows={manga.follows}
                            rating={manga.rating}
                            source={getDefaultMangaSourceId()}
                        />
                    ))}
                </div>
            ) : (
                <div className="empty-state">
                    <p className="empty-text">No works found for this creator.</p>
                </div>
            )}

            {/* Meta info */}
            {memberSince && (
                <div style={{ textAlign: "center", marginTop: 40, color: "var(--text-muted)", fontSize: "0.8rem" }}>
                    Member since {memberSince}
                </div>
            )}
        </div>
    );
}

function StatBox({ label, value, icon, suffix }: { label: string; value: string; icon: React.ReactNode; suffix?: string }) {
    return (
        <div style={{
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 14,
            padding: "14px 10px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
        }}>
            {icon}
            <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "#fff", lineHeight: 1 }}>
                {value}
                {suffix && <span style={{ fontSize: "0.6rem", color: "var(--text-muted)", fontWeight: 400 }}>{suffix}</span>}
            </div>
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {label}
            </div>
        </div>
    );
}

export default function CreatorPage() {
    return (
        <Suspense fallback={<div className="page-container" style={{ paddingBottom: 100, display: "flex", justifyContent: "center", paddingTop: 100 }}><div className="spinner" /></div>}>
            <CreatorPageContent />
        </Suspense>
    );
}
