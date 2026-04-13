import { Request, Response, NextFunction } from "express";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

declare global {
    namespace Express {
        interface Request {
            walletAddress?: string;
        }
    }
}

/**
 * Verify that the request is signed by the wallet owner.
 * Expects headers:
 *   x-wallet-address: base58 public key
 *   x-signature: base58-encoded signature of the message
 *   x-message: the signed message (should include a nonce/timestamp)
 */
export function requireWalletAuth(req: Request, res: Response, next: NextFunction) {
    const walletAddress = req.headers["x-wallet-address"] as string;
    const signature = req.headers["x-signature"] as string;
    const message = req.headers["x-message"] as string;

    if (!walletAddress || !signature || !message) {
        res.status(401).json({ error: "Missing auth headers (x-wallet-address, x-signature, x-message)" });
        return;
    }

    try {
        const pubkey = new PublicKey(walletAddress);
        const messageBytes = new TextEncoder().encode(message);
        const signatureBytes = bs58.decode(signature);

        const valid = nacl.sign.detached.verify(
            messageBytes,
            signatureBytes,
            pubkey.toBytes()
        );

        if (!valid) {
            res.status(401).json({ error: "Invalid signature" });
            return;
        }

        // Verify message freshness (within 5 minutes)
        const match = message.match(/ts:(\d+)/);
        if (match) {
            const ts = parseInt(match[1]);
            const now = Math.floor(Date.now() / 1000);
            if (Math.abs(now - ts) > 300) {
                res.status(401).json({ error: "Signature expired" });
                return;
            }
        }

        req.walletAddress = walletAddress;
        next();
    } catch (err) {
        res.status(401).json({ error: "Auth verification failed" });
    }
}

/**
 * Lightweight auth: just check that a wallet address is provided.
 * For read-only endpoints where full signature verification is overkill.
 */
export function requireWallet(req: Request, res: Response, next: NextFunction) {
    const walletAddress =
        req.headers["x-wallet-address"] as string ||
        req.params.wallet ||
        req.query.wallet as string;

    if (!walletAddress) {
        res.status(400).json({ error: "Wallet address required" });
        return;
    }

    try {
        new PublicKey(walletAddress);
        req.walletAddress = walletAddress;
        next();
    } catch {
        res.status(400).json({ error: "Invalid wallet address" });
    }
}
