"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { truncateAddress, getConnection, SAKURA_MINT, SOLANA_NETWORK } from "@/lib/solana";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
    generateWallet,
    storeWalletSecurely,
    removeWalletSecurely,
    revealStoredSecretKey,
    isWalletBackedUp,
    markWalletBackedUp,
} from "@/lib/wallet";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const BuySakuraModal = dynamic(() => import("@/components/BuySakuraModal"), { ssr: false });
const TipModal = dynamic(() => import("@/components/TipModal"), { ssr: false });
import LottieIcon from "@/components/LottieIcon";
import { useI18n } from "@/lib/i18n/I18nProvider";

/* ─── Context ─── */
interface SakuraWalletModalContextType {
    visible: boolean;
    setVisible: (v: boolean) => void;
}

const SakuraWalletModalContext = createContext<SakuraWalletModalContextType>({
    visible: false,
    setVisible: () => { },
});

export function useSakuraWalletModal() {
    return useContext(SakuraWalletModalContext);
}

/* ─── Provider + Modal ─── */
export function SakuraWalletModalProvider({ children }: { children: React.ReactNode }) {
    const [visible, setVisible] = useState(false);

    return (
        <SakuraWalletModalContext.Provider value={{ visible, setVisible }}>
            {children}
            {visible && <SakuraWalletModal onClose={() => setVisible(false)} />}
        </SakuraWalletModalContext.Provider>
    );
}

