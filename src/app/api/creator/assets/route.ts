import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
    ASSET_KINDS,
    type AssetKind,
    buildAssetObjectPath,
    canAssetBePublic,
    getDefaultBucketForAssetKind,
    getDefaultRoleForAssetKind,
    sanitizeStorageName,
} from "@/lib/publishing";
import { normalizeImageAsset } from "@/server/media/normalize-image";
import { verifyWalletHeaders } from "@/server/auth/wallet-auth";
import { getSupabaseAdmin } from "@/server/supabase-admin";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_ASSET_BYTES = 2 * 1024 * 1024;
const IMAGE_ASSET_KINDS: AssetKind[] = ["cover", "poster", "thumbnail", "manga_page"];
const TEXT_ASSET_KINDS: AssetKind[] = ["subtitle", "video_manifest"];
const SUBTITLE_CONTENT_TYPES = new Set([
    "text/vtt",
    "application/x-subrip",
    "text/plain",
    "",
]);
const MANIFEST_CONTENT_TYPES = new Set([
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "application/dash+xml",
    "text/plain",
    "",
]);

export async function POST(req: Request) {
    try {
        const { walletAddress } = verifyWalletHeaders(req.headers, "creator-asset-upload");
        const form = await req.formData();

        const file = form.get("file");
        const kindValue = String(form.get("kind") || "");
        const workId = stringOrNull(form.get("workId"));
        const releaseId = stringOrNull(form.get("releaseId"));
        const roleValue = stringOrNull(form.get("role"));
        const isPrimary = String(form.get("isPrimary") || "false") === "true";
        const keepOriginal = String(form.get("keepOriginal") || "true") !== "false";
        const exposePublic = String(form.get("isPublic") || "false") === "true";

        if (!(file instanceof File)) {
            return NextResponse.json({ error: "Missing file upload." }, { status: 400 });
        }

        if (!ASSET_KINDS.includes(kindValue as AssetKind)) {
            return NextResponse.json({ error: "Unsupported asset kind." }, { status: 400 });
        }

        const kind = kindValue as AssetKind;
        if (!IMAGE_ASSET_KINDS.includes(kind)) {
            return NextResponse.json({ error: "This route currently supports image assets only." }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const supabaseAdmin = getSupabaseAdmin();
        await assertAssetTargetOwnership(supabaseAdmin, { walletAddress, workId, releaseId });

        const assetId = randomUUID();
        const bucket = getDefaultBucketForAssetKind(kind);
        const storageBaseTarget = releaseId || workId || "draft";
        const shouldBePublic = exposePublic && canAssetBePublic(kind);
        const variantRows: Array<Record<string, unknown>> = [];
        let assetRow: Record<string, unknown>;

        if (IMAGE_ASSET_KINDS.includes(kind)) {
            if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
                return NextResponse.json({ error: "Image size must be between 1 byte and 15 MB." }, { status: 400 });
            }

            const normalized = await normalizeImageAsset({
                buffer,
                filename: file.name,
                contentType: file.type,
                purpose: kind === "cover" ? "cover" : kind === "poster" ? "poster" : kind === "thumbnail" ? "thumbnail" : "manga_page",
                keepOriginal,
            });

            const originalFilename = normalized.original.filename || sanitizeStorageName(file.name);
            const originalPath = buildAssetObjectPath({
                wallet: walletAddress,
                workId: workId || storageBaseTarget,
                releaseId: releaseId || undefined,
                kind,
                filename: `${assetId}-original-${originalFilename}`,
            });

            if (normalized.original.buffer) {
                const uploadOriginal = await supabaseAdmin.storage
                    .from(bucket)
                    .upload(originalPath, normalized.original.buffer, {
                        contentType: normalized.original.contentType,
                        upsert: false,
                    });

                if (uploadOriginal.error) {
                    console.error("Asset original upload failed:", uploadOriginal.error);
                    return NextResponse.json({ error: "Failed to store original asset." }, { status: 500 });
                }
            }

            for (const variant of normalized.variants) {
                const variantPath = buildAssetObjectPath({
                    wallet: walletAddress,
                    workId: workId || storageBaseTarget,
                    releaseId: releaseId || undefined,
                    kind,
                    filename: `${assetId}-${variant.filename}`,
                });

                const uploadVariant = await supabaseAdmin.storage
                    .from(bucket)
                    .upload(variantPath, variant.buffer, {
                        contentType: variant.contentType,
                        upsert: false,
                    });

                if (uploadVariant.error) {
                    console.error("Asset variant upload failed:", uploadVariant.error);
                    return NextResponse.json({ error: `Failed to store ${variant.key} variant.` }, { status: 500 });
                }

                variantRows.push({
                    asset_file_id: assetId,
                    variant_key: variant.key,
                    bucket,
                    object_path: variantPath,
                    mime_type: variant.contentType,
                    size_bytes: variant.sizeBytes,
                    width: variant.width,
                    height: variant.height,
                    status: "ready",
                    metadata: {},
                });
            }

            assetRow = {
                id: assetId,
                owner_wallet: walletAddress,
                storage_provider: "supabase",
                bucket,
                object_path: normalized.original.buffer ? originalPath : String(variantRows[0]?.object_path || originalPath),
                kind,
                mime_type: normalized.original.contentType,
                original_filename: file.name,
                size_bytes: normalized.original.sizeBytes,
                checksum_sha256: normalized.checksumSha256,
                width: normalized.original.width,
                height: normalized.original.height,
                status: "ready",
                is_public: shouldBePublic,
                metadata: {
                    hasOriginal: Boolean(normalized.original.buffer),
                    variantKeys: normalized.variants.map((v) => v.key),
                },
            };
        } else if (TEXT_ASSET_KINDS.includes(kind)) {
            if (file.size <= 0 || file.size > MAX_TEXT_ASSET_BYTES) {
                return NextResponse.json({ error: "Text-based asset size must be between 1 byte and 2 MB." }, { status: 400 });
            }

            const normalizedMimeType = normalizeTextAssetMimeType(kind, file.type, file.name);
            const objectPath = buildAssetObjectPath({
                wallet: walletAddress,
                workId: workId || storageBaseTarget,
                releaseId: releaseId || undefined,
                kind,
                filename: `${assetId}-${sanitizeStorageName(file.name)}`,
            });

            const uploadTextAsset = await supabaseAdmin.storage
                .from(bucket)
                .upload(objectPath, buffer, {
                    contentType: normalizedMimeType,
                    upsert: false,
                });

            if (uploadTextAsset.error) {
                console.error("Text asset upload failed:", uploadTextAsset.error);
                return NextResponse.json({ error: "Failed to store asset." }, { status: 500 });
            }

            assetRow = {
                id: assetId,
                owner_wallet: walletAddress,
                storage_provider: "supabase",
                bucket,
                object_path: objectPath,
                kind,
                mime_type: normalizedMimeType,
                original_filename: file.name,
                size_bytes: buffer.byteLength,
                checksum_sha256: createHash("sha256").update(buffer).digest("hex"),
                status: "ready",
                is_public: exposePublic,
                metadata: {},
            };
        } else {
            return NextResponse.json({ error: "Unsupported asset kind for this route." }, { status: 400 });
        }

        const insertedAsset = await supabaseAdmin
            .from("asset_files")
            .insert(assetRow)
            .select("*")
            .single();

        if (insertedAsset.error) {
            console.error("Asset row insert failed:", insertedAsset.error);
            return NextResponse.json({ error: "Failed to save asset metadata." }, { status: 500 });
        }

        if (variantRows.length > 0) {
            const insertedVariants = await supabaseAdmin
                .from("asset_variants")
                .insert(variantRows)
                .select("*");

            if (insertedVariants.error) {
                console.error("Asset variant insert failed:", insertedVariants.error);
                return NextResponse.json({ error: "Failed to save asset variants." }, { status: 500 });
            }
        }

        if (workId || releaseId) {
            const linkInsert = await supabaseAdmin.from("work_assets").insert({
                work_id: workId,
                release_id: releaseId,
                asset_file_id: assetId,
                role: roleValue || getDefaultRoleForAssetKind(kind),
                sort_order: Number.parseInt(String(form.get("sortOrder") || "0"), 10) || 0,
                is_primary: isPrimary,
            });

            if (linkInsert.error) {
                console.error("Work asset link insert failed:", linkInsert.error);
                return NextResponse.json({ error: "Failed to link asset to work." }, { status: 500 });
            }
        }

        return NextResponse.json({
            success: true,
            asset: {
                ...insertedAsset.data,
                publicUrl: Boolean(insertedAsset.data.is_public)
                    ? supabaseAdmin.storage.from(bucket).getPublicUrl(String(insertedAsset.data.object_path)).data.publicUrl
                    : null,
            },
            variants: variantRows.map((variant) => ({
                variantKey: variant.variant_key,
                bucket: variant.bucket,
                objectPath: variant.object_path,
                mimeType: variant.mime_type,
                width: variant.width,
                height: variant.height,
                publicUrl: Boolean(insertedAsset.data.is_public)
                    ? supabaseAdmin.storage.from(String(variant.bucket)).getPublicUrl(String(variant.object_path)).data.publicUrl
                    : null,
            })),
        });
    } catch (error: any) {
        console.error("Creator asset upload failed:", error);
        return NextResponse.json(
            { error: error?.message || "Creator asset upload failed." },
            { status: 500 }
        );
    }
}

function normalizeTextAssetMimeType(kind: AssetKind, contentType: string, filename: string): string {
    const lowerName = filename.toLowerCase();

    if (kind === "subtitle") {
        if (!SUBTITLE_CONTENT_TYPES.has(contentType)) {
            throw new Error("Unsupported subtitle file type.");
        }
        if (lowerName.endsWith(".vtt")) return "text/vtt";
        if (lowerName.endsWith(".srt")) return "application/x-subrip";
        return contentType || "text/plain";
    }

    if (kind === "video_manifest") {
        if (!MANIFEST_CONTENT_TYPES.has(contentType)) {
            throw new Error("Unsupported manifest file type.");
        }
        if (lowerName.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
        if (lowerName.endsWith(".mpd")) return "application/dash+xml";
        return contentType || "text/plain";
    }

    return contentType || "text/plain";
}

function stringOrNull(value: FormDataEntryValue | null): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

async function assertAssetTargetOwnership(
    supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
    input: { walletAddress: string; workId: string | null; releaseId: string | null }
) {
    if (input.releaseId) {
        const release = await supabaseAdmin
            .from("work_releases")
            .select("id, work_id")
            .eq("id", input.releaseId)
            .single();

        if (release.error || !release.data) {
            throw new Error("Release not found.");
        }

        const work = await supabaseAdmin
            .from("creator_works")
            .select("id, creator_wallet")
            .eq("id", release.data.work_id)
            .single();

        if (work.error || !work.data) {
            throw new Error("Parent work not found.");
        }

        if (work.data.creator_wallet !== input.walletAddress) {
            throw new Error("You do not own this release.");
        }

        return;
    }

    if (input.workId) {
        const work = await supabaseAdmin
            .from("creator_works")
            .select("id, creator_wallet")
            .eq("id", input.workId)
            .single();

        if (work.error || !work.data) {
            throw new Error("Work not found.");
        }

        if (work.data.creator_wallet !== input.walletAddress) {
            throw new Error("You do not own this work.");
        }
    }
}
