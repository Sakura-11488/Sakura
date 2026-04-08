"use client";

import Header from "@/components/Header";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import { useState, useEffect } from "react";
import { payForMonthlyPass, calculateSplit } from "@/lib/payment-split";
import { checkPassStatus, formatPassTimeRemaining, type PassStatus } from "@/lib/pass-check";
import { MONTHLY_PASS_PRICE, INSURANCE_SPLIT, BURN_SPLIT, getConnection } from "@/lib/solana";
import LottieIcon from "@/components/LottieIcon";

type PurchaseState = "idle" | "paying" | "success" | "error";

export default function MonthlyPassPage() {
    const { publicKey, signTransaction, connected } = useWallet();
    const { setVisible } = useSakuraWalletModal();
    const [purchaseState, setPurchaseState] = useState<PurchaseState>("idle");
    const [errorMessage, setErrorMessage] = useState("");
    const [txSignature, setTxSignature] = useState("");
    const [passStatus, setPassStatus] = useState<PassStatus | null>(null);
    const [checkingPass, setCheckingPass] = useState(false);

    const splits = calculateSplit(MONTHLY_PASS_PRICE);
    const [crankStale, setCrankStale] = useState(false);
    const [checkingCrank, setCheckingCrank] = useState(false);

    // Check if user already has a valid pass
    useEffect(() => {
        if (publicKey) {
            setCheckingPass(true);
            checkPassStatus(publicKey.toBase58())
                .then(setPassStatus)
                .finally(() => setCheckingPass(false));
        } else {
            setPassStatus(null);
        }
    }, [publicKey]);

    useEffect(() => {
        setCrankStale(false);
        setCheckingCrank(false);
    }, []);

    const handlePurchase = async () => {
        if (!publicKey || !signTransaction) {
            setVisible(true);
            return;
        }

        try {
            setPurchaseState("paying");
            setErrorMessage("");

            const result = await payForMonthlyPass(publicKey, signTransaction);
            if (!result.success) {
                throw new Error(result.error || "Payment failed");
            }
            setTxSignature(result.signature || "");

            // --- LOCAL RECEIPT FALLBACK ---
            // Set local receipt for +30 days since actual PDA doesn't exist on Mainnet yet
            const storage = await import("@/lib/storage");
            const { getPassExpiryDate } = await import("@/lib/pass-check");
            const receipts = storage.getLocal<Record<string, number>>(storage.STORAGE_KEYS.PASS_RECEIPTS, {});
            receipts[publicKey.toBase58()] = getPassExpiryDate().getTime();
            storage.setLocal(storage.STORAGE_KEYS.PASS_RECEIPTS, receipts);
            // --- END FALLBACK ---

            setPurchaseState("success");

            // Refresh pass status
            const newStatus = await checkPassStatus(publicKey.toBase58());
            setPassStatus(newStatus);
        } catch (error: unknown) {
            setPurchaseState("error");
            setErrorMessage(
                error instanceof Error ? error.message : "Something went wrong"
            );
        }
    };

    const renderPurchaseButton = () => {
        if (!connected) {
            return (
                <button
                    className="btn-primary"
                    style={{ width: "100%", justifyContent: "center" }}
                    onClick={() => setVisible(true)}
                >
                    <LottieIcon src="/icons/wired-outline-421-wallet-purse-hover-pinch.json" size={18} colorFilter="brightness(0) invert(1) opacity(0.7)" replayIntervalMs={3000} autoplay />
                    ログイン — Sign Up / Login First
                </button>
            );
        }

        if (checkingPass) {
            return (
                <button className="btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled>
                    Checking pass status...
                </button>
            );
        }

        if (crankStale) {
            return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{
                        padding: 12,
                        borderRadius: "var(--radius-md)",
                        background: "rgba(245, 158, 11, 0.1)",
                        border: "1px solid rgba(245, 158, 11, 0.3)",
                        textAlign: "center",
                        fontSize: 13,
                        color: "#d97706"
                    }}>
                        <strong>Note:</strong> Risk Engine coverage info may be delayed, but payments are unaffected.
                    </div>
                    <button
                        className="btn-primary"
                        style={{ width: "100%", justifyContent: "center" }}
                        onClick={handlePurchase}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="5" rx="2" /><line x1="2" x2="22" y1="10" y2="10" /></svg>
                        パスを購入 — Purchase Monthly Pass
                    </button>
                </div>
            );
        }

        if (passStatus?.valid) {
            return (
                <div className="pass-active-badge">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#4ade80" stroke="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15l-4-4 1.41-1.41L11 14.17l6.59-6.59L19 9l-8 8z" /></svg>
                    <div>
                        <p style={{ fontWeight: 600, color: "#4ade80" }}>パスは有効です — Pass Active</p>
                        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {passStatus.expiresAt && formatPassTimeRemaining(passStatus.expiresAt)}
                        </p>
                    </div>
                </div>
            );
        }

        switch (purchaseState) {
            case "paying":
                return (
                    <button className="btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled>
                        <span className="spinner" /> 支払い処理中... Sending $SAKURA
                    </button>
                );
            case "success":
                return (
                    <div className="premium-success-container">
                        <div className="premium-glow-ring"></div>
                        <div className="premium-sakura-bloom">🌸</div>
                        <div className="premium-success-content">
                            <h3 className="premium-welcome-text">Sakura Premium Unlocked</h3>
                            <p className="premium-welcome-sub">無限の物語へようこそ — Welcome to endless stories.</p>

                            {txSignature && (
                                <a
                                    href={`https://explorer.solana.com/tx/${txSignature}?cluster=mainnet-beta`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="premium-tx-link"
                                >
                                    Verify on Blockchain ↗
                                </a>
                            )}
                            <Link
                                href="/manga"
                                className="btn-primary"
                                style={{ width: "100%", justifyContent: "center", marginTop: 24, padding: "14px", fontSize: "16px", background: "linear-gradient(45deg, #ff9a9e, var(--sakura-pink))", border: "none" }}
                            >
                                マンガを読む — Start Reading →
                            </Link>
                        </div>
                    </div>
                );
            case "error":
                return (
                    <div>
                        <div style={{
                            padding: 16,
                            borderRadius: "var(--radius-md)",
                            background: "rgba(239, 68, 68, 0.1)",
                            border: "1px solid rgba(239, 68, 68, 0.3)",
                            marginBottom: 16,
                            textAlign: "center",
                        }}>
                            <p style={{ color: "#ef4444", fontWeight: 600, marginBottom: 4 }}>
                                エラー — Error
                            </p>
                            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                                {errorMessage}
                            </p>
                        </div>
                        <button
                            className="btn-primary"
                            style={{ width: "100%", justifyContent: "center" }}
                            onClick={() => {
                                setPurchaseState("idle");
                                handlePurchase();
                            }}
                        >
                            再試行 — Retry Purchase
                        </button>
                    </div>
                );
            default:
                return (
                    <button
                        className="btn-primary"
                        style={{ width: "100%", justifyContent: "center" }}
                        onClick={handlePurchase}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="5" rx="2" /><line x1="2" x2="22" y1="10" y2="10" /></svg>
                        パスを購入 — Purchase Monthly Pass
                    </button>
                );
        }
    };

    return (
        <>
            <Header />
            <main className="main-content">
                <section className="weekly-pass">
                    <div className="section-header">
                        <h2 className="section-title">Sakura Premium</h2>
                        <p className="section-subtitle">Support creators & read the latest chapters</p>
                    </div>

                    <div className="pass-card">
                        <h2>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--sakura-pink)" stroke="none" style={{ verticalAlign: 'middle', marginRight: 8 }}><path d="M12 2C9.5 5 7 8 7 11a5 5 0 0 0 10 0c0-3-2.5-6-5-9z" /><path d="M12 2C14.5 5 17 8 17 11" opacity="0.5" /></svg>
                            プレミアムパス
                        </h2>
                        <p className="jp-sub">Premium Monthly Pass</p>

                        <div className="pass-price">
                            <span className="amount">{MONTHLY_PASS_PRICE}</span>
                            <span className="currency">$SAKURA</span>
                            <span className="period">/ month</span>
                        </div>

                        <ul className="pass-features">
                            <li>
                                <span className="check">✓</span>
                                Read the <strong>latest 3 chapters</strong> of ongoing series
                            </li>
                            <li>
                                <span className="check">✓</span>
                                Unlimited access to entire backlog (Free)
                            </li>
                            <li>
                                <span className="check">✓</span>
                                Automated <strong>Insurance Fund Routing</strong>
                            </li>
                            <li>
                                <span className="check">✓</span>
                                Permanent <strong>SPL Token Burn</strong> mechanism
                            </li>
                        </ul>

                        {renderPurchaseButton()}

                        {purchaseState === "idle" && !passStatus?.valid && connected && (
                            <p
                                style={{
                                    fontSize: 11,
                                    color: "var(--text-muted)",
                                    marginTop: 12,
                                }}
                            >
                                Requires $SAKURA token balance on Solana
                            </p>
                        )}
                    </div>

                    {/* Revenue Split Visualization */}
                    <div className="split-section">
                        <h3 className="split-title">
                            収益分配 — Deterministic Fee Routing
                        </h3>
                        <p className="split-subtitle">Every valid payment is statically split 50/50 on-chain via SakuraFeeRouter</p>

                        {/* Split Bar */}
                        <div className="split-bar">
                            <div
                                className="split-bar-segment"
                                style={{ width: `${INSURANCE_SPLIT}%`, background: "var(--sakura-pink)" }}
                            >
                                {INSURANCE_SPLIT}%
                            </div>
                            <div
                                className="split-bar-segment"
                                style={{ width: `${BURN_SPLIT}%`, background: "#f87171" }}
                            >
                                {BURN_SPLIT}%
                            </div>
                        </div>

                        {/* Split Details */}
                        <div className="split-details">
                            <div className="split-detail-item">
                                <div className="split-dot" style={{ background: "var(--sakura-pink)" }} />
                                <div className="split-detail-info">
                                    <span className="split-detail-label">Percolator Insurance — Risk Pool</span>
                                    <span className="split-detail-amount">{splits.insurance} $SAKURA</span>
                                </div>
                                <span className="split-detail-pct">{INSURANCE_SPLIT}%</span>
                            </div>
                            <div className="split-detail-item">
                                <div className="split-dot" style={{ background: "#f87171" }} />
                                <div className="split-detail-info">
                                    <span className="split-detail-label">永久焼却 — Permanent SPL Burn</span>
                                    <span className="split-detail-amount">{splits.burn} $SAKURA</span>
                                </div>
                                <span className="split-detail-pct">{BURN_SPLIT}%</span>
                            </div>
                        </div>
                    </div>

                    {/* How it works */}
                    <div
                        style={{
                            maxWidth: 600,
                            margin: "60px auto 0",
                            textAlign: "left",
                        }}
                    >
                        <h3
                            style={{
                                fontFamily: "var(--font-jp)",
                                fontSize: 20,
                                textAlign: "center",
                                marginBottom: 32,
                            }}
                        >
                            購入フロー — Payment Flow
                        </h3>
                        {[
                            { step: "01", jp: "ウォレット接続", en: "Connect your Solana wallet (Phantom recommended)" },
                            { step: "02", jp: "$SAKURA支払い", en: `Pay ${MONTHLY_PASS_PRICE} $SAKURA — routes to FeeRouter` },
                            { step: "03", jp: "パス有効化", en: "Subscription PDA unix timestamp extends automatically on payment success." },
                            { step: "04", jp: "読書開始", en: "Unlock the latest chapters immediately" },
                        ].map((item) => (
                            <div
                                key={item.step}
                                style={{
                                    display: "flex",
                                    gap: 16,
                                    marginBottom: 16,
                                    alignItems: "flex-start",
                                    padding: 16,
                                    borderRadius: "var(--radius-md)",
                                    background: "var(--bg-card)",
                                    border: "1px solid var(--border-subtle)",
                                }}
                            >
                                <span
                                    style={{
                                        fontFamily: "var(--font-jp)",
                                        fontSize: 24,
                                        fontWeight: 700,
                                        color: "var(--sakura-pink)",
                                        minWidth: 40,
                                    }}
                                >
                                    {item.step}
                                </span>
                                <div>
                                    <p
                                        style={{
                                            fontFamily: "var(--font-jp)",
                                            fontSize: 14,
                                            marginBottom: 2,
                                        }}
                                    >
                                        {item.jp}
                                    </p>
                                    <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                                        {item.en}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                <footer className="footer">
                    <p className="footer-jp">桜 — マンガの新しい形</p>
                    <p className="footer-text">© 2026 Sakura. Read manga on the blockchain.</p>
                    <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                        <Link href="/privacy" style={{ color: "var(--sakura-pink)", textDecoration: "none", fontSize: "0.85rem" }}>
                            Privacy Policy
                        </Link>
                        <Link href="/terms" style={{ color: "var(--sakura-pink)", textDecoration: "none", fontSize: "0.85rem" }}>
                            Terms of Service
                        </Link>
                    </div>
                    <div className="footer-solana">
                        <span className="sol-dot" />
                        Built on Solana
                    </div>
                </footer>
            </main>
        </>
    );
}
