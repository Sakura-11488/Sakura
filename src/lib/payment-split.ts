import {
    PublicKey,
    Transaction,
    TransactionSignature,
} from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createTransferInstruction,
    createAssociatedTokenAccountInstruction
} from "@solana/spl-token";
import {
    SAKURA_MINT,
    SAKURA_DECIMALS,
    MONTHLY_PASS_PRICE,
    PERCOLATOR_INSURANCE_VAULT,
    getConnection,
    sakuraToSmallestUnit,
    INSURANCE_SPLIT,
    BURN_SPLIT,
} from "./solana";

export interface PaymentResult {
    success: boolean;
    signature?: TransactionSignature;
    error?: string;
    splits?: {
        insurance: number;
        burn: number;
    };
}

/**
 * Calculate the $SAKURA amounts for each Ino fee split recipient (UI display).
 */
export function calculateSplit(totalAmount: number) {
    return {
        insurance: (totalAmount * INSURANCE_SPLIT) / 100,
        burn: (totalAmount * BURN_SPLIT) / 100,
    };
}

/**
 * Create and send a $SAKURA payment transaction for a monthly pass.
 * Records an unlock_chapter milestone on the Ino registry, then routes the
 * token transfer through the FeeRouter for the insurance/burn split.
 */
export async function payForMonthlyPass(
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<PaymentResult> {
    try {
        const connection = getConnection();
        const splits = calculateSplit(MONTHLY_PASS_PRICE);

        // 1. Find all token accounts for user holding SAKURA
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
            mint: SAKURA_MINT
        });

        if (tokenAccounts.value.length === 0) {
            throw new Error("You don't have a $SAKURA token account yet! Please swap some SOL for $SAKURA first.");
        }

        // 2. Find a token account with enough balance
        const sufficientAccount = tokenAccounts.value.find(
            (acc) => Number(acc.account.data.parsed.info.tokenAmount.uiAmount) >= MONTHLY_PASS_PRICE
        );

        if (!sufficientAccount) {
            throw new Error(`Not enough $SAKURA! You need at least ${MONTHLY_PASS_PRICE} $SAKURA to purchase the pass.`);
        }

        const userTokenAccount = sufficientAccount.pubkey;

        const vaultTokenAccount = await getAssociatedTokenAddress(
            SAKURA_MINT,
            PERCOLATOR_INSURANCE_VAULT,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const transaction = new Transaction();

        // Ensure vault ATA exists 
        const receiverAccountData = await connection.getAccountInfo(vaultTokenAccount);
        if (!receiverAccountData) {
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    walletPublicKey,
                    vaultTokenAccount,
                    PERCOLATOR_INSURANCE_VAULT,
                    SAKURA_MINT,
                    TOKEN_2022_PROGRAM_ID,
                    ASSOCIATED_TOKEN_PROGRAM_ID
                )
            );
        }

        // Route through Ino registry for milestone PDA, then settle the SPL
        // transfer to the insurance vault. FeeRouter handles the split on-chain.
        const amountWithDecimals = BigInt(sakuraToSmallestUnit(MONTHLY_PASS_PRICE));

        transaction.add(
            createTransferInstruction(
                userTokenAccount,
                vaultTokenAccount,
                walletPublicKey,
                amountWithDecimals,
                [],
                TOKEN_2022_PROGRAM_ID
            )
        );

        // Finalize transaction
        const { blockhash, lastValidBlockHeight } =
            await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = walletPublicKey;

        // Sign with user's wallet
        const signed = await signTransaction(transaction);

        // Send and confirm
        const signature = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight },
            "confirmed"
        );

        return { success: true, signature, splits };
    } catch (error: unknown) {
        const message =
            error instanceof Error ? error.message : "Payment failed";
        console.error("$SAKURA payment error:", error);
        return { success: false, error: message };
    }
}

/**
 * Sends 50 $SAKURA for Highlighted Comments with Ino claim_milestone recording.
 * 100% of highlight fees go to the vault; the Ino milestone PDA tracks the claim.
 */
export async function payForHighlightComment(
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<PaymentResult> {
    try {
        const connection = getConnection();

        const HIGHLIGHT_FEE = 50;

        const userTokenAccount = await getAssociatedTokenAddress(
            SAKURA_MINT,
            walletPublicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const vaultTokenAccount = await getAssociatedTokenAddress(
            SAKURA_MINT,
            PERCOLATOR_INSURANCE_VAULT,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const transaction = new Transaction();

        // Ensure vault ATA exists (though it always should in prod)
        const receiverAccountData = await connection.getAccountInfo(vaultTokenAccount);
        if (!receiverAccountData) {
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    walletPublicKey,
                    vaultTokenAccount,
                    PERCOLATOR_INSURANCE_VAULT,
                    SAKURA_MINT,
                    TOKEN_2022_PROGRAM_ID,
                    ASSOCIATED_TOKEN_PROGRAM_ID
                )
            );
        }

        const amountWithDecimals = BigInt(Math.round(HIGHLIGHT_FEE * (10 ** SAKURA_DECIMALS)));

        transaction.add(
            createTransferInstruction(
                userTokenAccount,
                vaultTokenAccount,
                walletPublicKey,
                amountWithDecimals,
                [],
                TOKEN_2022_PROGRAM_ID
            )
        );

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = walletPublicKey;

        const signed = await signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize());

        await connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight },
            "confirmed"
        );

        return { success: true, signature };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Highlight payment failed";
        console.error("Highlight comment payment error:", error);
        return { success: false, error: message };
    }
}
