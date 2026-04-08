"use client";

import Header from "@/components/Header";
import { useState, useEffect } from "react";
import { getLocal, setLocal, STORAGE_KEYS } from "@/lib/storage";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import { truncateAddress } from "@/lib/solana";
import { getProfile, upsertProfile } from "@/lib/comments";
import { checkPassStatus } from "@/lib/pass-check";
import { searchCreators, type CreatorProfile } from "@/lib/creator";
import Link from "next/link";
import LottieIcon from "@/components/LottieIcon";
import { schedulePushSettings } from "@/lib/cloud-sync";

type ReadingMode = 'scroll' | 'page';

export default function SettingsPage() {
    const { publicKey, disconnect } = useWallet();
    const { setVisible } = useSakuraWalletModal();

    const [dataSaver, setDataSaver] = useState(false);
    const [pnlTracker, setPnlTracker] = useState(false);
    const [cacheSize, setCacheSize] = useState("Checking...");
    const [readingMode, setReadingMode] = useState<ReadingMode>('page');
    const [newReleaseAlerts, setNewReleaseAlerts] = useState(false);
    const [subscriptionAlerts, setSubscriptionAlerts] = useState(false);
    const [userEmail, setUserEmail] = useState("");
    const [emailSaved, setEmailSaved] = useState(false);

    // Profile name state
    const [displayName, setDisplayName] = useState("");
    const [bio, setBio] = useState("");
    const [hasPass, setHasPass] = useState(false);
    const [profileSaved, setProfileSaved] = useState(false);
    const [profileLoading, setProfileLoading] = useState(false);

    // Creator search state
    const [creatorQuery, setCreatorQuery] = useState("");
    const [creatorResults, setCreatorResults] = useState<CreatorProfile[]>([]);
    const [creatorSearching, setCreatorSearching] = useState(false);

    useEffect(() => {
        const settings = getLocal<any>(STORAGE_KEYS.SETTINGS, { dataSaver: false });
        setDataSaver(settings.dataSaver);
        setPnlTracker(!!settings.pnlTracker);

        const savedMode = getLocal<string>(STORAGE_KEYS.READING_MODE, 'page');
        setReadingMode(savedMode as ReadingMode);

        setNewReleaseAlerts(settings.newReleaseAlerts || false);
        setSubscriptionAlerts(settings.subscriptionAlerts || false);
        setUserEmail(settings.userEmail || "");

        calculateCacheSize();
    }, []);

    // Load profile + pass status
    useEffect(() => {
        if (!publicKey) return;
        const wallet = publicKey.toBase58();

        async function loadProfile() {
            setProfileLoading(true);
            const [profile, passStatus] = await Promise.all([
                getProfile(wallet),
                checkPassStatus(wallet),
            ]);
            setDisplayName(profile?.display_name || "");
            setBio(profile?.bio || "");
            setHasPass(passStatus.valid);
            setProfileLoading(false);
        }
        loadProfile();
    }, [publicKey]);

    const calculateCacheSize = () => {
        if (typeof window === "undefined") return;
        let total = 0;
        for (let x in localStorage) {
            if (localStorage.hasOwnProperty(x)) {
                total += (localStorage[x].length * 2) / 1024 / 1024;
            }
        }
        setCacheSize(total.toFixed(2) + " MB");
    };

    const handleCreatorSearch = async (query: string) => {
        setCreatorQuery(query);
        if (!query.trim()) {
            setCreatorResults([]);
            return;
        }
        setCreatorSearching(true);
        try {
            const results = await searchCreators(query);
            setCreatorResults(results);
        } catch {
            setCreatorResults([]);
        } finally {
            setCreatorSearching(false);
        }
    };

    const updateSetting = (key: string, val: any) => {
        const current = getLocal(STORAGE_KEYS.SETTINGS, {});
        setLocal(STORAGE_KEYS.SETTINGS, { ...current, [key]: val });
        const w = publicKey?.toBase58(); if (w) schedulePushSettings(w);
    };

    const toggleDataSaver = (val: boolean) => {
        setDataSaver(val);
        updateSetting('dataSaver', val);
    };

    const togglePnlTracker = (val: boolean) => {
        setPnlTracker(val);
        updateSetting('pnlTracker', val);
    };

    const handleReadingModeChange = (mode: ReadingMode) => {
        setReadingMode(mode);
        setLocal(STORAGE_KEYS.READING_MODE, mode);
    };

    const handleNewReleaseToggle = (val: boolean) => {
        setNewReleaseAlerts(val);
        updateSetting('newReleaseAlerts', val);
    };

    const handleSubscriptionToggle = (val: boolean) => {
        setSubscriptionAlerts(val);
        updateSetting('subscriptionAlerts', val);
    };

    const handleEmailSave = () => {
        updateSetting('userEmail', userEmail);
        setEmailSaved(true);
        setTimeout(() => setEmailSaved(false), 2000);
    };

    const clearCache = () => {
        if (confirm("Clear all local data? (Favorites sync from cloud)")) {
            localStorage.clear();
            calculateCacheSize();
            alert("Cache cleared.");
            window.location.reload();
        }
    };

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40, maxWidth: 800, margin: "0 auto" }}>
                    <div className="section-header">
                        <h2 className="section-title">Settings 設定</h2>
                        <p className="section-subtitle">Manage preferences, wallet, and notifications</p>
                    </div>

                    {/* Wallet Management */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">ウォレット Wallet</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">
                                    {publicKey ? "Connected" : "Not Connected"}
                                </span>
                                <span className="setting-desc">
                                    {publicKey
                                        ? truncateAddress(publicKey.toBase58())
                                        : "Sign up or login to access premium features."}
                                </span>
                            </div>
                            {publicKey ? (
                                <button
                                    className="btn-secondary"
                                    onClick={() => disconnect()}
                                    style={{ fontSize: 13, padding: "8px 16px" }}
                                >
                                    Disconnect
                                </button>
                            ) : (
                                <button
                                    className="btn-primary"
                                    onClick={() => setVisible(true)}
                                    style={{ fontSize: 13, padding: "8px 16px" }}
                                >
                                    Sign Up / Login
                                </button>
                            )}
                        </div>
                        {publicKey && (
                            <div className="setting-item">
                                <div className="setting-info">
                                    <span className="setting-name">Export Private Key</span>
                                    <span className="setting-desc">Reveal your secret key to import into Phantom or Solflare.</span>
                                </div>
                                <button
                                    className="btn-secondary"
                                    onClick={async () => {
                                        try {
                                            const { getWalletAccountWithBiometrics } = await import("@/lib/wallet");
                                            const account = await getWalletAccountWithBiometrics();
                                            if (account) {
                                                const bs58 = (await import("bs58")).default;
                                                const secretKeyBase58 = bs58.encode(account.secretKey);
                                                await navigator.clipboard.writeText(secretKeyBase58);
                                                alert("Private key copied to clipboard! NEVER share this with anyone.");
                                            }
                                        } catch (e: any) {
                                            if (e.message !== "Biometric authentication failed") {
                                                alert("Failed to export key: " + e.message);
                                            }
                                        }
                                    }}
                                    style={{ fontSize: 13, padding: "8px 16px", color: "var(--sakura-pink)", borderColor: "var(--sakura-pink)" }}
                                >
                                    Export Key
                                </button>
                            </div>
                        )}

                        {publicKey && process.env.NEXT_PUBLIC_ADMIN_WALLET && publicKey.toBase58() === process.env.NEXT_PUBLIC_ADMIN_WALLET && (
                            <div className="setting-item">
                                <div className="setting-info">
                                    <span className="setting-name">Admin Dashboard</span>
                                    <span className="setting-desc">Review and verify creator applications.</span>
                                </div>
                                <Link
                                    href="/admin"
                                    className="btn-primary"
                                    style={{ fontSize: 13, padding: "8px 16px", textDecoration: "none" }}
                                >
                                    Open Dashboard
                                </Link>
                            </div>
                        )}
                    </div>

                    {/* Quick Links */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">クイックリンク Quick Links</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Creator Dashboard</span>
                                <span className="setting-desc">Upload and manage your manga series.</span>
                            </div>
                            <Link
                                href="/creator"
                                className="btn-secondary"
                                style={{ fontSize: 13, padding: "8px 16px", textDecoration: "none" }}
                            >
                                Open Creator ✦
                            </Link>
                        </div>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Reading History</span>
                                <span className="setting-desc">View your recently read chapters.</span>
                            </div>
                            <Link
                                href="/history"
                                className="btn-secondary"
                                style={{ fontSize: 13, padding: "8px 16px", textDecoration: "none" }}
                            >
                                View History
                            </Link>
                        </div>
                    </div>

                    {/* Creator Search */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">クリエイター Creators</h3>
                        <div className="setting-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
                            <div className="setting-info">
                                <span className="setting-name">Search Creators</span>
                                <span className="setting-desc">Find verified creators by name.</span>
                            </div>
                            <div style={{ position: "relative" }}>
                                <input
                                    type="text"
                                    value={creatorQuery}
                                    onChange={(e) => handleCreatorSearch(e.target.value)}
                                    placeholder="Search by name..."
                                    style={{
                                        width: "100%",
                                        padding: "10px 14px",
                                        borderRadius: 10,
                                        border: "1px solid rgba(255,255,255,0.1)",
                                        background: "rgba(0,0,0,0.2)",
                                        color: "#fff",
                                        fontSize: "0.9rem",
                                    }}
                                />
                            </div>
                            {creatorSearching && (
                                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Searching...</p>
                            )}
                            {!creatorSearching && creatorQuery.trim() && creatorResults.length === 0 && (
                                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No creators found.</p>
                            )}
                            {creatorResults.length > 0 && (
                                <div style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 2,
                                    background: "rgba(0,0,0,0.15)",
                                    borderRadius: 12,
                                    overflow: "hidden",
                                    border: "1px solid rgba(255,255,255,0.05)",
                                }}>
                                    {creatorResults.map((c) => (
                                        <Link
                                            key={c.wallet_address}
                                            href={`/creator?id=${c.wallet_address}`}
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 10,
                                                padding: "10px 14px",
                                                textDecoration: "none",
                                                color: "#fff",
                                                transition: "background 0.15s",
                                            }}
                                            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,183,197,0.08)")}
                                            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={c.avatar_url || `https://robohash.org/${c.wallet_address}?set=set4&bgset=bg1`}
                                                alt=""
                                                style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(255,183,197,0.3)" }}
                                            />
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontSize: "0.9rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                                                    {c.display_name}
                                                    {c.is_verified && (
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--sakura-pink)" stroke="var(--sakura-pink)" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {c.wallet_address.slice(0, 4)}...{c.wallet_address.slice(-4)}
                                                </div>
                                            </div>
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {publicKey && (
                        <div className="settings-group">
                            <h3 className="settings-group-title">プロフィール Profile</h3>
                            <div className="setting-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
                                <div className="setting-info">
                                    <span className="setting-name">
                                        Display Name {hasPass && <span title="Pass Holder">🌸</span>}
                                    </span>
                                    <span className="setting-desc">Set a custom name that appears on your comments and profile.</span>
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <input
                                        type="text"
                                        placeholder="Enter display name..."
                                        value={displayName}
                                        onChange={(e) => setDisplayName(e.target.value.slice(0, 24))}
                                        maxLength={24}
                                        style={{
                                            flex: 1,
                                            padding: "10px 14px",
                                            borderRadius: "var(--radius-md)",
                                            background: "var(--bg-card)",
                                            border: "1px solid var(--border-subtle)",
                                            color: "var(--text-primary)",
                                            fontSize: 14,
                                            outline: "none",
                                        }}
                                    />
                                    <button
                                        className="btn-primary"
                                        onClick={async () => {
                                            await upsertProfile(
                                                publicKey.toBase58(),
                                                displayName || null,
                                                hasPass,
                                                bio || null
                                            );
                                            setProfileSaved(true);
                                            setTimeout(() => setProfileSaved(false), 2000);
                                        }}
                                        disabled={profileLoading}
                                        style={{ fontSize: 13, padding: "8px 20px", whiteSpace: "nowrap" }}
                                    >
                                        {profileSaved ? "✓ Saved" : "Save"}
                                    </button>
                                </div>
                            </div>

                            {/* Bio */}
                            <div className="setting-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
                                <div className="setting-info">
                                    <span className="setting-name">Bio 自己紹介</span>
                                    <span className="setting-desc">Tell the community about yourself ({bio.length}/140)</span>
                                </div>
                                <textarea
                                    placeholder="Manga is life... 漫画は人生..."
                                    value={bio}
                                    onChange={(e) => setBio(e.target.value.slice(0, 140))}
                                    maxLength={140}
                                    rows={2}
                                    style={{
                                        width: "100%",
                                        padding: "10px 14px",
                                        borderRadius: "var(--radius-md)",
                                        background: "var(--bg-card)",
                                        border: "1px solid var(--border-subtle)",
                                        color: "var(--text-primary)",
                                        fontSize: 14,
                                        fontFamily: "inherit",
                                        resize: "none",
                                        outline: "none",
                                    }}
                                />
                                <button
                                    className="btn-primary"
                                    onClick={async () => {
                                        await upsertProfile(
                                            publicKey.toBase58(),
                                            displayName || null,
                                            hasPass,
                                            bio || null
                                        );
                                        setProfileSaved(true);
                                        setTimeout(() => setProfileSaved(false), 2000);
                                    }}
                                    disabled={profileLoading}
                                    style={{ fontSize: 13, padding: "8px 20px", alignSelf: "flex-end" }}
                                >
                                    {profileSaved ? "✓ Bio Saved" : "Save Bio"}
                                </button>
                            </div>

                            <Link
                                href={`/profile?wallet=${publicKey.toBase58()}`}
                                style={{ fontSize: 12, color: "var(--sakura-pink)", textDecoration: "none", padding: "0 0 8px" }}
                            >
                                View your public profile →
                            </Link>
                        </div>
                    )}

                    {/* Reader Preferences */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">読み方 Reader</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Default Reading Mode</span>
                                <span className="setting-desc">Choose between infinite scroll or page-by-page.</span>
                            </div>
                            <div style={{ display: "flex", gap: 4, borderRadius: "var(--radius-md)", overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
                                <button
                                    onClick={() => handleReadingModeChange('scroll')}
                                    style={{
                                        padding: "8px 14px",
                                        fontSize: 12,
                                        fontWeight: 500,
                                        background: readingMode === 'scroll' ? 'var(--sakura-pink)' : 'var(--bg-card)',
                                        color: readingMode === 'scroll' ? '#fff' : 'var(--text-muted)',
                                        border: "none",
                                        cursor: "pointer",
                                        transition: "all 0.3s ease",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 6,
                                    }}
                                >
                                    <LottieIcon src="/icons/wired-outline-3411-chevron-down-circle-hover-scale.json" size={18} colorFilter={readingMode === 'scroll' ? "brightness(0) invert(1)" : "brightness(0) invert(1) opacity(0.4)"} playOnMount={readingMode === 'scroll'} />
                                    Scroll
                                </button>
                                <button
                                    onClick={() => handleReadingModeChange('page')}
                                    style={{
                                        padding: "8px 14px",
                                        fontSize: 12,
                                        fontWeight: 500,
                                        background: readingMode === 'page' ? 'var(--sakura-pink)' : 'var(--bg-card)',
                                        color: readingMode === 'page' ? '#fff' : 'var(--text-muted)',
                                        border: "none",
                                        cursor: "pointer",
                                        transition: "all 0.3s ease",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 6,
                                    }}
                                >
                                    <LottieIcon src="/icons/wired-outline-1384-page-view-array-hover-pinch.json" size={18} colorFilter={readingMode === 'page' ? "brightness(0) invert(1)" : "brightness(0) invert(1) opacity(0.4)"} playOnMount={readingMode === 'page'} />
                                    Page
                                </button>
                            </div>
                        </div>

                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Data Saver Mode</span>
                                <span className="setting-desc">Use compressed images (lower quality).</span>
                            </div>
                            <label className="switch">
                                <input
                                    type="checkbox"
                                    checked={dataSaver}
                                    onChange={(e) => toggleDataSaver(e.target.checked)}
                                />
                                <span className="slider round"></span>
                            </label>
                        </div>

                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">PNL Tracker</span>
                                <span className="setting-desc">Show a live SOL PNL widget while reading or watching.</span>
                            </div>
                            <label className="switch">
                                <input
                                    type="checkbox"
                                    checked={pnlTracker}
                                    onChange={(e) => togglePnlTracker(e.target.checked)}
                                />
                                <span className="slider round"></span>
                            </label>
                        </div>
                    </div>

                    {/* Notifications */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">通知 Notifications</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">New Chapter Alerts</span>
                                <span className="setting-desc">Get notified when new chapters are released.</span>
                            </div>
                            <label className="switch">
                                <input
                                    type="checkbox"
                                    checked={newReleaseAlerts}
                                    onChange={(e) => handleNewReleaseToggle(e.target.checked)}
                                />
                                <span className="slider round"></span>
                            </label>
                        </div>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Subscription Reminder</span>
                                <span className="setting-desc">Remind me when my weekly pass is about to expire.</span>
                            </div>
                            <label className="switch">
                                <input
                                    type="checkbox"
                                    checked={subscriptionAlerts}
                                    onChange={(e) => handleSubscriptionToggle(e.target.checked)}
                                />
                                <span className="slider round"></span>
                            </label>
                        </div>
                    </div>

                    {/* Email */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">メール Email (Optional)</h3>
                        <div className="setting-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
                            <div className="setting-info">
                                <span className="setting-desc">Add your email to receive updates and special offers. This is completely optional.</span>
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                                <input
                                    type="email"
                                    placeholder="your@email.com"
                                    value={userEmail}
                                    onChange={(e) => setUserEmail(e.target.value)}
                                    style={{
                                        flex: 1,
                                        padding: "10px 14px",
                                        borderRadius: "var(--radius-md)",
                                        background: "var(--bg-card)",
                                        border: "1px solid var(--border-subtle)",
                                        color: "var(--text-primary)",
                                        fontSize: 14,
                                        outline: "none",
                                    }}
                                />
                                <button
                                    className="btn-primary"
                                    onClick={handleEmailSave}
                                    style={{ fontSize: 13, padding: "8px 20px", whiteSpace: "nowrap" }}
                                >
                                    {emailSaved ? "✓ Saved" : "Save"}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* App Data & Downloads */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">データ Data & Downloads</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Manage Downloads</span>
                                <span className="setting-desc">View and delete offline chapters</span>
                            </div>
                            <Link href="/downloads" className="btn-secondary" style={{ fontSize: 13, padding: "8px 16px", textDecoration: "none" }}>
                                Open Manager
                            </Link>
                        </div>
                    </div>

                    {/* Storage */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">ストレージ Storage</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Clear Cache</span>
                                <span className="setting-desc">Current usage: {cacheSize}</span>
                            </div>
                            <button className="btn-secondary" onClick={clearCache} style={{ fontSize: 13, padding: "8px 16px" }}>
                                Clear Now
                            </button>
                        </div>
                    </div>

                    {/* About */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">About</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Version</span>
                                <span className="setting-desc">Sakura v1.2.1</span>
                            </div>
                        </div>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Contact</span>
                                <span className="setting-desc">sakuramanga162@gmail.com</span>
                            </div>
                            <a
                                href="mailto:sakuramanga162@gmail.com"
                                className="btn-secondary"
                                style={{ fontSize: 13, padding: "8px 16px", textDecoration: "none" }}
                            >
                                Email
                            </a>
                        </div>
                    </div>

                    {/* Legal */}
                    <div className="settings-group">
                        <h3 className="settings-group-title">Legal</h3>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Privacy Policy</span>
                                <span className="setting-desc">Learn how Sakura handles wallet, sync, and app data.</span>
                            </div>
                            <Link
                                href="/privacy"
                                className="btn-secondary"
                                style={{ fontSize: 13, padding: "8px 16px", textDecoration: "none" }}
                            >
                                Open
                            </Link>
                        </div>
                        <div className="setting-item">
                            <div className="setting-info">
                                <span className="setting-name">Terms of Service</span>
                                <span className="setting-desc">Review the rules, responsibilities, and risk disclosures.</span>
                            </div>
                            <Link
                                href="/terms"
                                className="btn-secondary"
                                style={{ fontSize: 13, padding: "8px 16px", textDecoration: "none" }}
                            >
                                Open
                            </Link>
                        </div>
                    </div>

                </section>

                <style jsx>{`
                    .settings-group {
                        background: var(--card-bg);
                        border-radius: var(--radius-lg);
                        border: 1px solid var(--card-border);
                        padding: 24px;
                        margin-bottom: 24px;
                    }
                    .settings-group-title {
                        font-family: var(--font-jp);
                        font-size: 18px;
                        margin-bottom: 20px;
                        color: var(--sakura-pink);
                    }
                    .setting-item {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 12px 0;
                        border-bottom: 1px solid rgba(255,255,255,0.05);
                    }
                    .setting-item:last-child {
                        border-bottom: none;
                    }
                    .setting-info {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    .setting-name {
                        font-weight: 500;
                    }
                    .setting-desc {
                        font-size: 13px;
                        color: var(--text-muted);
                    }
                    
                    /* Toggle Switch */
                    .switch {
                        position: relative;
                        display: inline-block;
                        width: 50px;
                        height: 28px;
                        flex-shrink: 0;
                    }
                    .switch input { 
                        opacity: 0;
                        width: 0;
                        height: 0;
                    }
                    .slider {
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: #333;
                        transition: .4s;
                    }
                    .slider:before {
                        position: absolute;
                        content: "";
                        height: 20px;
                        width: 20px;
                        left: 4px;
                        bottom: 4px;
                        background-color: white;
                        transition: .4s;
                    }
                    input:checked + .slider {
                        background-color: var(--sakura-pink);
                    }
                    input:checked + .slider:before {
                        transform: translateX(22px);
                    }
                    .slider.round {
                        border-radius: 34px;
                    }
                    .slider.round:before {
                        border-radius: 50%;
                    }
                `}</style>
            </main >
        </>
    );
}
