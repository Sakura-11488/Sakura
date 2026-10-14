import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { FontSize, FontWeight, Radius } from '@/constants/theme';
import { onTap } from '@/lib/sound';

export interface ChapterEndCardProps {
  width: number;
  height: number;
  /** Label of the chapter that just ended. */
  chapterLabel: string;
  /**
   * The chapter after it: a label to offer, null when this was the newest
   * chapter (caught up), undefined while the chapter list is still unknown.
   */
  next: { label: string; detail?: string } | null | undefined;
  onNext: () => void;
  onBackToSeries: () => void;
  /** Light background preference: dark text instead of light. */
  light?: boolean;
  /** Counter-mirror when drawn inside the right-to-left paged list. */
  mirrored?: boolean;
}

/**
 * What the reader shows after the last page of the session.
 *
 * The strip used to just stop: on the newest chapter there was no "you're
 * caught up", and with continuous reading off there was no way on except the
 * overlay's small skip button. WEBTOON, Tapas and Mihon all end a chapter
 * with the next one named and one tap away; this is that.
 *
 * A fixed size, passed in, because the list's layout math counts on it (the
 * webtoon footer height and one full page in paged mode).
 */
function ChapterEndCard({ width, height, chapterLabel, next, onNext, onBackToSeries, light, mirrored }: ChapterEndCardProps) {
  const ink = light ? '#1B1B1F' : '#FFFFFF';
  const muted = light ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
  const caughtUp = next === null;
  return (
    <View style={[s.wrap, { width, height }, mirrored && s.mirrored]} accessibilityRole="summary">
      <Text style={[s.kicker, { color: muted }]}>END OF {chapterLabel.toUpperCase()}</Text>
      {next ? (
        <>
          <Text style={[s.title, { color: ink }]} numberOfLines={2}>
            Up next: {next.label}
          </Text>
          {next.detail ? (
            <Text style={[s.detail, { color: muted }]} numberOfLines={1}>
              {next.detail}
            </Text>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Read ${next.label}`}
            style={s.primary}
            activeOpacity={0.85}
            onPress={onTap(onNext)}
          >
            <Text style={s.primaryText}>Read next chapter</Text>
          </TouchableOpacity>
        </>
      ) : caughtUp ? (
        <>
          <Text style={[s.title, { color: ink }]}>You're all caught up</Text>
          <Text style={[s.detail, { color: muted }]}>
            This is the newest chapter. New ones appear on the series page.
          </Text>
        </>
      ) : null}
      <TouchableOpacity
        accessibilityRole="button"
        style={[s.secondary, { borderColor: light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.35)' }]}
        activeOpacity={0.8}
        onPress={onTap(onBackToSeries)}
      >
        <Text style={[s.secondaryText, { color: ink }]}>Back to series</Text>
      </TouchableOpacity>
    </View>
  );
}

export default React.memo(ChapterEndCard);

const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 10 },
  mirrored: { transform: [{ scaleX: -1 }] },
  kicker: { fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.2, textAlign: 'center' },
  title: { fontSize: FontSize.xxl, fontWeight: FontWeight.bold, textAlign: 'center', maxWidth: 460 },
  detail: { fontSize: FontSize.sm, textAlign: 'center', maxWidth: 420, lineHeight: 20 },
  primary: {
    marginTop: 6,
    backgroundColor: '#E84545',
    borderRadius: Radius.full,
    paddingHorizontal: 28,
    paddingVertical: 13,
    minWidth: 220,
    alignItems: 'center',
  },
  primaryText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold },
  secondary: {
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingHorizontal: 22,
    paddingVertical: 10,
    minWidth: 180,
    alignItems: 'center',
  },
  secondaryText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
