import { supabase } from "./supabase";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    createTransferInstruction,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
    SAKURA_MINT,
    SAKURA_TREASURY_ADMIN,
    getConnection,
    sakuraToSmallestUnit,
} from "./solana";
import { checkPassStatus } from "./pass-check";

/* ═══════ Types ═══════ */

export interface Novel {
    id: string;
    creator_wallet: string;
    title: string;
    description: string;
    cover_url: string;
    genres: string[];
    status: "ongoing" | "completed" | "hiatus";
    language: string;
    free_until_chapter: number;
    paid_from_chapter: number;
    price_per_chapter: number;
    allow_pass: boolean;
    published: boolean;
    created_at: string;
    updated_at: string;
}

export interface NovelChapter {
    id: string;
    novel_id: string;
    chapter_number: number;
    title: string;
    content: string;
    word_count: number;
    is_free_override: boolean;
    published: boolean;
    release_time: string | null;
    created_at: string;
}

export interface NovelUnlock {
    id: string;
    user_wallet: string;
    novel_id: string;
    chapter_number: number;
    tx_signature: string;
    amount: number;
    created_at: string;
}

export interface NovelProgress {
    user_wallet: string;
    novel_id: string;
    chapter_number: number;
    scroll_position: number;
    updated_at: string;
}

export interface NovelMilestone {
    id: string;
    user_wallet: string;
    novel_id: string;
    milestone_type: string;
    chapter_number: number | null;
    created_at: string;
}

export interface NovelComment {
    id: string;
    user_wallet: string;
    novel_id: string;
    chapter_number: number | null;
    content: string;
    created_at: string;
}

export interface NovelStats {
    totalReaders: number;
    totalUnlocks: number;
    totalEarnings: number;
    totalChapters: number;
}

/* ═══════ Constants ═══════ */

export const NOVEL_CREATOR_SPLIT = 0.70;
export const NOVEL_TREASURY_SPLIT = 0.30;

export const NOVEL_GENRES = [
    "Fantasy", "Sci-Fi", "Romance", "Mystery", "Action",
    "Horror", "Slice of Life", "Adventure", "Drama", "Comedy",
    "Thriller", "Historical", "Isekai", "Martial Arts", "Supernatural",
];

/* ═══════ Novel CRUD ═══════ */

export async function createNovel(
    wallet: string,
    data: Partial<Novel>
): Promise<Novel | null> {
    if (!supabase) return null;
    const { data: novel, error } = await supabase
        .from("novels")
        .insert({ creator_wallet: wallet, ...data })
        .select()
        .single();
    if (error) { console.error("createNovel:", error); return null; }
    return novel;
}

export async function updateNovel(
    novelId: string,
    wallet: string,
    data: Partial<Novel>
): Promise<boolean> {
    if (!supabase) return false;
    const { error } = await supabase
        .from("novels")
        .update({ ...data, updated_at: new Date().toISOString() })
        .eq("id", novelId)
        .eq("creator_wallet", wallet);
    if (error) { console.error("updateNovel:", error); return false; }
    return true;
}

export async function publishNovel(novelId: string, wallet: string): Promise<boolean> {
    return updateNovel(novelId, wallet, { published: true } as Partial<Novel>);
}

export async function getNovel(novelId: string): Promise<Novel | null> {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from("novels")
        .select("*")
        .eq("id", novelId)
        .single();
    if (error) { console.error("getNovel:", error); return null; }
    return data;
}

export async function getNovels(opts?: {
    genre?: string;
    search?: string;
    limit?: number;
}): Promise<Novel[]> {
    if (!supabase) return [];
    let query = supabase
        .from("novels")
        .select("*")
        .eq("published", true)
        .order("created_at", { ascending: false });

    if (opts?.genre) {
        query = query.contains("genres", [opts.genre]);
    }
    if (opts?.search) {
        query = query.ilike("title", `%${opts.search}%`);
    }
    if (opts?.limit) {
        query = query.limit(opts.limit);
    }
    const { data, error } = await query;
    if (error) { console.error("getNovels:", error); return []; }
    return data || [];
}

