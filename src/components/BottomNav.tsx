"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useEffect, useState, useCallback } from "react";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";

interface Tab {
    href: string;
    label: string;
    lottieFile: string;
}

const tabs: Tab[] = [
    { href: "/", label: "Home", lottieFile: "/icons/wired-outline-1652-mortgage-loan-hover-pinch.json" },
    { href: "/novel", label: "Novel", lottieFile: "/icons/wired-outline-471-ebook-reader-hover-pinch.json" },
    { href: "/anime", label: "Anime", lottieFile: "/icons/wired-outline-2440-goku-hover-pinch.json" },
    { href: "/library", label: "Library", lottieFile: "/icons/wired-outline-3140-book-open-hover-pinch.json" },
    { href: "/settings", label: "Settings", lottieFile: "/icons/wired-outline-39-cog-hover-mechanic.json" },
];

const HIDDEN_PATHS = ["/chapter", "/anime/watch", "/novel/read"];

function NavIcon({ tab, isActive }: { tab: Tab; isActive: boolean }) {
    const lottieRef = useRef<LottieRefCurrentProps>(null);
    const [animData, setAnimData] = useState<object | null>(null);

    useEffect(() => {
        fetch(tab.lottieFile)
            .then(r => r.json())
            .then(setAnimData)
            .catch(() => {});
    }, [tab.lottieFile]);

    useEffect(() => {
        if (isActive && lottieRef.current) {
            lottieRef.current.goToAndPlay(0);
        }
    }, [isActive]);

    const handleClick = useCallback(() => {
        if (lottieRef.current) {
            lottieRef.current.goToAndPlay(0);
        }
    }, []);

    if (!animData) return <div style={{ width: 24, height: 24 }} />;

    return (
        <div
            onClick={handleClick}
            style={{
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                flexShrink: 0,
            }}
        >
            <Lottie
                lottieRef={lottieRef}
                animationData={animData}
                loop={false}
                autoplay={false}
                style={{
                    width: 24,
                    height: 24,
                    filter: isActive
                        ? "brightness(0) saturate(100%) invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg) brightness(101%) contrast(98%)"
                        : "brightness(0) invert(1) opacity(0.4)",
                }}
            />
        </div>
    );
}

export default function BottomNav() {
    const pathname = usePathname();

    if (HIDDEN_PATHS.some(p => pathname.startsWith(p))) {
        return null;
    }

    return (
        <nav className="bottom-nav">
            {tabs.map((tab) => {
                const isActive = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        className={`bottom-nav-item ${isActive ? "active" : ""}`}
                    >
                        <span className="bottom-nav-icon">
                            <NavIcon tab={tab} isActive={isActive} />
                        </span>
                        <span className="bottom-nav-label">{tab.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
