/**
 * Proof-of-Concept: Deposit Replay Attack
 *
 * Demonstrates that a single on-chain SOL transfer signature can be
 * submitted to /deposit-confirm multiple times to inflate trading margin.
 *
 * Two test suites:
 *   VULNERABLE  — runs against the original route (no replay check).
 *                 Shows the attack succeeds: balance grows on every replay.
 *   PATCHED     — runs against the fixed route.
 *                 Shows the second submission receives 409 and balance
 *                 is not double-credited.
 *
 * Run:
 *   npx ts-mocha -p tsconfig.json tests/f01-deposit-replay.test.ts
 */

import assert from "assert";
import express from "express";
import request from "supertest";
import { Connection } from "@solana/web3.js";

// Minimal in-memory DB stand-in 

interface DepositRecord {
    id: string;
    wallet: string;
    amount_sol: number;
    direction: string;
    tx_signature: string;
    status: string;
}

interface BalanceRecord {
    wallet: string;
    deposited_sol: number;
    available_margin: number;
}

class FakeDB {
    deposits: DepositRecord[] = [];
    balances: Map<string, BalanceRecord> = new Map();

    reset() {
        this.deposits = [];
        this.balances.clear();
    }

    getDepositByTxSignature(sig: string) {
        return this.deposits.find((d) => d.tx_signature === sig) ?? null;
    }

    insertDeposit(record: Omit<DepositRecord, "id">) {
        // Simulate DB UNIQUE constraint
        if (this.deposits.some((d) => d.tx_signature === record.tx_signature)) {
            const err: any = new Error("duplicate key value violates unique constraint");
            err.code = "23505";
            throw err;
        }
        const inserted = { id: Math.random().toString(36).slice(2), ...record };
        this.deposits.push(inserted);
        return inserted;
    }

    getBalance(wallet: string): BalanceRecord {
        return this.balances.get(wallet) ?? { wallet, deposited_sol: 0, available_margin: 0 };
    }

    upsertBalance(wallet: string, updates: Partial<BalanceRecord>) {
        const existing = this.getBalance(wallet);
        this.balances.set(wallet, { ...existing, ...updates });
    }
}

const db = new FakeDB();

// Mock RPC connection

const MOCK_WALLET = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const MOCK_SERVER_WALLET = "5NcWtvtQ48QJcizEs9i8H7Ef3YmtmybnSkPQxA2fxFiF";
const REPLAY_TX_SIG = "4vfake1111111111111111111111111111111111111111111111111111111111";
const DEPOSIT_LAMPORTS = 2_000_000_000; // 2 SOL

function mockGetTransaction() {
    return {
        meta: {
            err: null,
            preBalances: [10_000_000_000, 0],
            postBalances: [10_000_000_000 - DEPOSIT_LAMPORTS, DEPOSIT_LAMPORTS],
        },
        transaction: {
            message: {
                getAccountKeys: () => ({
                    length: 2,
                    get: (i: number) => ({
                        toBase58: () => (i === 1 ? MOCK_SERVER_WALLET : MOCK_WALLET),
                    }),
                }),
            },
        },
    };
}

// Helpers to build the two route variants

/** VULNERABLE route — original code, no replay check */
function buildVulnerableApp() {
    const app = express();
    app.use(express.json());

    // Bypass auth for testing
    app.use((req: any, _res: any, next: any) => {
        req.walletAddress = MOCK_WALLET;
        next();
    });

    app.post("/deposit-confirm", async (req: any, res: any) => {
        const { txSignature } = req.body;
        const wallet = req.walletAddress;

        // NO replay check
        const tx = mockGetTransaction() as any;
        const depositLamports = DEPOSIT_LAMPORTS;
        const depositSol = depositLamports / 1e9;

        try {
            db.insertDeposit({ wallet, amount_sol: depositSol, direction: "deposit", tx_signature: txSignature, status: "confirmed" });
        } catch {
            // Original code didn't have this catch — swallowed silently or
            // the DB just returned an error that was ignored. Either way,
            // the balance update below still runs.
        }

        // Balance updated regardless of whether the insert succeeded
        const bal = db.getBalance(wallet);
        db.upsertBalance(wallet, {
            deposited_sol: bal.deposited_sol + depositSol,
            available_margin: bal.available_margin + depositSol,
        });

        res.json({ success: true, deposited: depositSol });
    });

    return app;
}

/** PATCHED route — F-01 fix applied */
function buildPatchedApp() {
    const app = express();
    app.use(express.json());

    app.use((req: any, _res: any, next: any) => {
        req.walletAddress = MOCK_WALLET;
        next();
    });

    app.post("/deposit-confirm", async (req: any, res: any) => {
        const { txSignature } = req.body;
        const wallet = req.walletAddress;

        // ✅ FIX — application-level check
        const existing = db.getDepositByTxSignature(txSignature);
        if (existing) {
            return res.status(409).json({
                error: "Transaction already processed. This deposit has already been credited.",
                txSignature,
            });
        }

        const depositSol = DEPOSIT_LAMPORTS / 1e9;

        // ✅ FIX — DB-level unique constraint (simulated in FakeDB.insertDeposit)
        try {
            db.insertDeposit({ wallet, amount_sol: depositSol, direction: "deposit", tx_signature: txSignature, status: "confirmed" });
        } catch (insertErr: any) {
            if (insertErr?.code === "23505") {
                return res.status(409).json({
                    error: "Transaction already processed. This deposit has already been credited.",
                    txSignature,
                });
            }
            throw insertErr;
        }

        // Balance only updated after successful insert
        const bal = db.getBalance(wallet);
        db.upsertBalance(wallet, {
            deposited_sol: bal.deposited_sol + depositSol,
            available_margin: bal.available_margin + depositSol,
        });

        res.json({ success: true, deposited: depositSol });
    });

    return app;
}

