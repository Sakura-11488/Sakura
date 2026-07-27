import React, { useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Dimensions,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  interpolate,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { GlassView, GlassContainer, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { Octicons, FontAwesome6, Entypo, Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Colors, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import { playSwitch } from '@/lib/sound';
import { MAX_TAB_BAR_WIDTH, isWideWeb } from '@/constants/layout';

type BottomTabBarProps = {
  state: { index: number; routes: { name: string }[] };
  navigation: { navigate: (name: never) => void };
};

// ─── Layout constants ─────────────────────────────────────────────────────────
const W = Dimensions.get('window').width;
const ICON_SLOT   = 42;
const ACTIVE_SLOT = 84;
const SPRING = { damping: 22, stiffness: 280, mass: 0.7 };

// Evaluated once at module load — avoids per-render cost
const USE_GLASS = Platform.OS === 'ios' && isGlassEffectAPIAvailable();

// ─── Icons ────────────────────────────────────────────────────────────────────
const HomeIcon    = ({ active }: { active: boolean }) =>
  <Octicons    name="home-fill"    size={22} color={active ? (USE_GLASS ? '#fff' : '#fff') : Colors.textSecondary} />;
const AnimeIcon   = ({ active }: { active: boolean }) =>
  <Entypo      name="folder-video" size={22} color={active ? (USE_GLASS ? '#fff' : '#fff') : Colors.textSecondary} />;
const SearchIcon  = ({ active }: { active: boolean }) =>
  <Octicons    name="search"       size={20} color={active ? (USE_GLASS ? '#fff' : '#fff') : Colors.textSecondary} />;
const NovelIcon   = ({ active }: { active: boolean }) =>
  <FontAwesome6 name="book"        size={20} color={active ? (USE_GLASS ? '#fff' : '#fff') : Colors.textSecondary} />;
const MessagesIcon = ({ active }: { active: boolean }) =>
  <Ionicons name="chatbubbles-sharp" size={24} color={active ? (USE_GLASS ? '#fff' : '#fff') : Colors.textSecondary} />;
const ProfileIcon = ({ active }: { active: boolean }) =>
  <FontAwesome6 name="user-large"  size={20} color={active ? (USE_GLASS ? '#fff' : '#fff') : Colors.textSecondary} />;

const TABS = [
  { name: 'home',     label: 'Home',   Icon: HomeIcon    },
  { name: 'anime',    label: 'Watch',  Icon: AnimeIcon   },
  { name: 'search',   label: 'Search', Icon: SearchIcon  },
  { name: 'novel',    label: 'Novel',  Icon: NovelIcon   },
  { name: 'messages', label: 'Chat',   Icon: MessagesIcon },
  { name: 'profile',  label: 'My',     Icon: ProfileIcon },
];

// ─── Glass pill — separate component so GlassView renders cleanly ─────────────
function GlassPill({ active }: { active: boolean }) {
  return (
    <GlassView
      style={[StyleSheet.absoluteFill, ts.pillGlass]}
      glassEffectStyle={{
        style: active ? 'regular' : 'none',
        animate: true,
        animationDuration: 0.18,
      }}
      tintColor={active ? Colors.primary : undefined}
      isInteractive={active}
    />
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const { colors } = useTheme();
  const { unreadCount } = useUnreadMessages();
  const { width: windowW } = useWindowDimensions();

  const wrapperStyle = useMemo((): ViewStyle => {
    if (Platform.OS !== 'web') return ts.wrapper;
    const barW = Math.min(windowW - 28, MAX_TAB_BAR_WIDTH);
    return {
      position: 'absolute',
      bottom: 22,
      left: (windowW - barW) / 2,
      width: barW,
    };
  }, [windowW]);

  const hideBar = ['settings', 'library'].includes(state.routes[state.index]?.name);

  const idx = state.index;
  const prevIdx = useRef(idx);

  const w0 = useSharedValue(idx === 0 ? ACTIVE_SLOT : ICON_SLOT);
  const w1 = useSharedValue(idx === 1 ? ACTIVE_SLOT : ICON_SLOT);
  const w2 = useSharedValue(idx === 2 ? ACTIVE_SLOT : ICON_SLOT);
  const w3 = useSharedValue(idx === 3 ? ACTIVE_SLOT : ICON_SLOT);
  const w4 = useSharedValue(idx === 4 ? ACTIVE_SLOT : ICON_SLOT);
  const w5 = useSharedValue(idx === 5 ? ACTIVE_SLOT : ICON_SLOT);
  const widths = [w0, w1, w2, w3, w4, w5];

  const lo0 = useSharedValue(idx === 0 ? 1 : 0);
  const lo1 = useSharedValue(idx === 1 ? 1 : 0);
  const lo2 = useSharedValue(idx === 2 ? 1 : 0);
  const lo3 = useSharedValue(idx === 3 ? 1 : 0);
  const lo4 = useSharedValue(idx === 4 ? 1 : 0);
  const lo5 = useSharedValue(idx === 5 ? 1 : 0);
  const labelOps = [lo0, lo1, lo2, lo3, lo4, lo5];

  const ps0 = useSharedValue(1);
  const ps1 = useSharedValue(1);
  const ps2 = useSharedValue(1);
  const ps3 = useSharedValue(1);
  const ps4 = useSharedValue(1);
  const ps5 = useSharedValue(1);
  const pressScales = [ps0, ps1, ps2, ps3, ps4, ps5];

  useEffect(() => {
    const prev = prevIdx.current;
    const curr = idx;
    if (prev === curr) return;
    if (prev < TABS.length) {
      widths[prev].value = withSpring(ICON_SLOT, SPRING);
      labelOps[prev].value = withTiming(0, { duration: 120 });
    }
    if (curr < TABS.length) {
      widths[curr].value = withSpring(ACTIVE_SLOT, SPRING);
      labelOps[curr].value = withDelay(80, withTiming(1, { duration: 200 }));
    }
    prevIdx.current = curr;
  }, [idx]);

  const ws0 = useAnimatedStyle(() => ({ width: w0.value }));
  const ws1 = useAnimatedStyle(() => ({ width: w1.value }));
  const ws2 = useAnimatedStyle(() => ({ width: w2.value }));
  const ws3 = useAnimatedStyle(() => ({ width: w3.value }));
  const ws4 = useAnimatedStyle(() => ({ width: w4.value }));
  const ws5 = useAnimatedStyle(() => ({ width: w5.value }));
  const wStyles = [ws0, ws1, ws2, ws3, ws4, ws5];

  const ls0 = useAnimatedStyle(() => ({
    opacity: lo0.value,
    maxWidth: interpolate(lo0.value, [0, 1], [0, 56]),
    transform: [{ translateX: interpolate(lo0.value, [0, 1], [10, 0]) }],
  }));
  const ls1 = useAnimatedStyle(() => ({
    opacity: lo1.value,
    maxWidth: interpolate(lo1.value, [0, 1], [0, 56]),
    transform: [{ translateX: interpolate(lo1.value, [0, 1], [10, 0]) }],
  }));
  const ls2 = useAnimatedStyle(() => ({
    opacity: lo2.value,
    maxWidth: interpolate(lo2.value, [0, 1], [0, 56]),
    transform: [{ translateX: interpolate(lo2.value, [0, 1], [10, 0]) }],
  }));
  const ls3 = useAnimatedStyle(() => ({
    opacity: lo3.value,
    maxWidth: interpolate(lo3.value, [0, 1], [0, 56]),
    transform: [{ translateX: interpolate(lo3.value, [0, 1], [10, 0]) }],
  }));
  const ls4 = useAnimatedStyle(() => ({
    opacity: lo4.value,
    maxWidth: interpolate(lo4.value, [0, 1], [0, 56]),
    transform: [{ translateX: interpolate(lo4.value, [0, 1], [10, 0]) }],
  }));
  const ls5 = useAnimatedStyle(() => ({
    opacity: lo5.value,
    maxWidth: interpolate(lo5.value, [0, 1], [0, 56]),
    transform: [{ translateX: interpolate(lo5.value, [0, 1], [10, 0]) }],
  }));
  const lStyles = [ls0, ls1, ls2, ls3, ls4, ls5];

  const pss0 = useAnimatedStyle(() => ({ transform: [{ scale: ps0.value }] }));
  const pss1 = useAnimatedStyle(() => ({ transform: [{ scale: ps1.value }] }));
  const pss2 = useAnimatedStyle(() => ({ transform: [{ scale: ps2.value }] }));
  const pss3 = useAnimatedStyle(() => ({ transform: [{ scale: ps3.value }] }));
  const pss4 = useAnimatedStyle(() => ({ transform: [{ scale: ps4.value }] }));
  const pss5 = useAnimatedStyle(() => ({ transform: [{ scale: ps5.value }] }));
  const psStyles = [pss0, pss1, pss2, pss3, pss4, pss5];

  const handlePress = (i: number) => {
    pressScales[i].value = withTiming(0.93, { duration: 70 }, () => {
      pressScales[i].value = withTiming(1, { duration: 100 });
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playSwitch();
    navigation.navigate(TABS[i].name as never);
  };

  const barContent = TABS.map((tab, i) => {
    const active = idx === i;
    const { Icon } = tab;
    const showBadge = tab.name === 'messages' && unreadCount > 0;
    const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount);
    return (
      <Animated.View key={tab.name} style={[ts.tabSlot, wStyles[i]]}>
        <Animated.View style={[ts.pill, psStyles[i]]}>
          {USE_GLASS ? (
            <GlassPill active={active} />
          ) : (
            active && <View style={[StyleSheet.absoluteFill, ts.pillActiveFallback]} />
          )}
          <TouchableOpacity
            onPress={() => handlePress(i)}
            activeOpacity={1}
            style={ts.tabBtn}
          >
            <View style={ts.iconWrap}>
              <Icon active={active} />
              {showBadge ? (
                <View style={ts.badge}>
                  <Text style={ts.badgeText}>{badgeLabel}</Text>
                </View>
              ) : null}
            </View>
            <Animated.View style={[ts.labelWrap, lStyles[i]]}>
              <Text style={ts.label}>{tab.label}</Text>
            </Animated.View>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    );
  });

  // On desktop web the WebTopNav replaces the floating bottom bar.
  if (hideBar || isWideWeb(windowW)) return null;

  // ── Glass tab bar (iOS 26+) ──────────────────────────────────────────────
  if (USE_GLASS) {
    return (
      <View style={wrapperStyle} pointerEvents="box-none">
        <View style={ts.glassCard}>
          <GlassContainer spacing={10} style={ts.bar}>
            {/* Full-bar background glass */}
            <GlassView style={[StyleSheet.absoluteFill, ts.glassBackground]} />
            {barContent}
          </GlassContainer>
        </View>
      </View>
    );
  }

  // ── Blur / solid fallback (iOS < 26, Android) ────────────────────────────
  return (
    <View style={wrapperStyle}>
      <View style={[ts.floatCard, { backgroundColor: colors.tabBarBg, borderColor: colors.tabBarBorder }]}>
        {Platform.OS === 'ios' ? (
          <BlurView intensity={70} tint={colors.blurTint} style={ts.bar}>
            {barContent}
          </BlurView>
        ) : (
          <View style={[ts.bar, { backgroundColor: colors.tabBarBg }]}>
            {barContent}
          </View>
        )}
      </View>
    </View>
  );
}

const ts = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 22,
    left: 14,
    right: 14,
  },

  // ── Glass card (iOS 26+) ──────────────────────────────────────────────────
  glassCard: {
    borderRadius: 32,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 28,
  },
  glassBackground: {
    borderRadius: 32,
  },
  pillGlass: {
    borderRadius: 21,
  },

  // ── Fallback card (BlurView / solid) ─────────────────────────────────────
  floatCard: {
    borderRadius: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.11,
    shadowRadius: 24,
    elevation: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillActiveFallback: {
    borderRadius: 21,
    backgroundColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
  },

  // ── Shared ────────────────────────────────────────────────────────────────
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingVertical: 8,
    minHeight: 58,
  },
  tabSlot: {
    height: 42,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    flex: 1,
    width: '100%',
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 8,
    gap: 5,
  },
  iconWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
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
  labelWrap: {
    overflow: 'hidden',
  },
  label: {
    fontSize: 12,
    fontFamily: Fonts.bodyBold,
    fontWeight: FontWeight.bold,
    color: '#fff',
    letterSpacing: 0.1,
  },
});
