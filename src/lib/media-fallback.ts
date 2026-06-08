export const SAKURA_PLACEHOLDER_IMAGE = "/sakura-placeholder.svg";

export function isMissingOrPlaceholderImage(src?: string | null): boolean {
    if (!src) return true;
    return src === "/placeholder.png" || src === "/sakura.png";
}

export function imageOrPlaceholder(src?: string | null): string {
    return isMissingOrPlaceholderImage(src) ? SAKURA_PLACEHOLDER_IMAGE : src!;
}
