"use client";

import { useEffect, useRef, type CSSProperties } from "react";

export type BannerKind = "error" | "info" | "success" | "pending";

interface DismissibleBannerProps {
    kind: BannerKind;
    children: React.ReactNode;
    onDismiss: () => void;
    autoDismissMs?: number | null;
    style?: CSSProperties;
}

const KIND_STYLES: Record<BannerKind, CSSProperties> = {
    error: {
        background: "rgba(239, 68, 68, 0.08)",
        border: "1px solid rgba(239, 68, 68, 0.32)",
        color: "#fca5a5",
    },
    info: {
        background: "rgba(96, 165, 250, 0.08)",
        border: "1px solid rgba(96, 165, 250, 0.28)",
        color: "#bfdbfe",
    },
    success: {
        background: "rgba(74, 222, 128, 0.08)",
        border: "1px solid rgba(74, 222, 128, 0.32)",
        color: "#bbf7d0",
    },
    pending: {
        background: "rgba(250, 204, 21, 0.08)",
        border: "1px solid rgba(250, 204, 21, 0.32)",
        color: "#fde68a",
    },
};

export default function DismissibleBanner({
    kind,
    children,
    onDismiss,
    autoDismissMs = 4000,
    style,
}: DismissibleBannerProps) {
    const dismissRef = useRef(onDismiss);
    dismissRef.current = onDismiss;

    useEffect(() => {
        if (autoDismissMs == null || autoDismissMs <= 0) return;
        // Pending banners stay visible until the caller clears them; for
        // info/error/success we auto-clear so they don't stack forever
        // when the creator is iterating quickly.
        const handle = window.setTimeout(() => {
            dismissRef.current?.();
        }, autoDismissMs);
        return () => window.clearTimeout(handle);
    }, [autoDismissMs]);

    return (
        <div
            role={kind === "error" ? "alert" : "status"}
            style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "12px 14px",
                borderRadius: 10,
                fontSize: 13,
                lineHeight: 1.5,
                ...KIND_STYLES[kind],
                ...style,
            }}
        >
            {kind === "pending" && (
                <span
                    aria-hidden
                    style={{
                        flexShrink: 0,
                        width: 12,
                        height: 12,
                        marginTop: 4,
                        borderRadius: "50%",
                        border: "2px solid rgba(250, 204, 21, 0.35)",
                        borderTopColor: "#facc15",
                        animation: "spin 0.9s linear infinite",
                    }}
                />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
            <button
                onClick={onDismiss}
                aria-label="Dismiss"
                style={{
                    flexShrink: 0,
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    opacity: 0.7,
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                }}
            >
                ✕
            </button>
        </div>
    );
}
