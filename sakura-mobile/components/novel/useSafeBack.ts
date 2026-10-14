import { useCallback } from 'react';
import { useNavigation, useRouter, type Href } from 'expo-router';

/**
 * Back, unless "back" would land on the app's launch route.
 *
 * The root stack is seeded with `index` (initialRouteName), so a page opened
 * from a link — a shared novel, a notification, a reload — can always "go
 * back", but only to the launch screen, which on web renders nothing once it
 * has already run (live: Back from a deep-linked chapter left a blank /app/).
 * In that case go to the sensible parent instead.
 */
export function useSafeBack() {
  const router = useRouter();
  const navigation = useNavigation();
  return useCallback(
    (fallback: Href) => {
      const state = navigation.getState?.();
      const prev = state && typeof state.index === 'number' && state.index > 0 ? state.routes[state.index - 1] : undefined;
      if (prev && prev.name !== 'index' && router.canGoBack()) router.back();
      else router.replace(fallback);
    },
    [router, navigation],
  );
}
