"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";

const animCache = new Map<string, object>();

interface LottieIconProps {
    src?: string;
    animationData?: object;
    size?: number;
    colorFilter?: string;
    autoplay?: boolean;
    playOnMount?: boolean;
    replayIntervalMs?: number;
}

export default function LottieIcon({
    src,
    animationData,
    size = 24,
    colorFilter,
    autoplay = false,
    playOnMount = false,
    replayIntervalMs,
}: LottieIconProps) {
    const lottieRef = useRef<LottieRefCurrentProps>(null);
    const [animData, setAnimData] = useState<object | null>(() => {
        if (animationData) return animationData;
        if (src && animCache.has(src)) return animCache.get(src)!;
        return null;
    });

    useEffect(() => {
        if (animationData) {
            setAnimData(animationData);
            return;
        }
        if (!src) return;
        if (animCache.has(src)) {
            setAnimData(animCache.get(src)!);
            return;
        }
        fetch(src)
            .then(r => r.json())
            .then(data => {
                animCache.set(src, data);
                setAnimData(data);
            })
            .catch(() => {});
    }, [src, animationData]);

    useEffect(() => {
        if (playOnMount && animData && lottieRef.current) {
            lottieRef.current.goToAndPlay(0);
        }
    }, [playOnMount, animData]);

    useEffect(() => {
        if (!replayIntervalMs || !animData) return;
        const id = setInterval(() => {
            lottieRef.current?.goToAndPlay(0);
        }, replayIntervalMs);
        return () => clearInterval(id);
    }, [replayIntervalMs, animData]);

    const play = useCallback(() => {
        lottieRef.current?.goToAndPlay(0);
    }, []);

    if (!animData) return <div style={{ width: size, height: size }} />;

    return (
        <div
            onClick={play}
            style={{
                width: size,
                height: size,
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
                autoplay={autoplay}
                style={{
                    width: size,
                    height: size,
                    filter: colorFilter,
                }}
            />
        </div>
    );
}
