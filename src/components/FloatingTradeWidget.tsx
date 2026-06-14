"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { getLocal, STORAGE_KEYS } from "@/lib/storage";
import { fetchPhoenixMarketState, fetchPhoenixTraderData } from "@/lib/phoenix";

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

    // Load live Phoenix position PnL for the floating reader widget.
    useEffect(() => {
        if (!isVisible || !connected || !publicKey) {
            setHasRealPosition(false);
            return;
        }

        let isMounted = true;
        const wallet = publicKey.toBase58();

        const loadPosition = async () => {
            try {
                const market = await fetchPhoenixMarketState();
                const data = await fetchPhoenixTraderData(wallet, market.markPrice);
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

    if (!isVisible) return null;

    const isProfit = pnl >= 0;

    return (
        <div
            className={`floating-trade-widget ${isProfit ? "profit" : "loss"} ${flash ? `flash-${flash}` : ""}`}
            onClick={() => router.push("/trade")}
            title={hasRealPosition ? "Phoenix position PnL" : "Go to Phoenix Trading"}
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
