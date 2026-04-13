"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { getLocal, STORAGE_KEYS } from "@/lib/storage";
import { fetchPositions, type PositionInfo } from "@/lib/perps-api";

export default function FloatingTradeWidget() {
    const pathname = usePathname();
    const router = useRouter();
    const { publicKey, connected } = useWallet();

    const isReadingPage = pathname?.startsWith("/chapter") || pathname?.startsWith("/anime/watch") || pathname?.startsWith("/novel/read");
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        const settings = getLocal<any>(STORAGE_KEYS.SETTINGS, {});
        setEnabled(!!settings.pnlTracker);
    }, [pathname]);

    const isVisible = isReadingPage && enabled;

    const [pnl, setPnl] = useState(0);
    const [hasRealPosition, setHasRealPosition] = useState(false);
    const [flash, setFlash] = useState<"up" | "down" | null>(null);
    const [entryPrice, setEntryPrice] = useState<number | null>(null);
    const LEVERAGE = 10;

    // Try to load real position PnL from backend
    useEffect(() => {
        if (!isVisible || !connected || !publicKey) {
            setHasRealPosition(false);
            return;
        }

        let isMounted = true;
        const wallet = publicKey.toBase58();

        const loadPosition = async () => {
            try {
                const data = await fetchPositions(wallet);
                if (!isMounted) return;

                if (data.position && data.position.hasPosition) {
                    setHasRealPosition(true);
                    const newPnl = data.position.pnlPercent;
                    setPnl((prev) => {
                        if (prev !== newPnl) {
                            setFlash(newPnl > prev ? "up" : "down");
                            setTimeout(() => setFlash(null), 300);
                        }
                        return newPnl;
                    });
                } else {
                    setHasRealPosition(false);
                }
            } catch {
                setHasRealPosition(false);
            }
        };

        loadPosition();
        const interval = setInterval(loadPosition, 8000);

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [isVisible, connected, publicKey]);

    // Fallback: simulated PnL from CoinGecko spot price when no real position
    useEffect(() => {
        if (!isVisible || hasRealPosition) return;
        let isMounted = true;

        const updatePrice = async () => {
            try {
                const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                if (!res.ok) return;
                const data = await res.json();
                if (!isMounted || !data.solana) return;

                const currentPrice = data.solana.usd;

                setEntryPrice((prevEntry) => {
                    const entry = prevEntry || currentPrice;
                    const jitter = (Math.random() - 0.5) * 0.02;
                    const displayPrice = currentPrice + jitter;
                    const priceDelta = displayPrice - entry;
                    const pnlPercent = (priceDelta / entry) * 100 * LEVERAGE;

                    setPnl((prevPnl) => {
                        if (prevPnl !== pnlPercent) {
                            setFlash(pnlPercent > prevPnl ? "up" : "down");
                            setTimeout(() => setFlash(null), 300);
                        }
                        return pnlPercent;
                    });

                    return entry;
                });
            } catch (err) {
                console.error("Widget price fetch failed", err);
            }
        };

        updatePrice();
        const interval = setInterval(updatePrice, 3500);

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [isVisible, hasRealPosition]);

    if (!isVisible) return null;

    const isProfit = pnl >= 0;

    return (
        <div
            className={`floating-trade-widget ${isProfit ? "profit" : "loss"} ${flash ? `flash-${flash}` : ""}`}
            onClick={() => router.push("/trade")}
            title={hasRealPosition ? "Real position PnL" : "Go to Trading"}
        >
            <div className="ftw-icon">◎</div>
            <div className="ftw-pnl">
                {isProfit ? "+" : ""}{pnl.toFixed(2)}%
            </div>
            {hasRealPosition && <div className="ftw-live-dot" />}
            <div className="ftw-glow" />
        </div>
    );
}
