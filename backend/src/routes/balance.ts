import { Router, type Request, type Response } from "express";
const router = Router();

// The legacy custodial flow could credit a repeated deposit and reported
// withdrawal success without sending funds to the user's wallet. Its reads
// accepted only a public wallet address, exposing private account records.
const unavailable = (_req: Request, res: Response) => res.status(503).json({
    error: "Legacy custodial balances are unavailable. Contact support for an existing balance.",
});
router.get("/history/:wallet", unavailable);
router.get("/:wallet", unavailable);
router.post("/deposit-confirm", unavailable);
router.post("/withdraw", unavailable);

export default router;
