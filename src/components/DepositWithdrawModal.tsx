"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
    Connection,
    PublicKey,
    Transaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { RPC_ENDPOINT } from "@/lib/solana";
import {
    confirmDeposit,
    requestWithdraw,
    fetchBalance,
    fetchServerWallet,
    buildAuthHeaders,
    generateAuthMessage,
    type UserBalance,
} from "@/lib/perps-api";
import bs58 from "bs58";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onBalanceUpdate: (balance: UserBalance) => void;
}

type Tab = "deposit" | "withdraw";
type Status = "idle" | "signing" | "confirming" | "success" | "error";

export default function DepositWithdrawModal({ isOpen, onClose, onBalanceUpdate }: Props) {
    const { publicKey, signTransaction, signMessage, connected } = useWallet();
    const [tab, setTab] = useState<Tab>("deposit");
    const [amount, setAmount] = useState("");
    const [status, setStatus] = useState<Status>("idle");
    const [error, setError] = useState("");
    const [balance, setBalance] = useState<UserBalance | null>(null);
    const [serverWallet, setServerWallet] = useState("");
    const [solBalance, setSolBalance] = useState(0);

    useEffect(() => {
        if (!isOpen) return;
        fetchServerWallet().then(setServerWallet).catch(() => {});
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || !connected || !publicKey) return;
        const wallet = publicKey.toBase58();

        fetchBalance(wallet).then((b) => {
            setBalance(b);
            onBalanceUpdate(b);
        }).catch(() => {});

        const conn = new Connection(RPC_ENDPOINT, "confirmed");
        conn.getBalance(publicKey).then((b) => setSolBalance(b / LAMPORTS_PER_SOL)).catch(() => {});
    }, [isOpen, connected, publicKey, onBalanceUpdate]);

    const signAuth = async (action: string) => {
        if (!signMessage || !publicKey) throw new Error("Wallet not connected");
        const message = generateAuthMessage(action);
        const msgBytes = new TextEncoder().encode(message);
        const sigBytes = await signMessage(msgBytes);
        return buildAuthHeaders(publicKey.toBase58(), bs58.encode(sigBytes), message);
    };

    const handleDeposit = async () => {
        if (!publicKey || !signTransaction || !serverWallet) return;
        const amountNum = parseFloat(amount);
        if (!amountNum || amountNum <= 0) {
            setError("Enter a valid amount");
            return;
        }

        try {
            setStatus("signing");
            setError("");

            const conn = new Connection(RPC_ENDPOINT, "confirmed");
            const tx = new Transaction();
            tx.add(
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: new PublicKey(serverWallet),
                    lamports: Math.round(amountNum * LAMPORTS_PER_SOL),
                })
            );

            const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.feePayer = publicKey;

            const signed = await signTransaction(tx);
            const txSig = await conn.sendRawTransaction(signed.serialize());

            setStatus("confirming");

            await conn.confirmTransaction(
                { signature: txSig, blockhash, lastValidBlockHeight },
                "confirmed"
            );

            // Confirm with backend
            const authHeaders = await signAuth("deposit");
            const result = await confirmDeposit(txSig, authHeaders);

            if (!result.success) {
                throw new Error(result.error || "Deposit confirmation failed");
            }

            setStatus("success");
            setAmount("");

            // Refresh balance
            const newBal = await fetchBalance(publicKey.toBase58());
            setBalance(newBal);
            onBalanceUpdate(newBal);
            setSolBalance((prev) => prev - amountNum);

            setTimeout(() => setStatus("idle"), 2000);
        } catch (err: any) {
            setError(err.message || "Deposit failed");
            setStatus("error");
        }
    };

    const handleWithdraw = async () => {
        if (!publicKey || !signMessage) return;
        const amountNum = parseFloat(amount);
        if (!amountNum || amountNum <= 0) {
            setError("Enter a valid amount");
            return;
        }

        try {
            setStatus("signing");
            setError("");

            const authHeaders = await signAuth("withdraw");
            setStatus("confirming");

            const result = await requestWithdraw(amountNum, authHeaders);

            if (!result.success) {
                throw new Error(result.error || "Withdrawal failed");
            }

            setStatus("success");
            setAmount("");

            const newBal = await fetchBalance(publicKey.toBase58());
            setBalance(newBal);
            onBalanceUpdate(newBal);

            setTimeout(() => setStatus("idle"), 2000);
        } catch (err: any) {
            setError(err.message || "Withdrawal failed");
            setStatus("error");
        }
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
                <div className="modal-header">
                    <h3>{tab === "deposit" ? "Deposit Collateral" : "Withdraw"}</h3>
                    <button className="modal-close-btn" onClick={onClose}>x</button>
                </div>

                <div className="perp-side-toggle" style={{ marginBottom: 16 }}>
                    <button
                        className={`perp-side-btn ${tab === "deposit" ? "active-long" : ""}`}
                        onClick={() => { setTab("deposit"); setStatus("idle"); setError(""); }}
                    >
                        Deposit
                    </button>
                    <button
                        className={`perp-side-btn ${tab === "withdraw" ? "active-short" : ""}`}
                        onClick={() => { setTab("withdraw"); setStatus("idle"); setError(""); }}
                    >
                        Withdraw
                    </button>
                </div>

                <div className="perp-order-info" style={{ marginBottom: 12 }}>
                    <div className="perp-info-row">
                        <span>Wallet SOL</span>
                        <span>{solBalance.toFixed(4)} SOL</span>
                    </div>
                    <div className="perp-info-row">
                        <span>Trading Margin</span>
                        <span>{(balance?.available_margin || 0).toFixed(4)} SOL</span>
                    </div>
                    <div className="perp-info-row">
                        <span>Total Deposited</span>
                        <span>{(balance?.deposited_sol || 0).toFixed(4)} SOL</span>
                    </div>
                </div>

                <div className="perp-field">
                    <label>Amount (SOL)</label>
                    <div className="perp-input-row">
                        <input
                            type="number"
                            className="perp-input"
                            value={amount}
                            onChange={(e) => { setAmount(e.target.value); if (status === "error") setStatus("idle"); }}
                            placeholder="0.00"
                        />
                        <span className="perp-input-unit">SOL</span>
                    </div>
                    <div className="perp-size-pct">
                        {[25, 50, 75, 100].map((pct) => {
                            const max = tab === "deposit" ? solBalance : (balance?.available_margin || 0);
                            return (
                                <button key={pct} className="perp-pct-btn" onClick={() => setAmount(((max * pct) / 100).toFixed(4))}>
                                    {pct}%
                                </button>
                            );
                        })}
                    </div>
                </div>

                {error && <div className="perp-error" style={{ marginBottom: 8 }}>{error}</div>}

                {status === "success" ? (
                    <button className="perp-execute-btn success-btn" disabled>
                        {tab === "deposit" ? "Deposited!" : "Withdrawn!"}
                    </button>
                ) : status === "signing" || status === "confirming" ? (
                    <button className="perp-execute-btn long-btn" disabled>
                        <span className="perp-spinner" />
                        {status === "signing" ? "Sign Transaction..." : "Confirming..."}
                    </button>
                ) : (
                    <button
                        className={`perp-execute-btn ${tab === "deposit" ? "long" : "short"}-btn`}
                        onClick={tab === "deposit" ? handleDeposit : handleWithdraw}
                        disabled={!amount || parseFloat(amount) <= 0}
                    >
                        {tab === "deposit" ? "Deposit SOL" : "Withdraw SOL"}
                    </button>
                )}
            </div>
        </div>
    );
}