// Tests

describe("Deposit Replay Attack", () => {

    describe("VULNERABLE (original code) — attack succeeds", () => {
        const app = buildVulnerableApp();

        beforeEach(() => db.reset());

        it("credits balance on first submission", async () => {
            const res = await request(app)
                .post("/deposit-confirm")
                .send({ txSignature: REPLAY_TX_SIG });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.deposited, 2);
        });

        it("EXPLOIT: replaying the same txSignature credits balance a second time", async () => {
            // First submission
            await request(app)
                .post("/deposit-confirm")
                .send({ txSignature: REPLAY_TX_SIG });

            const balAfterFirst = db.getBalance(MOCK_WALLET);
            assert.strictEqual(balAfterFirst.deposited_sol, 2, "balance after first deposit should be 2 SOL");

            // Replay — same signature
            const replay = await request(app)
                .post("/deposit-confirm")
                .send({ txSignature: REPLAY_TX_SIG });

            // Vulnerable code returns 200 again
            assert.strictEqual(replay.status, 200, "vulnerable: replay returns 200");

            const balAfterReplay = db.getBalance(MOCK_WALLET);
            // Balance doubled — attacker gets 4 SOL margin from a 2 SOL deposit
            assert.strictEqual(
                balAfterReplay.deposited_sol, 4,
                "VULNERABLE: balance was double-credited — replay attack succeeded"
            );
        });

        it("EXPLOIT: 10 replays inflate balance 10×", async () => {
            for (let i = 0; i < 10; i++) {
                await request(app)
                    .post("/deposit-confirm")
                    .send({ txSignature: REPLAY_TX_SIG });
            }
            const bal = db.getBalance(MOCK_WALLET);
            assert.strictEqual(bal.deposited_sol, 20, "VULNERABLE: balance 10× actual deposit");
        });
    });

    describe("PATCHED (F-01 fix) — attack blocked", () => {
        const app = buildPatchedApp();

        beforeEach(() => db.reset());

        it("credits balance on first submission", async () => {
            const res = await request(app)
                .post("/deposit-confirm")
                .send({ txSignature: REPLAY_TX_SIG });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.deposited, 2);

            const bal = db.getBalance(MOCK_WALLET);
            assert.strictEqual(bal.deposited_sol, 2);
        });

        it("returns 409 on replay — balance not changed", async () => {
            // First legitimate deposit
            await request(app)
                .post("/deposit-confirm")
                .send({ txSignature: REPLAY_TX_SIG });

            const balAfterFirst = db.getBalance(MOCK_WALLET);

            // Replay attempt
            const replay = await request(app)
                .post("/deposit-confirm")
                .send({ txSignature: REPLAY_TX_SIG });

            // ✅ Fixed: replay returns 409
            assert.strictEqual(replay.status, 409);
            assert.ok(
                replay.body.error.includes("already processed"),
                "error message should say already processed"
            );
            assert.strictEqual(replay.body.txSignature, REPLAY_TX_SIG);

            // ✅ Balance unchanged
            const balAfterReplay = db.getBalance(MOCK_WALLET);
            assert.strictEqual(
                balAfterReplay.deposited_sol,
                balAfterFirst.deposited_sol,
                "balance must not change on replay"
            );
        });

        it("10 replay attempts all return 409 — balance stays at 2 SOL", async () => {
            // Legitimate first deposit
            await request(app)
                .post("/deposit-confirm")
                .send({ txSignature: REPLAY_TX_SIG });

            // 9 replay attempts
            for (let i = 0; i < 9; i++) {
                const res = await request(app)
                    .post("/deposit-confirm")
                    .send({ txSignature: REPLAY_TX_SIG });
                assert.strictEqual(res.status, 409, `replay attempt ${i + 2} should be 409`);
            }

            const bal = db.getBalance(MOCK_WALLET);
            assert.strictEqual(bal.deposited_sol, 2, "balance must remain 2 SOL despite 10 submissions");
        });

        it("different tx signatures are each accepted once", async () => {
            const sigs = [
                "4vfake1111111111111111111111111111111111111111111111111111111111",
                "5vfake2222222222222222222222222222222222222222222222222222222222",
            ];

            for (const sig of sigs) {
                const res = await request(app)
                    .post("/deposit-confirm")
                    .send({ txSignature: sig });
                assert.strictEqual(res.status, 200, `first submission of ${sig} should succeed`);
            }

            const bal = db.getBalance(MOCK_WALLET);
            assert.strictEqual(bal.deposited_sol, 4, "two distinct deposits should each credit 2 SOL");
        });
    });
});