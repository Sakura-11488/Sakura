"use client";

import { useSakuraAI } from "./SakuraAIModal";

/**
 * Pinned top-of-home launcher for Sakura AI. Visually distinct sakura-pink
 * gradient with the 桜 mark so it pulls focus over the hero banner.
 */
export default function SakuraAIButton() {
    const { setVisible } = useSakuraAI();
    return (
        <button
            type="button"
            className="sai-launcher"
            onClick={() => setVisible(true)}
            aria-label="Open Sakura AI"
        >
            <span className="sai-launcher-glow" aria-hidden />
            <span className="sai-launcher-mark" aria-hidden>桜</span>
            <span className="sai-launcher-body">
                <span className="sai-launcher-title">
                    Sakura AI
                    <span className="sai-launcher-beta">BETA</span>
                </span>
                <span className="sai-launcher-sub">Trade, transfer, bridge — by chat</span>
            </span>
            <span className="sai-launcher-arrow" aria-hidden>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                </svg>
            </span>
        </button>
    );
}
