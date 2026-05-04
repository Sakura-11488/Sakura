export const SAKURA_SHARE_BASE =
    (process.env.NEXT_PUBLIC_SAKURA_SHARE_BASE || "https://sakuraonseeker.com").replace(/\/+$/, "");

export type ShareTarget =
    | { kind: "anime"; id: string }
    | { kind: "manga"; id: string; source?: string }
    | { kind: "novel"; id?: string; source?: string; path?: string };

export function buildSakuraShareUrl(target: ShareTarget): string {
    const params = new URLSearchParams();

    if (target.kind === "anime") {
        params.set("id", target.id);
        return `${SAKURA_SHARE_BASE}/anime/details?${params.toString()}`;
    }

    if (target.kind === "manga") {
        params.set("id", target.id);
        if (target.source) params.set("source", target.source);
        return `${SAKURA_SHARE_BASE}/title?${params.toString()}`;
    }

    if (target.id) params.set("id", target.id);
    if (target.source) params.set("source", target.source);
    if (target.path) params.set("path", target.path);
    return `${SAKURA_SHARE_BASE}/novel/details?${params.toString()}`;
}

export async function shareOrCopyLink(args: {
    title: string;
    url: string;
    text?: string;
}): Promise<"shared" | "copied" | "unsupported"> {
    if (typeof navigator === "undefined") return "unsupported";
    if (navigator.share) {
        try {
            await navigator.share({
                title: args.title,
                text: args.text,
                url: args.url,
            });
            return "shared";
        } catch {
            // User-cancelled share sheets are not errors for the app.
            return "unsupported";
        }
    }
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(args.url);
        return "copied";
    }
    return "unsupported";
}
