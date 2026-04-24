"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import { truncateAddress } from "@/lib/solana";
import { getPublicProfile, type UserProfile, type ProfileStats } from "@/lib/comments";
import Link from "next/link";
import { getDefaultMangaSourceId } from "@/lib/sources/source-ids";

/* ─── SVG Icons (24x24, filled, currentColor) ─── */
const IconBook = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z" /></svg>;
const IconMessage = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" /></svg>;
const IconSparkles = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2zM5 16l1.5 2L9 19.5 6.5 21 5 23l-1.5-2L1 19.5 3.5 18 5 16zm14 0l1.5 2 2.5 1.5-2.5 1.5-1.5 2-1.5-2-2.5-1.5 2.5-1.5 1.5-2z" /></svg>;
const IconHeart = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>;
const IconSeedling = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c-1.1 0-2-.9-2-2v-1h4v1c0 1.1-.9 2-2 2zM8 16v-2c0-2.21 1.79-4 4-4s4 1.79 4 4v2H8zm-2 2H4v-2c0-1.5.5-2.9 1.4-4 .9-1.1 2.1-1.9 3.6-2.2V6c0-1.1-.9-2-2-2H6v2h2v2.8c-1.5.3-2.7 1.1-3.6 2.2C4.5 11.1 4 12.5 4 14v2H6z" /></svg>;
const IconStar = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>;
const IconFlame = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8c0-3.38-1.21-6.49-3.3-8.79-.24 2.58-2.2 4.79-4.7 4.79-2.07 0-3.63-1.67-3.63-3.73 0-2.15.74-4.8.74-4.8L13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" /></svg>;
const IconFlag = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6z" /></svg>;
const IconCrown = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9 8H3l3 4 2.5-2 2.5 2 3-4H15L12 2zm-1 14l-2.5-2L6 16l2 4h8l2-4-2.5-2L13 16l-2-2z" /></svg>;
const IconBooks = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z" /></svg>;
const IconDiamond = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5L2 9l10 12 10-12-3-6zM9.62 8l1.5-3h1.76l1.5 3H9.62zM11 10v6.68L5.44 10H11zm2 0h5.56L13 16.68V10zm6.26-2h-2.65l-1.5-3h2.65l1.5 3zM6.24 5h2.65l-1.5 3H4.74l1.5-3z" /></svg>;
const IconFlower = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c4.97 0 9-4.03 9-9-4.97 0-9 4.03-9 9zM5 13c-4.97 0-9 4.03-9 9 4.97 0 9-4.03 9-9-4.97 0-9-4.03-9-9zm14 0c4.97 0 9-4.03 9-9-4.97 0-9 4.03-9 9 4.97 0 9 4.03 9 9zM12 5c-4.97 0-9 4.03-9 9 4.97 0 9-4.03 9-9-4.97 0-9-4.03-9-9z" /></svg>;
const IconMic = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" /></svg>;
const IconLock = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" /></svg>;

/* ─── Otaku Level System ─── */
const LEVELS = [
    { min: 0, name: "新人 Rookie", icon: IconSeedling, color: "#6ee7b7" },
    { min: 5, name: "読者 Reader", icon: IconBook, color: "#93c5fd" },
    { min: 15, name: "オタク Otaku", icon: IconStar, color: "#c084fc" },
    { min: 30, name: "マニア Maniac", icon: IconFlame, color: "#fb923c" },
    { min: 50, name: "師範 Sensei", icon: IconFlag, color: "#f472b6" },
    { min: 100, name: "漫画家 Mangaka", icon: IconCrown, color: "#fbbf24" },
];

function getLevel(chaptersRead: number) {
    let level = LEVELS[0];
    for (const l of LEVELS) {
        if (chaptersRead >= l.min) level = l;
    }
    const nextLevel = LEVELS[LEVELS.indexOf(level) + 1];
    const progress = nextLevel
        ? ((chaptersRead - level.min) / (nextLevel.min - level.min)) * 100
        : 100;
    return { ...level, progress: Math.min(progress, 100), nextLevel };
}

