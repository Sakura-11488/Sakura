import { supabase } from './supabase';

/* Public profile + achievements, mirroring the Next.js model and reusing the
   same Supabase tables (user_profiles, favorites, reading_history,
   chapter_comments, comment_reactions). */

export interface PublicProfile {
  wallet_address: string;
  display_name: string | null;
  username: string | null;
  bio: string | null;
  avatar_seed: string;
  avatar_url?: string | null;
  avatar_mint_address?: string | null;
  creator_verification_state?: string | null;
  follower_count?: number;
  created_at: string | null;
}

export interface ProfileStats {
  chaptersRead: number;
  commentsPosted: number;
  reactionsReceived: number;
  favoritesCount: number;
  memberSince: string | null;
}

export interface ProfileFavorite {
  content_id: string;
  content_type: string;
  title: string;
  cover_url: string;
}

export interface LevelInfo {
  min: number;
  name: string;
  color: string;
  progress: number;
  nextMin: number | null;
}

export const LEVELS = [
  { min: 0, name: '新人 Newbie', color: '#94a3b8' },
  { min: 5, name: '読者 Reader', color: '#93c5fd' },
  { min: 15, name: 'オタク Otaku', color: '#c084fc' },
  { min: 30, name: 'マニア Maniac', color: '#fb923c' },
  { min: 50, name: '師範 Sensei', color: '#f472b6' },
  { min: 100, name: '漫画家 Mangaka', color: '#fbbf24' },
];

export function getLevel(chaptersRead: number): LevelInfo {
  let level = LEVELS[0];
  for (const l of LEVELS) if (chaptersRead >= l.min) level = l;
  const next = LEVELS[LEVELS.indexOf(level) + 1];
  const progress = next
    ? ((chaptersRead - level.min) / (next.min - level.min)) * 100
    : 100;
  return { ...level, progress: Math.min(Math.max(progress, 0), 100), nextMin: next?.min ?? null };
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  emoji: string;
  earned: boolean;
}

export function computeAchievements(stats: ProfileStats, hasPass: boolean): Achievement[] {
  return [
    { id: 'first-read', name: '初読み First Read', desc: 'Read your first chapter', emoji: '📖', earned: stats.chaptersRead >= 1 },
    { id: 'bookworm', name: '本の虫 Bookworm', desc: 'Read 10+ chapters', emoji: '📚', earned: stats.chaptersRead >= 10 },
    { id: 'social', name: '社交的 Social', desc: 'Post your first comment', emoji: '💬', earned: stats.commentsPosted >= 1 },
    { id: 'popular', name: '人気者 Popular', desc: 'Receive 5+ reactions', emoji: '✨', earned: stats.reactionsReceived >= 5 },
    { id: 'collector', name: '収集家 Collector', desc: 'Add 5+ favorites', emoji: '💎', earned: stats.favoritesCount >= 5 },
    { id: 'pass-holder', name: '桜メンバー Sakura Member', desc: 'Own a Monthly Pass', emoji: '🌸', earned: hasPass },
    { id: 'otaku', name: 'オタク Otaku', desc: 'Read 15+ chapters', emoji: '⭐', earned: stats.chaptersRead >= 15 },
    { id: 'chatterbox', name: 'おしゃべり Chatterbox', desc: 'Post 10+ comments', emoji: '🎙️', earned: stats.commentsPosted >= 10 },
  ];
}

const EMPTY_STATS: ProfileStats = {
  chaptersRead: 0,
  commentsPosted: 0,
  reactionsReceived: 0,
  favoritesCount: 0,
  memberSince: null,
};

export async function getPublicProfile(walletAddress: string): Promise<{
  profile: PublicProfile | null;
  favorites: ProfileFavorite[];
  stats: ProfileStats;
}> {
  if (!walletAddress) return { profile: null, favorites: [], stats: EMPTY_STATS };

  const [{ data: profileRow }, { data: usernameRow }] = await Promise.all([
    supabase
      .from('user_profiles')
      .select(
        'wallet_address, display_name, bio, avatar_seed, avatar_url, avatar_mint_address, created_at, creator_verification_state, follower_count',
      )
      .eq('wallet_address', walletAddress)
      .maybeSingle(),
    supabase
      .from('sakura_usernames')
      .select('username, display_name')
      .eq('wallet_address', walletAddress)
      .maybeSingle(),
  ]);

  const profile: PublicProfile | null = profileRow
    ? {
        wallet_address: profileRow.wallet_address,
        display_name: profileRow.display_name ?? usernameRow?.display_name ?? null,
        username: usernameRow?.username ?? null,
        bio: profileRow.bio ?? null,
        avatar_seed: profileRow.avatar_seed ?? walletAddress.slice(0, 8),
        avatar_url: profileRow.avatar_url ?? null,
        avatar_mint_address: profileRow.avatar_mint_address ?? null,
        creator_verification_state: profileRow.creator_verification_state ?? null,
        follower_count: profileRow.follower_count ?? 0,
        created_at: profileRow.created_at ?? null,
      }
    : usernameRow
      ? {
          wallet_address: walletAddress,
          display_name: usernameRow.display_name ?? null,
          username: usernameRow.username ?? null,
          bio: null,
          avatar_seed: walletAddress.slice(0, 8),
          avatar_url: null,
          avatar_mint_address: null,
          creator_verification_state: null,
          follower_count: 0,
          created_at: null,
        }
      : null;

  const stats: ProfileStats = { ...EMPTY_STATS, memberSince: profile?.created_at ?? null };
  let favorites: ProfileFavorite[] = [];

  try {
    const { data: favData } = await supabase
      .from('favorites')
      .select('content_id, content_type, title, cover_url')
      .eq('wallet_address', walletAddress)
      .order('created_at', { ascending: false })
      .limit(20);
    favorites = favData ?? [];
    stats.favoritesCount = favorites.length;

    const { count: chapCount } = await supabase
      .from('reading_history')
      .select('*', { count: 'exact', head: true })
      .eq('wallet_address', walletAddress);
    stats.chaptersRead = chapCount ?? 0;

    const { count: commentCount } = await supabase
      .from('chapter_comments')
      .select('*', { count: 'exact', head: true })
      .eq('wallet_address', walletAddress);
    stats.commentsPosted = commentCount ?? 0;

    const { data: userComments } = await supabase
      .from('chapter_comments')
      .select('id')
      .eq('wallet_address', walletAddress);
    if (userComments && userComments.length) {
      const ids = userComments.map((c: { id: number }) => c.id);
      const { count: rxCount } = await supabase
        .from('comment_reactions')
        .select('*', { count: 'exact', head: true })
        .in('comment_id', ids);
      stats.reactionsReceived = rxCount ?? 0;
    }
  } catch {
    // Best-effort stats; return whatever we managed to gather.
  }

  return { profile, favorites, stats };
}

export function truncateAddress(addr: string): string {
  return addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '';
}
