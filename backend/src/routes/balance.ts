import { Router } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import { requireWalletAuth, requireWallet } from "../middleware/auth";
import {
    depositCollateral,
    withdrawCollateral,
    getServerWalletAddress,
} from "../drift";
import {
    getOrCreateUser,
    getUserByWallet,
    getBalance,
    upsertBalance,
    recordDeposit,
    getDepositHistory,
} from "../db";

const router = Router();

function getMainnetConnection(): Connection {
    return new Connection(
        process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
        "confirmed"
    );
}

// ============ Read Balance ============

router.get("/:wallet", requireWallet, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const balance = await getBalance(wallet);
        res.json(balance);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ============ Deposit History ============

router.get("/history/:wallet", requireWallet, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const history = await getDepositHistory(wallet);
        res.json({ deposits: history });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ============ Confirm Deposit ============

/**
 * After user sends SOL to the server wallet, they call this endpoint
 * with the transaction signature. Backend verifies the transfer and
 * credits the user's balance, then deposits into Drift.
 */
router.post("/deposit-confirm", requireWalletAuth, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const { txSignature } = req.body;

        if (!txSignature) {
            res.status(400).json({ error: "txSignature required" });
            return;
        }

        const connection = getMainnetConnection();
        const serverWallet = getServerWalletAddress();

        // Verify the transaction
        const tx = await connection.getTransaction(txSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
            res.status(404).json({ error: "Transaction not found. It may not be confirmed yet." });
            return;
        }

        if (tx.meta?.err) {
            res.status(400).json({ error: "Transaction failed on-chain" });
            return;
        }

        // Find the SOL transfer to server wallet
        const accountKeys = tx.transaction.message.getAccountKeys();
        const preBalances = tx.meta!.preBalances;
        const postBalances = tx.meta!.postBalances;

        let depositLamports = 0;
        for (let i = 0; i < accountKeys.length; i++) {
            if (accountKeys.get(i)?.toBase58() === serverWallet) {
                depositLamports = postBalances[i] - preBalances[i];
                break;
            }
        }

        if (depositLamports <= 0) {
            res.status(400).json({ error: "No SOL transfer to server wallet found in transaction" });
            return;
        }

        const depositSol = depositLamports / 1e9;

        // Ensure user exists
        const user = await getOrCreateUser(wallet);

        // Record the deposit
        await recordDeposit({
            wallet,
            amount_sol: depositSol,
            direction: "deposit",
            tx_signature: txSignature,
            status: "confirmed",
        });

        // Update balance
        const currentBalance = await getBalance(wallet);
        await upsertBalance(wallet, {
            deposited_sol: (currentBalance.deposited_sol || 0) + depositSol,
            available_margin: (currentBalance.available_margin || 0) + depositSol,
        });

        // Deposit into Drift as collateral
        try {
            await depositCollateral(user.drift_sub_account_id, depositSol);
        } catch (driftErr: any) {
            console.error("[balance] Drift deposit failed (balance still credited):", driftErr);
        }

        res.json({
            success: true,
            deposited: depositSol,
            balance: {
                deposited_sol: (currentBalance.deposited_sol || 0) + depositSol,
                available_margin: (currentBalance.available_margin || 0) + depositSol,
            },
        });
    } catch (err: any) {
        console.error("[balance/deposit-confirm] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============ Withdraw ============

router.post("/withdraw", requireWalletAuth, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            res.status(400).json({ error: "Invalid withdrawal amount" });
            return;
        }

        const user = await getUserByWallet(wallet);
        if (!user) {
            res.status(404).json({ error: "No trading account found" });
            return;
        }

        const balance = await getBalance(wallet);
        if ((balance.available_margin || 0) < amount) {
            res.status(400).json({
                error: `Insufficient margin. Available: ${balance.available_margin} SOL`,
            });
            return;
        }

        // Withdraw from Drift
        const txSig = await withdrawCollateral(
            user.drift_sub_account_id,
            amount
        );

        // Record withdrawal
        await recordDeposit({
            wallet,
            amount_sol: amount,
            direction: "withdraw",
            tx_signature: txSig,
            status: "confirmed",
        });

        // Update balance
        await upsertBalance(wallet, {
            deposited_sol: Math.max(0, (balance.deposited_sol || 0) - amount),
            available_margin: Math.max(0, (balance.available_margin || 0) - amount),
        });

        // TODO: Transfer SOL from server wallet to user's wallet
        // This requires building a SOL transfer tx and sending it

        res.json({
            success: true,
            withdrawn: amount,
            txSig,
        });
    } catch (err: any) {
        console.error("[balance/withdraw] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
