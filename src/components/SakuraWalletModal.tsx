"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { truncateAddress, getConnection, SAKURA_MINT, SOLANA_NETWORK } from "@/lib/solana";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { generateWallet, storeWalletSecurely, removeWalletSecurely } from "@/lib/wallet";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const BuySakuraModal = dynamic(() => import("@/components/BuySakuraModal"), { ssr: false });
const TipModal = dynamic(() => import("@/components/TipModal"), { ssr: false });
import LottieIcon from "@/components/LottieIcon";

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
    const [balance, setBalance] = useState<number | null>(null);
    const [sakuraBalance, setSakuraBalance] = useState<number | null>(null);

    const [showBuySakura, setShowBuySakura] = useState(false);
    const [showDonate, setShowDonate] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importKey, setImportKey] = useState("");

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
        try {
            setError(null);
            setIsGenerating(true);

            const newKeypair = generateWallet();
            await storeWalletSecurely(newKeypair);
            await connectAfterStore();
        } catch (err: any) {
            console.error("Wallet generation error:", err);
            setError(err?.message || "Failed to create wallet");
        } finally {
            setIsGenerating(false);
        }
    };

    const handleImportWallet = async () => {
        try {
            setError(null);
            if (!importKey) return;

            let keypair: Keypair;
            try {
                const secretKey = bs58.decode(importKey.trim());
                keypair = Keypair.fromSecretKey(secretKey);
            } catch (e) {
                throw new Error("Invalid Secret Key format (must be Base58)");
            }

            await storeWalletSecurely(keypair);
            await connectAfterStore();
        } catch (err: any) {
            console.error("Wallet import error:", err);
            setError(err?.message || "Failed to import wallet");
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
                                    Trade SOL-PERP
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

                        <button className="swm-disconnect-btn" onClick={handleDisconnect}>
                            削除して切断 — Delete & Disconnect
                        </button>
                    </div>
                ) : (
                    <div className="swm-select">
                        <div className="swm-header-icon">
                            <LottieIcon src="/icons/wired-outline-421-wallet-purse-hover-pinch.json" size={48} colorFilter="brightness(0) saturate(100%) invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg) brightness(101%) contrast(98%)" replayIntervalMs={3000} autoplay />
                        </div>
                        <h2 className="swm-title">Sign Up / Login</h2>
                        <p className="swm-subtitle">Create or import a Sakura wallet.</p>

                        {error && (
                            <div className="swm-error">
                                <span>⚠️ {error}</span>
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
            </div>
        </div>
    );
}
