import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { playTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import {
  listPublishedWorks,
  workCoverUrl,
  type CreatorWork,
  type CreatorWorkKind,
} from '@/lib/creator';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';

const CARD_W = 112;
const CARD_H = Math.round(CARD_W * 1.45);

/**
 * "From Sakura Creators" — a horizontal row of published community uploads of a
 * given kind, linking to the creator-work reader. Renders nothing until at
 * least one work exists, so it never leaves an empty header on the page.
 */
export default function CreatorWorksRow({
  kind,
  title = 'From Sakura Creators',
}: {
  kind: CreatorWorkKind;
  title?: string;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const [works, setWorks] = useState<CreatorWork[]>([]);

  useEffect(() => {
    let alive = true;
    listPublishedWorks(kind, 20)
      .then((w) => {
        if (alive) setWorks(w);
      })
      .catch(() => {
        /* row simply stays hidden on error */
      });
    return () => {
      alive = false;
    };
  }, [kind]);

  const s = StyleSheet.create({
    wrap: { marginBottom: Spacing.md },
    title: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.md,
      color: colors.text,
      letterSpacing: 0.5,
      paddingHorizontal: Spacing.md,
      marginBottom: 12,
    },
    list: { paddingHorizontal: Spacing.md, gap: 10 },
    card: {
      width: CARD_W,
      height: CARD_H,
      borderRadius: Radius.md,
      overflow: 'hidden',
      backgroundColor: colors.surfaceSecondary,
    },
    cover: { width: '100%', height: '100%' },
    fallback: { alignItems: 'center', justifyContent: 'center' },
    fallbackText: { fontSize: 34, fontWeight: FontWeight.bold, color: colors.textTertiary },
    cardTitle: {
      width: CARD_W,
      marginTop: 6,
      fontSize: FontSize.xs,
      color: colors.text,
      fontFamily: Fonts.bodyMedium,
      lineHeight: 15,
    },
  });

  if (works.length === 0) return null;

  return (
    <View style={s.wrap}>
      <Text style={s.title}>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.list}>
        {works.map((w) => {
          const cover = workCoverUrl(w);
          return (
            <TouchableOpacity
              key={w.id}
              activeOpacity={0.85}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                playTap();
                router.push(`/work/${w.id}` as any);
              }}
            >
              <View style={s.card}>
                {cover ? (
                  <Image source={{ uri: cover }} style={s.cover} contentFit="cover" transition={250} />
                ) : (
                  <View style={[s.cover, s.fallback]}>
                    <Text style={s.fallbackText}>{(w.title || '?').slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
              </View>
              <Text style={s.cardTitle} numberOfLines={2}>{w.title}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}
