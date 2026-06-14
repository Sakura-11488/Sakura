import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ActivityIndicator, Alert,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { useTheme, AppColors } from '@/lib/theme';
import { useI18n } from '@/lib/i18n';
import { useWallet } from '@/lib/wallet/context';
import {
  ChapterComment, REACTION_EMOJIS, SERIES_CHAPTER_ID,
  commentDisplayName, deleteComment, getComments, postComment, toggleReaction,
} from '@/lib/comments';
import ProfileAvatar from '@/components/ui/ProfileAvatar';
import { Fonts, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function Avatar({ profile, wallet, colors }: { profile?: ChapterComment['profile']; wallet: string; colors: AppColors }) {
  return (
    <ProfileAvatar
      profile={{
        wallet_address: wallet,
        avatar_seed: profile?.avatar_seed || wallet.slice(0, 8),
        avatar_url: profile?.avatar_url,
      }}
      size={36}
      borderColor={colors.borderLight}
    />
  );
}

function CommentRow({
  comment, currentWallet, colors, onReact, onDelete, onOpenProfile,
}: {
  comment: ChapterComment;
  currentWallet: string | null;
  colors: AppColors;
  onReact: (id: number, emoji: string) => void;
  onDelete: (id: number) => void;
  onOpenProfile: (wallet: string) => void;
}) {
  const [showEmojis, setShowEmojis] = useState(false);
  const mine = currentWallet && comment.wallet_address === currentWallet;

  return (
    <View style={styles.commentRow}>
      <TouchableOpacity activeOpacity={0.7} onPress={() => onOpenProfile(comment.wallet_address)}>
        <Avatar profile={comment.profile} wallet={comment.wallet_address} colors={colors} />
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <View style={styles.commentHeader}>
          <TouchableOpacity activeOpacity={0.7} onPress={() => onOpenProfile(comment.wallet_address)}>
            <Text style={[styles.author, { color: colors.text }]} numberOfLines={1}>
              {commentDisplayName(comment)}
            </Text>
          </TouchableOpacity>
          {comment.is_highlighted ? <Text style={styles.pin}>📌</Text> : null}
          <Text style={[styles.time, { color: colors.textTertiary }]}>· {timeAgo(comment.created_at)}</Text>
        </View>
        <Text style={[styles.body, { color: colors.textSecondary }]}>{comment.content}</Text>

        <View style={styles.reactionRow}>
          {(comment.reactions ?? []).map((r) => (
            <TouchableOpacity
              key={r.emoji}
              onPress={() => onReact(comment.id, r.emoji)}
              activeOpacity={0.7}
              style={[
                styles.reactionChip,
                { borderColor: colors.border, backgroundColor: r.reacted ? `${colors.primary}22` : 'transparent' },
              ]}
            >
              <Text style={styles.reactionEmoji}>{r.emoji}</Text>
              <Text style={[styles.reactionCount, { color: r.reacted ? colors.primary : colors.textTertiary }]}>{r.count}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity onPress={() => setShowEmojis((v) => !v)} activeOpacity={0.7} style={[styles.reactionChip, { borderColor: colors.border }]}>
            <Svg width={14} height={14} viewBox="0 0 24 24">
              <Path d="M12 8v8M8 12h8" stroke={colors.textTertiary} strokeWidth={2} strokeLinecap="round" />
            </Svg>
          </TouchableOpacity>
          {mine ? (
            <TouchableOpacity onPress={() => onDelete(comment.id)} activeOpacity={0.7} style={styles.deleteBtn}>
              <Text style={[styles.deleteText, { color: '#FF3B30' }]}>Delete</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {showEmojis ? (
          <View style={[styles.emojiPicker, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
            {REACTION_EMOJIS.map((e) => (
              <TouchableOpacity key={e} onPress={() => { onReact(comment.id, e); setShowEmojis(false); }} activeOpacity={0.7}>
                <Text style={styles.pickerEmoji}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export default function CommentsSection({
  contentId,
  chapterId = SERIES_CHAPTER_ID,
  title,
}: {
  contentId: string;
  chapterId?: string;
  title?: string;
}) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const { connected, address } = useWallet();

  const openProfile = useCallback((w: string) => {
    router.push(`/user/${encodeURIComponent(w)}` as any);
  }, [router]);
  const [comments, setComments] = useState<ChapterComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getComments(contentId, chapterId, address ?? undefined);
      setComments(data);
    } catch {
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [contentId, chapterId, address]);

  useEffect(() => { load(); }, [load]);

  const handlePost = useCallback(async () => {
    if (!address || !input.trim() || posting) return;
    setPosting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const created = await postComment(address, contentId, chapterId, input.trim());
    if (created) {
      setInput('');
      await load();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      Alert.alert('Comment', 'Could not post your comment. Please try again.');
    }
    setPosting(false);
  }, [address, input, posting, contentId, chapterId, load]);

  const handleReact = useCallback(async (id: number, emoji: string) => {
    if (!address) return;
    Haptics.selectionAsync();
    // Optimistic update
    setComments((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      const reactions = [...(c.reactions ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === emoji);
      if (idx >= 0) {
        const r = reactions[idx];
        const reacted = !r.reacted;
        const count = Math.max(0, r.count + (reacted ? 1 : -1));
        if (count === 0) reactions.splice(idx, 1);
        else reactions[idx] = { ...r, reacted, count };
      } else {
        reactions.push({ emoji, count: 1, reacted: true });
      }
      return { ...c, reactions };
    }));
    await toggleReaction(id, address, emoji).catch(() => {});
  }, [address]);

  const handleDelete = useCallback((id: number) => {
    if (!address) return;
    Alert.alert('Delete comment?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          setComments((prev) => prev.filter((c) => c.id !== id));
          await deleteComment(id, address).catch(() => {});
        },
      },
    ]);
  }, [address]);

  return (
    <View style={styles.wrap}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>
        {title ?? 'Discussion'}{comments.length ? `  (${comments.length})` : ''}
      </Text>

      {connected ? (
        <View style={[styles.composer, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
          <TextInput
            value={input}
            onChangeText={(v) => setInput(v.slice(0, 500))}
            placeholder="Add to the discussion…"
            placeholderTextColor={colors.textTertiary}
            style={[styles.composerInput, { color: colors.text }]}
            multiline
            maxLength={500}
          />
          <TouchableOpacity
            onPress={handlePost}
            disabled={!input.trim() || posting}
            activeOpacity={0.85}
            style={[styles.postBtn, { backgroundColor: colors.primary, opacity: !input.trim() || posting ? 0.5 : 1 }]}
          >
            {posting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.postBtnText}>Post</Text>}
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={[styles.signedOut, { color: colors.textTertiary }]}>
          {t('wallet.connectDesc')}
        </Text>
      )}

      {loading ? (
        <ActivityIndicator style={{ marginVertical: 24 }} color={colors.primary} />
      ) : comments.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textTertiary }]}>Be the first to comment.</Text>
      ) : (
        comments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            currentWallet={address}
            colors={colors}
            onReact={handleReact}
            onDelete={handleDelete}
            onOpenProfile={openProfile}
          />
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:          { paddingHorizontal: Spacing.md, paddingTop: Spacing.md },
  sectionTitle:  { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 18, marginBottom: 12 },
  composer:      { borderWidth: 1, borderRadius: Radius.lg, padding: 10, marginBottom: 16, flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  composerInput: { flex: 1, fontSize: FontSize.md, maxHeight: 120, paddingTop: 4 },
  postBtn:       { borderRadius: Radius.full, paddingHorizontal: 16, paddingVertical: 8, minWidth: 56, alignItems: 'center' },
  postBtnText:   { color: '#fff', fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  signedOut:     { fontSize: FontSize.sm, marginBottom: 16, fontStyle: 'italic' },
  empty:         { fontSize: FontSize.sm, textAlign: 'center', marginVertical: 24 },
  commentRow:    { flexDirection: 'row', gap: 10, marginBottom: 18 },
  avatar:        { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  avatarText:    { color: '#fff', fontWeight: FontWeight.bold, fontSize: FontSize.xs },
  commentHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  author:        { fontSize: FontSize.sm, fontWeight: FontWeight.bold, maxWidth: 160 },
  pin:           { fontSize: 11 },
  time:          { fontSize: FontSize.xs },
  body:          { fontSize: FontSize.sm, lineHeight: 19, marginTop: 2 },
  reactionRow:   { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  reactionChip:  { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  reactionEmoji: { fontSize: 12 },
  reactionCount: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  deleteBtn:     { paddingHorizontal: 6, paddingVertical: 3 },
  deleteText:    { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  emojiPicker:   { flexDirection: 'row', gap: 10, borderWidth: 1, borderRadius: Radius.full, paddingHorizontal: 12, paddingVertical: 6, marginTop: 8, alignSelf: 'flex-start' },
  pickerEmoji:   { fontSize: 20 },
});
