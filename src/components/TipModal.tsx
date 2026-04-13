"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getConnection } from "@/lib/solana";
import { SAKURA_MINT } from "@/lib/solana";
import { buildDepositTx } from "@/lib/treasury";
import { recordTip } from "@/lib/creator";

const PRESETS = [100_000, 250_000, 500_000, 1_000_000];
const MIN_SAKURA = 100_000;

type Step = "amount" | "processing" | "done" | "error";

interface Props {
    onClose: () => void;
    header?: string;
    subtitle?: string;
    onComplete?: () => void;
    receiverAddress?: string;
}

export default function TipModal({
    onClose,
    header = "Support Sakura",
    subtitle = "Donate $SAKURA to the Sakura treasury",
    onComplete,
    receiverAddress,
}: Props) {
    const { publicKey, signTransaction } = useWallet();
    const [step, setStep] = useState<Step>("amount");
    const [amount, setAmount] = useState("");
    const [sakuraBalance, setSakuraBalance] = useState<number | null>(null);
    const [error, setError] = useState("");
    const [txid, setTxid] = useState("");

    const fetchBalance = useCallback(() => {
        if (!publicKey) {
            setSakuraBalance(null);
            return;
        }
        getConnection()
            .getParsedTokenAccountsByOwner(publicKey, { mint: SAKURA_MINT })
            .then((accounts) => {
                if (accounts.value.length > 0) {
                    let total = 0;
                    for (const acc of accounts.value) {
                        const amt = acc.account.data.parsed.info.tokenAmount.uiAmount;
                        total += Number(amt ?? 0);
                    }
                    setSakuraBalance(total);
                } else {
                    setSakuraBalance(0);
                }
            })
            .catch(() => setSakuraBalance(0));
    }, [publicKey]);

    useEffect(() => {
        fetchBalance();
    }, [fetchBalance]);

    const handleConfirm = async () => {
        if (!publicKey || !signTransaction) {
            setError("Connect your wallet first");
            return;
        }

        const amt = Number(amount.replace(/,/g, ""));
        if (isNaN(amt) || amt < MIN_SAKURA) {
            setError(`Minimum is ${MIN_SAKURA.toLocaleString()} SAKURA`);
            return;
        }

        if (sakuraBalance !== null && amt > sakuraBalance) {
            setError("Insufficient balance");
            return;
        }

        setStep("processing");
        setError("");

        try {
            const tx = await buildDepositTx(publicKey, amt, receiverAddress);
            const signed = await signTransaction(tx);
            const conn = getConnection();
            const sig = await conn.sendRawTransaction(signed.serialize());

            await conn.confirmTransaction(
                {
                    signature: sig,
                    blockhash: tx.recentBlockhash!,
                    lastValidBlockHeight: tx.lastValidBlockHeight!,
                },
                "confirmed"
            );

            setTxid(sig);
            setStep("done");

            if (receiverAddress) {
                recordTip(sig, publicKey.toBase58(), receiverAddress, amt).catch((err) => {
                    console.warn("Tip recorded on-chain but DB save failed:", err);
                });
            }

            onComplete?.();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Transaction failed");
            setStep("error");
        }
    };

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape" && step === "amount") onClose();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [onClose, step]);

    const amtNum = Number(amount.replace(/,/g, ""));
    const isValid = !isNaN(amtNum) && amtNum >= MIN_SAKURA;
    const hasBalance = sakuraBalance !== null && isValid && amtNum <= sakuraBalance;

    const shortAddr = receiverAddress
        ? `${receiverAddress.slice(0, 4)}...${receiverAddress.slice(-4)}`
        : null;

    return (
        <div className="buy-sakura-overlay" onClick={() => step === "amount" && onClose()}>
            <div className="buy-sakura-modal" onClick={(e) => e.stopPropagation()}>
                {step === "amount" && (
                    <>
                        <button className="bsm-close" onClick={onClose}>✕</button>
                        <div className="bsm-header">
                            <div className="bsm-icon">🌸</div>
                            <h2>{header}</h2>
                            <p className="bsm-subtitle">{subtitle}</p>
                            {shortAddr && (
                                <p style={{ color: 'var(--sakura-pink)', fontSize: '0.8rem', marginTop: 4, fontFamily: 'monospace' }}>
                                    Sending to {shortAddr}
                                </p>
                            )}
                        </div>

                        <div className="bsm-input-section">
                            <label className="bsm-label">Amount ($SAKURA)</label>
                            <div className="bsm-input-row">
                                <div className="bsm-input-icon">🌸</div>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    className="bsm-input"
                                    value={amount}
                                    onChange={(e) => {
                                        const v = e.target.value.replace(/[^0-9,]/g, "");
                                        setAmount(v);
                                        setError("");
                                    }}
                                    placeholder="100,000"
                                    autoFocus
                                />
                            </div>
                            <div className="bsm-balance-row">
                                <span>Balance: {sakuraBalance !== null ? sakuraBalance.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "..."} $SAKURA</span>
                                <span className="bsm-estimate">Min: {MIN_SAKURA.toLocaleString()}</span>
                            </div>
                        </div>

                        {error && <div className="bsm-error">{error}</div>}

                        <div className="bsm-presets">
                            {PRESETS.map((v) => (
                                <button
                                    key={v}
                                    className={`bsm-preset ${amount === v.toString() ? "active" : ""}`}
                                    onClick={() => setAmount(v.toString())}
                                >
                                    {v >= 1_000_000 ? `${v / 1_000_000}M` : v.toLocaleString()}
                                </button>
                            ))}
                        </div>

                        <button
                            className="bsm-confirm-btn"
                            onClick={handleConfirm}
                            disabled={!isValid || !hasBalance}
                        >
                            {receiverAddress ? "Send Tip" : "Donate"}{" "}
                            {amount ? `(${Number(amount.replace(/,/g, "")).toLocaleString()} $SAKURA)` : ""}
                        </button>
                    </>
                )}

                {step === "processing" && (
                    <div className="bsm-processing">
                        <div className="bsm-spinner" />
                        <h3>Sending...</h3>
                        <p>Please confirm the transaction in your wallet.</p>
                    </div>
                )}

                {step === "done" && (
                    <div className="bsm-done">
                        <div className="bsm-done-icon">✓</div>
                        <h3>Thank you!</h3>
                        <p className="bsm-done-amount">
                            {receiverAddress
                                ? `Your tip of ${Number(amount.replace(/,/g, "")).toLocaleString()} $SAKURA was sent!`
                                : "Your donation was sent successfully."}
                        </p>
                        {txid && (
                            <a
                                href={`https://solscan.io/tx/${txid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="bsm-tx-link"
                            >
                                View on Solscan →
                            </a>
                        )}
                        <button className="bsm-confirm-btn" onClick={onClose}>Done</button>
                    </div>
                )}

                {step === "error" && (
                    <div className="bsm-done">
                        <div className="bsm-done-icon" style={{ background: "rgba(255,107,107,0.15)", color: "#ff6b6b" }}>✕</div>
                        <h3>Something went wrong</h3>
                        <p className="bsm-done-amount" style={{ color: "#ff6b6b" }}>{error}</p>
                        <button className="bsm-confirm-btn" onClick={() => { setStep("amount"); setError(""); }}>Try Again</button>
                    </div>
                )}
            </div>
        </div>
    );
}
