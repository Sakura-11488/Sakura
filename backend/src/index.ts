import "dotenv/config";
import express from "express";
import cors from "cors";
import { initDrift, shutdownDrift } from "./drift";
import tradeRouter from "./routes/trade";
import balanceRouter from "./routes/balance";

const app = express();
const PORT = parseInt(process.env.PORT || "4000", 10);

app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", time: Date.now() });
});

app.use("/api/trade", tradeRouter);
app.use("/api/balance", balanceRouter);

async function main() {
    console.log("[sakura-perps] Initializing Drift client...");
    await initDrift();
    console.log("[sakura-perps] Drift client ready.");

    app.listen(PORT, () => {
        console.log(`[sakura-perps] Server listening on :${PORT}`);
    });
}

process.on("SIGINT", async () => {
    console.log("[sakura-perps] Shutting down...");
    await shutdownDrift();
    process.exit(0);
});

main().catch((err) => {
    console.error("[sakura-perps] Fatal startup error:", err);
    process.exit(1);
});
