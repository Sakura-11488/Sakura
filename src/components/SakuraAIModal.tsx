"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import {
    runSakuraAi,
    SAKURA_AI_MIN_BALANCE,
    aiGetSakuraBalance,
    type ConfirmSummary,
    type ChatMessage,
    type ToolEvent,
} from "@/lib/sakura-ai/engine";
import { getUsernameForWallet } from "@/lib/sakura-ai/usernames";
import {
    appendChatMessage,
    createChatThread,
    clearChatHistory,
    listChatThreads,
    loadChatHistory,
    renameChatThread,
    CHAT_DEFAULT_THREAD,
    type ChatThreadSummary,
    type StoredChatMessage,
} from "@/lib/sakura-ai/chat-history";
import { pollAlerts, summarizeAlert } from "@/lib/sakura-ai/alerts";
import { aiGetBridgeStatus } from "@/lib/sakura-ai/actions";
import { imageOrPlaceholder, isMissingOrPlaceholderImage } from "@/lib/media-fallback";
import {
    forgetMemory,
    listMemories,
    updateMemory,
    type SakuraMemory,
} from "@/lib/sakura-ai/memories";
import { useSakuraWalletModal } from "./SakuraWalletModal";

interface SakuraAIContextValue {
    visible: boolean;
    setVisible: (v: boolean) => void;
}

const SakuraAIContext = createContext<SakuraAIContextValue>({
    visible: false,
    setVisible: () => {},
});

export function useSakuraAI() {
    return useContext(SakuraAIContext);
}

