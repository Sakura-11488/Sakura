import { Buffer } from 'buffer';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { invokeCreatorFunction } from './creator-api';
import { getConnection } from './wallet/connection';
import { supabase } from './supabase';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export interface WorkMintRecord {
  id: string;
  work_id: string;
  creator_wallet: string;
  mint_type: string;
  status: string;
  metadata_uri: string | null;
  setup_tx_signature: string | null;
  tree_address: string | null;
}

function buildWorkMetadataUri(workId: string, title: string, kind: string, coverUrl: string | null): string {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const meta = {
    name: `${title} · Sakura`,
    symbol: 'SKRWORK',
    description: `Creator work registered on Sakura (${kind}).`,
    image: coverUrl ?? undefined,
    external_url: `https://sakura.app/work/${workId}`,
    attributes: [{ trait_type: 'kind', value: kind }, { trait_type: 'platform', value: 'Sakura' }],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(meta))}`;
}

/** On-chain memo proving wallet ownership — verified by edge function into work_mints. */
export async function registerWorkMintOnChain(
  keypair: Keypair,
  workId: string,
  title: string,
): Promise<string> {
  const memo = `sakura:work-mint:${workId}`;
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();

  const tx = new Transaction().add(
    new TransactionInstruction({
      keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, 'utf8'),
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed');
  return signature;
}

export async function verifyWorkMint(
  keypair: Keypair,
  input: {
    workId: string;
    title: string;
    kind: string;
    coverUrl?: string | null;
    txSignature: string;
  },
): Promise<WorkMintRecord> {
  const metadataUri = buildWorkMetadataUri(input.workId, input.title, input.kind, input.coverUrl ?? null);
  const res = await invokeCreatorFunction<{ mint: WorkMintRecord }>(
    'creator-work-mint-verify',
    'creator-work-mint-verify',
    keypair,
    {
      work_id: input.workId,
      tx_signature: input.txSignature,
      metadata_uri: metadataUri,
      mint_type: 'collectible',
    },
  );
  return res.mint;
}

export async function getWorkMintRecords(workId: string): Promise<WorkMintRecord[]> {
  const { data, error } = await supabase
    .from('work_mints')
    .select('*')
    .eq('work_id', workId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as WorkMintRecord[];
}

export async function publishWorkViaApi(keypair: Keypair, workId: string) {
  return invokeCreatorFunction<{
    ok: boolean;
    work_id: string;
    releases_published: number;
    followers_notified: number;
  }>('publish-creator-work', 'creator-publish-work', keypair, { work_id: workId });
}
