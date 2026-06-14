import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { createCreatorPost, fetchCreatorFeed, type CreatorFeedPost } from '@/lib/creator-social';
import ProfileAvatar from '@/components/ui/ProfileAvatar';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { useWallet } from '@/lib/wallet/context';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';

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

  const load = useCallback(async () => {
    const feed = await fetchCreatorFeed(25);
    setItems(feed);
  }, []);

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
    if (!address) {
      Alert.alert('Wallet required', 'Connect your creator wallet to post.');
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
      Alert.alert('Post failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setPosting(false);
    }
  }, [address, caption, mediaUrl, signWithBiometrics]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        back: { color: colors.primary, fontWeight: FontWeight.bold },
        title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, color: colors.text },
        compose: { margin: Spacing.md, padding: Spacing.md, borderRadius: Radius.lg, backgroundColor: colors.surface, gap: Spacing.sm, ...Shadow.sm },
        input: { color: colors.text, minHeight: 70, textAlignVertical: 'top' },
        mediaInput: { color: colors.text, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderLight, paddingTop: Spacing.sm },
        postBtn: { alignSelf: 'flex-end', borderRadius: Radius.full, backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 9 },
        postBtnDisabled: { opacity: 0.55 },
        postBtnText: { color: '#fff', fontWeight: FontWeight.bold },
        card: { minHeight: 420, marginHorizontal: Spacing.md, marginBottom: Spacing.md, borderRadius: Radius.xl, overflow: 'hidden', backgroundColor: colors.surface, ...Shadow.sm },
        media: { width: '100%', height: 310, backgroundColor: colors.surfaceSecondary },
        videoStub: { height: 310, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
        videoText: { color: '#fff', fontFamily: Fonts.bodyBold },
        body: { padding: Spacing.md, gap: 8 },
        creatorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        creatorMeta: { flex: 1, gap: 2 },
        creator: { color: colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold },
        verified: { color: colors.primary, fontWeight: FontWeight.bold },
        caption: { color: colors.textSecondary, lineHeight: 20 },
        stats: { color: colors.textTertiary, fontSize: FontSize.xs },
        center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
      }),
    [colors],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}><Text style={styles.back}>Back</Text></TouchableOpacity>
        <Text style={styles.title}>Creator Feed</Text>
        <View style={{ width: 38 }} />
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
        ListHeaderComponent={
          <View style={styles.compose}>
            <TextInput
              style={styles.input}
              placeholder="Post a Sakura creator update..."
              placeholderTextColor={colors.textTertiary}
              multiline
              value={caption}
              onChangeText={setCaption}
            />
            <TextInput
              style={styles.mediaInput}
              placeholder="Optional image/video URL"
              placeholderTextColor={colors.textTertiary}
              value={mediaUrl}
              onChangeText={setMediaUrl}
              autoCapitalize="none"
            />
            <TouchableOpacity style={[styles.postBtn, posting && styles.postBtnDisabled]} onPress={submitPost} disabled={posting} activeOpacity={0.85}>
              <Text style={styles.postBtnText}>{posting ? 'Posting...' : 'Post'}</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => {
          const firstMedia = item.media?.[0];
          const isVideo = firstMedia?.media_type === 'video';
          return (
            <View style={styles.card}>
              {firstMedia ? (
                isVideo ? (
                  <View style={styles.videoStub}>
                    <Text style={styles.videoText}>Video post</Text>
                    <Text style={[styles.stats, { color: 'rgba(255,255,255,0.7)', marginTop: 6 }]} numberOfLines={1}>{firstMedia.url}</Text>
                  </View>
                ) : (
                  <Image source={{ uri: firstMedia.url }} style={styles.media} contentFit="cover" />
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
