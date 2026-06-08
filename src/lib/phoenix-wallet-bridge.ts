import { Transaction, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export interface PhoenixWalletRequest {
    requestId: string;
    method: string;
    params: Record<string, unknown>;
}

function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function serializeSignedTransaction(tx: Transaction | VersionedTransaction): Uint8Array {
    if (tx instanceof VersionedTransaction) {
        return tx.serialize();
    }
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

export async function handlePhoenixWalletRequest(
    request: PhoenixWalletRequest,
    wallet: Pick<
        WalletContextState,
        "publicKey" | "connected" | "signTransaction" | "signAllTransactions" | "signMessage"
    >,
): Promise<unknown> {
    const { method, params } = request;

    switch (method) {
        case "connect": {
            if (!wallet.connected || !wallet.publicKey) {
                throw new Error("Connect your Sakura wallet in the app first.");
            }
            return {
                publicKey: wallet.publicKey.toBase58(),
                publicKeyBytes: uint8ArrayToBase64(wallet.publicKey.toBytes()),
            };
        }
        case "disconnect":
            return { ok: true };
        case "signTransaction": {
            if (!wallet.signTransaction) throw new Error("Wallet cannot sign transactions");
            const raw = typeof params.transaction === "string" ? params.transaction : "";
            const bytes = base64ToUint8Array(raw);
            const version = params.version === "v0" ? "v0" : "legacy";
            const tx =
                version === "v0"
                    ? VersionedTransaction.deserialize(bytes)
                    : Transaction.from(bytes);
            const signed = await wallet.signTransaction(tx as Transaction | VersionedTransaction);
            return { transaction: uint8ArrayToBase64(serializeSignedTransaction(signed)) };
        }
        case "signAllTransactions": {
            if (!wallet.signAllTransactions) throw new Error("Wallet cannot sign transactions");
            const items = Array.isArray(params.transactions) ? params.transactions : [];
            const txs = items.map((item: { transaction: string; version?: string }) => {
                const bytes = base64ToUint8Array(item.transaction);
                return item.version === "v0"
                    ? VersionedTransaction.deserialize(bytes)
                    : Transaction.from(bytes);
            });
            const signed = await wallet.signAllTransactions(
                txs as (Transaction | VersionedTransaction)[],
            );
            return {
                transactions: signed.map((tx) => uint8ArrayToBase64(serializeSignedTransaction(tx))),
            };
        }
        case "signMessage": {
            if (!wallet.signMessage) throw new Error("Wallet cannot sign messages");
            const raw = typeof params.message === "string" ? params.message : "";
            const message = base64ToUint8Array(raw);
            const signature = await wallet.signMessage(message);
            return { signature: uint8ArrayToBase64(signature) };
        }
        default:
            throw new Error(`Unsupported Phoenix wallet method: ${method}`);
    }
}
