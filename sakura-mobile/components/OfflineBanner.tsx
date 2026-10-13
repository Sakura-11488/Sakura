import React, { useMemo } from 'react';
import { Platform, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useOnline } from '@/lib/use-online';

/**
 * App-wide "You're offline" strip with a way into Downloads.
 *
 * Offline, the only route to downloaded chapters and episodes used to be
 * Profile → My Downloads, which nobody finds while standing in a train tunnel
 * looking at a home screen of shelves that will not load. This strip is that
 * shortcut, shown exactly while the browser reports no network.
 *
 * It sits IN the layout, above the navigator, rather than floating over it:
 * a floating strip would cover headers and back buttons on every screen, and
 * there is no inset every screen agrees to leave free for it. In flow, the
 * screens simply get 32px less height while it shows. It takes over the top
 * safe-area inset itself and hands the screens below a top inset of zero, so
 * on a notched display the gap is not paid twice.
 *
 * Hidden on screens that already explain being offline (the manga page shows
 * its own "showing your downloaded chapters" notice, and Downloads is where
 * the link goes) and on full-screen readers and players, where a strip would
 * shift a layout sized to the whole window.
 *
 * Web only. Native has no connectivity signal to show (lib/use-online.ts
 * reports native as always online) and keeps its layout exactly as it was.
 */
export default function OfflineBanner({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return <WebOfflineFrame>{children}</WebOfflineFrame>;
}

/** First route segment(s) on which the strip stays hidden; see above. */
function hiddenOn(segments: string[]): boolean {
  const [first, second] = segments;
  if (first === 'manga' || first === 'downloads' || first === 'chapter') return true;
  if (first === 'anime' && second === 'watch') return true;
  if (first === 'novel' && second === 'read') return true;
  return false;
}

function WebOfflineFrame({ children }: { children: React.ReactNode }) {
  const online = useOnline();
  const segments = useSegments() as string[];
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors } = useTheme();
  const show = !online && !hiddenOn(segments);

  // The tree under the strip is always rendered through this provider, so
  // showing or hiding the strip changes a value rather than the element
  // structure — the navigator is never remounted by a connectivity change.
  const childInsets = useMemo(
    () => (show && insets.top > 0 ? { ...insets, top: 0 } : insets),
    [show, insets],
  );

  const s = useMemo(
    () =>
      StyleSheet.create({
        bar: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          minHeight: 32,
          paddingHorizontal: 16,
          paddingBottom: 6,
          backgroundColor: colors.surfaceSecondary,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.warning },
        label: { color: colors.text, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
        link: { color: colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
      }),
    [colors],
  );

  return (
    <View style={styles.fill}>
      {show ? (
        <View
          style={[s.bar, { paddingTop: insets.top + 6 }]}
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
        >
          <View style={s.dot} />
          <Text style={s.label}>You're offline</Text>
          <TouchableOpacity
            accessibilityRole="link"
            hitSlop={10}
            // No playTap: offline — the only time this link exists — its
            // sound asset may never have been cached, and every press would
            // just log NotSupportedError.
            onPress={() => router.push('/downloads')}
          >
            <Text style={s.link}>Downloads</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <SafeAreaInsetsContext.Provider value={childInsets}>
        <View style={styles.fill}>{children}</View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