export async function getNovelsByCreator(wallet: string): Promise<Novel[]> {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from("novels")
        .select("*")
        .eq("creator_wallet", wallet)
        .order("created_at", { ascending: false });
    if (error) { console.error("getNovelsByCreator:", error); return []; }
    return data || [];
}

export async function deleteNovel(novelId: string, wallet: string): Promise<boolean> {
    if (!supabase) return false;
    const { error } = await supabase
        .from("novels")
        .delete()
        .eq("id", novelId)
        .eq("creator_wallet", wallet);
    if (error) { console.error("deleteNovel:", error); return false; }
    return true;
}

/* ═══════ Chapter CRUD ═══════ */

export async function createChapter(
    novelId: string,
    wallet: string,
    data: { chapter_number: number; title: string; content: string }
): Promise<NovelChapter | null> {
    if (!supabase) return null;
    const novel = await getNovel(novelId);
    if (!novel || novel.creator_wallet !== wallet) return null;

    const wordCount = data.content.trim().split(/\s+/).filter(Boolean).length;
    const { data: chapter, error } = await supabase
        .from("novel_chapters")
        .insert({
            novel_id: novelId,
            chapter_number: data.chapter_number,
            title: data.title,
            content: data.content,
            word_count: wordCount,
        })
        .select()
        .single();
    if (error) { console.error("createChapter:", error); return null; }
    return chapter;
}

export async function updateChapter(
    chapterId: string,
    wallet: string,
    data: Partial<NovelChapter>
): Promise<boolean> {
    if (!supabase) return false;
    const { data: chapter } = await supabase
        .from("novel_chapters")
        .select("novel_id")
        .eq("id", chapterId)
        .single();
    if (!chapter) return false;

    const novel = await getNovel(chapter.novel_id);
    if (!novel || novel.creator_wallet !== wallet) return false;

    const updates: Record<string, unknown> = { ...data };
    if (data.content !== undefined) {
        updates.word_count = data.content.trim().split(/\s+/).filter(Boolean).length;
    }
    delete updates.id;
    delete updates.novel_id;
    delete updates.created_at;

    const { error } = await supabase
        .from("novel_chapters")
        .update(updates)
        .eq("id", chapterId);
    if (error) { console.error("updateChapter:", error); return false; }
    return true;
}

export async function publishChapter(chapterId: string, wallet: string): Promise<boolean> {
    return updateChapter(chapterId, wallet, { published: true } as Partial<NovelChapter>);
}

export async function deleteChapter(chapterId: string, wallet: string): Promise<boolean> {
    if (!supabase) return false;
    const { data: chapter } = await supabase
        .from("novel_chapters")
        .select("novel_id")
        .eq("id", chapterId)
        .single();
    if (!chapter) return false;

    const novel = await getNovel(chapter.novel_id);
    if (!novel || novel.creator_wallet !== wallet) return false;

    const { error } = await supabase
        .from("novel_chapters")
        .delete()
        .eq("id", chapterId);
    if (error) { console.error("deleteChapter:", error); return false; }
    return true;
}

export async function getChapters(novelId: string): Promise<Omit<NovelChapter, "content">[]> {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from("novel_chapters")
        .select("id, novel_id, chapter_number, title, word_count, is_free_override, published, release_time, created_at")
        .eq("novel_id", novelId)
        .order("chapter_number", { ascending: true });
    if (error) { console.error("getChapters:", error); return []; }
    return data || [];
}

export async function getChapterContent(
    novelId: string,
    chapterNum: number
): Promise<NovelChapter | null> {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from("novel_chapters")
        .select("*")
        .eq("novel_id", novelId)
        .eq("chapter_number", chapterNum)
        .single();
    if (error) { console.error("getChapterContent:", error); return null; }
    return data;
}

