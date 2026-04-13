import "server-only";

import { createHash } from "node:crypto";
import sharp, { type FitEnum } from "sharp";

import { sanitizeStorageName } from "@/lib/publishing";

export const SUPPORTED_IMAGE_CONTENT_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
] as const;

export type SupportedImageContentType = (typeof SUPPORTED_IMAGE_CONTENT_TYPES)[number];
export type ImageNormalizationPurpose = "cover" | "poster" | "manga_page" | "thumbnail";

export interface NormalizeImageInput {
    buffer: Buffer;
    filename: string;
    contentType: string;
    purpose: ImageNormalizationPurpose;
    keepOriginal?: boolean;
}

export interface NormalizedImageVariant {
    key: string;
    filename: string;
    contentType: "image/webp";
    buffer: Buffer;
    width: number;
    height: number;
    sizeBytes: number;
}

export interface NormalizedImageAsset {
    checksumSha256: string;
    original: {
        filename: string;
        contentType: string;
        sizeBytes: number;
        width: number;
        height: number;
        buffer?: Buffer;
    };
    variants: NormalizedImageVariant[];
}

interface VariantDefinition {
    key: string;
    width: number;
    height?: number;
    fit: keyof FitEnum;
    quality: number;
}

const PURPOSE_VARIANTS: Record<ImageNormalizationPurpose, VariantDefinition[]> = {
    cover: [
        { key: "thumb-card", width: 480, height: 720, fit: "cover", quality: 82 },
        { key: "detail", width: 1280, height: 1920, fit: "inside", quality: 84 },
        { key: "blur", width: 48, height: 72, fit: "cover", quality: 55 },
    ],
    poster: [
        { key: "thumb-card", width: 480, height: 720, fit: "cover", quality: 82 },
        { key: "detail", width: 1440, height: 2160, fit: "inside", quality: 84 },
        { key: "blur", width: 48, height: 72, fit: "cover", quality: 55 },
    ],
    thumbnail: [
        { key: "thumb-sm", width: 320, height: 320, fit: "cover", quality: 80 },
        { key: "thumb-md", width: 640, height: 640, fit: "cover", quality: 82 },
        { key: "blur", width: 32, height: 32, fit: "cover", quality: 50 },
    ],
    manga_page: [
        { key: "page-mobile", width: 1280, height: 2560, fit: "inside", quality: 82 },
        { key: "page-hd", width: 1800, height: 3200, fit: "inside", quality: 84 },
        { key: "preview", width: 480, height: 960, fit: "inside", quality: 75 },
    ],
};

export function isSupportedImageContentType(contentType: string): contentType is SupportedImageContentType {
    return SUPPORTED_IMAGE_CONTENT_TYPES.includes(contentType as SupportedImageContentType);
}

export async function normalizeImageAsset(input: NormalizeImageInput): Promise<NormalizedImageAsset> {
    if (!isSupportedImageContentType(input.contentType)) {
        throw new Error(`Unsupported image content type: ${input.contentType}`);
    }

    const metadata = await sharp(input.buffer, { animated: false }).rotate().metadata();
    if (!metadata.width || !metadata.height) {
        throw new Error("Could not determine image dimensions.");
    }

    const checksumSha256 = createHash("sha256").update(input.buffer).digest("hex");
    const originalBase = sanitizeStorageName(stripExtension(input.filename));
    const variants: NormalizedImageVariant[] = [];

    for (const variant of PURPOSE_VARIANTS[input.purpose]) {
        const pipeline = sharp(input.buffer, { animated: false })
            .rotate()
            .resize({
                width: variant.width,
                height: variant.height,
                fit: variant.fit,
                withoutEnlargement: true,
            })
            .webp({
                quality: variant.quality,
                effort: 4,
            });

        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
        variants.push({
            key: variant.key,
            filename: `${originalBase}-${variant.key}.webp`,
            contentType: "image/webp",
            buffer: data,
            width: info.width,
            height: info.height,
            sizeBytes: info.size,
        });
    }

    return {
        checksumSha256,
        original: {
            filename: sanitizeStorageName(input.filename),
            contentType: input.contentType,
            sizeBytes: input.buffer.byteLength,
            width: metadata.width,
            height: metadata.height,
            buffer: input.keepOriginal === false ? undefined : input.buffer,
        },
        variants,
    };
}

function stripExtension(filename: string): string {
    const idx = filename.lastIndexOf(".");
    return idx > 0 ? filename.slice(0, idx) : filename;
}
