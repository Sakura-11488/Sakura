import { Router, type Request, type Response } from "express";
import {
    getMarketState,
    getOrderBook,
    getRecentTrades,
    getFundingRates,
} from "../drift";

const router = Router();

router.get("/market", async (_req, res) => {
    try { res.json(await getMarketState()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
});
router.get("/orderbook", async (_req, res) => {
    try { res.json(await getOrderBook()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
});
router.get("/recent-trades", async (_req, res) => {
    try { res.json(await getRecentTrades()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
});
router.get("/funding", async (_req, res) => {
    try { res.json(await getFundingRates()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Do not advertise the custodial receiving wallet while deposits are disabled.
router.get("/server-wallet", (_req, res) => {
    res.status(503).json({ error: "Legacy custodial deposits are unavailable." });
});

// The old fee proof could be replayed and sub-account allocation raced.
// Position and history reads accepted only a public wallet address. Existing
// positions require operator-assisted resolution before auth and settlement
// can be restored.
const unavailable = (_req: Request, res: Response) => res.status(503).json({
    error: "Legacy custodial trading is unavailable. Contact support for an existing position.",
});
router.get("/positions/:wallet", unavailable);
router.get("/history/:wallet", unavailable);
router.post("/open", unavailable);
router.post("/close", unavailable);

export default router;
