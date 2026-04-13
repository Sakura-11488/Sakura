"use client";

import { useState, useEffect, Suspense } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { submitCreatorApplication } from "@/lib/creator";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

function CreatorApplyPageContent() {
    const { publicKey, connected } = useWallet();
    const { setVisible } = useSakuraWalletModal();
    const router = useRouter();
    const searchParams = useSearchParams();

    // Check if they clicked "Claim" from an existing creator profile
    const initialAuthorId = searchParams?.get("authorId") || "";

    const [displayName, setDisplayName] = useState("");
    const [bio, setBio] = useState("");
    const [contentAuthorId, setContentAuthorId] = useState(initialAuthorId);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Prompt wallet connect if not connected
    useEffect(() => {
        if (!connected) {
            setVisible(true);
        }
    }, [connected, setVisible]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!connected || !publicKey) {
            setError("You must connect a wallet to apply.");
            setVisible(true);
            return;
        }

        if (!displayName.trim()) {
            setError("Display name is required.");
            return;
        }

        try {
            setError(null);
            setIsSubmitting(true);

            const result = await submitCreatorApplication(
                publicKey.toBase58(),
                displayName.trim(),
                bio.trim(),
                contentAuthorId.trim() || null
            );

            if (result) {
                setSuccess(true);
                // Optionally redirect to their new profile after a few seconds
                setTimeout(() => {
                    router.push(`/creator?id=${publicKey.toBase58()}`);
                }, 3000);
            } else {
                setError("Failed to submit application. Please try again.");
            }
        } catch (err: any) {
            console.error("Application error:", err);
            setError(err?.message || "An unexpected error occurred.");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="page-container" style={{ paddingBottom: '100px', maxWidth: '600px', margin: '0 auto' }}>
            <div className="title-header" style={{ marginBottom: '30px' }}>
                <Link href="/" className="back-btn">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </Link>
                <div className="title-header-text">Creator Profile Setup</div>
                <div style={{ width: 40 }} />
            </div>

            <div style={{
                background: 'linear-gradient(135deg, rgba(255, 183, 197, 0.1) 0%, rgba(138, 43, 226, 0.1) 100%)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '24px',
                padding: '30px'
            }}>
                <div style={{ textAlign: 'center', marginBottom: '30px' }}>
                    <div style={{ fontSize: '48px', marginBottom: '16px' }}>🌸</div>
                    <h1 style={{ fontSize: '1.8rem', marginBottom: '8px' }}>Become a Creator</h1>
                    <p style={{ color: 'var(--text-secondary)' }}>
                        Set up a creator profile for publishing, public creator pages, and direct $SAKURA support from readers.
                    </p>
                </div>

                {success ? (
                    <div style={{ textAlign: 'center', padding: '20px', background: 'rgba(0,0,0,0.2)', borderRadius: '16px', border: '1px solid var(--sakura-pink)' }}>
                        <h2 style={{ color: 'var(--sakura-pink)', marginBottom: '8px' }}>Application Submitted!</h2>
                        <p style={{ color: 'var(--text-secondary)' }}>
                            Your profile has been created and is pending primary verification. You will be redirected to your profile layout shortly.
                        </p>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                        <div>
                            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                Wallet Address
                            </label>
                            <input
                                type="text"
                                value={connected && publicKey ? publicKey.toBase58() : "Not Connected"}
                                disabled
                                style={{
                                    width: '100%', padding: '12px', borderRadius: '12px',
                                    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)',
                                    color: connected ? 'var(--sakura-pink)' : '#666', fontFamily: 'monospace'
                                }}
                            />
                        </div>

                        <div>
                            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                Existing Author ID (Optional)
                            </label>
                            <input
                                type="text"
                                value={contentAuthorId}
                                onChange={e => setContentAuthorId(e.target.value)}
                                placeholder="e.g. 5e1823ab-..."
                                style={{
                                    width: '100%', padding: '12px', borderRadius: '12px',
                                    background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff'
                                }}
                            />
                            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '6px' }}>
                                If you already publish elsewhere, you can add your existing author ID now and link it later to this creator profile.
                            </p>
                        </div>

                        <div>
                            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                Display Name *
                            </label>
                            <input
                                type="text"
                                value={displayName}
                                onChange={e => setDisplayName(e.target.value)}
                                placeholder="Your pen name or studio name"
                                required
                                style={{
                                    width: '100%', padding: '12px', borderRadius: '12px',
                                    background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff'
                                }}
                            />
                        </div>

                        <div>
                            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                Creator Bio
                            </label>
                            <textarea
                                value={bio}
                                onChange={e => setBio(e.target.value)}
                                placeholder="Tell readers about yourself and your works..."
                                rows={4}
                                style={{
                                    width: '100%', padding: '12px', borderRadius: '12px',
                                    background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)',
                                    color: '#fff', resize: 'vertical'
                                }}
                            />
                        </div>

                        {error && (
                            <div style={{ color: '#ff4d4f', padding: '10px', background: 'rgba(255,77,79,0.1)', borderRadius: '8px', fontSize: '0.9rem' }}>
                                {error}
                            </div>
                        )}

                        <button
                            type="submit"
                            className="btn-primary"
                            disabled={!connected || isSubmitting}
                            style={{
                                padding: '14px',
                                borderRadius: '14px',
                                marginTop: '10px',
                                opacity: !connected || isSubmitting ? 0.7 : 1,
                                fontWeight: 'bold'
                            }}
                        >
                            {isSubmitting ? "Creating Creator Profile..." : "Create Creator Profile"}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}

export default function CreatorApplyPage() {
    return (
        <Suspense fallback={<div className="page-container" style={{ paddingBottom: '100px', display: 'flex', justifyContent: 'center', paddingTop: '100px' }}><div className="spinner" /></div>}>
            <CreatorApplyPageContent />
        </Suspense>
    );
}