/* ─── The Modal ─── */
function SakuraWalletModal({ onClose }: { onClose: () => void }) {
    const { wallets, select, connect, publicKey, disconnect, connected } = useWallet();
    const router = useRouter();
    const { t } = useI18n();
    const [balance, setBalance] = useState<number | null>(null);
    const [sakuraBalance, setSakuraBalance] = useState<number | null>(null);

    const [showBuySakura, setShowBuySakura] = useState(false);
    const [showDonate, setShowDonate] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [diagnostics, setDiagnostics] = useState<string | null>(null);
    const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importKey, setImportKey] = useState("");

    // Backup-secret-key state. `mandatorySecret` is set immediately after a
    // wallet is generated and forces the user to acknowledge they've saved
    // the key before they can leave the modal. `revealedSecret` powers the
    // optional "Show my secret key" flow on an already-connected wallet.
    const [mandatorySecret, setMandatorySecret] = useState<string | null>(null);
    const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
    const [revealError, setRevealError] = useState<string | null>(null);
    const [revealLoading, setRevealLoading] = useState(false);
    const [backedUp, setBackedUp] = useState<boolean | null>(null);

    useEffect(() => {
        // Re-check the backup flag every time the connected wallet changes
        // so the persistent banner updates instantly after the user finishes
        // a backup flow.
        if (!connected) {
            setBackedUp(null);
            return;
        }
        let cancelled = false;
        isWalletBackedUp().then((flag) => {
            if (!cancelled) setBackedUp(flag);
        });
        return () => { cancelled = true; };
    }, [connected, publicKey]);

    const handleRevealSecret = useCallback(async () => {
        setRevealError(null);
        setRevealLoading(true);
        try {
            const secret = await revealStoredSecretKey();
            if (!secret) {
                setRevealError("No stored secret found. (Was the wallet imported into a different device?)");
            } else {
                setRevealedSecret(secret);
            }
        } catch (err: any) {
            setRevealError(err?.message || "Could not retrieve secret key.");
        } finally {
            setRevealLoading(false);
        }
    }, []);

    const handleAcknowledgeBackup = useCallback(async () => {
        await markWalletBackedUp();
        setBackedUp(true);
        setMandatorySecret(null);
        setRevealedSecret(null);
    }, []);

    const buildDiagnostics = useCallback((step: string, err: any) => {
        const lines = [
            `Sakura wallet sign-up diagnostics`,
            `Step: ${step}`,
            `When: ${new Date().toISOString()}`,
            `Network: ${SOLANA_NETWORK}`,
            `Adapter: ${wallets?.[0]?.adapter?.name ?? "(none)"}`,
            `UserAgent: ${typeof navigator !== "undefined" ? navigator.userAgent : "(server)"}`,
            "",
            `Error: ${err?.name || "Error"}: ${err?.message || String(err)}`,
        ];
        if (err?.stack) {
            lines.push("", String(err.stack));
        }
        return lines.join("\n");
    }, [wallets]);

    const handleCopyDiagnostics = useCallback(async () => {
        if (!diagnostics) return;
        try {
            await navigator.clipboard.writeText(diagnostics);
            setDiagnosticsCopied(true);
            setTimeout(() => setDiagnosticsCopied(false), 2000);
        } catch (copyErr) {
            console.warn("Failed to copy diagnostics:", copyErr);
        }
    }, [diagnostics]);

    const fetchBalances = useCallback(() => {
        if (!publicKey) {
            setBalance(null);
            setSakuraBalance(null);
            return;
        }

        const conn = getConnection();

        conn.getBalance(publicKey)
            .then(b => setBalance(b / LAMPORTS_PER_SOL))
            .catch((e) => { console.warn("SOL balance fetch failed:", e); setBalance(0); });

        import("@/lib/solana").then(({ SAKURA_MINT, SAKURA_DECIMALS }) => {
            conn.getParsedTokenAccountsByOwner(publicKey, { mint: SAKURA_MINT })
                .then(accounts => {
                    if (accounts.value.length > 0) {
                        let total = 0;
                        for (const account of accounts.value) {
                            const amountStr = account.account.data.parsed.info.tokenAmount.amount;
                            total += Number(amountStr) / (10 ** SAKURA_DECIMALS);
                        }
                        setSakuraBalance(total);
                    } else {
                        setSakuraBalance(0);
                    }
                })
                .catch((e) => { console.warn("SAKURA balance fetch failed:", e); setSakuraBalance(0); });
        });
    }, [publicKey]);

    const [balanceLoading, setBalanceLoading] = useState(false);
    const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        fetchBalances();

        if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
        if (publicKey) {
            refreshTimerRef.current = setInterval(fetchBalances, 15_000);
        }
        return () => {
            if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
        };
    }, [fetchBalances]);

    const connectAfterStore = async () => {
        if (!wallets || wallets.length === 0) return;
        const adapter = wallets[0].adapter;
        select(adapter.name);
        await new Promise(r => setTimeout(r, 150));
        // Call adapter.connect() directly — the hook's connect() can have stale
        // internal state from a failed auto-connect on first load (no key yet).
        // The adapter emits 'connect', which the WalletProvider listens to and
        // updates React state, so `connected` / `publicKey` will update properly.
        await adapter.connect();
    };

    const handleCreateWallet = async () => {
        setError(null);
        setDiagnostics(null);
        setIsGenerating(true);

        let newKeypair: Keypair;
        try {
            newKeypair = generateWallet();
        } catch (err: any) {
            console.error("[wallet] generateWallet failed:", err);
            setError("Could not generate a new wallet. " + (err?.message || ""));
            setDiagnostics(buildDiagnostics("generateWallet", err));
            setIsGenerating(false);
            return;
        }

        // Capture the base58 secret BEFORE we hand the keypair off to secure
        // storage — we need it for the mandatory backup sheet, and we don't
        // want to round-trip through biometrics here on the happy path.
        const secretBase58 = bs58.encode(newKeypair.secretKey);

        try {
            await storeWalletSecurely(newKeypair);
        } catch (err: any) {
            console.error("[wallet] storeWalletSecurely failed:", err);
            setError("Could not save wallet to secure storage. " + (err?.message || ""));
            setDiagnostics(buildDiagnostics("storeWalletSecurely", err));
            setIsGenerating(false);
            return;
        }

        // The Solana wallet adapter occasionally races on first connect right
        // after a fresh keystore write. We retry once after a short delay so
        // the user doesn't have to manually re-tap "Create wallet".
        try {
            await connectAfterStore();
        } catch (firstErr: any) {
            console.warn("[wallet] connectAfterStore first attempt failed, retrying:", firstErr);
            await new Promise((resolve) => setTimeout(resolve, 250));
            try {
                await connectAfterStore();
            } catch (secondErr: any) {
                console.error("[wallet] connectAfterStore retry failed:", secondErr);
                setError("Wallet was saved, but we could not connect it automatically. Re-open this menu to try again.");
                setDiagnostics(buildDiagnostics("connectAfterStore (retry)", secondErr));
                setIsGenerating(false);
                return;
            }
        }

        setIsGenerating(false);
        // Force the user to back up their secret RIGHT NOW. They cannot
        // dismiss this sheet without explicitly acknowledging that they
        // saved the key — see <BackupSecretSheet />.
        setMandatorySecret(secretBase58);
        setBackedUp(false);
    };

    const handleImportWallet = async () => {
        setError(null);
        setDiagnostics(null);
        if (!importKey) return;

        let keypair: Keypair;
        try {
            const secretKey = bs58.decode(importKey.trim());
            keypair = Keypair.fromSecretKey(secretKey);
        } catch (err: any) {
            console.error("[wallet] decode importKey failed:", err);
            setError("Invalid Secret Key format (must be Base58).");
            setDiagnostics(buildDiagnostics("decodeImportKey", err));
            return;
        }

        try {
            await storeWalletSecurely(keypair);
        } catch (err: any) {
            console.error("[wallet] storeWalletSecurely failed:", err);
            setError("Could not save imported wallet to secure storage. " + (err?.message || ""));
            setDiagnostics(buildDiagnostics("storeWalletSecurely", err));
            return;
        }

        try {
            await connectAfterStore();
        } catch (firstErr: any) {
            console.warn("[wallet] connectAfterStore first attempt failed (import), retrying:", firstErr);
            await new Promise((resolve) => setTimeout(resolve, 250));
            try {
                await connectAfterStore();
            } catch (secondErr: any) {
                console.error("[wallet] connectAfterStore retry failed (import):", secondErr);
                setError("Wallet was imported, but we could not connect it automatically. Re-open this menu to try again.");
                setDiagnostics(buildDiagnostics("connectAfterStore (retry, import)", secondErr));
            }
        }

        // The user brought their own secret to import, so they obviously
        // have a backup of it elsewhere — auto-mark as backed up so they
        // don't get pestered by the banner.
        try {
            await markWalletBackedUp();
            setBackedUp(true);
        } catch {
            // non-fatal
        }
    };

    const handleDisconnect = useCallback(async () => {
        try {
            await disconnect();
            await removeWalletSecurely();
            onClose();
        } catch (err) {
            console.error(err);
        }
    }, [disconnect, onClose]);

    const handleCopy = useCallback(() => {
        if (!publicKey) return;
        navigator.clipboard.writeText(publicKey.toBase58());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [publicKey]);

    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [onClose]);

    return (
        <div className="sakura-wallet-overlay" onClick={onClose}>
            <div className="sakura-wallet-modal" onClick={e => e.stopPropagation()}>
                <div className="swm-petals">
                    <span className="swm-petal" style={{ top: '-6px', left: '20%', animationDelay: '0s' }}>🌸</span>
                    <span className="swm-petal" style={{ top: '-8px', right: '15%', animationDelay: '0.5s' }}>🌸</span>
                    <span className="swm-petal" style={{ bottom: '-6px', left: '40%', animationDelay: '1s' }}>🌸</span>
                </div>

                <button className="swm-close" onClick={onClose}>✕</button>

                {connected && publicKey ? (
                    <div className="swm-connected">
                        <div className="swm-avatar">
                            <LottieIcon src="/icons/wired-outline-421-wallet-purse-hover-pinch.json" size={40} colorFilter="brightness(0) saturate(100%) invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg) brightness(101%) contrast(98%)" replayIntervalMs={3000} autoplay />
                        </div>
                        <h2 className="swm-title">接続済み — Connected</h2>
                        <p className="swm-subtitle">Sakura Native Wallet</p>
                        <span style={{ display: 'inline-block', fontSize: 10, background: 'rgba(0,200,83,0.15)', color: '#00c853', padding: '2px 8px', borderRadius: 20, marginBottom: 8 }}>
                            Solana {SOLANA_NETWORK}
                        </span>

                        {backedUp === false && (
                            <div className="swm-backup-banner">
                                <span className="swm-backup-banner-title">⚠️ Back up your secret key</span>
                                <span className="swm-backup-banner-body">
                                    Sakura cannot recover this wallet for you. If your phone is lost, reset, or the
                                    app is uninstalled, your funds are unspendable forever. Tap below to view and
                                    save your key now.
                                </span>
                                <button
                                    className="swm-backup-banner-cta"
                                    onClick={handleRevealSecret}
                                    disabled={revealLoading}
                                >
                                    {revealLoading ? "Authenticating…" : "Show & save my secret key"}
                                </button>
                                {revealError && <span className="swm-backup-banner-err">{revealError}</span>}
                            </div>
                        )}

                        <div className="swm-address-card" onClick={handleCopy}>
                            <span className="swm-address">{truncateAddress(publicKey.toBase58())}</span>
                            <span className="swm-copy-hint">{copied ? "✓ Copied!" : "📋 Tap to copy"}</span>
                        </div>

                        <div className="swm-balance">
                            <span className="swm-balance-amount">◎ {balance !== null ? balance.toFixed(4) : '...'}</span>
                            <span className="swm-balance-label">SOL</span>
                        </div>

                        <div className="swm-balance" style={{ marginTop: '8px', background: 'rgba(255, 105, 180, 0.1)', borderColor: 'rgba(255, 105, 180, 0.3)' }}>
                            <span className="swm-balance-amount" style={{ color: 'var(--sakura-pink)' }}>🌸 {sakuraBalance !== null ? sakuraBalance.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '...'}</span>
                            <span className="swm-balance-label" style={{ color: 'var(--sakura-pink)' }}>$SAKURA</span>
                        </div>

                        <button
                            onClick={() => { setBalanceLoading(true); fetchBalances(); setTimeout(() => setBalanceLoading(false), 1500); }}
                            disabled={balanceLoading}
                            style={{
                                marginTop: 8, padding: '6px 16px', fontSize: 12,
                                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: 8, color: 'var(--text-muted)', cursor: 'pointer',
                                opacity: balanceLoading ? 0.5 : 1, width: '100%'
                            }}
                        >
                            {balanceLoading ? 'Refreshing...' : '↻ Refresh Balances'}
                        </button>

                        {(SOLANA_NETWORK as string) === 'mainnet-beta' && (
                            <>
                                <button
                                    className="bsm-buy-btn"
                                    onClick={() => setShowBuySakura(true)}
                                    style={{ marginTop: 16, width: '100%' }}
                                >
                                    <span className="bsm-buy-btn-icon">🌸</span>
                                    Buy $SAKURA
                                </button>
                                <button
                                    className="btn-secondary"
                                    onClick={() => setShowDonate(true)}
                                    style={{ marginTop: 8, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                >
                                    <span>🌸</span>
                                    Support Sakura
                                </button>
                                <button
                                    className="btn-secondary"
                                    onClick={() => { onClose(); router.push('/trade'); }}
                                    style={{ marginTop: 8, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                                >
                                    <LottieIcon src="/icons/wired-outline-2611-sales-hover-pinch.json" size={22} playOnMount />
                                    Trade Phoenix SOL-PERP
                                </button>
                            </>
                        )}

                        {showDonate && (
                            <TipModal
                                onClose={() => setShowDonate(false)}
                                header="Support Sakura"
                                subtitle="Donate $SAKURA to the Sakura treasury"
                                onComplete={() => fetchBalances()}
                            />
                        )}

                        {showBuySakura && (
                            <BuySakuraModal
                                onClose={() => setShowBuySakura(false)}
                                solBalance={balance ?? 0}
                                onComplete={() => fetchBalances()}
                            />
                        )}

                        {backedUp !== false && (
                            <button
                                className="btn-secondary"
                                onClick={handleRevealSecret}
                                disabled={revealLoading}
                                style={{ marginTop: 8, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                            >
                                <span>🔐</span>
                                {revealLoading ? "Authenticating…" : "Show / re-export secret key"}
                            </button>
                        )}
                        {revealError && backedUp !== false && (
                            <div className="swm-error" style={{ marginTop: 8 }}>{revealError}</div>
                        )}

                        <button className="swm-disconnect-btn" onClick={handleDisconnect}>
                            削除して切断 — Delete & Disconnect
                        </button>
                    </div>
                ) : (
                    <div className="swm-select">
                        <div className="swm-header-icon">
                            <LottieIcon src="/icons/wired-outline-421-wallet-purse-hover-pinch.json" size={48} colorFilter="brightness(0) saturate(100%) invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg) brightness(101%) contrast(98%)" replayIntervalMs={3000} autoplay />
                        </div>
                        <h2 className="swm-title">{t("wallet.signIn")}</h2>
                        <p className="swm-subtitle">Create or import a Sakura wallet.</p>

                        {error && (
                            <div className="swm-error">
                                <span>⚠️ {error}</span>
                                {diagnostics && (
                                    <button
                                        type="button"
                                        onClick={handleCopyDiagnostics}
                                        style={{
                                            marginTop: 8,
                                            alignSelf: "flex-start",
                                            background: "rgba(255,255,255,0.08)",
                                            border: "1px solid rgba(255,255,255,0.15)",
                                            color: "#fff",
                                            padding: "6px 12px",
                                            borderRadius: 8,
                                            fontSize: 12,
                                            cursor: "pointer",
                                        }}
                                    >
                                        {diagnosticsCopied ? "✓ Copied diagnostics" : "Copy diagnostics"}
                                    </button>
                                )}
                            </div>
                        )}

                        {isImporting ? (
                            <div className="swm-import-section" style={{ marginTop: '20px' }}>
                                <input
                                    className="swm-import-input"
                                    style={{
                                        width: '100%',
                                        padding: '12px',
                                        borderRadius: '12px',
                                        border: '1px solid rgba(255,183,197, 0.3)',
                                        background: 'rgba(0,0,0,0.2)',
                                        color: '#fff',
                                        outline: 'none',
                                        fontFamily: 'monospace'
                                    }}
                                    placeholder="Paste Base58 Secret Key..."
                                    value={importKey}
                                    onChange={(e) => setImportKey(e.target.value)}
                                    autoFocus
                                />
                                <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                                    <button className="swm-wallet-btn" style={{ flex: 1, padding: '10px', justifyContent: 'center' }} onClick={() => setIsImporting(false)}>
                                        Cancel
                                    </button>
                                    <button
                                        className="swm-wallet-btn swm-wallet-btn-hero"
                                        style={{ flex: 1, padding: '10px', justifyContent: 'center' }}
                                        onClick={handleImportWallet}
                                        disabled={!importKey.trim()}
                                    >
                                        Import
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="swm-section" style={{ marginTop: '20px' }}>
                                <button className="swm-wallet-btn swm-wallet-btn-hero" onClick={handleCreateWallet} disabled={isGenerating}>
                                    <span className="swm-wallet-emoji">✨</span>
                                    <div className="swm-wallet-info">
                                        <span className="swm-wallet-name">Create New Wallet</span>
                                        <span className="swm-wallet-tag">Instant Solana wallet</span>
                                    </div>
                                </button>
                                <button className="swm-wallet-btn" onClick={() => setIsImporting(true)}>
                                    <span className="swm-wallet-emoji">🔑</span>
                                    <div className="swm-wallet-info">
                                        <span className="swm-wallet-name">Import Existing</span>
                                        <span className="swm-wallet-tag">Paste a secret key</span>
                                    </div>
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {(mandatorySecret || revealedSecret) && (
                    <BackupSecretSheet
                        secret={(mandatorySecret || revealedSecret)!}
                        mandatory={!!mandatorySecret}
                        onAcknowledge={handleAcknowledgeBackup}
                        onClose={() => {
                            // Optional reveal: just close. Mandatory: noop —
                            // the user must explicitly tap "I've saved it".
                            if (mandatorySecret) return;
                            setRevealedSecret(null);
                        }}
                    />
                )}
            </div>
        </div>
    );
}

function BackupSecretSheet({
    secret,
    mandatory,
    onAcknowledge,
    onClose,
}: {
    secret: string;
    mandatory: boolean;
    onAcknowledge: () => void;
    onClose: () => void;
}) {
    const [copied, setCopied] = useState(false);
    const [revealedHint, setRevealedHint] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard API can be flaky in WebView; fall back to a manual
            // selection by toggling reveal so the user can long-press copy.
            setRevealedHint(true);
        }
    };

    return (
        <div className="swm-backup-sheet-bg" onClick={mandatory ? undefined : onClose}>
            <div className="swm-backup-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="swm-backup-warn">
                    <span className="swm-backup-warn-icon">⚠️</span>
                    <div>
                        <div className="swm-backup-warn-title">
                            {mandatory ? "Save this NOW. You will not see it again automatically." : "Your wallet secret key"}
                        </div>
                        <div className="swm-backup-warn-body">
                            Anyone with this key controls your wallet. Save it in a password manager
                            or write it on paper. Sakura cannot help you recover funds if it&apos;s lost.
                        </div>
                    </div>
                </div>

                <div className="swm-backup-secret">{secret}</div>
                {revealedHint && (
                    <div className="swm-backup-hint">
                        Clipboard blocked — long-press the box above and use Copy.
                    </div>
                )}

                <div className="swm-backup-actions">
                    <button className="swm-backup-copy" onClick={handleCopy}>
                        {copied ? "✓ Copied" : "📋 Copy to clipboard"}
                    </button>
                </div>

                <label className="swm-backup-check">
                    <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                    <span>I&apos;ve saved this somewhere only I can access. I understand Sakura cannot recover it.</span>
                </label>

                <div className="swm-backup-cta-row">
                    {!mandatory && (
                        <button className="swm-backup-cta-secondary" onClick={onClose}>
                            Close
                        </button>
                    )}
                    <button
                        className="swm-backup-cta"
                        disabled={!acknowledged}
                        onClick={onAcknowledge}
                    >
                        I&apos;ve saved my key
                    </button>
                </div>
            </div>
        </div>
    );
}
