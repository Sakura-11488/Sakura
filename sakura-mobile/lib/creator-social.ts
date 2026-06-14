import { supabase } from './supabase';
import type { WalletAuthHeaders } from './wallet-auth';

export interface CreatorSocialState {
  following: boolean;
  notify_new_works: boolean;
  follower_count: number;
  verified: boolean;
  creator_verified_at: string | null;
}

export interface CreatorPostMedia {
  id?: string;
  media_type: 'image' | 'video';
  url: string;
  thumbnail_url?: string | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
}

export interface CreatorFeedPost {
  id: string;
  creator_wallet: string;
  post_type: 'text' | 'image' | 'video' | 'work_update' | 'coin_update';
  caption: string;
  like_count: number;
  comment_count: number;
  view_count: number;
  published_at: string;
  creator?: {
    display_name: string | null;
    avatar_seed: string | null;
    avatar_url?: string | null;
    creator_verification_state?: string | null;
  } | null;
  media?: CreatorPostMedia[];
}

export async function getCreatorSocialState(
  creatorWallet: string,
  viewerWallet?: string | null,
): Promise<CreatorSocialState> {
  const [profileRes, followRes] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('follower_count, creator_verification_state, creator_verified_at')
      .eq('wallet_address', creatorWallet)
      .maybeSingle(),
    viewerWallet
      ? supabase
          .from('creator_follows')
          .select('notify_new_works')
          .eq('creator_wallet', creatorWallet)
          .eq('follower_wallet', viewerWallet)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (profileRes.error) throw profileRes.error;
  if (followRes.error) throw followRes.error;

  return {
    following: !!followRes.data,
    notify_new_works: followRes.data?.notify_new_works ?? false,
    follower_count: profileRes.data?.follower_count ?? 0,
    verified: profileRes.data?.creator_verification_state === 'verified',
    creator_verified_at: profileRes.data?.creator_verified_at ?? null,
  };
}

export async function setCreatorFollow(input: {
  creatorWallet: string;
  following: boolean;
  notifyNewWorks?: boolean;
  authHeaders: WalletAuthHeaders;
}): Promise<CreatorSocialState> {
  const { data, error } = await supabase.functions.invoke('follow-creator', {
    body: {
      action: input.following ? 'follow' : 'unfollow',
      creator_wallet: input.creatorWallet,
      notify_new_works: input.notifyNewWorks ?? true,
    },
    headers: input.authHeaders,
  });
  if (error) throw error;
  return data as CreatorSocialState;
}

export async function submitCreatorVerification(input: {
  reason: string;
  socialLinks?: Record<string, string>;
  authHeaders: WalletAuthHeaders;
}): Promise<void> {
  const { error } = await supabase.functions.invoke('request-creator-verification', {
    body: {
      reason: input.reason,
      social_links: input.socialLinks ?? {},
    },
    headers: input.authHeaders,
  });
  if (error) throw error;
}

export async function fetchCreatorFeed(limit = 20, cursor?: string): Promise<CreatorFeedPost[]> {
  const { data, error } = await supabase.functions.invoke('creator-feed', {
    body: { limit, cursor },
  });
  if (error) throw error;
  return (data?.items ?? []) as CreatorFeedPost[];
}

export async function createCreatorPost(input: {
  caption: string;
  media?: CreatorPostMedia[];
  authHeaders: WalletAuthHeaders;
}): Promise<CreatorFeedPost> {
  const { data, error } = await supabase.functions.invoke('creator-post', {
    body: {
      caption: input.caption,
      media: input.media ?? [],
    },
    headers: input.authHeaders,
  });
  if (error) throw error;
  return data.post as CreatorFeedPost;
}

export async function requestCreatorCoinLaunch(input: {
  name: string;
  symbol: string;
  description: string;
  imageUrl?: string;
  metadataUri?: string;
  authHeaders: WalletAuthHeaders;
}) {
  const { data, error } = await supabase.functions.invoke('creator-coin-launch', {
    body: {
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      image_url: input.imageUrl,
      metadata_uri: input.metadataUri,
    },
    headers: input.authHeaders,
  });
  if (error) throw error;
  return data as {
    ok: boolean;
    coin_id: string;
    launch_request_id: string;
    status: string;
    unsigned_transaction?: string | null;
  };
}

