import type { AssetKind, AssetRole } from "@/lib/publishing";
import type { WalletAuthHeaders } from "@/lib/wallet-auth";

export interface UploadCreatorAssetInput {
    file: File;
    kind: Extract<AssetKind, "cover" | "poster" | "thumbnail" | "manga_page" | "subtitle" | "video_manifest">;
    workId?: string;
    releaseId?: string;
    role?: AssetRole;
    isPrimary?: boolean;
    keepOriginal?: boolean;
    isPublic?: boolean;
    sortOrder?: number;
}

export interface UploadedCreatorAsset {
    success: boolean;
    asset: {
        id: string;
        bucket: string;
        object_path: string;
        kind: string;
        checksum_sha256: string;
        status: string;
        is_public: boolean;
        publicUrl: string | null;
    };
    variants: Array<{
        variantKey: string;
        bucket: string;
        objectPath: string;
        mimeType: string;
        width: number | null;
        height: number | null;
        publicUrl: string | null;
    }>;
}

export async function uploadCreatorAsset(
    input: UploadCreatorAssetInput,
    authHeaders: WalletAuthHeaders
): Promise<UploadedCreatorAsset> {
    const form = new FormData();
    form.append("file", input.file);
    form.append("kind", input.kind);

    if (input.workId) form.append("workId", input.workId);
    if (input.releaseId) form.append("releaseId", input.releaseId);
    if (input.role) form.append("role", input.role);
    if (input.isPrimary) form.append("isPrimary", "true");
    if (input.keepOriginal === false) form.append("keepOriginal", "false");
    if (input.isPublic) form.append("isPublic", "true");
    if (typeof input.sortOrder === "number") form.append("sortOrder", String(input.sortOrder));

    const res = await fetch("/api/creator/assets", {
        method: "POST",
        headers: authHeaders,
        body: form,
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.error || "Failed to upload creator asset.");
    }

    return data as UploadedCreatorAsset;
}
