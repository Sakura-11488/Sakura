"use client";

import { useRouter } from "next/navigation";

export default function BackButton() {
    const router = useRouter();
    return (
        <button
            className="page-back-btn"
            onClick={() => router.back()}
            aria-label="Go back"
        >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
            </svg>
        </button>
    );
}
