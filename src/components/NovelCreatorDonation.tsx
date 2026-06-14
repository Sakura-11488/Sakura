"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
    Connection,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
} from "@solana/web3.js";
import { RPC_ENDPOINT, truncateAddress } from "@/lib/solana";
import { recordTip } from "@/lib/creator";

const PRESET_SOL = [0.01, 0.05, 0.1];

type Status = "idle" | "sending" | "success" | "error";

interface Props {
    creatorWallet: string;
    novelTitle: string;
}

function formatSol(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function NovelCreatorDonation({ creatorWallet, novelTitle }: Props) {
    const { publicKey, signTransaction, connected } = useWallet();
    const [amount, setAmount] = useState("0.05");
    const [copied, setCopied] = useState(false);
    const [status, setStatus] = useState<Status>("idle");
    const [error, setError] = useState("");
    const [txid, setTxid] = useState("");

    const recipient = useMemo(() => {
        try {
            return new PublicKey(creatorWallet);
        } catch {
            return null;
        }
    }, [creatorWallet]);

    const amountNum = Number(amount);
    const validAmount = Number.isFinite(amountNum) && amountNum > 0;
    const solanaPayUrl = recipient
        ? `solana:${recipient.toBase58()}?amount=${encodeURIComponent(validAmount ? String(amountNum) : "")}&label=${encodeURIComponent("Sakura creator donation")}&message=${encodeURIComponent(`Support ${novelTitle}`)}`
        : "";

    const copyAddress = async () => {
        if (!recipient) return;
        try {
            await navigator.clipboard.writeText(recipient.toBase58());
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
        } catch {
            setError("Could not copy address. Long-press the wallet address to copy it.");
        }
    };

    const sendSol = async () => {
        if (!recipient) {
            setError("Creator wallet is invalid.");
            return;
        }
        if (!publicKey || !connected || !signTransaction) {
            setError("Connect your Sakura wallet or copy the address to send from another wallet.");
            return;
        }
        if (!validAmount) {
            setError("Enter a valid SOL amount.");
            return;
        }

        try {
            setStatus("sending");
            setError("");
            setTxid("");

            const conn = new Connection(RPC_ENDPOINT, "confirmed");
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: recipient,
                    lamports: Math.round(amountNum * LAMPORTS_PER_SOL),
                }),
            );

            const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.feePayer = publicKey;

            const signed = await signTransaction(tx);
            const signature = await conn.sendRawTransaction(signed.serialize());
            await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

            setTxid(signature);
            setStatus("success");
            recordTip(signature, publicKey.toBase58(), recipient.toBase58(), amountNum).catch(() => undefined);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Donation failed.");
            setStatus("error");
        }
    };

    if (!recipient) return null;

    return (
        <div style={{
            marginBottom: 20,
            padding: 16,
            borderRadius: 16,
            background: "linear-gradient(135deg, rgba(255,107,157,0.12), rgba(138,43,226,0.10))",
            border: "1px solid rgba(255,107,157,0.22)",
        }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                    <h3 style={{ margin: 0, fontSize: 16, color: "var(--text-primary)" }}>Support this creator</h3>
                    <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)" }}>
                        Send SOL directly to the novel creator. Use Sakura wallet, or copy the address and send from Phantom, Solflare, or any Solana wallet.
                    </p>
                </div>
                <span style={{ fontSize: 20 }}>◎</span>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                {PRESET_SOL.map((preset) => (
                    <button
                        key={preset}
                        onClick={() => setAmount(String(preset))}
                        style={{
                            padding: "8px 12px",
                            borderRadius: 999,
                            border: amount === String(preset) ? "1px solid var(--sakura-pink)" : "1px solid rgba(255,255,255,0.1)",
                            background: amount === String(preset) ? "rgba(255,107,157,0.18)" : "rgba(255,255,255,0.04)",
                            color: "var(--text-primary)",
                            fontWeight: 700,
                            cursor: "pointer",
                        }}
                    >
                        {formatSol(preset)} SOL
                    </button>
                ))}
                <input
                    value={amount}
                    inputMode="decimal"
                    onChange={(e) => {
                        setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                        setError("");
                    }}
                    aria-label="Donation amount in SOL"
                    style={{
                        width: 94,
                        padding: "8px 10px",
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.18)",
                        color: "var(--text-primary)",
                        fontWeight: 700,
                    }}
                />
            </div>

            <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(0,0,0,0.18)",
                border: "1px solid rgba(255,255,255,0.08)",
                marginBottom: 12,
            }}>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {truncateAddress(recipient.toBase58())}
                </span>
                <button
                    onClick={copyAddress}
                    style={{ border: "none", background: "transparent", color: "var(--sakura-pink)", fontWeight: 800, cursor: "pointer" }}
                >
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>

            {error && <p style={{ margin: "0 0 10px", color: "#ff8a8a", fontSize: 12 }}>{error}</p>}
            {status === "success" && (
                <p style={{ margin: "0 0 10px", color: "#4ade80", fontSize: 12 }}>
                    Donation sent. {txid && <a href={`https://solscan.io/tx/${txid}`} target="_blank" rel="noopener noreferrer" style={{ color: "#4ade80", fontWeight: 700 }}>View on Solscan</a>}
                </p>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                    onClick={sendSol}
                    disabled={status === "sending" || !validAmount}
                    style={{
                        flex: "1 1 180px",
                        padding: "12px 16px",
                        borderRadius: 14,
                        border: "none",
                        background: "linear-gradient(135deg, var(--sakura-pink), var(--purple-accent))",
                        color: "#fff",
                        fontWeight: 800,
                        opacity: status === "sending" || !validAmount ? 0.6 : 1,
                        cursor: status === "sending" || !validAmount ? "wait" : "pointer",
                    }}
                >
                    {status === "sending" ? "Sending..." : `Send ${validAmount ? formatSol(amountNum) : ""} SOL`}
                </button>
                <a
                    href={solanaPayUrl}
                    style={{
                        flex: "1 1 150px",
                        textAlign: "center",
                        padding: "12px 16px",
                        borderRadius: 14,
                        textDecoration: "none",
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        color: "var(--text-primary)",
                        fontWeight: 800,
                    }}
                >
                    Open wallet app
                </a>
            </div>
        </div>
    );
}
