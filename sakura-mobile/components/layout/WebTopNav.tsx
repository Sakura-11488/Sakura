import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Image } from 'expo-image';
import { usePathname, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/lib/theme';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import { playSwitch } from '@/lib/sound';
import WalletButton from '@/components/wallet/WalletButton';
import { MAX_CONTENT_WIDTH_DESKTOP, TOP_NAV_HEIGHT } from '@/constants/layout';
import { Colors, Fonts, FontWeight } from '@/constants/theme';

/**
 * Desktop-web top navigation bar.
 *
 * Replaces the left rail at desktop widths, matching the shape every streaming
 * site uses: brand at the left, routes across the top, account controls at the
 * right. The practical gain is horizontal space — the rail cost 232px of every
 * viewport permanently, which on a 1440px content column is a sixth of the page
 * given over to six links.
 *
 * Deliberately shares [`NAV`] and the navigation approach with `WebSidebar`
 * rather than redefining them: routing goes through `usePathname` +
 * `router.navigate` directly, not the Tabs `tabBar` slot, so both shells stay
 * interchangeable and adding a route means editing one list.
 *
 * Labels only, no icons. At 15px in a horizontal bar an icon beside each label
 * is noise — the rail needed them because a narrow vertical list reads better
 * with a glyph anchor.
 */

type NavItem = { route: string; label: string };

const NAV: NavItem[] = [
  { route: '/home', label: 'Home' },
  { route: '/anime', label: 'Watch' },
  { route: '/search', label: 'Search' },
  { route: '/novel', label: 'Novel' },
  { route: '/messages', label: 'Chat' },
  { route: '/profile', label: 'My' },
];

export default function WebTopNav() {
  const { colors } = useTheme();
  const { unreadCount } = useUnreadMessages();
  const router = useRouter();
  const pathname = usePathname();
  const [hovered, setHovered] = useState<string | null>(null);
  const isWeb = Platform.OS === 'web';

  const isActive = (route: string) => pathname === route || pathname.startsWith(`${route}/`);

  const go = (route: string) => {
    if (!isActive(route)) {
      Haptics.selectionAsync();
      playSwitch();
      router.navigate(route as never);
    }
  };

  return (
    <View style={[s.bar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <View style={s.inner}>
        <View style={s.brand}>
          <Image source={require('@/assets/images/logo.png')} style={s.mascot} contentFit="contain" />
          <Image
            source={require('@/assets/images/sakura-textlogo.png')}
            style={s.textLogo}
            contentFit="contain"
          />
        </View>

        <View style={s.nav}>
          {NAV.map((item) => {
            const active = isActive(item.route);
            const showBadge = item.route === '/messages' && unreadCount > 0;
            const isHovered = isWeb && hovered === item.route && !active;
            // onHoverIn/Out are RN-Web only and absent from TouchableOpacity's
            // React Native types, hence the cast.
            const hoverProps = isWeb
              ? {
                  onHoverIn: () => setHovered(item.route),
                  onHoverOut: () => setHovered((h) => (h === item.route ? null : h)),
                }
              : {};

            return (
              <TouchableOpacity
                key={item.route}
                onPress={() => go(item.route)}
                {...(hoverProps as any)}
                activeOpacity={0.85}
                style={[s.item, isWeb && ({ cursor: 'pointer' } as any)]}
              >
                <Text
                  style={[
                    s.label,
                    { color: active ? colors.text : colors.textSecondary },
                    isHovered && { color: colors.text },
                  ]}
                >
                  {item.label}
                </Text>
                {showBadge ? (
                  <View style={s.badge}>
                    <Text style={s.badgeText}>
                      {unreadCount > 99 ? '99+' : String(unreadCount)}
                    </Text>
                  </View>
                ) : null}
                {/* Underline rather than a filled pill: across a horizontal bar
                    a solid block on the active item is heavy, and the underline
                    is the convention every streaming nav already uses. */}
                <View
                  style={[
                    s.underline,
                    { backgroundColor: active ? Colors.primary : 'transparent' },
                  ]}
                />
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={s.right}>
          <WalletButton />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    width: '100%',
    height: TOP_NAV_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    // Stays put while the page scrolls, so navigation is always one click away.
    // `position: 'sticky'` is web-only and absent from RN's ViewStyle types.
    ...(Platform.OS === 'web' ? ({ position: 'sticky', top: 0, zIndex: 50 } as any) : null),
  },
  inner: {
    flex: 1,
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH_DESKTOP,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 28,
  },
  brand: { flexDirection: 'row', alignItems: 'center' },
  mascot: { width: 32, height: 32 },
  textLogo: { width: 74, height: 40 },
  nav: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  item: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  label: {
    fontSize: 15,
    fontFamily: Fonts.bodyBold,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.1,
  },
  underline: {
    height: 2,
    borderRadius: 1,
    marginTop: 6,
  },
  right: { flexDirection: 'row', alignItems: 'center' },
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontFamily: Fonts.bodyBold,
    fontWeight: FontWeight.bold,
    lineHeight: 12,
  },
});
