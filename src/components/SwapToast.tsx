"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";

interface SwapToastData {
    state: "pending" | "success" | "error";
    amountIn?: string;
    amountOut?: string;
    tokenIn?: string;
    tokenOut?: string;
    txid?: string;
    error?: string;
}

interface SwapToastContextType {
    show: (data: SwapToastData) => void;
    update: (data: Partial<SwapToastData>) => void;
    dismiss: () => void;
}

const SwapToastContext = createContext<SwapToastContextType>({
    show: () => {},
    update: () => {},
    dismiss: () => {},
});

export function useSwapToast() {
    return useContext(SwapToastContext);
}

const SOLSCAN_BASE = "https://solscan.io/tx";

function truncateTx(tx: string) {
    if (tx.length <= 16) return tx;
    return `${tx.slice(0, 8)}...${tx.slice(-8)}`;
}

export function SwapToastProvider({ children }: { children: React.ReactNode }) {
    const [toast, setToast] = useState<SwapToastData | null>(null);
    const [visible, setVisible] = useState(false);
    const [exiting, setExiting] = useState(false);

    const dismiss = useCallback(() => {
        setExiting(true);
        setTimeout(() => {
            setToast(null);
            setVisible(false);
            setExiting(false);
        }, 350);
    }, []);

    const show = useCallback((data: SwapToastData) => {
        setExiting(false);
        setToast(data);
        setVisible(true);
    }, []);

    const update = useCallback((data: Partial<SwapToastData>) => {
        setToast(prev => prev ? { ...prev, ...data } : null);
    }, []);

    useEffect(() => {
        if (!toast || toast.state === "pending") return;
        const timer = setTimeout(dismiss, 6000);
        return () => clearTimeout(timer);
    }, [toast?.state, dismiss]);

    return (
        <SwapToastContext.Provider value={{ show, update, dismiss }}>
            {children}
            {visible && toast && (
                <div className={`swap-toast-container ${exiting ? "exiting" : ""}`}>
                    <div className="swap-toast" onClick={toast.state !== "pending" ? dismiss : undefined}>
                        {/* Left icon */}
                        <div className={`swap-toast-icon ${toast.state}`}>
                            {toast.state === "pending" && (
                                <div className="swap-toast-spinner" />
                            )}
                            {toast.state === "success" && (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            )}
                            {toast.state === "error" && (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            )}
                        </div>

                        {/* Content */}
                        <div className="swap-toast-body">
                            <div className="swap-toast-title">
                                {toast.state === "pending" && "Confirming Swap..."}
                                {toast.state === "success" && "Swap Confirmed"}
                                {toast.state === "error" && "Swap Failed"}
                            </div>

                            {toast.state === "success" && toast.amountIn && toast.amountOut && (
                                <div className="swap-toast-amounts">
                                    <span className="swap-toast-out">−{toast.amountIn} {toast.tokenIn || "SOL"}</span>
                                    <svg className="swap-toast-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="5" y1="12" x2="19" y2="12" />
                                        <polyline points="12 5 19 12 12 19" />
                                    </svg>
                                    <span className="swap-toast-in">+{toast.amountOut} {toast.tokenOut || "$SAKURA"}</span>
                                </div>
                            )}

                            {toast.state === "error" && toast.error && (
                                <div className="swap-toast-error-msg">{toast.error}</div>
                            )}

                            {toast.state === "success" && toast.txid && (
                                <a
                                    className="swap-toast-tx"
                                    href={`${SOLSCAN_BASE}/${toast.txid}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                >
                                    {truncateTx(toast.txid)} ↗
                                </a>
                            )}

                            {toast.state === "pending" && (
                                <div className="swap-toast-sub">Waiting for confirmation on Solana...</div>
                            )}
                        </div>

                        {/* Dismiss button — pending toasts also dismissable
                            so the user can clear the UI if a swap is taking
                            forever; the on-chain transaction continues
                            independently. */}
                        <button
                            className="swap-toast-close"
                            onClick={(e) => { e.stopPropagation(); dismiss(); }}
                            aria-label="Dismiss"
                        >
                            ×
                        </button>
                    </div>
                </div>
            )}
        </SwapToastContext.Provider>
    );
}