/* ─── Achievements ─── */
interface Achievement {
    id: string;
    name: string;
    desc: string;
    icon: React.ComponentType;
    earned: boolean;
}

function computeAchievements(stats: ProfileStats, hasPass: boolean): Achievement[] {
    return [
        { id: "first-read", name: "初読み First Read", desc: "Read your first chapter", icon: IconBook, earned: stats.chaptersRead >= 1 },
        { id: "bookworm", name: "本の虫 Bookworm", desc: "Read 10+ chapters", icon: IconBooks, earned: stats.chaptersRead >= 10 },
        { id: "social", name: "社交的 Social", desc: "Post your first comment", icon: IconMessage, earned: stats.commentsPosted >= 1 },
        { id: "popular", name: "人気者 Popular", desc: "Receive 5+ reactions", icon: IconSparkles, earned: stats.reactionsReceived >= 5 },
        { id: "collector", name: "収集家 Collector", desc: "Add 5+ favorites", icon: IconDiamond, earned: stats.favoritesCount >= 5 },
        { id: "pass-holder", name: "桜メンバー Sakura Member", desc: "Own a Monthly Pass", icon: IconFlower, earned: hasPass },
        { id: "otaku", name: "オタク Otaku", desc: "Read 15+ chapters", icon: IconStar, earned: stats.chaptersRead >= 15 },
        { id: "chatterbox", name: "おしゃべり Chatterbox", desc: "Post 10+ comments", icon: IconMic, earned: stats.commentsPosted >= 10 },
    ];
}

/* ─── Stat Card ─── */
function StatCard({ value, label, icon: Icon }: { value: number | string; label: string; icon: React.ComponentType }) {
    return (
        <div className="stat-card">
            <span className="stat-icon"><Icon /></span>
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
        </div>
    );
}

