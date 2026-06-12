/**
 * Ino on-chain participation registry client (React Native port).
 * Handles PDA derivation, instruction building, and sign/send for chapter
 * unlocks, completions, milestone claims, and creator support recording.
 *
 * Program: E9ju12He2mnBRaneM4xdtUXECDPXdpQQbU6HtSKb6Hpf
 */
import { Buffer } from 'buffer';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  type Keypair,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { INO_PROGRAM_ID } from './config';
import { getConnection } from './connection';

function hashSeed(value: string): Uint8Array {
  return sha256(new TextEncoder().encode(value));
}

// ─── PDA derivation ───────────────────────────────────────────────────────────
export function getUserChapterPDA(user: PublicKey, seriesId: string, chapterId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user-chapter'), user.toBuffer(), Buffer.from(hashSeed(seriesId)), Buffer.from(hashSeed(chapterId))],
    INO_PROGRAM_ID,
  );
}

export function getChapterStatsPDA(seriesId: string, chapterId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('chapter-stats'), Buffer.from(hashSeed(seriesId)), Buffer.from(hashSeed(chapterId))],
    INO_PROGRAM_ID,
  );
}

export function getMilestoneConfigPDA(
  seriesId: string,
  chapterId: string,
  milestoneType: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('milestone-config'),
      Buffer.from(hashSeed(seriesId)),
      Buffer.from(hashSeed(chapterId)),
      Buffer.from(hashSeed(milestoneType)),
    ],
    INO_PROGRAM_ID,
  );
}

export function getUserMilestonePDA(user: PublicKey, milestoneConfig: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user-milestone'), user.toBuffer(), milestoneConfig.toBuffer()],
    INO_PROGRAM_ID,
  );
}

export function getUserSupportPDA(user: PublicKey, creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('support'), user.toBuffer(), creator.toBuffer()],
    INO_PROGRAM_ID,
  );
}

// ─── Instruction sighashes ──────────────────────────────────────────────────
const SIGHASH_UNLOCK_CHAPTER = Buffer.from('a]4\x8b\xc2\x01\x9a\x12', 'binary');
const SIGHASH_COMPLETE_CHAPTER = Buffer.from('\x1b\xf9\xe7\xd3\xa0\x15\xcc\x4e', 'binary');
const SIGHASH_CLAIM_MILESTONE = Buffer.from('\xe3\x02\x88\x5d\xf1\xa7\x3c\x90', 'binary');
const SIGHASH_RECORD_SUPPORT = Buffer.from('\x7a\xb0\x44\x31\xd5\xe8\xbb\x19', 'binary');

// ─── Instruction builders ─────────────────────────────────────────────────────
export function buildUnlockChapterIx(
  user: PublicKey,
  userChapter: PublicKey,
  chapterStats: PublicKey,
  seriesId: string,
  chapterId: string,
): TransactionInstruction {
  const data = Buffer.concat([
    SIGHASH_UNLOCK_CHAPTER,
    Buffer.from(hashSeed(seriesId)),
    Buffer.from(hashSeed(chapterId)),
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
  chapterId: string,
): TransactionInstruction {
  const data = Buffer.concat([
    SIGHASH_COMPLETE_CHAPTER,
    Buffer.from(hashSeed(seriesId)),
    Buffer.from(hashSeed(chapterId)),
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
  milestoneType: string,
): TransactionInstruction {
  const data = Buffer.concat([
    SIGHASH_CLAIM_MILESTONE,
    Buffer.from(hashSeed(seriesId)),
    Buffer.from(hashSeed(chapterId)),
    Buffer.from(hashSeed(milestoneType)),
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
  amount: bigint,
): TransactionInstruction {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const data = Buffer.concat([SIGHASH_RECORD_SUPPORT, creatorKey.toBuffer(), amountBuf]);
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

// ─── Sign + send helpers ────────────────────────────────────────────────────
async function signAndSend(keypair: Keypair, ix: TransactionInstruction): Promise<string> {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: blockhash }).add(ix);
  tx.sign(keypair);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed');
  return signature;
}

export async function unlockChapterOnChain(
  keypair: Keypair,
  seriesId: string,
  chapterId: string,
): Promise<string> {
  const [userChapter] = getUserChapterPDA(keypair.publicKey, seriesId, chapterId);
  const [chapterStats] = getChapterStatsPDA(seriesId, chapterId);
  return signAndSend(keypair, buildUnlockChapterIx(keypair.publicKey, userChapter, chapterStats, seriesId, chapterId));
}

export async function completeChapterOnChain(
  keypair: Keypair,
  seriesId: string,
  chapterId: string,
): Promise<string> {
  const [userChapter] = getUserChapterPDA(keypair.publicKey, seriesId, chapterId);
  const [chapterStats] = getChapterStatsPDA(seriesId, chapterId);
  return signAndSend(keypair, buildCompleteChapterIx(keypair.publicKey, userChapter, chapterStats, seriesId, chapterId));
}

export async function recordSupportOnChain(
  keypair: Keypair,
  creator: PublicKey,
  amount: bigint,
): Promise<string> {
  const [userSupport] = getUserSupportPDA(keypair.publicKey, creator);
  return signAndSend(keypair, buildRecordSupportIx(keypair.publicKey, userSupport, creator, amount));
}

// ─── Read helpers ───────────────────────────────────────────────────────────
export interface ChapterParticipation {
  unlocked: boolean;
  completed: boolean;
}

/**
 * Reads whether the user has an on-chain unlock/completion record for a chapter.
 * Returns `unlocked` if the user-chapter PDA exists; completion is reflected by
 * the same account once `completeChapter` has run.
 */
export async function getChapterParticipation(
  user: PublicKey,
  seriesId: string,
  chapterId: string,
): Promise<ChapterParticipation> {
  try {
    const [userChapter] = getUserChapterPDA(user, seriesId, chapterId);
    const info = await getConnection().getAccountInfo(userChapter, 'confirmed');
    if (!info) return { unlocked: false, completed: false };
    // Layout: [..flags]. The final data byte is set to 1 on completion.
    const data = info.data;
    const completed = data.length > 0 && data[data.length - 1] === 1;
    return { unlocked: true, completed };
  } catch {
    return { unlocked: false, completed: false };
  }
}
