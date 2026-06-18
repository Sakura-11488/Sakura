import { supabase } from './supabase';

export type CreatorFollowHandlers = {
  /** Current viewer started/stopped following this creator. */
  onFollowingChange?: (following: boolean) => void;
  /** Any follow/unfollow for this creator (refresh counts). */
  onFollowersChanged?: () => void;
  /** Synced follower_count from user_profiles trigger. */
  onProfileFollowerCount?: (count: number) => void;
};

type FollowRow = {
  follower_wallet?: string;
  creator_wallet?: string;
};

let followChannelSeq = 0;

function uniqueFollowChannel(prefix: string): string {
  followChannelSeq += 1;
  return `${prefix}-${followChannelSeq}-${Date.now().toString(36)}`;
}

/** Live follow/subscribe updates for a creator channel. */
export function subscribeToCreatorFollows(
  creatorWallet: string,
  viewerWallet: string | null,
  handlers: CreatorFollowHandlers,
): () => void {
  const channel = supabase.channel(uniqueFollowChannel(`creator-follows-${creatorWallet}`));

  channel
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'creator_follows',
        filter: `creator_wallet=eq.${creatorWallet}`,
      },
      (payload) => {
        const row = payload.new as FollowRow;
        if (viewerWallet && row.follower_wallet === viewerWallet) {
          handlers.onFollowingChange?.(true);
        }
        handlers.onFollowersChanged?.();
      },
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'creator_follows',
        filter: `creator_wallet=eq.${creatorWallet}`,
      },
      (payload) => {
        const row = payload.old as FollowRow;
        if (viewerWallet && row.follower_wallet === viewerWallet) {
          handlers.onFollowingChange?.(false);
        }
        handlers.onFollowersChanged?.();
      },
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'user_profiles',
        filter: `wallet_address=eq.${creatorWallet}`,
      },
      (payload) => {
        const count = (payload.new as { follower_count?: number | null })?.follower_count;
        if (typeof count === 'number') {
          handlers.onProfileFollowerCount?.(count);
        }
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/** Live updates for the list of creators a user follows. */
export function subscribeToMyFollowing(
  followerWallet: string,
  onChange: () => void,
): () => void {
  const channel = supabase
    .channel(uniqueFollowChannel(`my-following-${followerWallet}`))
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'creator_follows',
        filter: `follower_wallet=eq.${followerWallet}`,
      },
      () => onChange(),
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