export async function verifyCreatorCoinLaunch(input: {
  coinId: string;
  launchRequestId?: string;
  signature: string;
  mintAddress: string;
  authHeaders: WalletAuthHeaders;
}) {
  const { data, error } = await supabase.functions.invoke('creator-coin-verify', {
    body: {
      coin_id: input.coinId,
      launch_request_id: input.launchRequestId,
      signature: input.signature,
      mint_address: input.mintAddress,
    },
    headers: input.authHeaders,
  });
  if (error) throw error;
  return data as { ok: boolean; status: string };
}

export async function verifySakuraBuyback(input: {
  creatorCoinId: string;
  sourceClaimId?: string;
  sourceAmount?: number;
  sakuraAmount?: number;
  buybackSignature: string;
  authHeaders: WalletAuthHeaders;
}) {
  const { data, error } = await supabase.functions.invoke('sakura-buyback-verify', {
    body: {
      creator_coin_id: input.creatorCoinId,
      source_claim_id: input.sourceClaimId,
      source_amount: input.sourceAmount,
      sakura_amount: input.sakuraAmount,
      buyback_signature: input.buybackSignature,
    },
    headers: input.authHeaders,
  });
  if (error) throw error;
  return data as { ok: boolean; buyback_record_id: string };
}

export async function startCreatorChat(input: {
  recipientWallet: string;
  authHeaders: WalletAuthHeaders;
}): Promise<string> {
  const { data, error } = await supabase.functions.invoke('creator-chat', {
    body: { action: 'start', recipient_wallet: input.recipientWallet },
    headers: input.authHeaders,
  });
  if (error) throw error;
  return data.thread_id as string;
}

export async function sendCreatorChatMessage(input: {
  threadId: string;
  content: string;
  authHeaders: WalletAuthHeaders;
}) {
  const { data, error } = await supabase.functions.invoke('creator-chat', {
    body: { action: 'send', thread_id: input.threadId, content: input.content },
    headers: input.authHeaders,
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data.message as { id: string; sender_wallet: string; content: string; created_at: string };
}

export async function fetchCreatorChatMessages(input: {
  threadId: string;
  authHeaders: WalletAuthHeaders;
  markRead?: boolean;
}) {
  const { data, error } = await supabase.functions.invoke('creator-chat', {
    body: {
      action: 'messages',
      thread_id: input.threadId,
      mark_read: input.markRead ?? false,
    },
    headers: input.authHeaders,
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return (data.messages ?? []) as Array<{ id: string; sender_wallet: string; content: string; created_at: string }>;
}

export async function markChatThreadRead(input: {
  threadId: string;
  authHeaders: WalletAuthHeaders;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke('creator-chat', {
    body: { action: 'mark_read', thread_id: input.threadId },
    headers: input.authHeaders,
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
}

export async function blockChatUser(input: {
  recipientWallet: string;
  authHeaders: WalletAuthHeaders;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke('creator-chat', {
    body: { action: 'block', recipient_wallet: input.recipientWallet },
    headers: input.authHeaders,
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
}

export async function reportChatThread(input: {
  threadId: string;
  reason: string;
  authHeaders: WalletAuthHeaders;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke('creator-chat', {
    body: { action: 'report', thread_id: input.threadId, reason: input.reason },
    headers: input.authHeaders,
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
}

export { countUnreadThreads, isThreadUnread } from './chat-utils';

export interface ChatThreadSummary {
  thread_id: string;
  last_read_at: string | null;
  peer_wallet: string | null;
  peer_username: string | null;
  peer_display_name: string | null;
  peer_avatar_url: string | null;
  peer_avatar_seed: string | null;
  last_message: string | null;
  last_message_at: string | null;
}

export async function fetchChatThreads(authHeaders: WalletAuthHeaders): Promise<ChatThreadSummary[]> {
  const { data, error } = await supabase.functions.invoke('creator-chat', {
    body: { action: 'threads' },
    headers: authHeaders,
  });
  if (error) throw error;
  return (data.threads ?? []).map((row: Record<string, unknown>) => ({
    thread_id: String(row.thread_id),
    last_read_at: row.last_read_at ? String(row.last_read_at) : null,
    peer_wallet: row.peer_wallet ? String(row.peer_wallet) : null,
    peer_username: row.peer_username ? String(row.peer_username) : null,
    peer_display_name: row.peer_display_name ? String(row.peer_display_name) : null,
    peer_avatar_url: row.peer_avatar_url ? String(row.peer_avatar_url) : null,
    peer_avatar_seed: row.peer_avatar_seed ? String(row.peer_avatar_seed) : null,
    last_message: row.last_message ? String(row.last_message) : null,
    last_message_at: row.last_message_at ? String(row.last_message_at) : null,
  }));
}
