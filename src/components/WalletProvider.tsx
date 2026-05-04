"use client";

import { useMemo, useEffect, useRef } from "react";
import {
    ConnectionProvider,
    WalletProvider,
    useWallet,
} from "@solana/wallet-adapter-react";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SakuraWalletModalProvider } from "./SakuraWalletModal";
import { SakuraAIProvider } from "./SakuraAIModal";
import { SwapToastProvider } from "./SwapToast";
import { RPC_ENDPOINT } from "@/lib/solana";
import { SakuraNativeWalletAdapter } from "@/lib/wallet-adapter";

// AutoConnects the Sakura Native Wallet silently if public key is stored
function WalletPersistence() {
    const { select, wallets, connected, connecting } = useWallet();
    const attempted = useRef(false);

    useEffect(() => {
        if (connected || connecting || wallets.length === 0 || attempted.current) return;

        // Only attempt once to prevent infinite render loops
        attempted.current = true;
        try {
            select(wallets[0].adapter.name);
        } catch {
            // Silently ignore - no wallet available
        }
    }, [wallets, select, connected, connecting]);

    return null;
}

export default function SolanaProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const wallets = useMemo(
        () => [new SakuraNativeWalletAdapter()],
        []
    );

    return (
        <ConnectionProvider endpoint={RPC_ENDPOINT}>
            <WalletProvider wallets={wallets} autoConnect>
                <SwapToastProvider>
                    <SakuraWalletModalProvider>
                        <SakuraAIProvider>
                            <WalletPersistence />
                            {children}
                        </SakuraAIProvider>
                    </SakuraWalletModalProvider>
                </SwapToastProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}
