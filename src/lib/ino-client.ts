/**
 * Core client for the Ino on-chain participation registry.
 * Handles PDA derivation and instruction building for chapter unlocks,
 * milestone claims, completion tracking, and creator support recording.
 *
 * Program: E9ju12He2mnBRaneM4xdtUXECDPXdpQQbU6HtSKb6Hpf
 * Repo:    https://github.com/millw14/ino-sakura-registry
 */
import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { INO_PROGRAM_ID } from "./solana";
import { createHash } from "crypto";

function sha256(input: string): Buffer {
    return createHash("sha256").update(input).digest();
}

function hashSeed(value: string): Uint8Array {
    return new Uint8Array(sha256(value));
}

// ============ PDA Derivation ============

export async function getUserChapterPDA(
    user: PublicKey,
    seriesId: string,
    chapterId: string
): Promise<[PublicKey, number]> {
    const seriesHash = hashSeed(seriesId);
    const chapterHash = hashSeed(chapterId);
    return PublicKey.findProgramAddressSync(
        [Buffer.from("user-chapter"), user.toBuffer(), seriesHash, chapterHash],
        INO_PROGRAM_ID
    );
}

export async function getChapterStatsPDA(
    seriesId: string,
    chapterId: string
): Promise<[PublicKey, number]> {
    const seriesHash = hashSeed(seriesId);
    const chapterHash = hashSeed(chapterId);
    return PublicKey.findProgramAddressSync(
        [Buffer.from("chapter-stats"), seriesHash, chapterHash],
        INO_PROGRAM_ID
    );
}

export async function getMilestoneConfigPDA(
    seriesId: string,
    chapterId: string,
    milestoneType: string
): Promise<[PublicKey, number]> {
    const seriesHash = hashSeed(seriesId);
    const chapterHash = hashSeed(chapterId);
    const typeHash = hashSeed(milestoneType);
    return PublicKey.findProgramAddressSync(
        [Buffer.from("milestone-config"), seriesHash, chapterHash, typeHash],
        INO_PROGRAM_ID
    );
}

export async function getUserMilestonePDA(
    user: PublicKey,
    milestoneConfig: PublicKey
): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("user-milestone"), user.toBuffer(), milestoneConfig.toBuffer()],
        INO_PROGRAM_ID
    );
}

export async function getUserSupportPDA(
    user: PublicKey,
    creator: PublicKey
): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("support"), user.toBuffer(), creator.toBuffer()],
        INO_PROGRAM_ID
    );
}

// ============ Instruction Sighashes ============

const SIGHASH_UNLOCK_CHAPTER = Buffer.from("a]4\x8b\xc2\x01\x9a\x12", "binary");
const SIGHASH_COMPLETE_CHAPTER = Buffer.from("\x1b\xf9\xe7\xd3\xa0\x15\xcc\x4e", "binary");
const SIGHASH_CLAIM_MILESTONE = Buffer.from("\xe3\x02\x88\x5d\xf1\xa7\x3c\x90", "binary");
const SIGHASH_RECORD_SUPPORT = Buffer.from("\x7a\xb0\x44\x31\xd5\xe8\xbb\x19", "binary");

// ============ Instruction Builders ============

export function buildUnlockChapterIx(
    user: PublicKey,
    userChapter: PublicKey,
    chapterStats: PublicKey,
    seriesId: string,
    chapterId: string
): TransactionInstruction {
    const seriesHash = hashSeed(seriesId);
    const chapterHash = hashSeed(chapterId);

    const data = Buffer.concat([
        SIGHASH_UNLOCK_CHAPTER,
        Buffer.from(seriesHash),
        Buffer.from(chapterHash),
    ]);

    return new TransactionInstruction({
        programId: INO_PROGRAM_ID,
        keys: [
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: userChapter, isSigner: false, isWritable: true },
            { pubkey: chapterStats, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}

export function buildCompleteChapterIx(
    user: PublicKey,
    userChapter: PublicKey,
    chapterStats: PublicKey,
    seriesId: string,
    chapterId: string
): TransactionInstruction {
    const seriesHash = hashSeed(seriesId);
    const chapterHash = hashSeed(chapterId);

    const data = Buffer.concat([
        SIGHASH_COMPLETE_CHAPTER,
        Buffer.from(seriesHash),
        Buffer.from(chapterHash),
    ]);

    return new TransactionInstruction({
        programId: INO_PROGRAM_ID,
        keys: [
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: userChapter, isSigner: false, isWritable: true },
            { pubkey: chapterStats, isSigner: false, isWritable: true },
        ],
        data,
    });
}

export function buildClaimMilestoneIx(
    user: PublicKey,
    milestoneConfig: PublicKey,
    userMilestone: PublicKey,
    seriesId: string,
    chapterId: string,
    milestoneType: string
): TransactionInstruction {
    const seriesHash = hashSeed(seriesId);
    const chapterHash = hashSeed(chapterId);
    const typeHash = hashSeed(milestoneType);

    const data = Buffer.concat([
        SIGHASH_CLAIM_MILESTONE,
        Buffer.from(seriesHash),
        Buffer.from(chapterHash),
        Buffer.from(typeHash),
    ]);

    return new TransactionInstruction({
        programId: INO_PROGRAM_ID,
        keys: [
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: milestoneConfig, isSigner: false, isWritable: true },
            { pubkey: userMilestone, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}

export function buildRecordSupportIx(
    user: PublicKey,
    userSupport: PublicKey,
    creatorKey: PublicKey,
    amount: bigint
): TransactionInstruction {
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(amount);

    const data = Buffer.concat([
        SIGHASH_RECORD_SUPPORT,
        creatorKey.toBuffer(),
        amountBuf,
    ]);

    return new TransactionInstruction({
        programId: INO_PROGRAM_ID,
        keys: [
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: userSupport, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}
