import type { MintScope, MintType, WorkMintRecord } from "@/lib/publishing";
import type { WalletAuthHeaders } from "@/lib/wallet-auth";

export interface VerifyCreatorMintIntentInput {
    workId?: string;
    releaseId?: string;
    mintScope: MintScope;
    mintType: MintType;
    metadataUri: string;
    txSignature: string;
    mintPrice: number;
    maxSupply?: number | null;
    currency?: string;
    collectionAddress?: string;
    treeAddress?: string;
    mintAddress?: string;
}

export interface VerifiedCreatorMintIntentResponse {
    success: boolean;
    mint: WorkMintRecord;
}

export async function verifyCreatorMintIntent(
    input: VerifyCreatorMintIntentInput,
    authHeaders: WalletAuthHeaders
): Promise<VerifiedCreatorMintIntentResponse> {
    const res = await fetch("/api/creator/mints/verify", {
        method: "POST",
        headers: {
            ...authHeaders,
            "content-type": "application/json",
        },
        body: JSON.stringify(input),
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.error || "Failed to verify mint intent.");
    }

    return data as VerifiedCreatorMintIntentResponse;
}
