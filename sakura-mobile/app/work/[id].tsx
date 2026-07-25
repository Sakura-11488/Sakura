import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import Svg, { Path } from 'react-native-svg';
import { onTap } from '@/lib/sound';
import { formatReleaseDate } from '@/lib/format-release-date';
import { useTheme } from '@/lib/theme';
import {
  fetchWorkForReading,
  type WorkReadPayload,
  type WorkReadRelease,
} from '@/lib/creator';
import { MEDIA_BASE_DEFAULT } from '@/lib/content-hosts';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const { width: W } = Dimensions.get('window');

/** Droplet-hosted creator video → absolute URL (web routes via the media proxy). */
function resolveVideoUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const abs = `${MEDIA_BASE_DEFAULT}${path}`;
  return Platform.OS === 'web' ? getWebMediaProxyUrl(abs) : abs;
}

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M19 12H5M12 19l-7-7 7-7" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function WorkScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [payload, setPayload] = useState<WorkReadPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkReadRelease | null>(null);

  const player = useVideoPlayer('', (p) => {
    p.loop = false;
  });

  useEffect(() => {
    let alive = true;
    const workId = typeof id === 'string' ? id : '';
    if (!workId) {
      setError('Missing work.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setSelected(null);
    fetchWorkForReading(workId)
      .then((p) => {
        if (alive) {
          setPayload(p);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load this work.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // Load the selected anime episode into the player.
  useEffect(() => {
    if (!payload || payload.work.kind !== 'anime' || !selected) return;
    const url = resolveVideoUrl(selected.media?.videoPath);
    if (!url) return;
    try {
      player.replace(url);
      player.play();
    } catch {
      /* player not ready */
    }
  }, [selected, payload, player]);

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.sm,
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerTitle: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
    muted: { color: colors.textSecondary, textAlign: 'center' },
    hero: { flexDirection: 'row', gap: 14, padding: Spacing.md },
    cover: { width: 96, height: 144, borderRadius: Radius.md, backgroundColor: colors.surfaceSecondary },
    title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
    kind: { fontSize: FontSize.xs, color: colors.primary, fontWeight: FontWeight.bold, textTransform: 'uppercase', marginTop: 4, letterSpacing: 0.5 },
    desc: { fontSize: FontSize.sm, color: colors.textSecondary, marginTop: 8, lineHeight: 20 },
    sectionTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text, paddingHorizontal: Spacing.md, marginTop: 8, marginBottom: 6 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.md,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
      gap: 10,
    },
    rowNum: { width: 28, color: colors.textTertiary, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { color: colors.text, fontSize: FontSize.sm },
    rowDate: { color: colors.textTertiary, fontSize: 10, marginTop: 2 },
    readerText: { color: colors.text, fontSize: 17, lineHeight: 27, padding: Spacing.md },
    page: { width: W, height: W * 1.5, backgroundColor: colors.surfaceSecondary },
    video: { width: W, height: W * 0.5625, backgroundColor: '#000' },
  });

  if (loading) {
    return (
      <View style={s.root}>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={s.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  if (error || !payload) {
    return (
      <View style={s.root}>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={s.header}>
            <TouchableOpacity style={s.iconBtn} onPress={onTap(() => router.back())} hitSlop={10}>
              <BackIcon color={colors.text} />
            </TouchableOpacity>
          </View>
          <View style={s.center}>
            <Text style={s.muted}>{error || 'Work not available.'}</Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  const { work, releases } = payload;

  // ── Reading a single release ──
  if (selected) {
    return (
      <View style={s.root}>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={s.header}>
            <TouchableOpacity style={s.iconBtn} onPress={onTap(() => setSelected(null))} hitSlop={10}>
              <BackIcon color={colors.text} />
            </TouchableOpacity>
            <Text style={s.headerTitle} numberOfLines={1}>{selected.title}</Text>
          </View>

          {work.kind === 'novel' && (
            <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
              <Text style={s.readerText}>{selected.body_text || 'This chapter has no text yet.'}</Text>
            </ScrollView>
          )}

          {work.kind === 'manga' && (
            <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
              {(selected.media?.pages ?? []).length === 0 ? (
                <View style={s.center}><Text style={s.muted}>No pages in this chapter yet.</Text></View>
              ) : (
                (selected.media?.pages ?? []).map((uri, i) => (
                  <Image key={`${uri}-${i}`} source={{ uri }} style={s.page} contentFit="contain" transition={200} />
                ))
              )}
            </ScrollView>
          )}

          {work.kind === 'anime' && (
            <View style={{ flex: 1 }}>
              {resolveVideoUrl(selected.media?.videoPath) ? (
                <VideoView style={s.video} player={player} nativeControls contentFit="contain" />
              ) : (
                <View style={s.center}><Text style={s.muted}>This episode has no video yet.</Text></View>
              )}
              {!!selected.summary && <Text style={[s.desc, { paddingHorizontal: Spacing.md }]}>{selected.summary}</Text>}
            </View>
          )}
        </SafeAreaView>
      </View>
    );
  }

  // ── Work detail (chapter / episode list) ──
  const listLabel = work.kind === 'anime' ? 'Episodes' : 'Chapters';
  return (
    <View style={s.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity style={s.iconBtn} onPress={onTap(() => router.back())} hitSlop={10}>
            <BackIcon color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle} numberOfLines={1}>{work.title}</Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 80 }} showsVerticalScrollIndicator={false}>
          <View style={s.hero}>
            {work.cover_url ? (
              <Image source={{ uri: work.cover_url }} style={s.cover} contentFit="cover" transition={250} />
            ) : (
              <View style={s.cover} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={s.title} numberOfLines={3}>{work.title}</Text>
              <Text style={s.kind}>{work.kind}</Text>
              {!!work.description && <Text style={s.desc} numberOfLines={6}>{work.description}</Text>}
            </View>
          </View>

          <Text style={s.sectionTitle}>{listLabel}</Text>
          {releases.length === 0 ? (
            <View style={s.center}><Text style={s.muted}>No {listLabel.toLowerCase()} published yet.</Text></View>
          ) : (
            releases.map((r) => (
              <TouchableOpacity key={r.id} style={s.row} activeOpacity={0.7} onPress={onTap(() => setSelected(r))}>
                <Text style={s.rowNum}>{r.sequence_number}</Text>
                {/* Title and date stack, so the row needs a wrapper — it is a
                    horizontal flex. Unpublished releases have no date. */}
                <View style={s.rowText}>
                  <Text style={s.rowTitle} numberOfLines={1}>{r.title}</Text>
                  {!!formatReleaseDate(r.published_at) && (
                    <Text style={s.rowDate}>{formatReleaseDate(r.published_at)}</Text>
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
