import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { getCreatorSocialState, setCreatorFollow, type CreatorSocialState } from '@/lib/creator-social';
import { getOrRefreshWalletAuthSession } from '@/lib/wallet-auth-session';

type Props = {
  targetWallet: string;
  viewerWallet?: string | null;
  compact?: boolean;
  /** Fires with the fresh social state (incl. follower_count) on load and after
   *  each follow/unfollow, so the parent can keep a displayed count in sync. */
  onFollowChange?: (state: CreatorSocialState) => void;
};

export default function UserSocialActions({ targetWallet, viewerWallet, compact, onFollowChange }: Props) {
  const { colors } = useTheme();
  const router = useRouter();
  const { signWithBiometrics } = useWallet();
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const isSelf = viewerWallet === targetWallet;

  useEffect(() => {
    if (!targetWallet || isSelf) {
      setLoading(false);
      return;
    }
    getCreatorSocialState(targetWallet, viewerWallet)
      .then((state) => {
        setFollowing(state.following);
        onFollowChange?.(state);
      })
      .catch(() => setFollowing(false))
      .finally(() => setLoading(false));
  }, [targetWallet, viewerWallet, isSelf, onFollowChange]);

  const toggleFollow = useCallback(async () => {
    if (!viewerWallet) {
      Alert.alert('Connect wallet', 'Connect your Sakura wallet to follow users.');
      return;
    }
    setFollowBusy(true);
    try {
      const headers = await getOrRefreshWalletAuthSession(signWithBiometrics, 'creator-follow');
      const next = await setCreatorFollow({
        creatorWallet: targetWallet,
        following: !following,
        authHeaders: headers,
      });
      setFollowing(next.following);
      onFollowChange?.(next);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Follow failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setFollowBusy(false);
    }
  }, [following, signWithBiometrics, targetWallet, viewerWallet, onFollowChange]);

  const openMessage = useCallback(() => {
    if (!viewerWallet) {
      Alert.alert('Connect wallet', 'Connect your Sakura wallet to send messages.');
      return;
    }
    router.push({ pathname: '/creator-chat', params: { wallet: targetWallet } } as never);
  }, [router, targetWallet, viewerWallet]);

  if (isSelf || loading) return null;

  const s = StyleSheet.create({
    row: {
      flexDirection: 'row',
      gap: 10,
      width: '100%',
      marginTop: compact ? 0 : 12,
    },
    followBtn: {
      flex: 1,
      paddingVertical: compact ? 10 : 12,
      borderRadius: Radius.full,
      backgroundColor: following ? colors.surfaceSecondary : colors.primary,
      alignItems: 'center',
      borderWidth: 1.5,
      borderColor: following ? colors.border : colors.primary,
    },
    followTxt: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.bold,
      color: following ? colors.text : '#fff',
    },
    messageBtn: {
      flex: 1,
      paddingVertical: compact ? 10 : 12,
      borderRadius: Radius.full,
      alignItems: 'center',
      borderWidth: 1.5,
      borderColor: colors.primary,
    },
    messageTxt: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.bold,
      color: colors.primary,
    },
  });

  return (
    <View style={s.row}>
      <TouchableOpacity style={s.followBtn} onPress={toggleFollow} disabled={followBusy} activeOpacity={0.88}>
        {followBusy ? (
          <ActivityIndicator color={following ? colors.primary : '#fff'} size="small" />
        ) : (
          <Text style={s.followTxt}>{following ? 'Following' : 'Follow'}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity style={s.messageBtn} onPress={openMessage} activeOpacity={0.88}>
        <Text style={s.messageTxt}>Message</Text>
      </TouchableOpacity>
    </View>
  );
}