/* ═══════ Paywall Logic ═══════ */

export async function canReadChapter(
    wallet: string | null,
    novelId: string,
    chapterNum: number
): Promise<boolean> {
    const novel = await getNovel(novelId);
    if (!novel) return false;

    if (chapterNum <= novel.free_until_chapter) return true;

    const chapter = await getChapterContent(novelId, chapterNum);
    if (chapter?.is_free_override) return true;

    if (!wallet) return false;

    if (!supabase) return false;
    const { data: unlock } = await supabase
        .from("novel_unlocks")
        .select("id")
        .eq("user_wallet", wallet)
        .eq("novel_id", novelId)
        .eq("chapter_number", chapterNum)
        .maybeSingle();
    if (unlock) return true;

    if (novel.allow_pass) {
        const pass = await checkPassStatus(wallet);
        if (pass.valid) return true;
    }

    return false;
}

export async function getUserUnlocks(wallet: string, novelId: string): Promise<number[]> {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from("novel_unlocks")
        .select("chapter_number")
        .eq("user_wallet", wallet)
        .eq("novel_id", novelId);
    if (error) return [];
    return (data || []).map(d => d.chapter_number);
}

/* ═══════ Unlock / Payment ═══════ */

export async function unlockChapter(
    wallet: string,
    novelId: string,
    chapterNum: number,
    txSig: string,
    amount: number
): Promise<boolean> {
    if (!supabase) return false;
    const { error } = await supabase
        .from("novel_unlocks")
        .upsert({
            user_wallet: wallet,
            novel_id: novelId,
            chapter_number: chapterNum,
            tx_signature: txSig,
            amount,
        }, { onConflict: "user_wallet, novel_id, chapter_number" });
    if (error) { console.error("unlockChapter:", error); return false; }
    await recordMilestone(wallet, novelId, "unlock", chapterNum);
    return true;
}