/* ─── Profile Content ─── */
function ProfileContent() {
    const searchParams = useSearchParams();
    const walletAddress = searchParams.get("wallet");

    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [favorites, setFavorites] = useState<{ manga_id: string; title: string; cover_url: string }[]>([]);
    const [stats, setStats] = useState<ProfileStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!walletAddress) return;
        async function load() {
            setLoading(true);
            const data = await getPublicProfile(walletAddress!);
            setProfile(data.profile);
            setFavorites(data.favorites);
            setStats(data.stats);
            setLoading(false);
        }
        load();
    }, [walletAddress]);

    if (!walletAddress) {
        return (
            <>
                <Header />
                <main className="main-content">
                    <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
                        <p>No wallet specified.</p>
                    </div>
                </main>
            </>
        );
    }

    const displayName = profile?.display_name || truncateAddress(walletAddress);
    const avatarHue = hashCode(walletAddress) % 360;
    const level = getLevel(stats?.chaptersRead || 0);
    const achievements = computeAchievements(
        stats || { chaptersRead: 0, commentsPosted: 0, reactionsReceived: 0, favoritesCount: 0, memberSince: null },
        profile?.has_pass || false
    );
    const earnedCount = achievements.filter(a => a.earned).length;

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40, maxWidth: 800, margin: "0 auto" }}>
                    {loading ? (
                        <div className="profile-loading">
                            <div className="swm-spinner" />
                            <span>Loading profile...</span>
                        </div>
                    ) : (
                        <>
                            {/* ═══ Hero Card ═══ */}
                            <div className="profile-hero" style={{ '--hero-hue': avatarHue } as React.CSSProperties}>
                                <div className="profile-hero-glow" />
                                <div className="profile-hero-content">
                                    <div
                                        className="profile-avatar-lg"
                                        style={{ background: `linear-gradient(135deg, hsl(${avatarHue}, 70%, 55%), hsl(${(avatarHue + 40) % 360}, 60%, 45%))` }}
                                    >
                                        {displayName[0].toUpperCase()}
                                    </div>
                                    <div className="profile-hero-info">
                                        <h1 className="profile-hero-name">
                                            {displayName}
                                            {profile?.has_pass && <span className="pass-badge-lg" title="Pass Holder">{React.createElement(IconFlower)}</span>}
                                        </h1>
                                        <p className="profile-hero-wallet">{truncateAddress(walletAddress)}</p>
                                        {profile?.bio && (
                                            <p className="profile-hero-bio">{profile.bio}</p>
                                        )}
                                        {stats?.memberSince && (
                                            <p className="profile-member-since">
                                                Member since {new Date(stats.memberSince).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                                            </p>
                                        )}
                                    </div>
                                </div>

                                {/* Level Badge */}
                                <div className="level-badge" style={{ borderColor: level.color }}>
                                    <span className="level-icon" style={{ color: level.color }}>{React.createElement(level.icon)}</span>
                                    <span className="level-name" style={{ color: level.color }}>{level.name}</span>
                                    {level.nextLevel && (
                                        <div className="level-progress-bar">
                                            <div
                                                className="level-progress-fill"
                                                style={{ width: `${level.progress}%`, background: level.color }}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* ═══ Stats Grid ═══ */}
                            <div className="stats-grid">
                                <StatCard value={stats?.chaptersRead || 0} label="Chapters Read" icon={IconBook} />
                                <StatCard value={stats?.commentsPosted || 0} label="Comments" icon={IconMessage} />
                                <StatCard value={stats?.reactionsReceived || 0} label="Reactions" icon={IconSparkles} />
                                <StatCard value={stats?.favoritesCount || 0} label="Favorites" icon={IconHeart} />
                            </div>

                            {/* ═══ Achievements ═══ */}
                            <div className="profile-section">
                                <h2 className="profile-section-title">
                                    実績 Achievements
                                    <span className="profile-count">{earnedCount}/{achievements.length}</span>
                                </h2>
                                <div className="achievements-grid">
                                    {achievements.map(a => (
                                        <div key={a.id} className={`achievement-card ${a.earned ? "earned" : "locked"}`}>
                                            <span className="achievement-icon">{React.createElement(a.icon)}</span>
                                            <span className="achievement-name">{a.name}</span>
                                            <span className="achievement-desc">{a.desc}</span>
                                            {!a.earned && <div className="achievement-lock">{React.createElement(IconLock)}</div>}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* ═══ Favorites ═══ */}
                            <div className="profile-section">
                                <h2 className="profile-section-title">
                                    お気に入り Favorites
                                    {favorites.length > 0 && <span className="profile-count">{favorites.length}</span>}
                                </h2>
                                {favorites.length === 0 ? (
                                    <div className="profile-empty">
                                        <p>No public favorites yet.</p>
                                    </div>
                                ) : (
                                    <div className="profile-favorites-grid">
                                        {favorites.map(fav => (
                                            <Link
                                                key={fav.manga_id}
                                                href={`/title?id=${fav.manga_id}&source=${getDefaultMangaSourceId()}`}
                                                className="profile-fav-card"
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={fav.cover_url} alt={fav.title} className="profile-fav-cover" referrerPolicy="no-referrer" />
                                                <span className="profile-fav-title">{fav.title}</span>
                                            </Link>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </section>

                <footer className="footer">
                    <p className="footer-jp">桜 — マンガの新しい形</p>
                    <p className="footer-text">© 2026 Sakura. Read manga on the blockchain.</p>
                    <div className="footer-solana">
                        <span className="sol-dot" />
                        Built on Solana
                    </div>
                </footer>
            </main>
        </>
    );
}

export default function ProfilePage() {
    return (
        <Suspense fallback={<div style={{ textAlign: "center", padding: 60 }}>Loading...</div>}>
            <ProfileContent />
        </Suspense>
    );
}

function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
}
