import { supabase } from "@/lib/supabase";
import type {
    CreatorWork,
    PublicationStatus,
    SeriesStatus,
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
