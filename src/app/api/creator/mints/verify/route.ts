import { Connection, PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import {
    MINT_TYPES,
    type MintScope,
    type MintType,
    validateMintIntentDraft,
} from "@/lib/publishing";
import { RPC_ENDPOINT } from "@/lib/solana";
import { verifyWalletHeaders } from "@/server/auth/wallet-auth";
import { resolvePublishingOwnership } from "@/server/publishing/ownership";
import { getSupabaseAdmin } from "@/server/supabase-admin";

export const runtime = "nodejs";

interface VerifyMintIntentPayload {
    workId?: string;
    releaseId?: string;
    mintScope?: MintScope;
    mintType?: MintType;
    metadataUri?: string;
    txSignature?: string;
    mintPrice?: number;
    maxSupply?: number | null;
    currency?: string;
    collectionAddress?: string;
    treeAddress?: string;
    mintAddress?: string;
}

export async function POST(req: Request) {
    try {
        const { walletAddress } = verifyWalletHeaders(req.headers, "creator-mint-verify");
        const body = (await req.json()) as VerifyMintIntentPayload;

        const mintType = body.mintType && MINT_TYPES.includes(body.mintType)
            ? body.mintType
            : "collectible";
        const mintPrice = Number(body.mintPrice ?? 0);
        const maxSupply = body.maxSupply == null || body.maxSupply === 0
            ? null
            : Number(body.maxSupply);
        const issues = validateMintIntentDraft({
            mintType,
            metadataUri: String(body.metadataUri || ""),
            txSignature: String(body.txSignature || ""),
            mintPrice,
            maxSupply,
            collectionAddress: body.collectionAddress,
            treeAddress: body.treeAddress,
            mintAddress: body.mintAddress,
        });

        if (issues.length > 0) {
            return NextResponse.json({ error: issues[0].message }, { status: 400 });
        }

        const supabaseAdmin = getSupabaseAdmin();
        const ownership = await resolvePublishingOwnership(supabaseAdmin, {
            walletAddress,
            workId: body.workId || null,
            releaseId: body.releaseId || null,
        });

        if (!ownership.linkableWorkId && !ownership.releaseId) {
            return NextResponse.json(
                { error: "Mint setup requires a unified creator work or release target." },
                { status: 400 }
            );
        }

        const txSignature = String(body.txSignature || "");
        const duplicateSignature = await supabaseAdmin
            .from("work_mints")
            .select("*")
            .eq("setup_tx_signature", txSignature)
            .maybeSingle();

        if (duplicateSignature.data) {
            if (duplicateSignature.data.creator_wallet !== walletAddress) {
                return NextResponse.json({ error: "Mint transaction already claimed." }, { status: 400 });
            }

            return NextResponse.json({ success: true, mint: duplicateSignature.data });
        }

        const connection = new Connection(RPC_ENDPOINT, "confirmed");
        const tx = await connection.getTransaction(txSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!tx || !tx.meta) {
            return NextResponse.json({ error: "Transaction not found or not confirmed." }, { status: 400 });
        }

        if (tx.meta.err) {
            return NextResponse.json({ error: "Transaction failed on-chain." }, { status: 400 });
        }

        const feePayer = tx.transaction.message.getAccountKeys().get(0)?.toBase58();
        if (feePayer !== walletAddress) {
            return NextResponse.json({ error: "Transaction signer does not match wallet." }, { status: 400 });
        }

        const messageAccountKeys = tx.transaction.message.getAccountKeys();
        const accountKeys = new Set<string>();
        for (let index = 0; index < messageAccountKeys.length; index += 1) {
            const key = messageAccountKeys.get(index);
            if (key) {
                accountKeys.add(key.toBase58());
            }
        }

        for (const address of [body.collectionAddress, body.treeAddress, body.mintAddress]) {
            if (!address) continue;
            try {
                const normalized = new PublicKey(address).toBase58();
                if (!accountKeys.has(normalized)) {
                    return NextResponse.json(
                        { error: `Verified transaction is missing expected account ${normalized}.` },
                        { status: 400 }
                    );
                }
            } catch {
                return NextResponse.json({ error: "One of the provided mint addresses is invalid." }, { status: 400 });
            }
        }

        let targetQuery = supabaseAdmin
            .from("work_mints")
            .select("*")
            .eq("creator_wallet", walletAddress)
            .eq("mint_scope", body.mintScope === "release" ? "release" : "work")
            .eq("mint_type", mintType);

        if (ownership.releaseId) {
            targetQuery = targetQuery.eq("release_id", ownership.releaseId);
        } else {
            targetQuery = targetQuery.is("release_id", null);
        }

        if (ownership.linkableWorkId) {
            targetQuery = targetQuery.eq("work_id", ownership.linkableWorkId);
        } else {
            targetQuery = targetQuery.is("work_id", null);
        }

        const existingTarget = await targetQuery.maybeSingle();
        const mintRow = {
            work_id: ownership.linkableWorkId,
            release_id: ownership.releaseId,
            creator_wallet: walletAddress,
            mint_scope: body.mintScope === "release" ? "release" : "work",
            mint_type: mintType,
            status: "pending_review",
            collection_address: body.collectionAddress || null,
            tree_address: body.treeAddress || null,
            mint_address: body.mintAddress || null,
            metadata_uri: String(body.metadataUri || "").trim(),
            max_supply: maxSupply,
            mint_price: mintPrice,
            currency: String(body.currency || "SAKURA").trim() || "SAKURA",
            setup_tx_signature: txSignature,
            verified_at: new Date().toISOString(),
            verification_state: {
                signature: txSignature,
                slot: tx.slot,
                verified_signer: walletAddress,
                verified_at: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
        };

        const persisted = existingTarget.data
            ? await supabaseAdmin
                .from("work_mints")
                .update(mintRow)
                .eq("id", existingTarget.data.id)
                .select("*")
                .single()
            : await supabaseAdmin
                .from("work_mints")
                .insert(mintRow)
                .select("*")
                .single();

        if (persisted.error || !persisted.data) {
            console.error("Mint intent persistence failed:", persisted.error);
            return NextResponse.json({ error: "Failed to store mint intent." }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            mint: persisted.data,
        });
    } catch (error: any) {
        console.error("Creator mint verify failed:", error);
        return NextResponse.json(
            { error: error?.message || "Creator mint verification failed." },
            { status: 500 }
        );
    }
}
