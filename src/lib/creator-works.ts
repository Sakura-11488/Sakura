import { supabase } from "@/lib/supabase";
import type {
    AssetFileRecord,
    AssetVariantRecord,
    CreatorWork,
    LinkedCreatorAsset,
    PublicationStatus,
    SeriesStatus,
    WorkAssetLink,
    WorkContentType,
    WorkKind,
    WorkRelease,
    WorkVisibility,
} from "@/lib/publishing";

export interface CreatorWorkCreateInput {
    kind: WorkKind;
    title: string;
    slug?: string | null;
    description?: string;
    genres?: string[];
    language?: string;
    series_status?: SeriesStatus;
    publication_status?: PublicationStatus;
    visibility?: WorkVisibility;
    minting_enabled?: boolean;
    release_metadata?: Record<string, unknown>;
}

export interface CreatorWorkReleaseCreateInput {
    sequence_number: number;
    title: string;
    summary?: string;
    content_type: WorkContentType;
    publication_status?: PublicationStatus;
    visibility?: WorkVisibility;
    body_text?: string;
    duration_ms?: number | null;
    release_metadata?: Record<string, unknown>;
}

export async function getCreatorWorksByCreator(wallet: string): Promise<CreatorWork[]> {
    if (!wallet || !supabase) return [];

    const { data, error } = await supabase
        .from("creator_works")
        .select("*")
        .eq("creator_wallet", wallet)
        .order("updated_at", { ascending: false });

    if (error) {
        console.error("getCreatorWorksByCreator:", error);
        return [];
    }

    return (data as CreatorWork[]) || [];
}

export async function getCreatorWork(workId: string): Promise<CreatorWork | null> {
    if (!workId || !supabase) return null;

    const { data, error } = await supabase
        .from("creator_works")
        .select("*")
        .eq("id", workId)
        .single();

    if (error) {
        console.error("getCreatorWork:", error);
        return null;
    }

    return data as CreatorWork;
}

export async function createCreatorWork(wallet: string, input: CreatorWorkCreateInput): Promise<CreatorWork | null> {
    if (!wallet || !supabase) return null;

    const { data, error } = await supabase
        .from("creator_works")
        .insert({
            creator_wallet: wallet,
            kind: input.kind,
            title: input.title.trim(),
            slug: input.slug || null,
            description: input.description?.trim() || "",
            genres: input.genres || [],
            language: input.language || "en",
            series_status: input.series_status || "ongoing",
            publication_status: input.publication_status || "draft",
            visibility: input.visibility || "private",
            minting_enabled: input.minting_enabled || false,
            release_metadata: input.release_metadata || {},
        })
        .select("*")
        .single();

    if (error) {
        console.error("createCreatorWork:", error);
        return null;
    }

    return data as CreatorWork;
}

export async function updateCreatorWork(
    workId: string,
    wallet: string,
    updates: Partial<CreatorWork>
): Promise<boolean> {
    if (!workId || !wallet || !supabase) return false;

    const { error } = await supabase
        .from("creator_works")
        .update({
            ...updates,
            updated_at: new Date().toISOString(),
        })
        .eq("id", workId)
        .eq("creator_wallet", wallet);

    if (error) {
        console.error("updateCreatorWork:", error);
        return false;
    }

    return true;
}

export async function deleteCreatorWork(workId: string, wallet: string): Promise<boolean> {
    if (!workId || !wallet || !supabase) return false;

    const { error } = await supabase
        .from("creator_works")
        .delete()
        .eq("id", workId)
        .eq("creator_wallet", wallet);

    if (error) {
        console.error("deleteCreatorWork:", error);
        return false;
    }

    return true;
}

export async function getWorkReleases(workId: string): Promise<WorkRelease[]> {
    if (!workId || !supabase) return [];

    const { data, error } = await supabase
        .from("work_releases")
        .select("*")
        .eq("work_id", workId)
        .order("sequence_number", { ascending: true });

    if (error) {
        console.error("getWorkReleases:", error);
        return [];
    }

    return (data as WorkRelease[]) || [];
}

export async function createWorkRelease(
    workId: string,
    wallet: string,
    input: CreatorWorkReleaseCreateInput
): Promise<WorkRelease | null> {
    if (!workId || !wallet || !supabase) return null;

    const work = await getCreatorWork(workId);
    if (!work || work.creator_wallet !== wallet) {
        return null;
    }

    const { data, error } = await supabase
        .from("work_releases")
        .insert({
            work_id: workId,
            sequence_number: input.sequence_number,
            title: input.title.trim(),
            summary: input.summary?.trim() || "",
            content_type: input.content_type,
            publication_status: input.publication_status || "draft",
            visibility: input.visibility || "private",
            body_text: input.body_text || "",
            duration_ms: input.duration_ms ?? null,
            release_metadata: input.release_metadata || {},
        })
        .select("*")
        .single();

    if (error) {
        console.error("createWorkRelease:", error);
        return null;
    }

    return data as WorkRelease;
}

