import { Connection, PublicKey } from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const SAKURA_MINT = new PublicKey(
    process.env.SAKURA_MINT || "EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump"
);
const SAKURA_TREASURY_ADMIN = new PublicKey(
    process.env.SAKURA_TREASURY_ADMIN || "5NcWtvtQ48QJcizEs9i8H7Ef3YmtmybnSkPQxA2fxFiF"
);
const SAKURA_DECIMALS = 9;
const REQUIRED_FEE = 100_000; // 100,000 $SAKURA

let mainnetConnection: Connection | null = null;

function getMainnetConnection(): Connection {
    if (!mainnetConnection) {
        mainnetConnection = new Connection(
            process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
            "confirmed"
        );
    }
    return mainnetConnection;
}

/**
 * Verify that a $SAKURA trading fee was paid by checking the transaction on mainnet.
 * Verifies:
 * 1. Transaction exists and succeeded
 * 2. Contains an SPL transfer to the treasury ATA
 * 3. Transfer amount meets the minimum fee
 * 4. Transfer is of the $SAKURA token
 */
export async function verifyTradingFee(
    signature: string,
    expectedPayer: string
): Promise<{ valid: boolean; error?: string }> {
    try {
        const connection = getMainnetConnection();

        const tx = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
            return { valid: false, error: "Transaction not found" };
        }

        if (tx.meta?.err) {
            return { valid: false, error: "Transaction failed on-chain" };
        }

        // Get the treasury ATA
        const treasuryAta = await getAssociatedTokenAddress(
            SAKURA_MINT,
            SAKURA_TREASURY_ADMIN,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // Check pre/post token balances for a transfer to treasury
        const preBalances = tx.meta?.preTokenBalances || [];
        const postBalances = tx.meta?.postTokenBalances || [];

        const treasuryAtaStr = treasuryAta.toBase58();

        // Find treasury ATA balance change
        const preEntry = preBalances.find(
            (b) => b.mint === SAKURA_MINT.toBase58() &&
            tx.transaction.message.getAccountKeys().get(b.accountIndex)?.toBase58() === treasuryAtaStr
        );
        const postEntry = postBalances.find(
            (b) => b.mint === SAKURA_MINT.toBase58() &&
            tx.transaction.message.getAccountKeys().get(b.accountIndex)?.toBase58() === treasuryAtaStr
        );

        if (!postEntry) {
            return { valid: false, error: "No $SAKURA transfer to treasury found in transaction" };
        }

        const preAmount = preEntry
            ? Number(preEntry.uiTokenAmount.uiAmount || 0)
            : 0;
        const postAmount = Number(postEntry.uiTokenAmount.uiAmount || 0);
        const transferred = postAmount - preAmount;

        if (transferred < REQUIRED_FEE) {
            return {
                valid: false,
                error: `Insufficient fee: ${transferred} $SAKURA (need ${REQUIRED_FEE})`,
            };
        }

        // Verify the signer matches the expected payer
        const signers = tx.transaction.message.getAccountKeys();
        const firstSigner = signers.get(0)?.toBase58();
        if (firstSigner !== expectedPayer) {
            return { valid: false, error: "Fee payer does not match wallet" };
        }

        return { valid: true };
    } catch (err: any) {
        console.error("[verify-fee] Error:", err);
        return { valid: false, error: err.message || "Fee verification failed" };
    }
}
