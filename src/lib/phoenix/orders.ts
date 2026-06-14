import {
    PublicKey,
    Transaction,
    TransactionInstruction,
    type Connection,
    type TransactionSignature,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { getConnection } from "@/lib/solana";
import { getPhoenixHttpClient, normalizePhoenixSymbol } from "./client";
import type { PhoenixOrderRequest, PhoenixOrderResult } from "./types";

type ApiAccountMeta = {
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
};

type ApiInstructionResponse = {
    programId: string;
    data: number[];
    keys: ApiAccountMeta[];
};
type KitAccountMeta = {
    address?: string;
    role?: number | string;
};
type KitInstructionResponse = {
    programAddress?: string;
    data?: Uint8Array | number[];
    accounts?: readonly KitAccountMeta[];
};

function sideToPhoenix(side: PhoenixOrderRequest["side"]): "bid" | "ask" {
    return side === "long" ? "bid" : "ask";
}

function isWritableRole(role: unknown): boolean {
    if (typeof role === "number") return role === 1 || role === 3;
    if (typeof role === "string") return role.toLowerCase().includes("writable");
    return false;
}

function isSignerRole(role: unknown): boolean {
    if (typeof role === "number") return role === 2 || role === 3;
    if (typeof role === "string") return role.toLowerCase().includes("signer");
    return false;
}

function toTransactionInstruction(raw: ApiInstructionResponse | KitInstructionResponse): TransactionInstruction {
    const apiIx = raw as ApiInstructionResponse;
    if (apiIx.programId && apiIx.keys) {
        return new TransactionInstruction({
            programId: new PublicKey(apiIx.programId),
            keys: apiIx.keys.map(key => ({
                pubkey: new PublicKey(key.pubkey),
                isSigner: key.isSigner,
                isWritable: key.isWritable,
            })),
            data: Buffer.from(apiIx.data),
        });
    }

    const kitIx = raw as KitInstructionResponse;
    if (!kitIx.programAddress || !kitIx.accounts || !kitIx.data) {
        throw new Error("Phoenix returned an unsupported instruction shape");
    }

    return new TransactionInstruction({
        programId: new PublicKey(kitIx.programAddress),
        keys: kitIx.accounts.map(account => ({
            pubkey: new PublicKey(account.address || ""),
            isSigner: isSignerRole(account.role),
            isWritable: isWritableRole(account.role),
        })),
        data: Buffer.from(kitIx.data),
    });
}

async function buildOrderInstructions(request: PhoenixOrderRequest): Promise<Array<ApiInstructionResponse | KitInstructionResponse>> {
    const client = getPhoenixHttpClient();
    const base = {
        authority: request.authority,
        symbol: normalizePhoenixSymbol(request.symbol),
        side: sideToPhoenix(request.side),
        quantity: request.quantity,
        isReduceOnly: !!request.reduceOnly,
        allowCrossAndIsolatedForAsset: true,
        transferAmount: request.transferAmount ? Math.max(0, Math.round(request.transferAmount * 1_000_000)) : undefined,
        tpSl: request.takeProfitPrice || request.stopLossPrice ? {
            quantity: request.quantity,
            takeProfitTriggerPrice: request.takeProfitPrice || undefined,
            stopLossTriggerPrice: request.stopLossPrice || undefined,
        } : undefined,
    };

    if (request.orderType === "limit") {
        if (!request.price || request.price <= 0) {
            throw new Error("Limit price is required");
        }
        return await client.orders().placeIsolatedLimitOrder({
            ...base,
            price: request.price,
            isPostOnly: !!request.postOnly,
        }) as unknown as Array<ApiInstructionResponse | KitInstructionResponse>;
    }

    return await client.orders().placeIsolatedMarketOrder(base) as unknown as Array<ApiInstructionResponse | KitInstructionResponse>;
}

export async function executePhoenixOrder(
    request: PhoenixOrderRequest,
    wallet: Pick<WalletContextState, "publicKey" | "sendTransaction">,
    connection: Connection = getConnection()
): Promise<PhoenixOrderResult> {
    if (!wallet.publicKey || wallet.publicKey.toBase58() !== request.authority) {
        throw new Error("Wallet is not connected");
    }
    if (!wallet.sendTransaction) {
        throw new Error("Connected wallet does not support transaction sending");
    }

    const instructions = await buildOrderInstructions(request);
    if (!instructions.length) {
        throw new Error("Phoenix did not return any transaction instructions");
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
        feePayer: wallet.publicKey,
        recentBlockhash: blockhash,
    });
    transaction.add(...instructions.map(toTransactionInstruction));

    const signature: TransactionSignature = await wallet.sendTransaction(transaction, connection);
    await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, "confirmed");

    return {
        signature,
        orderType: request.orderType,
    };
}

export async function closePhoenixPosition(
    params: {
        authority: string;
        symbol: string;
        side: PhoenixOrderRequest["side"];
        quantity: number;
    },
    wallet: Pick<WalletContextState, "publicKey" | "sendTransaction">,
    connection: Connection = getConnection()
): Promise<PhoenixOrderResult> {
    return executePhoenixOrder(
        {
            authority: params.authority,
            symbol: params.symbol,
            side: params.side === "long" ? "short" : "long",
            orderType: "market",
            quantity: params.quantity,
            reduceOnly: true,
        },
        wallet,
        connection
    );
}