export async function updateWorkRelease(
    releaseId: string,
    wallet: string,
    updates: Partial<WorkRelease>
): Promise<boolean> {
    if (!releaseId || !wallet || !supabase) return false;

    const { data: release, error: releaseError } = await supabase
        .from("work_releases")
        .select("id, work_id")
        .eq("id", releaseId)
        .single();

    if (releaseError || !release) {
        console.error("updateWorkRelease release lookup:", releaseError);
        return false;
    }

    const work = await getCreatorWork(release.work_id);
    if (!work || work.creator_wallet !== wallet) {
        return false;
    }

    const { error } = await supabase
        .from("work_releases")
        .update({
            ...updates,
            updated_at: new Date().toISOString(),
        })
        .eq("id", releaseId);

    if (error) {
        console.error("updateWorkRelease:", error);
        return false;
    }

    return true;
}

export async function deleteWorkRelease(releaseId: string, wallet: string): Promise<boolean> {
    if (!releaseId || !wallet || !supabase) return false;

    const { data: release, error: releaseError } = await supabase
        .from("work_releases")
        .select("id, work_id")
        .eq("id", releaseId)
        .single();

    if (releaseError || !release) {
        console.error("deleteWorkRelease release lookup:", releaseError);
        return false;
    }

    const work = await getCreatorWork(release.work_id);
    if (!work || work.creator_wallet !== wallet) {
        return false;
    }

    const { error } = await supabase
        .from("work_releases")
        .delete()
        .eq("id", releaseId);

    if (error) {
        console.error("deleteWorkRelease:", error);
        return false;
    }

    return true;
}

export async function getReleaseAssetsForReleases(
    releaseIds: string[]
): Promise<Record<string, LinkedCreatorAsset[]>> {
    const client = supabase;
    if (!client || releaseIds.length === 0) return {};

    const uniqueReleaseIds = [...new Set(releaseIds.filter(Boolean))];
    if (uniqueReleaseIds.length === 0) return {};

    const { data: assetLinks, error: linkError } = await client
        .from("work_assets")
        .select("*")
        .in("release_id", uniqueReleaseIds)
        .order("sort_order", { ascending: true });

    if (linkError) {
        console.error("getReleaseAssetsForReleases links:", linkError);
        return {};
    }

    const typedLinks = (assetLinks as WorkAssetLink[]) || [];
    const assetIds = [...new Set(typedLinks.map((link) => link.asset_file_id))];
    if (assetIds.length === 0) {
        return Object.fromEntries(uniqueReleaseIds.map((releaseId) => [releaseId, []]));
    }

    const [{ data: assetFiles, error: assetError }, { data: assetVariants, error: variantError }] = await Promise.all([
        client
            .from("asset_files")
            .select("*")
            .in("id", assetIds),
        client
            .from("asset_variants")
            .select("*")
            .in("asset_file_id", assetIds),
    ]);

    if (assetError) {
        console.error("getReleaseAssetsForReleases files:", assetError);
        return {};
    }

    if (variantError) {
        console.error("getReleaseAssetsForReleases variants:", variantError);
        return {};
    }

    const fileMap = new Map(
        ((assetFiles as AssetFileRecord[]) || []).map((file) => [file.id, file])
    );
    const variantsByFile = new Map<string, AssetVariantRecord[]>();

    for (const variant of (assetVariants as AssetVariantRecord[]) || []) {
        const existing = variantsByFile.get(variant.asset_file_id) || [];
        existing.push(variant);
        variantsByFile.set(variant.asset_file_id, existing);
    }

    const result: Record<string, LinkedCreatorAsset[]> = Object.fromEntries(
        uniqueReleaseIds.map((releaseId) => [releaseId, []])
    );

    for (const link of typedLinks) {
        if (!link.release_id) continue;
        const file = fileMap.get(link.asset_file_id);
        if (!file) continue;

        const publicUrl = file.is_public
            ? client.storage.from(file.bucket).getPublicUrl(file.object_path).data.publicUrl
            : null;
        const variants = (variantsByFile.get(file.id) || []).map((variant) => ({
            ...variant,
            publicUrl: file.is_public
                ? client.storage.from(variant.bucket).getPublicUrl(variant.object_path).data.publicUrl
                : null,
        }));

        result[link.release_id].push({
            ...link,
            file: {
                ...file,
                publicUrl,
            },
            variants,
        });
    }

    for (const releaseId of Object.keys(result)) {
        result[releaseId].sort((left, right) => left.sort_order - right.sort_order);
    }

    return result;
}
