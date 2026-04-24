"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getPendingCreators, verifyCreator, type CreatorProfile } from "@/lib/creator";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import Link from "next/link";
import { getAuthorDetails } from "@/lib/content-source";
import { getTreasuryBalance } from "@/lib/treasury";
import { SAKURA_TREASURY_ADMIN } from "@/lib/solana";
import { getExternalAuthorUrl, sourceSupportsCreatorLookup } from "@/lib/sources/source-meta";
import { MANGA_SOURCE_IDS } from "@/lib/sources/source-ids";

export default function AdminPage() {
    const { publicKey, connected } = useWallet();
    const { setVisible } = useSakuraWalletModal();
    const [pendingCreators, setPendingCreators] = useState<(CreatorProfile & { authorName?: string })[]>([]);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [treasuryBalance, setTreasuryBalance] = useState<number | null>(null);

    // Retrieve the admin wallet from environment variable, fallback to empty string if not set
    const adminWalletStr = process.env.NEXT_PUBLIC_ADMIN_WALLET || "";

    useEffect(() => {
        if (!connected) {
            setVisible(true);
            setLoading(false);
            return;
        }

        // Only load if connected and is the admin
        if (publicKey && publicKey.toBase58() === adminWalletStr) {
            loadPending();
        } else {
            setLoading(false);
        }
    }, [connected, publicKey, adminWalletStr, setVisible]);

    const loadPending = async () => {
        setLoading(true);
        try {
            const creators = await getPendingCreators();

            // Fetch extra author info if they linked a content author ID
            const enriched = await Promise.all(creators.map(async (creator) => {
                if (creator.mangadex_author_id) {
                    const authorInfo = await getAuthorDetails(creator.mangadex_author_id);
                    return { ...creator, authorName: authorInfo?.name };
                }
                return creator;
            }));

            setPendingCreators(enriched);
        } catch (err) {
            console.error("Failed to load pending creators:", err);
        } finally {
            setLoading(false);
        }
    };

    const fetchTreasuryBalance = useCallback(async () => {
        try {
            const bal = await getTreasuryBalance();
            setTreasuryBalance(bal);
        } catch {
            setTreasuryBalance(null);
        }
    }, []);

    useEffect(() => {
        if (publicKey && adminWalletStr && publicKey.toBase58() === adminWalletStr) {
            fetchTreasuryBalance();
        }
    }, [publicKey, adminWalletStr, fetchTreasuryBalance]);

    const handleVerify = async (walletAddress: string) => {
        if (!confirm("Are you sure you want to verify this creator?")) return;

        setActionLoading(walletAddress);
        try {
            const success = await verifyCreator(walletAddress);
            if (success) {
                // Remove from pending list
                setPendingCreators(prev => prev.filter(c => c.wallet_address !== walletAddress));
                alert("Creator successfully verified!");
            } else {
                alert("Failed to verify creator.");
            }
        } catch (error) {
            console.error(error);
            alert("An error occurred.");
        } finally {
            setActionLoading(null);
        }
    };

    if (!connected) {
        return (
            <div className="page-container" style={{ paddingBottom: '100px', textAlign: 'center', paddingTop: '100px' }}>
                <h2 style={{ marginBottom: '16px' }}>Admin Dashboard</h2>
                <p style={{ color: 'var(--text-secondary)' }}>Please connect your admin wallet to continue.</p>
                <button className="btn-primary" onClick={() => setVisible(true)} style={{ marginTop: '20px' }}>
                    Connect Wallet
                </button>
            </div>
        );
    }

    // Check if the connected wallet is the designated admin wallet
    if (publicKey && adminWalletStr && publicKey.toBase58() !== adminWalletStr) {
        return (
            <div className="page-container" style={{ paddingBottom: '100px', textAlign: 'center', paddingTop: '100px' }}>
                <h2 style={{ marginBottom: '16px', color: '#ff4d4f' }}>Access Denied</h2>
                <p style={{ color: 'var(--text-secondary)' }}>
                    Your wallet ({publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}) does not have admin privileges.
                </p>
                <Link href="/" className="btn-secondary" style={{ marginTop: '20px', display: 'inline-block' }}>
                    Return Home
                </Link>
            </div>
        );
    }

    if (publicKey && !adminWalletStr) {
        return (
            <div className="page-container" style={{ paddingBottom: '100px', textAlign: 'center', paddingTop: '100px' }}>
                <h2 style={{ marginBottom: '16px', color: '#ffb7c5' }}>Admin Not Configured</h2>
                <p style={{ color: 'var(--text-secondary)' }}>
                    Please set <code>NEXT_PUBLIC_ADMIN_WALLET</code> in your <code>.env.local</code> file to your wallet address.
                </p>
                <p style={{ color: 'var(--text-muted)', marginTop: '8px', fontSize: '0.9rem' }}>
                    Your current wallet: {publicKey.toBase58()}
                </p>
            </div>
        );
    }

    return (
        <div className="page-container" style={{ paddingBottom: '100px' }}>
            <div className="title-header" style={{ marginBottom: '30px' }}>
                <Link href="/" className="back-btn">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </Link>
                <div className="title-header-text">Admin Dashboard</div>
                <div style={{ width: 40 }} />
            </div>

            <div className="section-header" style={{ marginBottom: '8px' }}>
                <h2>Treasury</h2>
                <span style={{ color: 'var(--sakura-pink)', fontSize: '0.9rem' }}>
                    {treasuryBalance !== null ? `${treasuryBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} $SAKURA` : "..."}
                </span>
            </div>
            <div style={{
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '16px',
                padding: '20px',
                marginBottom: '24px',
            }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
                    Tips, donations, and trading fees go directly to the admin wallet.
                    To withdraw, use any Solana wallet (Phantom, etc.) connected with:
                </p>
                <code style={{ display: 'block', marginTop: 8, fontSize: '0.8rem', color: 'var(--sakura-pink)', background: 'rgba(255,183,197,0.08)', padding: '8px 12px', borderRadius: '8px', wordBreak: 'break-all' }}>
                    {SAKURA_TREASURY_ADMIN.toBase58()}
                </code>
            </div>

            <div className="section-header">
                <h2>Pending Verifications</h2>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{pendingCreators.length} Total</span>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
                    <div className="spinner" />
                </div>
            ) : pendingCreators.length === 0 ? (
                <div className="empty-state">
                    <p className="empty-text">No pending creators to verify.</p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {pendingCreators.map(creator => (
                        <div key={creator.wallet_address} style={{
                            background: 'rgba(0,0,0,0.2)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '16px',
                            padding: '20px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '12px'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div>
                                    <h3 style={{ fontSize: '1.2rem', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        {creator.display_name}
                                    </h3>
                                    <code style={{ fontSize: '0.8rem', color: 'var(--sakura-pink)', background: 'rgba(255,183,197,0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                                        {creator.wallet_address}
                                    </code>
                                </div>
                                <button
                                    onClick={() => handleVerify(creator.wallet_address)}
                                    disabled={actionLoading === creator.wallet_address}
                                    className="btn-primary"
                                    style={{ padding: '8px 16px', fontSize: '0.9rem', borderRadius: '8px', opacity: actionLoading ? 0.6 : 1 }}
                                >
                                    {actionLoading === creator.wallet_address ? 'Verifying...' : 'Verify Creator'}
                                </button>
                            </div>

                            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5' }}>
                                {creator.bio || "No bio provided."}
                            </p>

                            {creator.mangadex_author_id && (
                                <div style={{
                                    background: 'rgba(255,183,197,0.05)',
                                    border: '1px solid rgba(255,183,197,0.2)',
                                    borderRadius: '8px',
                                    padding: '10px',
                                    fontSize: '0.9rem'
                                }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Shueisha Link: </span>
                                    <Link href={getExternalAuthorUrl(MANGA_SOURCE_IDS.MANGADEX, creator.mangadex_author_id) || "#"} target="_blank" style={{ color: 'var(--sakura-pink)' }}>
                                        {creator.authorName || creator.mangadex_author_id}
                                    </Link>
                                    <span style={{ color: 'var(--text-muted)', marginLeft: '8px', fontSize: '0.8rem' }}>
                                        (Review their ID matches their social handles before verifying)
                                    </span>
                                </div>
                            )}

                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                Applied on: {new Date(creator.created_at).toLocaleDateString()}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
