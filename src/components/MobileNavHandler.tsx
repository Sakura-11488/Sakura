"use client";

import { useEffect, useRef } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useRouter, usePathname } from "next/navigation";
import { SAKURA_SHARE_BASE } from "@/lib/share";

const ALLOWED_IN_APP_PATHS = new Set([
    "/anime/details",
    "/anime/watch",
    "/title",
    "/novel/details",
]);

function normalizeShareHost(host: string): string {
    return host.replace(/^www\./i, "").toLowerCase();
}

function getExpectedDeepLinkHost(): string {
    try {
        return normalizeShareHost(new URL(SAKURA_SHARE_BASE).hostname);
    } catch {
        return "sakuraonseeker.com";
    }
}

/** Returns in-app route like `/anime/details?id=...` or null if not a gated share/deep link. */
export function resolveSakuraDeepLinkRoute(rawUrl: string): string | null {
    if (!rawUrl?.trim()) return null;
    try {
        const u = new URL(rawUrl);
        const expected = getExpectedDeepLinkHost();
        if (normalizeShareHost(u.hostname) !== expected) return null;

        let path = u.pathname || "/";
        if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

        if (!ALLOWED_IN_APP_PATHS.has(path)) return null;

        const search = u.search || "";
        return `${path}${search}`;
    } catch {
        return null;
    }
}

function navigateToDeepLink(router: ReturnType<typeof useRouter>, route: string) {
    router.push(route);
}

export default function MobileNavHandler() {
    const router = useRouter();
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);

    // Keep ref in sync
    useEffect(() => {
        pathnameRef.current = pathname;
    }, [pathname]);

    useEffect(() => {
        if (!Capacitor.isNativePlatform()) return;

        const applyDeepLink = (raw: string | undefined) => {
            const route = raw ? resolveSakuraDeepLinkRoute(raw) : null;
            if (!route) return;
            if (typeof window !== "undefined") {
                const current = `${window.location.pathname}${window.location.search}`;
                if (current === route) return;
            }
            navigateToDeepLink(router, route);
        };

        let appUrlSub: { remove: () => Promise<void> } | undefined;

        void App.getLaunchUrl()
            .then(res => applyDeepLink(res?.url))
            .catch(() => undefined);

        void App.addListener("appUrlOpen", event => {
            applyDeepLink(event?.url);
        }).then(handle => {
            appUrlSub = handle;
        });

        return () => {
            void appUrlSub?.remove();
        };
    }, [router]);

    useEffect(() => {
        const handleBackButton = async () => {
            if (pathnameRef.current === "/") {
                await App.exitApp();
            } else {
                // Use window.history for reliable back navigation
                if (window.history.length > 1) {
                    router.back();
                } else if (pathnameRef.current === "/downloads") {
                    router.push("/settings");
                } else {
                    // Fallback to home
                    router.push("/");
                }
            }
        };

        const listener = App.addListener("backButton", handleBackButton);

        return () => {
            listener.then(l => l.remove());
        };
    }, [router]);

    return null;
}
