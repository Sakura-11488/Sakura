"use client";

import Link from "next/link";
import { memo, useEffect, useState } from "react";
import { imageOrPlaceholder, SAKURA_PLACEHOLDER_IMAGE } from "@/lib/media-fallback";

interface MangaCardProps {
    slug: string;
    title: string;
    cover: string;
    genres: string[];
    chapterCount?: number;
    latestChapter?: number;
    follows?: number;
    rating?: number;
    source?: string;
}

const MangaCard = memo(function MangaCard({
    slug,
    title,
    cover,
    genres,
    chapterCount,
    follows,
    rating,
    source
}: MangaCardProps) {
    const [imgSrc, setImgSrc] = useState(() => imageOrPlaceholder(cover));

    useEffect(() => {
        setImgSrc(imageOrPlaceholder(cover));
    }, [cover]);

    return (
        <Link href={`/title?id=${slug}&source=${source || 'atsumaru'}`} className="manga-card">
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
                    {/* Removed source badge based on user request to make it cleaner */}
                    {follows ? (
                        <span>♥ {follows.toLocaleString()}</span>
                    ) : chapterCount ? (
                        <span>{chapterCount} chapters</span>
                    ) : null}
                </div>
            </div>
            <div className="manga-card-info">
                <h3 className="manga-card-title">{title}</h3>
                <div className="manga-card-meta">
                    {rating && (
                        <span style={{ color: "var(--gold)", fontWeight: "bold", marginRight: 8 }}>
                            ★ {rating.toFixed(1)}
                        </span>
                    )}
                    {genres.slice(0, 3).map((g) => (
                        <span key={g} className="manga-card-genre">{g}</span>
                    ))}
                </div>
            </div>
        </Link>
    );
});

export default MangaCard;
