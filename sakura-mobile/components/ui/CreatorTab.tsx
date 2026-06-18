import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import SakuraLottie from '@/components/ui/SakuraLottie';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { supabase } from '@/lib/supabase';
import { type CreatorUserProfile } from '@/lib/creator';
import SubscribeButton from '@/components/social/SubscribeButton';
import { getFollowerCount } from '@/lib/follow';
import { subscribeToCreatorFollows } from '@/lib/follow-realtime';
import { navigateToWalletChat } from '@/lib/user-chat-nav';
import { sendSakura } from '@/lib/wallet/connection';
import { notifySakuraTransfer } from '@/lib/wallet-transfer-notify';
import { useTransferCelebration } from '@/lib/wallet/transfer-celebration';
import GorhomSheetModal from '@/components/ui/GorhomSheetModal';

const TIP_AMOUNTS = [1_000, 5_000, 10_000, 50_000];

function parseTipAmount(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return null;
  const parsed = Math.floor(Number(trimmed));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(seed: string): string {
  const colors = ['#E84545', '#9B59B6', '#3498DB', '#27AE60', '#E67E22', '#E91E8C'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

// ─── Tip Modal ────────────────────────────────────────────────────────────────
function TipModal({
  visible,
  receiverWallet,
  receiverName,
  onClose,
  actionLabel = 'Send',
}: {
  visible: boolean;
  receiverWallet: string;
  receiverName: string;
  onClose: () => void;
  actionLabel?: string;
}) {
  const { colors } = useTheme();
  const { publicKey, signWithBiometrics, sakuraBalance } = useWallet();
  const { showCelebration } = useTransferCelebration();
  const snapPoints = useMemo(() => ['58%'], []);
  const [presetAmount, setPresetAmount] = useState(TIP_AMOUNTS[1]);
  const [customText, setCustomText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (visible) {
      setPresetAmount(TIP_AMOUNTS[1]);
      setCustomText('');
      setSending(false);
    }
  }, [visible]);

  const customAmount = useMemo(() => parseTipAmount(customText), [customText]);
  const usingCustom = customText.trim().length > 0;
  const selected = usingCustom ? customAmount : presetAmount;

  const handleSend = useCallback(async () => {
    if (!publicKey) {
      Alert.alert('Account Required', 'Connect your account in the Profile tab to tip creators.');
      return;
    }
    if (!selected) {
      Alert.alert('Invalid Amount', 'Enter a valid SKR amount to donate.');
      return;
    }
    if (sakuraBalance !== null && sakuraBalance < selected) {
      Alert.alert('Insufficient Balance', `You need ${selected.toLocaleString()} SKR to send this tip.`);
      return;
    }
    setSending(true);
    try {
      const kp = await signWithBiometrics();
      if (!kp) { setSending(false); return; }
      const txid = await sendSakura(kp, receiverWallet, selected);
      setSending(false);
      onClose();
      void notifySakuraTransfer({
        senderWallet: publicKey.toBase58(),
        receiverWallet,
        amount: selected,
        txid,
      });
      showCelebration({
        role: 'sent',
        amount: selected,
        counterparty: receiverWallet,
        title: 'Donation sent!',
        subtitle: `${selected.toLocaleString()} SKR sent to ${receiverName}`,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setSending(false);
      Alert.alert('Send Failed', e?.message ?? 'Please try again.');
    }
  }, [publicKey, sakuraBalance, selected, receiverWallet, receiverName, signWithBiometrics, onClose, showCelebration]);

  const s = StyleSheet.create({
    content: { padding: 24, paddingBottom: 32 },
    title: { fontSize: FontSize.lg, fontFamily: Fonts.bodyBold, color: colors.text, textAlign: 'center', marginBottom: 4 },
    sub: { fontSize: FontSize.sm, fontFamily: Fonts.body, color: colors.textSecondary, textAlign: 'center', marginBottom: 24 },
    amountsRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
    amountBtn: { flex: 1, paddingVertical: 12, borderRadius: Radius.md, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', backgroundColor: colors.surfaceSecondary },
    amountBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary + '18' },
    amountTxt: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.textSecondary },
    amountTxtActive: { color: colors.primary },
    customRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.md,
      borderWidth: 1.5,
      borderColor: usingCustom ? colors.primary : colors.border,
      paddingHorizontal: 14,
      marginBottom: 24,
    },
    customInput: {
      flex: 1,
      fontSize: FontSize.md,
      fontFamily: Fonts.bodyBold,
      color: colors.text,
      paddingVertical: 12,
    },
    customLabel: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.textSecondary, marginLeft: 8 },
    customHint: { fontSize: FontSize.xs, fontFamily: Fonts.body, color: '#FF3B30', marginTop: -16, marginBottom: 16, textAlign: 'center' },
    sendBtn: { borderRadius: Radius.full, overflow: 'hidden' },
    sendGrad: { paddingVertical: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
    sendTxt: { color: '#fff', fontSize: FontSize.md, fontFamily: Fonts.bodyBold },
    balance: { fontSize: FontSize.xs, fontFamily: Fonts.body, color: colors.textTertiary, textAlign: 'center', marginTop: 12 },
  });

  return (
    <GorhomSheetModal visible={visible} onClose={onClose} snapPoints={snapPoints}>
      <BottomSheetScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.title}>Support {receiverName}</Text>
        <Text style={s.sub}>Send SKR from your Sakura account</Text>
        <View style={s.amountsRow}>
          {TIP_AMOUNTS.map((amt) => (
            <TouchableOpacity
              key={amt}
              style={[s.amountBtn, !usingCustom && presetAmount === amt && s.amountBtnActive]}
              onPress={() => {
                setPresetAmount(amt);
                setCustomText('');
                Haptics.selectionAsync();
              }}
              activeOpacity={0.8}
            >
              <Text style={[s.amountTxt, !usingCustom && presetAmount === amt && s.amountTxtActive]}>
                {amt >= 1000 ? `${amt / 1000}K` : amt}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.customRow}>
          <TextInput
            style={s.customInput}
            value={customText}
            onChangeText={(text) => setCustomText(text.replace(/[^\d,]/g, ''))}
            placeholder="Custom amount"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            returnKeyType="done"
          />
          <Text style={s.customLabel}>SKR</Text>
        </View>
        {usingCustom && customText.trim() && !customAmount && (
          <Text style={s.customHint}>Enter a valid amount</Text>
        )}
        <TouchableOpacity
          style={s.sendBtn}
          onPress={handleSend}
          disabled={sending || !selected}
          activeOpacity={0.88}
        >
          <LinearGradient colors={['#E84545', '#9B21BE']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.sendGrad}>
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={s.sendTxt}>
                {selected
                  ? `${actionLabel} ${selected.toLocaleString()} SKR`
                  : `${actionLabel} SKR`}
              </Text>
            )}
          </LinearGradient>
        </TouchableOpacity>
        {sakuraBalance !== null && (
          <Text style={s.balance}>Balance: {Math.floor(sakuraBalance).toLocaleString()} SKR</Text>
        )}
      </BottomSheetScrollView>
    </GorhomSheetModal>
  );
}

// ─── Creator / Author Tab ─────────────────────────────────────────────────────
export default function CreatorTab({
  creatorWallet,
  displayName: displayNameOverride,
  avatarImage,
  tipLabel = 'Tip Creator',
  showPass = true,
}: {
  creatorWallet: string;
  displayName?: string;
  avatarImage?: number | { uri: string };
  tipLabel?: string;
  showPass?: boolean;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const { address, unlockForAppSession } = useWallet();
  const [profile, setProfile] = useState<CreatorUserProfile | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [followerCount, setFollowerCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tipOpen, setTipOpen] = useState(false);

  const refreshFollowerCount = useCallback(() => {
    getFollowerCount(creatorWallet).then(setFollowerCount);
  }, [creatorWallet]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from('user_profiles').select('*').eq('wallet_address', creatorWallet).maybeSingle(),
      supabase.from('sakura_usernames').select('username').eq('wallet_address', creatorWallet).maybeSingle(),
      getFollowerCount(creatorWallet),
    ])
      .then(([profileRes, usernameRes, count]) => {
        if (cancelled) return;
        setProfile(profileRes.data as CreatorUserProfile | null);
        setUsername(usernameRes.data?.username ?? null);
        setFollowerCount(count);
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(null);
          setUsername(null);
          setFollowerCount(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creatorWallet]);

  useEffect(() => {
    if (!creatorWallet) return;
    return subscribeToCreatorFollows(creatorWallet, address ?? null, {
      onFollowersChanged: () => refreshFollowerCount(),
      onProfileFollowerCount: setFollowerCount,
    });
  }, [creatorWallet, address, refreshFollowerCount]);

  const openChannel = () => {
    if (username) router.push({ pathname: '/creator/[username]', params: { username } } as never);
  };

  const openChat = async () => {
    if (!address) {
      Alert.alert('Connect Account', 'Connect your Sakura account to message this creator.');
      return;
    }
    if (address === creatorWallet) {
      router.push('/(tabs)/messages');
      return;
    }
    try {
      const kp = await unlockForAppSession();
      if (!kp) return;
      await navigateToWalletChat(router, kp, {
        walletAddress: creatorWallet,
        displayName: displayNameOverride ?? profile?.display_name ?? null,
        username,
        avatarUrl: profile?.avatar_url ?? null,
        avatarSeed: profile?.avatar_seed ?? creatorWallet.slice(0, 8),
      });
    } catch (e) {
      Alert.alert('Message failed', e instanceof Error ? e.message : 'Try again.');
    }
  };

  const displayName =
    displayNameOverride ??
    profile?.display_name ??
    creatorWallet.slice(0, 6) + '…' + creatorWallet.slice(-4);
  const seed = profile?.avatar_seed ?? creatorWallet.slice(0, 8);
  const bg = avatarColor(seed);
  const abbr = initials(displayNameOverride ?? profile?.display_name ?? null);

  const s = StyleSheet.create({
    root: { paddingHorizontal: Spacing.md, paddingTop: 12, paddingBottom: 28 },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      flexShrink: 0,
    },
    avatarText: { color: '#fff', fontSize: 24, fontFamily: Fonts.bodyBold },
    headerBody: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    headerInfo: { flex: 1, gap: 2 },
    name: { fontSize: FontSize.lg, fontFamily: Fonts.bodyBold, color: colors.text },
    handle: { fontSize: FontSize.sm, fontFamily: Fonts.body, color: colors.textSecondary },
    wallet: { fontSize: FontSize.xs, fontFamily: Fonts.body, color: colors.textTertiary },
    statItem: { alignItems: 'flex-end', gap: 2 },
    statVal: { fontSize: FontSize.lg, fontFamily: Fonts.bodyBold, color: colors.text },
    statLbl: { fontSize: FontSize.xs, fontFamily: Fonts.body, color: colors.textTertiary },
    bio: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.body,
      color: colors.textSecondary,
      lineHeight: 20,
      marginTop: 14,
    },
    actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, width: '100%' },
    tipBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 11,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: colors.primary,
      backgroundColor: 'transparent',
    },
    tipLottie: { width: 22, height: 22 },
    tipTxt: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.primary },
    outlineBtn: {
      flex: 1,
      paddingVertical: 11,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
    },
    iconBtn: {
      width: 44,
      height: 44,
      borderRadius: Radius.md,
      borderWidth: 1.5,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
    },
    outlineTxt: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.text },
  });

  if (loading) {
    return (
      <View style={[s.root, { alignItems: 'center', paddingTop: 40 }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.headerRow}>
        <View style={[s.avatar, !avatarImage && { backgroundColor: bg }]}>
          {avatarImage ? (
            <Image source={avatarImage} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <Text style={s.avatarText}>{abbr}</Text>
          )}
        </View>

        <View style={s.headerBody}>
          <TouchableOpacity style={s.headerInfo} onPress={openChannel} disabled={!username} activeOpacity={username ? 0.8 : 1}>
            <Text style={s.name} numberOfLines={1}>{displayName}</Text>
            {username ? (
              <Text style={s.handle} numberOfLines={1}>@{username}</Text>
            ) : (
              <Text style={s.wallet} numberOfLines={1}>{creatorWallet.slice(0, 6)}…{creatorWallet.slice(-6)}</Text>
            )}
          </TouchableOpacity>

          <View style={s.statItem}>
            <Text style={s.statVal}>{followerCount.toLocaleString()}</Text>
            <Text style={s.statLbl}>Subscribers</Text>
          </View>
        </View>
      </View>

      <View style={s.actionsRow}>
        <SubscribeButton
          creatorWallet={creatorWallet}
          iconOnly
          onChange={(_, count) => {
            if (count !== undefined) setFollowerCount(count);
            else refreshFollowerCount();
          }}
        />
        <TouchableOpacity style={s.iconBtn} onPress={openChat} activeOpacity={0.85}>
          <Ionicons name="chatbubbles-outline" size={22} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity
          style={s.tipBtn}
          onPress={() => { setTipOpen(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
          activeOpacity={0.88}
        >
          <SakuraLottie
            source={require('@/assets/lottie/donate.json')}
            style={s.tipLottie}
            autoPlay
            loop
            speed={0.9}
          />
          <Text style={s.tipTxt}>{tipLabel}</Text>
        </TouchableOpacity>
        {showPass ? (
          <TouchableOpacity
            style={s.outlineBtn}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push('/(tabs)/profile' as any); }}
            activeOpacity={0.88}
          >
            <Text style={s.outlineTxt}>Get Pass</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {profile?.bio ? <Text style={s.bio}>{profile.bio}</Text> : null}

      <TipModal
        visible={tipOpen}
        receiverWallet={creatorWallet}
        receiverName={displayName}
        onClose={() => setTipOpen(false)}
        actionLabel={tipLabel === 'Donate' ? 'Donate' : 'Send'}
      />
    </View>
  );
}
