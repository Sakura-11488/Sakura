import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, RefreshControl, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Image from '@/components/ui/CoverImage';
import { useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { createCreatorPost, fetchCreatorFeed, type CreatorFeedPost } from '@/lib/creator-social';
import ProfileAvatar from '@/components/ui/ProfileAvatar';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import { Fonts, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

function creatorName(post: CreatorFeedPost): string {
  return post.creator?.display_name?.trim() || `${post.creator_wallet.slice(0, 6)}...${post.creator_wallet.slice(-4)}`;
}

export default function CreatorFeedScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { address, signWithBiometrics } = useWallet();
  const [items, setItems] = useState<CreatorFeedPost[]>([]);
  const [caption, setCaption] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [moreError, setMoreError] = useState('');
  const requestVersion = React.useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoadError('');
    setMoreError('');
    try {
      const { items: feed, nextCursor } = await fetchCreatorFeed(25);
      if (version !== requestVersion.current) return;
      setItems(feed);
      setCursor(nextCursor);
    } catch {
      if (version === requestVersion.current) setLoadError('The creator feed could not be loaded.');
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !cursor) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    setMoreError('');
    try {
      const { items: more, nextCursor } = await fetchCreatorFeed(25, cursor);
      if (version !== requestVersion.current) return;
      // De-dupe by id in case a boundary post repeats across pages.
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...more.filter((p) => !seen.has(p.id))];
      });
      setCursor(more.length ? nextCursor : null);
    } catch {
      if (version === requestVersion.current) setMoreError('More posts could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const submitPost = useCallback(async () => {
    if (posting || (!caption.trim() && !mediaUrl.trim())) return;
    if (!address) {
      showAlert('Wallet required', 'Connect your creator wallet to post.');
      return;
    }
    setPosting(true);
    try {
      const keypair = await signWithBiometrics();
      if (!keypair) throw new Error('Wallet approval is required.');
      const trimmedMedia = mediaUrl.trim();
      const post = await createCreatorPost({
        caption,
        media: trimmedMedia
          ? [{
              media_type: /\.(mp4|mov|m3u8)(\?|$)/i.test(trimmedMedia) ? 'video' : 'image',
              url: trimmedMedia,
              thumbnail_url: trimmedMedia,
            }]
          : [],
        authHeaders: buildWalletAuthHeaders(keypair, 'creator-post'),
      });
      setItems((current) => [post, ...current]);
      setCaption('');
      setMediaUrl('');
    } catch (error) {
      showAlert('Post failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setPosting(false);
    }
  }, [address, caption, mediaUrl, posting, signWithBiometrics]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        back: { color: colors.primary, fontWeight: FontWeight.bold },
        title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, color: colors.text },
        compose: { margin: Spacing.md, padding: Spacing.md, borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface, gap: Spacing.sm },
        input: { color: colors.text, minHeight: 80, fontSize: 16, lineHeight: 24, textAlignVertical: 'top' },
        mediaInput: { color: colors.text, minHeight: 44, fontSize: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderLight, paddingVertical: Spacing.sm },
        postBtn: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', borderRadius: Radius.md, backgroundColor: colors.primary, paddingHorizontal: 22, paddingVertical: 10 },
        postBtnDisabled: { opacity: 0.55 },
        postBtnText: { color: '#fff', fontWeight: FontWeight.bold },
        card: { marginHorizontal: Spacing.md, marginBottom: Spacing.lg, borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden', backgroundColor: colors.surface },
        media: { width: '100%', aspectRatio: 16 / 10, maxHeight: 480, backgroundColor: colors.surfaceSecondary },
        videoStub: { minHeight: 144, gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceSecondary },
        videoText: { color: '#fff', fontFamily: Fonts.bodyBold },
        body: { padding: Spacing.md, gap: 8 },
        creatorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        creatorMeta: { flex: 1, gap: 2 },
        creator: { color: colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold },
        verified: { color: colors.primary, fontWeight: FontWeight.bold },
        caption: { color: colors.textSecondary, lineHeight: 20 },
        stats: { color: colors.textTertiary, fontSize: FontSize.xs },
        center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
        feedback: { padding: Spacing.lg, gap: 8, alignItems: 'center' },
        textButton: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
      }),
    [colors],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator accessibilityLabel="Loading creator feed" color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" style={styles.textButton} onPress={() => router.back()}><Text style={styles.back}>Back</Text></TouchableOpacity>
        <Text style={styles.title}>Creator feed</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh creator feed" style={styles.textButton} onPress={refresh} disabled={refreshing}><Text style={styles.back}>{refreshing ? '…' : 'Refresh'}</Text></TouchableOpacity>
      </View>

      <FlatList
        data={items}
        contentContainerStyle={{ paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        onEndReached={() => { if (!moreError) void loadMore(); }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 20 }} />
          ) : moreError ? <View style={styles.feedback}>
            <Text accessibilityRole="alert" style={styles.caption}>{moreError}</Text>
            <TouchableOpacity accessibilityRole="button" onPress={loadMore} style={styles.textButton}><Text style={styles.back}>Try again</Text></TouchableOpacity>
          </View> : null
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
        ListHeaderComponent={
          <>{loadError ? <View style={styles.feedback}>
            <Text accessibilityRole="alert" style={styles.caption}>{loadError}</Text>
            <TouchableOpacity accessibilityRole="button" onPress={refresh} style={styles.textButton}><Text style={styles.back}>Try again</Text></TouchableOpacity>
          </View> : null}<View style={styles.compose}>
            <Text style={styles.creator}>Share an update</Text>
            <TextInput
              accessibilityLabel="Creator update"
              style={styles.input}
              placeholder="Post a Sakura creator update..."
              placeholderTextColor={colors.textTertiary}
              multiline
              value={caption}
              onChangeText={setCaption}
            />
            <TextInput
              accessibilityLabel="Optional image or video URL"
              keyboardType="url"
              autoCorrect={false}
              style={styles.mediaInput}
              placeholder="Optional image/video URL"
              placeholderTextColor={colors.textTertiary}
              value={mediaUrl}
              onChangeText={setMediaUrl}
              autoCapitalize="none"
            />
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={posting ? 'Publishing update' : 'Publish update'} style={[styles.postBtn, (posting || (!caption.trim() && !mediaUrl.trim())) && styles.postBtnDisabled]} onPress={submitPost} disabled={posting || (!caption.trim() && !mediaUrl.trim())} activeOpacity={0.85}>
              <Text style={styles.postBtnText}>{posting ? 'Posting...' : 'Post'}</Text>
            </TouchableOpacity>
          </View></>
        }
        ListEmptyComponent={!loadError ? <View style={styles.feedback}><Text style={styles.creator}>No updates yet</Text><Text style={styles.caption}>Creator posts will appear here.</Text></View> : null}
        renderItem={({ item }) => {
          const firstMedia = item.media?.[0];
          const isVideo = firstMedia?.media_type === 'video';
          return (
            <View style={styles.card}>
              {firstMedia ? (
                isVideo ? (
                  <View style={styles.videoStub}>
                    <Text style={styles.creator}>Video update</Text>
                    {/^https?:\/\//i.test(firstMedia.url) ? <TouchableOpacity accessibilityRole="link" accessibilityLabel={`Open video from ${creatorName(item)}`} style={styles.textButton} onPress={() => { void Linking.openURL(firstMedia.url); }}><Text style={styles.back}>Open video ↗</Text></TouchableOpacity> : null}
                  </View>
                ) : (
                  <Image source={{ uri: firstMedia.url }} thumbnailWidth={512} style={styles.media} contentFit="cover" accessibilityLabel={`Image shared by ${creatorName(item)}`} />
                )
              ) : null}
              <View style={styles.body}>
                <View style={styles.creatorRow}>
                  <ProfileAvatar
                    profile={{
                      wallet_address: item.creator_wallet,
                      avatar_url: item.creator?.avatar_url ?? null,
                      avatar_seed: item.creator?.avatar_seed ?? item.creator_wallet.slice(0, 8),
                    }}
                    size={36}
                  />
                  <View style={styles.creatorMeta}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.creator}>{creatorName(item)}</Text>
                      {item.creator?.creator_verification_state === 'verified' ? <Text style={styles.verified}>✓</Text> : null}
                    </View>
                  </View>
                </View>
                {item.caption ? <Text style={styles.caption}>{item.caption}</Text> : null}
                <Text style={styles.stats}>
                  {item.like_count} likes · {item.comment_count} comments · {item.view_count} views
                </Text>
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}
