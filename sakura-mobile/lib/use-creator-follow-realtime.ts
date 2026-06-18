import { useCallback, useEffect, useState } from 'react';
import { getFollowerCount, isFollowingCreator } from './follow';
import { subscribeToCreatorFollows } from './follow-realtime';

export function useCreatorFollowRealtime(
  creatorWallet: string | null | undefined,
  viewerWallet: string | null | undefined,
) {
  const [followerCount, setFollowerCount] = useState(0);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!creatorWallet) {
      setLoading(false);
      return;
    }
    try {
      const count = await getFollowerCount(creatorWallet);
      setFollowerCount(count);
      if (viewerWallet && viewerWallet !== creatorWallet) {
        const isFollowing = await isFollowingCreator(viewerWallet, creatorWallet);
        setFollowing(isFollowing);
      } else {
        setFollowing(false);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [creatorWallet, viewerWallet]);

  useEffect(() => {
    if (!creatorWallet) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh();

    const unsubscribe = subscribeToCreatorFollows(creatorWallet, viewerWallet ?? null, {
      onFollowingChange: (next) => setFollowing(next),
      onFollowersChanged: () => {
        getFollowerCount(creatorWallet).then(setFollowerCount).catch(() => {});
      },
      onProfileFollowerCount: (count) => setFollowerCount(count),
    });

    return unsubscribe;
  }, [creatorWallet, viewerWallet, refresh]);

  return { followerCount, following, loading, refresh, setFollowerCount, setFollowing };
}
