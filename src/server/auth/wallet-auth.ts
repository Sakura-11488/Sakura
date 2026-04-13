import "server-only";

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export interface VerifiedWalletRequest {
    walletAddress: string;
    message: string;
    signature: string;
}

export function verifyWalletHeaders(headers: Headers, expectedAction: string): VerifiedWalletRequest {
    const walletAddress = headers.get("x-wallet-address") || "";
    const signature = headers.get("x-signature") || "";
    const message = headers.get("x-message") || "";

    if (!walletAddress || !signature || !message) {
        throw new Error("Missing wallet auth headers.");
    }

    const pubkey = new PublicKey(walletAddress);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);

    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkey.toBytes());
    if (!valid) {
        throw new Error("Invalid wallet signature.");
    }

    const actionPrefix = `sakura:${expectedAction}:ts:`;
    if (!message.startsWith(actionPrefix)) {
        throw new Error("Unexpected wallet auth action.");
    }

    const ts = Number.parseInt(message.slice(actionPrefix.length), 10);
    if (!Number.isFinite(ts)) {
        throw new Error("Malformed wallet auth timestamp.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 300) {
        throw new Error("Wallet auth signature expired.");
    }

    return { walletAddress, message, signature };
}
