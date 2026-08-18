import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
  LayoutChangeEvent,} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Colors, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';

const DEFAULT_CATEGORIES = ['Manga', 'Comics'];

interface Measurement { x: number; width: number }

interface Props {
  selected: string;
  onSelect: (cat: string) => void;
  /** Tab labels to show. Defaults to Manga/Comics; the home screen appends
   *  '18+' when the adult-content setting is on. */
  categories?: string[];
}

export default function CategoryTabs({ selected, onSelect, categories = DEFAULT_CATEGORIES }: Props) {
  const CATEGORIES = categories;
  const measurements = useRef<Measurement[]>([]);
  const indicatorX = useSharedValue(0);
  const indicatorW = useSharedValue(0);
  const [ready, setReady] = useState(false);

  const applyIndicator = useCallback(
    (index: number, animate = true) => {
      const m = measurements.current[index];
      if (!m) return;
      if (animate) {
        indicatorX.value = withSpring(m.x, { damping: 22, stiffness: 260, mass: 0.7 });
        indicatorW.value = withSpring(m.width, { damping: 22, stiffness: 260, mass: 0.7 });
      } else {
        indicatorX.value = m.x;
        indicatorW.value = m.width;
      }
    },
    []
  );

  const handleLayout = useCallback(
    (index: number, e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      measurements.current[index] = { x, width };
      const filled = measurements.current.filter(Boolean).length;
      if (filled === CATEGORIES.length && !ready) {
        const activeIdx = CATEGORIES.indexOf(selected);
        applyIndicator(activeIdx, false);
        setReady(true);
      }
    },
    [selected, ready, applyIndicator]
  );

  const handlePress = (cat: string, index: number) => {
    // Fire-and-forget so the pill animates instantly instead of waiting on the
    // haptic promise (and it's a harmless no-op on web).
    void Haptics.selectionAsync();
    applyIndicator(index, true);
    onSelect(cat);
  };

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorW.value,
    opacity: ready ? 1 : 0,
  }));

  return (
    <View style={s.wrapper}>
      <View style={s.track}>
        {/* Sliding pill */}
        <Animated.View style={[s.indicator, indicatorStyle]} />

        {CATEGORIES.map((cat, i) => {
          const isActive = cat === selected;
          return (
            <TouchableOpacity
              key={cat}
              onPress={() => handlePress(cat, i)}
              onLayout={(e) => handleLayout(i, e)}
              activeOpacity={0.85}
              style={s.tab}
            >
              <Text style={[s.text, isActive && s.textActive]}>{cat}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    paddingVertical: 2,
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.055)',
    borderRadius: Radius.full,
    padding: 3,
    position: 'relative',
  },
  indicator: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 0,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    zIndex: 0,
  },
  tab: {
    paddingHorizontal: 26,
    paddingVertical: 6,
    zIndex: 1,
  },
  text: {
    fontFamily: Fonts.bodyMedium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  textActive: {
    color: Colors.white,
    fontFamily: Fonts.bodyBold,
  },
});
