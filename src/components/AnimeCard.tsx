"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { imageOrPlaceholder, SAKURA_PLACEHOLDER_IMAGE } from "@/lib/media-fallback";

interface AnimeCardProps {
    id: string;
    title: string;
    image?: string;
    type?: string;
    year?: number | null;
    showMeta?: boolean;
}

export default function AnimeCard({ id, title, image, type, year, showMeta }: AnimeCardProps) {
    const [imgSrc, setImgSrc] = useState(() => imageOrPlaceholder(image));
    const metaParts: string[] = [];
    if (showMeta) {
        if (type) metaParts.push(type);
        if (year) metaParts.push(String(year));
    }

    useEffect(() => {
        setImgSrc(imageOrPlaceholder(image));
    }, [image]);

    return (
        <Link href={`/anime/details?id=${encodeURIComponent(id)}`} className="manga-card">
            <div className="manga-card-cover">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={imgSrc}
                    alt={title}
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setImgSrc(SAKURA_PLACEHOLDER_IMAGE)}
                />
                <div className="manga-card-badge">
                    <span>▶ {type || "TV"}</span>
                </div>
            </div>
            <div className="manga-card-info">
                <h3 className="manga-card-title">{title}</h3>
                {metaParts.length > 0 && (
                    <div className="manga-card-meta">{metaParts.join(" · ")}</div>
                )}
            </div>
        </Link>
    );
}