export function SakuraAIProvider({ children }: { children: React.ReactNode }) {
    const [visible, setVisible] = useState(false);
    const { publicKey } = useWallet();
    const [alertToast, setAlertToast] = useState<string | null>(null);

    useEffect(() => {
        const walletAddress = publicKey?.toBase58();
        if (!walletAddress) return;
        let cancelled = false;
        const run = async () => {
            try {
                const triggered = await pollAlerts(walletAddress);
                if (cancelled || triggered.length === 0) return;
                setAlertToast(`Alert hit: ${triggered.map((t) => summarizeAlert(t.alert)).join(" • ")}`);
                setTimeout(() => {
                    if (!cancelled) setAlertToast(null);
                }, 7500);
            } catch {
                // keep app-wide alert polling best-effort
            }
        };
        run();
        const id = setInterval(run, 45_000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [publicKey]);

    return (
        <SakuraAIContext.Provider value={{ visible, setVisible }}>
            {children}
            {alertToast && <div className="sai-global-toast" role="status">{alertToast}</div>}
            {visible && <SakuraAIModal onClose={() => setVisible(false)} />}
        </SakuraAIContext.Provider>
    );
}

interface PendingConfirmation {
    summary: ConfirmSummary;
    resolve: (approved: boolean) => void;
}

interface DiscoveryCard {
    kind: "anime" | "manga" | "novel";
    id: string;
    title: string;
    image?: string;
    year?: number | null;
    score?: number | null;
    type?: string;
    route: string;
    genres?: string[];
}

interface UiMessage {
    role: "user" | "assistant" | "tool-event" | "cards" | "bridge-quote";
    content: string;
    toolName?: string;
    success?: boolean;
    cards?: DiscoveryCard[];
    cardsHeader?: string;
    bridgeQuote?: BridgeQuoteCard;
    /** Stable client-id used to persist + dedupe across history loads. */
    storedId?: string;
}

interface BridgeQuoteCard {
    fromChain: string;
    toChain: string;
    fromToken: string;
    toToken: string;
    inputAmount: number;
    expectedOutput: number;
    minOutput: number;
    slippageBps: number;
    priceImpactPct?: number | null;
    etaSeconds?: number;
    routeType?: string;
}

// Quick prompts are conversational examples — paraphrasing them, asking the
// same thing in slang, or skipping the example entirely should ALL work.
// They're starter sparks, not magic phrases.
const QUICK_PROMPTS = [
    "Catch me up on everything",
    "I wanna keep watching from where I stopped",
    "Gimme something to read tonight",
    "I'm in the mood for something cozy",
    "Bring me up to speed on Chainsaw Man",
    "Buy me 0.5 SOL of SAKURA",
    "Send a tip to the author of Jujutsu Kaisen",
    "Ping me if SOL goes above 300",
];

function SakuraAIModal({ onClose }: { onClose: () => void }) {
    const { publicKey, signTransaction, connected } = useWallet();
    const { setVisible: setWalletModalVisible } = useSakuraWalletModal();

    const walletAddress = publicKey?.toBase58() || "";
    const [sakuraBalance, setSakuraBalance] = useState<number | null>(null);
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [username, setUsername] = useState<string | null>(null);

    const [messages, setMessages] = useState<UiMessage[]>([]);
    const [conversation, setConversation] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<PendingConfirmation | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [closing, setClosing] = useState(false);
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [threadId, setThreadId] = useState(CHAT_DEFAULT_THREAD);
    const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
    const [threadPanelOpen, setThreadPanelOpen] = useState(false);
    const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
    const [memories, setMemories] = useState<SakuraMemory[]>([]);
    const [bridgeTracker, setBridgeTracker] = useState<{
        signature: string;
        status: string;
        explorerUrl?: string;
    } | null>(null);

    const scrollRef = useRef<HTMLDivElement | null>(null);

    const refreshGate = useCallback(async () => {
        if (!walletAddress) return;
        setBalanceLoading(true);
        try {
            const [bal, u] = await Promise.all([
                aiGetSakuraBalance(walletAddress),
                getUsernameForWallet(walletAddress),
            ]);
            setSakuraBalance(bal);
            setUsername(u?.username || null);
        } finally {
            setBalanceLoading(false);
        }
    }, [walletAddress]);

    useEffect(() => {
        if (!walletAddress) {
            setSakuraBalance(0);
            setUsername(null);
            return;
        }
        refreshGate();
    }, [walletAddress, refreshGate]);

    useEffect(() => {
        if (!walletAddress) return;
        setThreads(listChatThreads(walletAddress));
        let cancelled = false;
        setHistoryLoading(true);
        setHistoryLoaded(false);
        loadChatHistory(walletAddress, threadId)
            .then((stored) => {
                if (cancelled) return;
                const ui = restoreUiMessagesFromStored(stored);
                setMessages(ui.uiMessages);
                setConversation(ui.engineHistory);
                setHistoryLoaded(true);
            })
            .catch(() => {
                if (cancelled) return;
                setHistoryLoaded(true);
            })
            .finally(() => {
                if (!cancelled) setHistoryLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [walletAddress, threadId]);

    useEffect(() => {
        if (!bridgeTracker?.signature) return;
        let cancelled = false;
        const run = async () => {
            const res = await aiGetBridgeStatus(bridgeTracker.signature);
            if (cancelled || !res.ok) return;
            setBridgeTracker({
                signature: res.data.signature,
                status: res.data.status,
                explorerUrl: res.data.explorerUrl,
            });
        };
        run();
        const id = setInterval(run, 15_000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [bridgeTracker?.signature]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, busy, pending]);

    const allowed = useMemo(() => {
        if (!connected || !walletAddress) return false;
        if (sakuraBalance == null) return false;
        return sakuraBalance >= SAKURA_AI_MIN_BALANCE;
    }, [connected, walletAddress, sakuraBalance]);

    const handleClose = useCallback(() => {
        setClosing(true);
        setTimeout(() => onClose(), 200);
    }, [onClose]);

    const requireConfirm = useCallback((summary: ConfirmSummary) => {
        return new Promise<boolean>((resolve) => {
            setPending({ summary, resolve });
        });
    }, []);

    const resolveConfirm = useCallback((approved: boolean) => {
        setPending((current) => {
            current?.resolve(approved);
            return null;
        });
    }, []);

    const refreshMemories = useCallback(async () => {
        if (!walletAddress) return;
        setMemories(await listMemories(walletAddress, 30));
    }, [walletAddress]);

    const onToolProgress = useCallback((event: ToolEvent) => {
        const success = event.result?.ok !== false && !event.result?.error;
        const toolBubble: UiMessage = {
            role: "tool-event",
            toolName: event.name,
            success,
            content: describeToolEvent(event),
        };
        const next: UiMessage[] = [toolBubble];

        // Cards header: prefer an explicit `cards_header` from the engine
        // (continue / recommend / mood / brief), fall back to the
        // "Inspired by <ref>" pattern from find_similar_*.
        const cards: DiscoveryCard[] = Array.isArray(event.result?.cards) ? event.result.cards : [];
        if (cards.length > 0) {
            const explicit = event.result?.cards_header;
            const ref = event.result?.reference || "";
            const genre = event.result?.matched_genre;
            const headerBits = explicit
                ? explicit
                : [
                      ref ? `Inspired by ${ref}` : "",
                      genre ? `· ${genre}` : "",
                  ].filter(Boolean).join(" ");
            next.push({
                role: "cards",
                content: "",
                cards,
                cardsHeader: headerBits,
            });
        }

        if (event.name === "bridge_quote" && event.result?.ok) {
            next.push({
                role: "bridge-quote",
                content: "",
                bridgeQuote: bridgeQuoteFromResult(event.result),
            });
        }

        if (event.name === "bridge_execute" && event.result?.signature) {
            setBridgeTracker({
                signature: event.result.signature,
                status: "SUBMITTED",
                explorerUrl: event.result.explorer_url,
            });
        }

        setMessages((prev) => [...prev, ...next]);

        // Persist tool events + card payloads. Cloud sync makes them
        // re-renderable on a fresh device after a wallet import.
        if (walletAddress) {
            void appendChatMessage(walletAddress, {
                role: "tool",
                content: toolBubble.content,
                toolName: event.name,
                toolPayload: event.result ?? null,
                threadId,
            });
            if (cards.length > 0) {
                const headerBits = next[next.length - 1].cardsHeader || "";
                void appendChatMessage(walletAddress, {
                    role: "tool",
                    content: "",
                    toolName: `${event.name}__cards`,
                    cards: cards as any[],
                    cardsHeader: headerBits,
                    threadId,
                });
            }
            if (event.name === "bridge_quote" && event.result?.ok) {
                void appendChatMessage(walletAddress, {
                    role: "tool",
                    content: "",
                    toolName: "bridge_quote__card",
                    toolPayload: event.result,
                    threadId,
                });
            }
        }
    }, [walletAddress, threadId]);

    const send = useCallback(async (text: string) => {
        if (!text.trim() || busy) return;
        if (!publicKey || !signTransaction) {
            setError("Connect your wallet first.");
            return;
        }
        setError(null);
        const trimmed = text;
        setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
        setInput("");
        setBusy(true);

        const wallet = publicKey.toBase58();
        if (wallet) {
            void appendChatMessage(wallet, { role: "user", content: trimmed, threadId });
        }

        try {
            const result = await runSakuraAi({
                history: conversation,
                userMessage: trimmed,
                context: {
                    walletPublicKey: publicKey,
                    walletAddress: wallet,
                    signTransaction: signTransaction as (tx: Transaction) => Promise<Transaction>,
                    signTransactionVersioned: signTransaction as unknown as (tx: VersionedTransaction) => Promise<VersionedTransaction>,
                    requireConfirm,
                    onToolProgress,
                },
            });
            setConversation(result.history);
            const reply = result.reply || "(empty response)";
            setMessages((prev) => [
                ...prev,
                { role: "assistant", content: reply },
            ]);
            if (wallet) {
                void appendChatMessage(wallet, { role: "assistant", content: reply, threadId });
                setThreads(listChatThreads(wallet));
            }
        } catch (e: any) {
            console.error("[sakura-ai] run failed", e);
            setError(e?.message || "Sakura ran into an error. Try again.");
        } finally {
            setBusy(false);
        }
    }, [busy, publicKey, signTransaction, conversation, requireConfirm, onToolProgress, threadId]);

    const handleClearChat = useCallback(async () => {
        if (!walletAddress) return;
        if (!confirm("Clear this chat? History on other devices will also be removed.")) return;
        await clearChatHistory(walletAddress, threadId);
        setThreads(listChatThreads(walletAddress));
        setMessages([]);
        setConversation([]);
    }, [walletAddress, threadId]);

    const handleNewThread = useCallback(() => {
        if (!walletAddress) return;
        const thread = createChatThread(walletAddress);
        setThreads(listChatThreads(walletAddress));
        setThreadId(thread.id);
        setMessages([]);
        setConversation([]);
        setThreadPanelOpen(false);
    }, [walletAddress]);

    return (
        <>
            <div
                className={`sai-backdrop ${closing ? "closing" : ""}`}
                onClick={handleClose}
            />
            <div className={`sai-container ${closing ? "closing" : ""}`} role="dialog" aria-modal>
                <header className="sai-header">
                    <div className="sai-header-id">
                        <div className="sai-avatar" aria-hidden>
                            <span>桜</span>
                        </div>
                        <div>
                            <div className="sai-title">Sakura AI</div>
                            <div className="sai-sub">
                                {username ? `Hi, @${username}` : "Your on-chain agent"}
                            </div>
                        </div>
                    </div>
                    <div className="sai-header-actions">
                        <button
                            className="sai-header-btn"
                            onClick={() => setThreadPanelOpen((v) => !v)}
                            aria-label="Chat threads"
                            title="Chat threads"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
                            </svg>
                        </button>
                        <button
                            className="sai-header-btn"
                            onClick={async () => {
                                await refreshMemories();
                                setMemoryPanelOpen((v) => !v);
                            }}
                            aria-label="Memory review"
                            title="Memory review"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2v20" />
                                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H15a3.5 3.5 0 0 1 0 7H7" />
                            </svg>
                        </button>
                        {messages.length > 0 && (
                            <button
                                className="sai-header-btn"
                                onClick={handleNewThread}
                                aria-label="New chat"
                                title="New chat"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 5v14" />
                                    <path d="M5 12h14" />
                                </svg>
                            </button>
                        )}
                        <button className="sai-close" onClick={handleClose} aria-label="Close">×</button>
                    </div>
                </header>

                {bridgeTracker && (
                    <div className="sai-alert-toast bridge" role="status">
                        Bridge status: {formatBridgeStatus(bridgeTracker.status)}
                        {bridgeTracker.explorerUrl && (
                            <a href={bridgeTracker.explorerUrl} target="_blank" rel="noreferrer">Track</a>
                        )}
                    </div>
                )}

                {threadPanelOpen && (
                    <div className="sai-thread-panel">
                        <div className="sai-thread-panel-head">
                            <strong>Chats</strong>
                            <button onClick={handleNewThread}>New</button>
                        </div>
                        <div className="sai-thread-list">
                            {threads.map((t) => (
                                <div key={t.id} className={`sai-thread-row ${t.id === threadId ? "active" : ""}`}>
                                    <button
                                        className="sai-thread-item"
                                        onClick={() => {
                                            setThreadId(t.id);
                                            setThreadPanelOpen(false);
                                        }}
                                    >
                                        <span>{t.title}</span>
                                        {t.lastMessage && <small>{t.lastMessage}</small>}
                                    </button>
                                    <button
                                        className="sai-thread-mini"
                                        onClick={() => {
                                            const title = prompt("Rename chat", t.title);
                                            if (!title || !walletAddress) return;
                                            renameChatThread(walletAddress, t.id, title);
                                            setThreads(listChatThreads(walletAddress));
                                        }}
                                    >Rename</button>
                                    <button
                                        className="sai-thread-mini danger"
                                        onClick={async () => {
                                            if (!walletAddress || !confirm("Delete this chat?")) return;
                                            await clearChatHistory(walletAddress, t.id);
                                            setThreads(listChatThreads(walletAddress));
                                            if (t.id === threadId) {
                                                setThreadId(CHAT_DEFAULT_THREAD);
                                                setMessages([]);
                                                setConversation([]);
                                            }
                                        }}
                                    >Delete</button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {memoryPanelOpen && (
                    <div className="sai-thread-panel sai-memory-panel">
                        <div className="sai-thread-panel-head">
                            <strong>Memory review</strong>
                            <button onClick={refreshMemories}>Refresh</button>
                        </div>
                        <div className="sai-memory-list">
                            {memories.length === 0 && (
                                <div className="sai-memory-empty">No saved memories yet.</div>
                            )}
                            {memories.map((m) => (
                                <div className="sai-memory-row" key={m.id}>
                                    <div>
                                        <strong>{m.note}</strong>
                                        {m.tag && <small>#{m.tag}</small>}
                                    </div>
                                    <button onClick={async () => {
                                        const note = prompt("Edit memory", m.note);
                                        if (!note || !walletAddress) return;
                                        await updateMemory(walletAddress, m.id, note, m.tag);
                                        await refreshMemories();
                                    }}>Edit</button>
                                    <button className="danger" onClick={async () => {
                                        if (!walletAddress || !confirm("Forget this memory?")) return;
                                        await forgetMemory(walletAddress, { id: m.id });
                                        await refreshMemories();
                                    }}>Forget</button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {!allowed ? (
                    <Gate
                        connected={connected}
                        balance={sakuraBalance}
                        loading={balanceLoading}
                        onConnect={() => {
                            handleClose();
                            setWalletModalVisible(true);
                        }}
                        onRefresh={refreshGate}
                    />
                ) : (
                    <>
                        <div ref={scrollRef} className="sai-messages">
                            {historyLoading && messages.length === 0 && (
                                <div className="sai-history-loading">
                                    <div className="sai-typing"><span /><span /><span /></div>
                                    <div>Loading your chat history…</div>
                                </div>
                            )}
                            {!historyLoading && messages.length === 0 && (
                                <Welcome username={username} onPick={(p) => send(p)} firstTime={!historyLoaded} />
                            )}
                            {messages.map((m, i) => <Bubble key={m.storedId || i} message={m} onClose={handleClose} />)}
                            {busy && (
                                <div className="sai-bubble assistant">
                                    <div className="sai-typing"><span /><span /><span /></div>
                                </div>
                            )}
                            {error && <div className="sai-error">{error}</div>}
                        </div>

                        <form
                            className="sai-input-row"
                            onSubmit={(e) => { e.preventDefault(); send(input); }}
                        >
                            <input
                                className="sai-input"
                                placeholder="Ask Sakura anything…"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                disabled={busy}
                            />
                            <button
                                type="submit"
                                className="sai-send"
                                disabled={busy || !input.trim()}
                                aria-label="Send"
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 2 11 13" />
                                    <path d="M22 2 15 22 11 13 2 9z" />
                                </svg>
                            </button>
                        </form>
                    </>
                )}

                {pending && (
                    <ConfirmSheet
                        summary={pending.summary}
                        onResolve={resolveConfirm}
                    />
                )}
            </div>
        </>
    );
}

function Welcome({
    username,
    onPick,
    firstTime,
}: {
    username: string | null;
    onPick: (p: string) => void;
    firstTime?: boolean;
}) {
    return (
        <div className="sai-welcome">
            <div className="sai-welcome-emoji">🌸</div>
            <h3>{username ? `Welcome back, @${username}` : "Hi, I'm Sakura"}</h3>
            <p>
                {firstTime
                    ? "Read your wallet, swap, tip creators, recommend anime, set price alerts, recap a series — try one:"
                    : "Wallet, swaps, transfers, bridges, recommendations, recaps, alerts, memory. Try one:"}
            </p>
            <div className="sai-quick">
                {QUICK_PROMPTS.map((p) => (
                    <button key={p} className="sai-quick-chip" onClick={() => onPick(p)}>{p}</button>
                ))}
            </div>
        </div>
    );
}

function Bubble({ message, onClose }: { message: UiMessage; onClose: () => void }) {
    const router = useRouter();
    const openCard = useCallback((event: React.MouseEvent<HTMLAnchorElement>, route: string) => {
        event.preventDefault();
        if (!route) return;
        router.push(route);
        onClose();
    }, [onClose, router]);

    if (message.role === "tool-event") {
        return (
            <div className={`sai-tool ${message.success ? "ok" : "fail"}`}>
                <span className="sai-tool-dot" />
                <span className="sai-tool-name">{message.toolName}</span>
                <span className="sai-tool-detail">{message.content}</span>
            </div>
        );
    }
    if (message.role === "cards") {
        return (
            <div className="sai-cards">
                {message.cardsHeader && (
                    <div className="sai-cards-head">{message.cardsHeader}</div>
                )}
                <div className="sai-cards-row">
                    {(message.cards || []).map((card) => (
                        <a
                            key={`${card.kind}-${card.id}`}
                            href={card.route}
                            className="sai-card"
                            onClick={(event) => openCard(event, card.route)}
                        >
                            <div className="sai-card-img">
                                <span className="sai-card-fallback">{card.title.slice(0, 2)}</span>
                                {!isMissingOrPlaceholderImage(card.image) && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={imageOrPlaceholder(card.image)}
                                        alt={card.title}
                                        loading="lazy"
                                        decoding="async"
                                        referrerPolicy="no-referrer"
                                        onError={(event) => {
                                            event.currentTarget.style.display = "none";
                                        }}
                                    />
                                )}
                                <span className={`sai-card-kind k-${card.kind}`}>{card.kind}</span>
                            </div>
                            <div className="sai-card-body">
                                <div className="sai-card-title">{card.title}</div>
                                <div className="sai-card-meta">
                                    {card.year ? <span>{card.year}</span> : null}
                                    {card.score ? <span>· ★ {Number(card.score).toFixed(1)}</span> : null}
                                </div>
                            </div>
                        </a>
                    ))}
                </div>
            </div>
        );
    }
    if (message.role === "bridge-quote" && message.bridgeQuote) {
        const q = message.bridgeQuote;
        return (
            <div className="sai-bridge-card">
                <div className="sai-bridge-head">
                    <span>{q.routeType || "Mayan"}</span>
                    <strong>{q.fromChain} → {q.toChain}</strong>
                </div>
                <div className="sai-bridge-route">
                    <div>
                        <small>You send</small>
                        <b>{formatAmount(q.inputAmount, 6)} {q.fromToken}</b>
                    </div>
                    <span>→</span>
                    <div>
                        <small>Est. receive</small>
                        <b>{formatAmount(q.expectedOutput, 6)} {q.toToken}</b>
                    </div>
                </div>
                <div className="sai-bridge-meta">
                    <span>Min {formatAmount(q.minOutput, 6)} {q.toToken}</span>
                    <span>Slippage {(q.slippageBps / 100).toFixed(2)}%</span>
                    {q.priceImpactPct != null && <span>Impact {Number(q.priceImpactPct).toFixed(2)}%</span>}
                    {q.etaSeconds ? <span>ETA ~{formatEta(q.etaSeconds)}</span> : null}
                </div>
            </div>
        );
    }
    return (
        <div className={`sai-bubble ${message.role}`}>{message.content}</div>
    );
}

function ConfirmSheet({ summary, onResolve }: { summary: ConfirmSummary; onResolve: (ok: boolean) => void }) {
    return (
        <div className="sai-confirm">
            <div className="sai-confirm-card">
                <div className="sai-confirm-kind">{labelForKind(summary.kind)}</div>
                <h4>{summary.title}</h4>
                <p>{summary.detail}</p>
                <div className="sai-confirm-actions">
                    <button className="sai-confirm-no" onClick={() => onResolve(false)}>Cancel</button>
                    <button className="sai-confirm-yes" onClick={() => onResolve(true)}>Confirm</button>
                </div>
            </div>
        </div>
    );
}

function Gate({
    connected,
    balance,
    loading,
    onConnect,
    onRefresh,
}: {
    connected: boolean;
    balance: number | null;
    loading: boolean;
    onConnect: () => void;
    onRefresh: () => void;
}) {
    return (
        <div className="sai-gate">
            <div className="sai-gate-emoji">🔐</div>
            {!connected && <h3>Connect your wallet to chat with Sakura</h3>}
            {connected && (
                <>
                    <h3>Hold {SAKURA_AI_MIN_BALANCE.toLocaleString()} $SAKURA to unlock Sakura AI</h3>
                    <p>
                        {loading
                            ? "Checking your balance…"
                            : `You currently hold ${(balance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} $SAKURA.`}
                    </p>
                </>
            )}
            <p className="sai-gate-sub">
                Your AI agent can analyze your wallet, swap tokens, send transfers, bridge cross-chain, and recommend anime / manga — gated to active SAKURA holders.
            </p>
            <div className="sai-gate-actions">
                {!connected ? (
                    <button className="sai-gate-cta" onClick={onConnect}>Connect Wallet</button>
                ) : (
                    <>
                        <a className="sai-gate-cta" href="/pass">Get $SAKURA</a>
                        <button className="sai-gate-refresh" onClick={onRefresh} disabled={loading}>
                            {loading ? "Checking…" : "Refresh balance"}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function labelForKind(k: ConfirmSummary["kind"]): string {
    switch (k) {
        case "transfer_sol": return "TRANSFER";
        case "transfer_token": return "TRANSFER";
        case "swap": return "SWAP";
        case "bridge": return "BRIDGE";
        case "set_username": return "PROFILE";
        case "tip_creator": return "TIP";
        case "set_memory": return "MEMORY";
        case "create_evm_wallet": return "EVM WALLET";
        case "set_price_alert": return "ALERT";
    }
}

function describeToolEvent(event: ToolEvent): string {
    const r = event.result || {};
    if (r.error) return `Error: ${r.error}`;
    switch (event.name) {
        case "swap_quote":
            return `Quoted ${formatAmount(r.input_amount)} ${r.input?.toUpperCase()} → ${formatAmount(r.output_amount, 6)} ${r.output?.toUpperCase()}`;
        case "swap_execute":
            return r.signature ? `Swap confirmed (${r.signature.slice(0, 8)}…)` : "Swap done";
        case "transfer_sol":
            return r.signature ? `SOL sent (${r.signature.slice(0, 8)}…)` : "SOL sent";
        case "transfer_token":
            return r.signature ? `${r.symbol || "Token"} sent (${r.signature.slice(0, 8)}…)` : "Token sent";
        case "bridge_quote":
            return r.ok
                ? `Bridge quote: ${formatAmount(r.input_amount)} ${r.from_token} → ~${formatAmount(r.expected_output, 6)} ${r.to_token} (${r.route_type})`
                : "Bridge quote failed";
        case "bridge_execute":
            return r.signature ? `Bridge submitted (${r.signature.slice(0, 8)}…)` : "Bridge submitted";
        case "bridge_status":
            return r.status ? `Bridge ${formatBridgeStatus(r.status)}` : "Bridge status checked";
        case "bridge_open":
            return "Mayan bridge opened";
        case "get_evm_bridge_wallet":
            return r.exists ? `EVM bridge wallet ${String(r.address).slice(0, 8)}…` : "No EVM bridge wallet yet";
        case "create_evm_bridge_wallet":
            return r.address ? `Created EVM bridge wallet ${String(r.address).slice(0, 8)}…` : "EVM wallet not created";
        case "reveal_evm_bridge_key":
            return r.ok ? "EVM private key revealed for backup" : "EVM key not revealed";
        case "set_username":
            if (r.ok) return `Saved @${r.username}`;
            if (r.reason === "taken") return "Username taken";
            if (r.reason === "placeholder") return "Asked again — placeholder rejected";
            return "Username unchanged";
        case "find_user":
            return r.found ? `Found @${r.username} → ${String(r.wallet).slice(0, 6)}…` : "User not found";
        case "get_my_balances":
            return `Total ≈ $${(r.total_value_usd ?? 0).toFixed(2)}, ${r.holdings?.length ?? 0} tokens`;
        case "analyze_wallet":
            return `≈ $${(r.total_value_usd ?? 0).toFixed(2)} total`;
        case "recent_activity":
            return `${r.transactions?.length ?? 0} recent txs`;
        case "lookup_token":
            return r.symbol ? `${r.symbol}${r.price_usd ? ` @ $${Number(r.price_usd).toFixed(6)}` : ""}` : "";
        case "find_similar_anime":
        case "find_similar_manga":
        case "find_similar_novels": {
            const n = Array.isArray(r.cards) ? r.cards.length : 0;
            const kind = event.name.replace("find_similar_", "");
            return n > 0 ? `Found ${n} similar ${kind}` : `No ${kind} matches`;
        }
        case "continue_where_i_left_off": {
            const n = Array.isArray(r.cards) ? r.cards.length : 0;
            return n > 0 ? `${n} resume cards` : "Nothing to resume yet";
        }
        case "recommend_for_me": {
            const n = Array.isArray(r.cards) ? r.cards.length : 0;
            return n > 0 ? `Personalised picks (${n})` : "Need more history first";
        }
        case "mood_pick": {
            const n = Array.isArray(r.cards) ? r.cards.length : 0;
            const tags = Array.isArray(r.matched_genres) ? r.matched_genres.join(", ") : "";
            return n > 0 ? `${n} picks · ${tags}` : "No mood matches";
        }
        case "recap_anime":
        case "recap_manga": {
            const t = r.title ? r.title : event.name;
            const upTo = r.up_to ? ` · up to ${r.up_to.type} ${r.up_to.number}` : "";
            return `Recap ready: ${t}${upTo}`;
        }
        case "find_creator_to_tip": {
            if (r.ok && r.creator) return `${r.creator} (${r.work_title || "Sakura creator"}) → ${String(r.wallet || "").slice(0, 6)}…`;
            if (r.author) return `${r.author} isn't on Sakura yet`;
            return "Couldn't find that creator";
        }
        case "tip_creator": {
            if (r.ok && r.signature) return `Tipped ${r.creator || ""} (${(r.signature || "").slice(0, 8)}…)`;
            return r.error || "Tip cancelled";
        }
        case "remember": {
            if (r.ok) return "Memory saved";
            return r.error || "Memory not saved";
        }
        case "recall_memories": {
            return `${r.count ?? 0} memories`;
        }
        case "forget": {
            if (r.ok) return `Forgot ${r.deleted ?? 0}`;
            return r.error || "Nothing to forget";
        }
        case "set_price_alert": {
            if (r.ok) return `Alert set: ${r.summary}`;
            return r.error || "Alert not set";
        }
        case "list_price_alerts": {
            const a = Array.isArray(r.active) ? r.active.length : 0;
            const t = Array.isArray(r.triggered) ? r.triggered.length : 0;
            return `${a} active · ${t} recently triggered`;
        }
        case "cancel_price_alert": {
            return r.ok ? "Alert cancelled" : (r.error || "Couldn't cancel");
        }
        case "daily_brief": {
            const b = r.brief || {};
            const total = b?.portfolio?.total_value_usd;
            const alerts = (b?.activeAlerts?.length ?? 0) + (b?.triggeredAlerts?.length ?? 0);
            const resume = b?.resume?.length ?? 0;
            const bits = [
                total != null ? `≈ $${Number(total).toFixed(2)}` : "",
                alerts ? `${alerts} alerts` : "",
                resume ? `${resume} to resume` : "",
            ].filter(Boolean).join(" · ");
            return bits || "Brief ready";
        }
        default:
            return event.name;
    }
}

function formatAmount(value: any, decimals?: number): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value ?? "");
    const opts: Intl.NumberFormatOptions =
        decimals != null
            ? { maximumFractionDigits: decimals }
            : { maximumFractionDigits: n >= 1000 ? 0 : 4 };
    return n.toLocaleString(undefined, opts);
}

function bridgeQuoteFromResult(r: any): BridgeQuoteCard {
    return {
        fromChain: r.from_chain || "",
        toChain: r.to_chain || "",
        fromToken: r.from_token || "",
        toToken: r.to_token || "",
        inputAmount: Number(r.input_amount || 0),
        expectedOutput: Number(r.expected_output || 0),
        minOutput: Number(r.min_output || 0),
        slippageBps: Number(r.slippage_bps || 0),
        priceImpactPct: r.price_impact_pct == null ? null : Number(r.price_impact_pct),
        etaSeconds: Number(r.eta_seconds || 0),
        routeType: r.route_type || "Mayan",
    };
}

function formatEta(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "soon";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    return `${Math.round(seconds / 60)}m`;
}

function formatBridgeStatus(status: string): string {
    const value = (status || "").replace(/_/g, " ").toLowerCase();
    if (!value) return "checking";
    return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Reconstruct the in-memory chat state from rows persisted by chat-history.
 * - Plain user / assistant messages become regular bubbles.
 * - Stored tool rows become either a tool-event bubble or a cards bubble
 *   (we tagged the cards row with `__cards` suffix at save time).
 * - We also rebuild the model-side `engineHistory` so subsequent turns can
 *   continue the existing conversation seamlessly.
 */
function restoreUiMessagesFromStored(stored: StoredChatMessage[]): {
    uiMessages: UiMessage[];
    engineHistory: ChatMessage[];
} {
    const uiMessages: UiMessage[] = [];
    const engineHistory: ChatMessage[] = [];

    for (const row of stored) {
        if (row.role === "user") {
            uiMessages.push({ role: "user", content: row.content || "", storedId: row.id });
            engineHistory.push({ role: "user", content: row.content || "" });
            continue;
        }
        if (row.role === "assistant") {
            uiMessages.push({ role: "assistant", content: row.content || "", storedId: row.id });
            engineHistory.push({ role: "assistant", content: row.content || "" });
            continue;
        }
        if (row.role === "tool") {
            const toolName = row.toolName || "";
            if (toolName.endsWith("__cards") && Array.isArray(row.cards)) {
                uiMessages.push({
                    role: "cards",
                    content: "",
                    cards: row.cards as DiscoveryCard[],
                    cardsHeader: row.cardsHeader || "",
                    storedId: row.id,
                });
            } else if (toolName === "bridge_quote__card" && row.toolPayload?.ok) {
                uiMessages.push({
                    role: "bridge-quote",
                    content: "",
                    bridgeQuote: bridgeQuoteFromResult(row.toolPayload),
                    storedId: row.id,
                });
            } else {
                const success = row.toolPayload?.ok !== false && !row.toolPayload?.error;
                uiMessages.push({
                    role: "tool-event",
                    toolName,
                    success,
                    content: row.content || "",
                    storedId: row.id,
                });
            }
            // Skip tool messages in the engine history we hand to the model —
            // OpenAI-style tool messages must reference a corresponding tool_call_id
            // that we don't preserve across reloads. We start fresh tool
            // chains on each new turn while the user-visible cards remain.
            continue;
        }
        // system rows are not currently persisted; ignored if they appear.
    }

    return { uiMessages, engineHistory };
}
