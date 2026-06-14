"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "./SakuraWalletModal";
import { truncateAddress } from "@/lib/solana";
import { useState, useEffect } from "react";
import { checkPassStatus } from "@/lib/pass-check";
import LottieIcon from "@/components/LottieIcon";
import { useI18n } from "@/lib/i18n/I18nProvider";

export default function Header() {
    const { publicKey, disconnect, connecting } = useWallet();
    const { setVisible } = useSakuraWalletModal();
    const { t } = useI18n();
    const [isPremium, setIsPremium] = useState(false);

    useEffect(() => {
        if (publicKey) {
            checkPassStatus(publicKey.toBase58()).then(status => {
                setIsPremium(status.valid);
            });
        } else {
            setIsPremium(false);
        }
    }, [publicKey]);

    const handleWalletClick = () => {
        setVisible(true);
    };

    return (
        <header className="header">
            <Link href="/" className="header-logo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/sakura.png" alt="Sakura" />
                <div className="header-logo-text">
                    <span className="jp">桜 Sakura</span>
                    <span className="en">{t("app.tagline")}</span>
                </div>
            </Link>

            <nav className="header-nav">
                <Link href="/">
                    {t("nav.home")}
                    <span className="jp-label">ホーム</span>
                </Link>
                <Link href="/manga">
                    {t("nav.browse")}
                    <span className="jp-label">マンガ</span>
                </Link>
                <Link href="/pass">
                    {t("nav.pass")}
                    <span className="jp-label">パス</span>
                </Link>
                <Link href="/library">
                    {t("nav.library")}
                    <span className="jp-label">ライブラリ</span>
                </Link>
                <Link href="/history">
                    {t("nav.history")}
                    <span className="jp-label">履歴</span>
                </Link>
                <Link href="/creator">
                    {t("nav.creator")}
                    <span className="jp-label">クリエイター</span>
                </Link>
                <Link href="/settings">
                    {t("nav.settings")}
                    <span className="jp-label">設定</span>
                </Link>

                <Link href="/pass" className="wallet-btn" style={{
                    padding: '8px 14px',
                    marginRight: 8,
                    background: 'linear-gradient(135deg, rgba(88, 101, 242, 0.15), rgba(255, 105, 180, 0.1))',
                    border: '1px solid rgba(88, 101, 242, 0.25)',
                    fontSize: 13,
                    gap: 6,
                    minWidth: 'auto'
                }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(88, 101, 242, 1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="20" height="14" x="2" y="5" rx="2" />
                        <line x1="2" x2="22" y1="10" y2="10" />
                    </svg>
                    <span style={{ color: 'rgba(88, 101, 242, 1)' }}>{t("nav.store")}</span>
                </Link>

                <button
                    className={`wallet-btn ${publicKey ? "wallet-connected" : ""}`}
                    onClick={handleWalletClick}
                    disabled={connecting}
                    style={isPremium ? { border: "1px solid var(--gold)", boxShadow: "0 0 10px rgba(245, 197, 66, 0.2)" } : {}}
                >
                    {isPremium && (
                        <span style={{ marginRight: '6px', display: 'flex', alignItems: 'center', filter: 'drop-shadow(0 0 4px rgba(245, 197, 66, 0.8))' }} title="Sakura Premium VIP">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="rgba(245, 197, 66, 0.2)" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.956-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
                                <path d="M5 21h14" />
                            </svg>
                        </span>
                    )}
                    <span className="icon">
                        <LottieIcon
                            src="/icons/wired-outline-421-wallet-purse-hover-pinch.json"
                            size={18}
                            colorFilter={isPremium
                                ? "brightness(0) saturate(100%) invert(79%) sepia(48%) saturate(1000%) hue-rotate(5deg) brightness(103%) contrast(94%)"
                                : "brightness(0) invert(1) opacity(0.7)"}
                            replayIntervalMs={3000}
                            autoplay
                        />
                    </span>
                    <span style={isPremium ? { color: "var(--gold)", fontWeight: "bold" } : {}}>
                        {publicKey ? truncateAddress(publicKey.toBase58()) : t("wallet.signIn")}
                    </span>
                </button>
            </nav>
        </header>
    );
}
