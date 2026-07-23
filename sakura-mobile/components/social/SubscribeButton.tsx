import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, StyleSheet } from 'react-native';
import SimpleLineIcons from '@expo/vector-icons/SimpleLineIcons';
import * as Haptics from 'expo-haptics';
import { FontSize, FontWeight, Radius } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { followCreator, unfollowCreator, getFollowerCount, isFollowingCreator } from '@/lib/follow';
import { subscribeToCreatorFollows } from '@/lib/follow-realtime';

type Props = {
  creatorWallet: string;
  compact?: boolean;
  fill?: boolean;
  iconOnly?: boolean;
  onChange?: (following: boolean, followerCount?: number) => void;
};

export default function SubscribeButton({ creatorWallet, compact, fill, iconOnly, onChange }: Props) {
  const { colors } = useTheme();
  const { address, signWithBiometrics } = useWallet();
  const [following, setFollowing] = useState(false);
  const followingRef = useRef(following);
  followingRef.current = following;
  // Keep onChange in a ref so the realtime subscribe effect doesn't tear down
  // and recreate its Supabase channel on every parent re-render (callers pass a
  // fresh inline lambda each render).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const syncCounts = useCallback(
    async (nextFollowing?: boolean) => {
      const count = await getFollowerCount(creatorWallet);
      const f =
        nextFollowing ??
        (address ? await isFollowingCreator(address, creatorWallet) : false);
      setFollowing(f);
      onChangeRef.current?.(f, count);
      return { following: f, count };
    },
    [address, creatorWallet],
  );

  const refresh = useCallback(async () => {
    if (!address || address === creatorWallet) {
      setLoading(false);
      return;
    }
    try {
      await syncCounts();
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [address, creatorWallet, syncCounts]);

  useEffect(() => {
    refresh();
    if (!creatorWallet) return;

    const unsubscribe = subscribeToCreatorFollows(creatorWallet, address, {
      onFollowingChange: (next) => {
        setFollowing(next);
        getFollowerCount(creatorWallet)
          .then((count) => onChangeRef.current?.(next, count))
          .catch(() => onChangeRef.current?.(next));
      },
      onFollowersChanged: () => {
        syncCounts().catch(() => {});
      },
      onProfileFollowerCount: (count) => {
        onChangeRef.current?.(followingRef.current, count);
      },
    });

    return unsubscribe;
    // Only re-subscribe when the creator or viewer actually changes; refresh and
    // syncCounts are stable, and onChange is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorWallet, address]);

  const toggle = async () => {
    if (!address) {
      Alert.alert('Connect Account', 'Connect your Sakura account to subscribe.');
      return;
    }
    if (address === creatorWallet) return;

    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const nextFollowing = !following;
    setFollowing(nextFollowing);
    try {
      const kp = await signWithBiometrics();
      if (!kp) {
        setFollowing(!nextFollowing);
        setBusy(false);
        return;
      }
      const status = nextFollowing
        ? await followCreator(kp, creatorWallet)
        : await unfollowCreator(kp, creatorWallet);
      setFollowing(status.following);
      onChange?.(status.following, status.follower_count);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setFollowing(!nextFollowing);
      Alert.alert('Subscribe failed', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!address || address === creatorWallet) return null;

  const s = StyleSheet.create({
    btn: {
      flex: fill ? 1 : undefined,
      paddingHorizontal: iconOnly ? 0 : compact ? 14 : 18,
      paddingVertical: iconOnly ? 0 : compact ? 8 : 10,
      borderRadius: iconOnly ? Radius.md : Radius.full,
      backgroundColor: iconOnly ? 'transparent' : following ? colors.surfaceSecondary : colors.primary,
      borderWidth: iconOnly ? 1.5 : following ? 1 : 0,
      borderColor: colors.border,
      minWidth: iconOnly ? 44 : compact ? 88 : 104,
      width: iconOnly ? 44 : undefined,
      height: iconOnly ? 44 : undefined,
      alignItems: 'center',
      justifyContent: 'center',
    },
    txt: {
      fontSize: compact ? FontSize.sm : FontSize.md,
      fontWeight: FontWeight.bold,
      color: following ? colors.text : '#fff',
    },
  });

  const iconColor = iconOnly ? colors.text : following ? colors.text : '#fff';
  const spinnerColor = iconOnly ? colors.text : following ? colors.text : '#fff';

  if (loading) {
    return (
      <TouchableOpacity style={s.btn} disabled activeOpacity={1}>
        <ActivityIndicator size="small" color={colors.primary} />
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity style={s.btn} onPress={toggle} disabled={busy} activeOpacity={0.85}>
      {busy ? (
        <ActivityIndicator size="small" color={spinnerColor} />
      ) : iconOnly ? (
        <SimpleLineIcons
          name={following ? 'user-following' : 'user-follow'}
          size={24}
          color={iconColor}
        />
      ) : (
        <Text style={s.txt}>{following ? 'Subscribed' : 'Subscribe'}</Text>
      )}
    </TouchableOpacity>
  );
}
