import { supabase } from "@/lib/supabase";
import type { WorkMintRecord } from "@/lib/publishing";

export async function getWorkMintRecords(input: {
    workId?: string;
    releaseId?: string;
}): Promise<WorkMintRecord[]> {
    if (!supabase) return [];

    let query = supabase
        .from("work_mints")
        .select("*")
        .order("updated_at", { ascending: false });

    if (input.releaseId) {
        query = query.eq("release_id", input.releaseId);
    } else if (input.workId) {
        query = query.eq("work_id", input.workId);
    } else {
        return [];
    }

    const { data, error } = await query;
    if (error) {
        console.error("getWorkMintRecords:", error);
        return [];
    }

    return (data as WorkMintRecord[]) || [];
}
