import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Image } from 'expo-image';
import { usePathname, useRouter } from 'expo-router';
import { Octicons, FontAwesome6, Entypo, Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/lib/theme';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import { playSwitch } from '@/lib/sound';
import WalletButton from '@/components/wallet/WalletButton';
import { SIDEBAR_WIDTH } from '@/constants/layout';
import { Colors, Fonts, FontWeight } from '@/constants/theme';

/**
 * Desktop-web left navigation rail. Rendered by WebAppShell only at desktop
 * window widths; the floating CustomTabBar takes over below the breakpoint and
 * on native. Uses expo-router directly (pathname + navigate) so it doesn't
 * depend on the Tabs navigator's tabBar slot.
 */

type NavItem = {
  route: string;
  label: string;
  render: (active: boolean) => React.ReactNode;
};

const ACTIVE = '#fff';

const NAV: NavItem[] = [
  { route: '/home', label: 'Home', render: (a) => <Octicons name="home-fill" size={22} color={a ? ACTIVE : Colors.textSecondary} /> },
  { route: '/anime', label: 'Watch', render: (a) => <Entypo name="folder-video" size={22} color={a ? ACTIVE : Colors.textSecondary} /> },
  { route: '/search', label: 'Search', render: (a) => <Octicons name="search" size={20} color={a ? ACTIVE : Colors.textSecondary} /> },
  { route: '/novel', label: 'Novel', render: (a) => <FontAwesome6 name="book" size={19} color={a ? ACTIVE : Colors.textSecondary} /> },
  { route: '/messages', label: 'Chat', render: (a) => <Ionicons name="chatbubbles-sharp" size={23} color={a ? ACTIVE : Colors.textSecondary} /> },
  { route: '/profile', label: 'My', render: (a) => <FontAwesome6 name="user-large" size={19} color={a ? ACTIVE : Colors.textSecondary} /> },
];

export default function WebSidebar() {
  const { colors } = useTheme();
  const { unreadCount } = useUnreadMessages();
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (route: string) =>
    pathname === route || pathname.startsWith(`${route}/`);

  const go = (route: string) => {
    if (!isActive(route)) {
      Haptics.selectionAsync();
      playSwitch();
      router.navigate(route as never);
    }
  };

  const [hovered, setHovered] = useState<string | null>(null);
  const isWeb = Platform.OS === 'web';

  return (
    <View style={[s.rail, { backgroundColor: colors.surface, borderRightColor: colors.border }]}>
      {/* Brand */}
      <View style={s.brand}>
        <Image source={require('@/assets/images/logo.png')} style={s.mascot} contentFit="contain" />
        <Image source={require('@/assets/images/sakura-textlogo.png')} style={s.textLogo} contentFit="contain" />
      </View>

      {/* Nav */}
      <View style={s.nav}>
        {NAV.map((item) => {
          const active = isActive(item.route);
          const showBadge = item.route === '/messages' && unreadCount > 0;
          const isHovered = isWeb && hovered === item.route && !active;
          // onHoverIn/Out are RN-Web-only and absent from TouchableOpacity's RN types.
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
              style={[
                s.item,
                active && { backgroundColor: Colors.primary },
                isHovered && { backgroundColor: colors.border },
                isWeb && ({ cursor: 'pointer' } as any),
              ]}
            >
              <View style={s.iconWrap}>
                {item.render(active)}
                {showBadge ? (
                  <View style={s.badge}>
                    <Text style={s.badgeText}>{unreadCount > 99 ? '99+' : String(unreadCount)}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[s.label, { color: active ? ACTIVE : colors.text }]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Wallet / SKR balance */}
      <View style={s.footer}>
        <WalletButton />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  rail: {
    width: SIDEBAR_WIDTH,
    height: '100%',
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 20,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginBottom: 28,
  },
  mascot: { width: 38, height: 38 },
  textLogo: { width: 82, height: 46 },
  nav: {
    flex: 1,
    gap: 6,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  iconWrap: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 15,
    fontFamily: Fonts.bodyBold,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.1,
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -10,
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
  footer: {
    marginTop: 16,
    alignItems: 'flex-start',
  },
});
