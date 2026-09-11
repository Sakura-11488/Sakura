import { supabase } from './supabase';

/**
 * What the dashboard needs to decide whether to offer a coin launch.
 *
 * WHY IT COUNTS `creator_follows` DIRECTLY rather than reading
 * `user_profiles.follower_count`: that column only updates for wallets that
 * HAVE a profile row, and the creators most likely to qualify do not have one.
 * All four Sakura Originals have zero `user_profiles` rows, PsyopAnime included
 * — and PsyopAnime has the most followers of any creator on the platform. The
 * server-side gate learned this the same way and counts the table directly too.
 *
 * THE SERVER IS AUTHORITATIVE. This is guidance for the UI, nothing more. The
 * real threshold lives in `CREATOR_COIN_MIN_FOLLOWERS` on the edge function and
 * can be changed without shipping an app build, so a refusal carries its own
 * `follower_count` / `required` and should always win over what is shown here.
 */

/** Matches the edge function's default. The server may be configured higher. */
export const DEFAULT_MIN_FOLLOWERS = 5;

export interface CreatorCoinStatus {
  followerCount: number;
  publishedWorks: number;
  /** Best-effort, using the default threshold. The server decides for real. */
  likelyEligible: boolean;
  /** Only visible once launched — RLS hides in-flight coins from the client. */
  launchedCoin: { mint_address: string | null; symbol: string; name: string } | null;
}

export async function getCreatorCoinStatus(walletAddress: string): Promise<CreatorCoinStatus> {
  const [follows, works, coin] = await Promise.all([
    supabase
      .from('creator_follows')
      .select('*', { count: 'exact', head: true })
      .eq('creator_wallet', walletAddress),
    supabase
      .from('creator_works')
      .select('*', { count: 'exact', head: true })
      .eq('creator_wallet', walletAddress)
      // publication_status, NOT visibility: the Originals are deliberately
      // `unlisted` and still count, exactly as the server gate has it.
      .eq('publication_status', 'published'),
    supabase
      .from('creator_coins')
      .select('mint_address, symbol, name')
      .eq('creator_wallet', walletAddress)
      // `creator_coins` is public-readable only at status 'launched', so an
      // in-flight launch is invisible here by design rather than by omission.
      .eq('status', 'launched')
      .maybeSingle(),
  ]);

  const followerCount = follows.count ?? 0;
  const publishedWorks = works.count ?? 0;

  return {
    followerCount,
    publishedWorks,
    likelyEligible: followerCount >= DEFAULT_MIN_FOLLOWERS && publishedWorks >= 1,
    launchedCoin: coin.data ?? null,
  };
}
