import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import SakuraLottie from '@/components/ui/SakuraLottie';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { supabase } from '@/lib/supabase';
import { type CreatorUserProfile } from '@/lib/creator';
import { getCreatorSocialState, setCreatorFollow, type CreatorSocialState } from '@/lib/creator-social';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { sendSakura } from '@/lib/wallet/connection';
import { notifySakuraTransfer } from '@/lib/wallet-transfer-notify';
import { useTransferCelebration } from '@/lib/wallet/transfer-celebration';

const TIP_AMOUNTS = [1_000, 5_000, 10_000, 50_000];

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
  const [selected, setSelected] = useState(TIP_AMOUNTS[1]);
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!publicKey) {
      Alert.alert('Wallet Required', 'Connect your wallet in the Profile tab to tip creators.');
      return;
    }
    if (sakuraBalance !== null && sakuraBalance < selected) {
      Alert.alert('Insufficient Balance', `You need ${selected.toLocaleString()} $SAKURA to send this tip.`);
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
        subtitle: `${selected.toLocaleString()} $SAKURA sent to ${receiverName}`,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: unknown) {
      setSending(false);
      Alert.alert('Transaction Failed', e instanceof Error ? e.message : 'Please try again.');
    }
  }, [publicKey, sakuraBalance, selected, receiverWallet, receiverName, signWithBiometrics, onClose, showCelebration]);

  const s = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
    handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 20 },
    title: { fontSize: FontSize.lg, fontFamily: Fonts.bodyBold, color: colors.text, textAlign: 'center', marginBottom: 4 },
    sub: { fontSize: FontSize.sm, fontFamily: Fonts.body, color: colors.textSecondary, textAlign: 'center', marginBottom: 24 },
    amountsRow: { flexDirection: 'row', gap: 10, marginBottom: 24 },
    amountBtn: { flex: 1, paddingVertical: 12, borderRadius: Radius.md, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', backgroundColor: colors.surfaceSecondary },
    amountBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary + '18' },
    amountTxt: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.textSecondary },
    amountTxtActive: { color: colors.primary },
    sendBtn: { borderRadius: Radius.full, overflow: 'hidden' },
    sendGrad: { paddingVertical: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
    sendTxt: { color: '#fff', fontSize: FontSize.md, fontFamily: Fonts.bodyBold },
    balance: { fontSize: FontSize.xs, fontFamily: Fonts.body, color: colors.textTertiary, textAlign: 'center', marginTop: 12 },
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}}>
          <View style={s.sheet}>
            <View style={s.handle} />
            <Text style={s.title}>Support {receiverName}</Text>
            <Text style={s.sub}>Send $SAKURA from your Sakura wallet</Text>
            <View style={s.amountsRow}>
              {TIP_AMOUNTS.map((amt) => (
                <TouchableOpacity
                  key={amt}
                  style={[s.amountBtn, selected === amt && s.amountBtnActive]}
                  onPress={() => { setSelected(amt); Haptics.selectionAsync(); }}
                  activeOpacity={0.8}
                >
                  <Text style={[s.amountTxt, selected === amt && s.amountTxtActive]}>
                    {amt >= 1000 ? `${amt / 1000}K` : amt}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={s.sendBtn} onPress={handleSend} disabled={sending} activeOpacity={0.88}>
              <LinearGradient colors={['#E84545', '#9B21BE']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.sendGrad}>
                {sending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={s.sendTxt}>{actionLabel} {selected.toLocaleString()} $SAKURA</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>
            {sakuraBalance !== null && (
              <Text style={s.balance}>Balance: {Math.floor(sakuraBalance).toLocaleString()} $SAKURA</Text>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
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
  const { address, signWithBiometrics } = useWallet();
  const [profile, setProfile] = useState<CreatorUserProfile | null>(null);
  const [social, setSocial] = useState<CreatorSocialState | null>(null);
  const [loading, setLoading] = useState(true);
  const [followBusy, setFollowBusy] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from('user_profiles').select('*').eq('wallet_address', creatorWallet).maybeSingle(),
      getCreatorSocialState(creatorWallet, address),
    ]).then(([{ data }, socialState]) => {
      setProfile(data as CreatorUserProfile | null);
      setSocial(socialState);
      setLoading(false);
    });
  }, [creatorWallet, address]);

  const toggleFollow = useCallback(async () => {
    if (!address) {
      Alert.alert('Wallet Required', 'Connect your wallet to follow creators.');
      return;
    }
    if (address === creatorWallet) {
      Alert.alert('This is you', 'You cannot follow your own creator profile.');
      return;
    }
    setFollowBusy(true);
    try {
      const kp = await signWithBiometrics();
      if (!kp) return;
      const next = await setCreatorFollow({
        creatorWallet,
        following: !(social?.following ?? false),
        authHeaders: buildWalletAuthHeaders(kp, 'creator-follow'),
      });
      setSocial(next);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Follow failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setFollowBusy(false);
    }
  }, [address, creatorWallet, signWithBiometrics, social?.following]);

  const displayName =
    displayNameOverride ??
    profile?.display_name ??
    creatorWallet.slice(0, 6) + '…' + creatorWallet.slice(-4);
  const seed = profile?.avatar_seed ?? creatorWallet.slice(0, 8);
  const bg = avatarColor(seed);
  const abbr = initials(displayNameOverride ?? profile?.display_name ?? null);

  const s = StyleSheet.create({
    root: { paddingHorizontal: Spacing.md, paddingTop: 20, paddingBottom: 28 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: Radius.lg,
      padding: 20,
      paddingBottom: 24,
      alignItems: 'center',
      gap: 10,
    },
    avatar: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 4, overflow: 'hidden' },
    avatarText: { color: '#fff', fontSize: 24, fontFamily: Fonts.bodyBold },
    name: { fontSize: FontSize.lg, fontFamily: Fonts.bodyBold, color: colors.text, textAlign: 'center' },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    verifiedBadge: { color: colors.primary, fontSize: FontSize.md, fontFamily: Fonts.bodyBold },
    walletRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    wallet: { fontSize: FontSize.xs, fontFamily: Fonts.body, color: colors.textTertiary },
    bio: { fontSize: FontSize.sm, fontFamily: Fonts.body, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 4, width: '100%' },
    followBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: Radius.full,
      backgroundColor: social?.following ? colors.surfaceSecondary : colors.primary,
      alignItems: 'center',
      borderWidth: 1.5,
      borderColor: social?.following ? colors.border : colors.primary,
    },
    followTxt: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyBold,
      color: social?.following ? colors.text : '#fff',
    },
    socialActions: { flexDirection: 'row', width: '100%', gap: 10 },
    messageBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: Radius.full,
      alignItems: 'center',
      borderWidth: 1.5,
      borderColor: colors.primary,
    },
    messageTxt: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.primary },
    tipBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 12,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: colors.primary,
      backgroundColor: colors.surface,
    },
    tipLottie: { width: 24, height: 24 },
    tipTxt: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.primary },
    passBtn: { flex: 1, paddingVertical: 12, borderRadius: Radius.full, borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
    passTxt: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, color: colors.primary },
    divider: { width: '100%', height: 1, backgroundColor: colors.border, marginVertical: 4 },
    statRow: { flexDirection: 'row', width: '100%', justifyContent: 'center' },
    statItem: { flex: 1, alignItems: 'center', gap: 2 },
    statVal: { fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.text },
    statLbl: { fontSize: FontSize.xs, fontFamily: Fonts.body, color: colors.textTertiary },
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
      <View style={s.card}>
        {/* Avatar */}
        <View style={[s.avatar, !avatarImage && { backgroundColor: bg }]}>
          {avatarImage ? (
            <Image source={avatarImage} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <Text style={s.avatarText}>{abbr}</Text>
          )}
        </View>

        {/* Name */}
        <View style={s.nameRow}>
          <Text style={s.name}>{displayName}</Text>
          {social?.verified ? <Text style={s.verifiedBadge}>✓</Text> : null}
        </View>
        <Text style={s.wallet}>{creatorWallet.slice(0, 6)}…{creatorWallet.slice(-6)}</Text>

        {/* Bio */}
        {profile?.bio ? (
          <Text style={s.bio}>{profile.bio}</Text>
        ) : null}

        <View style={s.divider} />

        {address !== creatorWallet ? (
          <View style={s.socialActions}>
            <TouchableOpacity style={s.followBtn} onPress={toggleFollow} disabled={followBusy} activeOpacity={0.88}>
              {followBusy ? (
                <ActivityIndicator color={social?.following ? colors.primary : '#fff'} size="small" />
              ) : (
                <Text style={s.followTxt}>{social?.following ? 'Following' : 'Follow'}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={s.messageBtn}
              onPress={() => router.push({ pathname: '/creator-chat', params: { wallet: creatorWallet } } as any)}
              activeOpacity={0.88}
            >
              <Text style={s.messageTxt}>Message</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Action buttons */}
        <View style={s.actions}>
          <TouchableOpacity
            style={[s.tipBtn, !showPass && { flex: 1 }]}
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
            <TouchableOpacity style={s.passBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push('/(tabs)/profile' as any); }} activeOpacity={0.88}>
              <Text style={s.passTxt}>Get Pass</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

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