export async function buildChapterPaymentTx(
    userWallet: PublicKey,
    pricePerChapter: number,
    creatorWalletAddress: string
): Promise<{ tx: Transaction; blockhash: string; lastValidBlockHeight: number }> {
    const connection = getConnection();
    const creatorPubkey = new PublicKey(creatorWalletAddress);

    const creatorAmount = Math.floor(pricePerChapter * NOVEL_CREATOR_SPLIT);
    const treasuryAmount = pricePerChapter - creatorAmount;

    const userAta = await getAssociatedTokenAddress(SAKURA_MINT, userWallet, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const creatorAta = await getAssociatedTokenAddress(SAKURA_MINT, creatorPubkey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const treasuryAta = await getAssociatedTokenAddress(SAKURA_MINT, SAKURA_TREASURY_ADMIN, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const tx = new Transaction();

    const userAtaInfo = await connection.getAccountInfo(userAta);
    if (!userAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(userWallet, userAta, userWallet, SAKURA_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }

    const creatorAtaInfo = await connection.getAccountInfo(creatorAta);
    if (!creatorAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(userWallet, creatorAta, creatorPubkey, SAKURA_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }
    const treasuryAtaInfo = await connection.getAccountInfo(treasuryAta);
    if (!treasuryAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(userWallet, treasuryAta, SAKURA_TREASURY_ADMIN, SAKURA_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }

    tx.add(createTransferInstruction(userAta, creatorAta, userWallet, BigInt(sakuraToSmallestUnit(creatorAmount)), [], TOKEN_PROGRAM_ID));
    tx.add(createTransferInstruction(userAta, treasuryAta, userWallet, BigInt(sakuraToSmallestUnit(treasuryAmount)), [], TOKEN_PROGRAM_ID));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = userWallet;

    return { tx, blockhash, lastValidBlockHeight };
}

/* ═══════ Progress ═══════ */

export async function saveProgress(
    wallet: string,
    novelId: string,
    chapterNum: number,
    scrollPos: number
): Promise<void> {
    if (!supabase) return;
    await supabase
        .from("novel_progress")
        .upsert({
            user_wallet: wallet,
            novel_id: novelId,
            chapter_number: chapterNum,
            scroll_position: scrollPos,
            updated_at: new Date().toISOString(),
        }, { onConflict: "user_wallet, novel_id" });
}

export async function getProgress(wallet: string, novelId: string): Promise<NovelProgress | null> {
    if (!supabase) return null;
    const { data } = await supabase
        .from("novel_progress")
        .select("*")
        .eq("user_wallet", wallet)
        .eq("novel_id", novelId)
        .maybeSingle();
    return data;
}

/* ═══════ Milestones ═══════ */

export async function recordMilestone(
    wallet: string,
    novelId: string,
    type: string,
    chapterNum?: number
): Promise<void> {
    if (!supabase) return;
    await supabase
        .from("novel_milestones")
        .upsert({
            user_wallet: wallet,
            novel_id: novelId,
            milestone_type: type,
            chapter_number: chapterNum ?? null,
        }, { onConflict: "user_wallet, novel_id, milestone_type, chapter_number" })
        .then(({ error }) => { if (error) console.error("recordMilestone:", error); });
}

export async function getMilestones(wallet: string, novelId: string): Promise<NovelMilestone[]> {
    if (!supabase) return [];
    const { data } = await supabase
        .from("novel_milestones")
        .select("*")
        .eq("user_wallet", wallet)
        .eq("novel_id", novelId)
        .order("created_at", { ascending: false });
    return data || [];
}

/* ═══════ Comments ═══════ */

export async function getNovelComments(novelId: string, chapterNum?: number): Promise<NovelComment[]> {
    if (!supabase) return [];
    let query = supabase
        .from("novel_comments")
        .select("*")
        .eq("novel_id", novelId)
        .order("created_at", { ascending: false });
    if (chapterNum !== undefined) {
        query = query.eq("chapter_number", chapterNum);
    } else {
        query = query.is("chapter_number", null);
    }
    const { data } = await query;
    return data || [];
}

export async function postNovelComment(
    wallet: string,
    novelId: string,
    content: string,
    chapterNum?: number
): Promise<NovelComment | null> {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from("novel_comments")
        .insert({
            user_wallet: wallet,
            novel_id: novelId,
            chapter_number: chapterNum ?? null,
            content,
        })
        .select()
        .single();
    if (error) { console.error("postNovelComment:", error); return null; }
    return data;
}

export async function deleteNovelComment(commentId: string, wallet: string): Promise<boolean> {
    if (!supabase) return false;
    const { error } = await supabase
        .from("novel_comments")
        .delete()
        .eq("id", commentId)
        .eq("user_wallet", wallet);
    if (error) { console.error("deleteNovelComment:", error); return false; }
    return true;
}

/* ═══════ Stats (Creator Dashboard) ═══════ */

export async function getNovelStats(novelId: string): Promise<NovelStats> {
    if (!supabase) return { totalReaders: 0, totalUnlocks: 0, totalEarnings: 0, totalChapters: 0 };

    const [readers, unlocks, chapters] = await Promise.all([
        supabase.from("novel_progress").select("user_wallet", { count: "exact" }).eq("novel_id", novelId),
        supabase.from("novel_unlocks").select("amount", { count: "exact" }).eq("novel_id", novelId),
        supabase.from("novel_chapters").select("id", { count: "exact" }).eq("novel_id", novelId).eq("published", true),
    ]);

    const totalEarnings = (unlocks.data || []).reduce((sum, u) => sum + Number(u.amount || 0), 0);

    return {
        totalReaders: readers.count || 0,
        totalUnlocks: unlocks.count || 0,
        totalEarnings,
        totalChapters: chapters.count || 0,
    };
}
