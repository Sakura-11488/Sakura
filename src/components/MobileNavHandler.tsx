"use client";

import { useEffect, useRef } from "react";
import { App } from "@capacitor/app";
import { useRouter, usePathname } from "next/navigation";

export default function MobileNavHandler() {
    const router = useRouter();
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);

    // Keep ref in sync
    useEffect(() => {
        pathnameRef.current = pathname;
    }, [pathname]);

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
