"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { handlePhoenixWalletRequest, type PhoenixWalletRequest } from "@/lib/phoenix-wallet-bridge";
import { useSakuraWalletModal } from "./SakuraWalletModal";

interface ElectronPhoenixBridge {
    onPhoenixWalletRequest?: (
        handler: (request: PhoenixWalletRequest) => void,
    ) => () => void;
    respondPhoenixWallet?: (
        requestId: string,
        result: unknown,
        error: string | null,
    ) => Promise<void>;
}

export default function PhoenixBridgeProvider({ children }: { children: React.ReactNode }) {
    const wallet = useWallet();
    const { setVisible } = useSakuraWalletModal();
    const walletRef = useRef(wallet);
    walletRef.current = wallet;

    useEffect(() => {
        const api = (window as unknown as { electronAPI?: ElectronPhoenixBridge }).electronAPI;
        if (!api?.onPhoenixWalletRequest || !api.respondPhoenixWallet) return;

        const unsubscribe = api.onPhoenixWalletRequest(async (request) => {
            try {
                if (request.method === "connect" && !walletRef.current.connected) {
                    setVisible(true);
                }
                const result = await handlePhoenixWalletRequest(request, walletRef.current);
                await api.respondPhoenixWallet!(request.requestId, result, null);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : "Wallet request failed";
                await api.respondPhoenixWallet!(request.requestId, null, message);
            }
        });

        return unsubscribe;
    }, [setVisible]);

    return <>{children}</>;
}
