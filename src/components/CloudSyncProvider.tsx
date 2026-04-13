"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { pullAllFromCloud, pushAllToCloud } from "@/lib/cloud-sync";

export default function CloudSyncProvider() {
    const { publicKey, connected } = useWallet();
    const lastWallet = useRef<string | null>(null);

    useEffect(() => {
        const wallet = publicKey?.toBase58() || null;
        if (!connected || !wallet) {
            lastWallet.current = null;
            return;
        }

        if (wallet === lastWallet.current) return;
        lastWallet.current = wallet;

        (async () => {
            try {
                await pullAllFromCloud(wallet);
                await pushAllToCloud(wallet);
            } catch (e) {
                console.error("Cloud sync error:", e);
            }
        })();
    }, [connected, publicKey]);

    return null;
}
