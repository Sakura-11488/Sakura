import { Router } from "express";
import { requireWalletAuth, requireWallet } from "../middleware/auth";
import { verifyTradingFee } from "../verify-fee";
import {
    getMarketState,
    getOrderBook,
    getRecentTrades,
    getFundingRates,
    openPosition,
    closePosition,
    getPosition,
    getServerWalletAddress,
} from "../drift";
import {
    getOrCreateUser,
    getUserByWallet,
    recordTrade,
    updateTradeClose,
    getOpenTrades,
    getTradeHistory,
    getBalance,
} from "../db";

const router = Router();

// ============ Public Market Data (no auth) ============

router.get("/market", async (_req, res) => {
    try {
        const state = await getMarketState();
        res.json(state);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/orderbook", async (_req, res) => {
    try {
        const book = await getOrderBook();
        res.json(book);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/recent-trades", async (_req, res) => {
    try {
        const trades = await getRecentTrades();
        res.json(trades);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/funding", async (_req, res) => {
    try {
        const funding = await getFundingRates();
        res.json(funding);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/server-wallet", (_req, res) => {
    res.json({ address: getServerWalletAddress() });
});

// ============ User Positions (lightweight auth) ============

router.get("/positions/:wallet", requireWallet, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const user = await getUserByWallet(wallet);
        if (!user) {
            res.json({ position: null, trades: [] });
            return;
        }

        const position = await getPosition(user.drift_sub_account_id);
        const openTrades = await getOpenTrades(wallet);
        res.json({ position, trades: openTrades });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/history/:wallet", requireWallet, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const trades = await getTradeHistory(wallet);
        res.json({ trades });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ============ Trade Execution (full auth required) ============

router.post("/open", requireWalletAuth, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const { side, size, leverage, feeSignature } = req.body;

        if (!side || !size || !leverage || !feeSignature) {
            res.status(400).json({ error: "Missing required fields: side, size, leverage, feeSignature" });
            return;
        }

        if (!["long", "short"].includes(side)) {
            res.status(400).json({ error: "side must be 'long' or 'short'" });
            return;
        }

        if (size <= 0 || size > 1000) {
            res.status(400).json({ error: "size must be between 0 and 1000 SOL" });
            return;
        }

        if (leverage < 1 || leverage > 20) {
            res.status(400).json({ error: "leverage must be between 1x and 20x" });
            return;
        }

        // 1. Verify $SAKURA fee was paid
        const feeResult = await verifyTradingFee(feeSignature, wallet);
        if (!feeResult.valid) {
            res.status(402).json({ error: `Fee verification failed: ${feeResult.error}` });
            return;
        }

        // 2. Get or create user + sub-account
        const user = await getOrCreateUser(wallet);

        // 3. Get current market price for entry
        const market = await getMarketState();

        // 4. Execute trade on Drift
        const result = await openPosition({
            side,
            size,
            leverage,
            subAccountId: user.drift_sub_account_id,
        });

        if (!result.success) {
            res.status(500).json({ error: result.error });
            return;
        }

        // 5. Record trade in database
        const trade = await recordTrade({
            wallet,
            market: "SOL-PERP",
            side,
            size,
            leverage,
            entry_price: market.markPrice,
            fee_signature: feeSignature,
            drift_tx_sig: result.txSig || "",
            status: "open",
        });

        res.json({
            success: true,
            trade,
            txSig: result.txSig,
            entryPrice: market.markPrice,
        });
    } catch (err: any) {
        console.error("[trade/open] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/close", requireWalletAuth, async (req, res) => {
    try {
        const wallet = req.walletAddress!;
        const user = await getUserByWallet(wallet);

        if (!user) {
            res.status(404).json({ error: "No trading account found" });
            return;
        }

        // Get current position info before closing
        const positionBefore = await getPosition(user.drift_sub_account_id);
        if (!positionBefore.hasPosition) {
            res.status(400).json({ error: "No open position to close" });
            return;
        }

        // Execute close on Drift
        const result = await closePosition(user.drift_sub_account_id);
        if (!result.success) {
            res.status(500).json({ error: result.error });
            return;
        }

        // Update trade record
        const openTrades = await getOpenTrades(wallet);
        if (openTrades.length > 0) {
            await updateTradeClose(
                openTrades[0].id,
                positionBefore.markPrice,
                positionBefore.pnl
            );
        }

        res.json({
            success: true,
            txSig: result.txSig,
            pnl: positionBefore.pnl,
            exitPrice: positionBefore.markPrice,
        });
    } catch (err: any) {
        console.error("[trade/close] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
