import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import type { AvatarApologyGrantStatus } from '@/lib/user-avatar';

const ACCENT = '#E84545';

interface Props {
  visible: boolean;
  grant: AvatarApologyGrantStatus;
  busy?: boolean;
  /** Opens the picker. Requires an unlock, so it can fail. */
  onPick: () => void;
  /** Durable "I don't want to choose now" — writes the server-side latch. */
  onKeep: () => void;
  /** Session-only escape. Never touches the wallet, never fails. */
  onLater: () => void;
}

function lostLine(grant: AvatarApologyGrantStatus): string {
  const amount = grant.charged_sakura > 0 ? `${grant.charged_sakura.toLocaleString()} SAKURA` : 'SAKURA';
  // "got nothing back" is only true for a wallet that received zero avatars.
  // Three of the four affected wallets paid twice and received once, and telling
  // them they got nothing reads as a company that does not know what it did.
  if (grant.incident === 'charged_twice_delivered_once' || grant.received_count > 0) {
    return `You were charged ${amount} for an avatar that never arrived. That was a bug on our side, not anything you did.`;
  }
  return `You sent ${amount} to forge an avatar and got nothing back. That was a bug on our side, not anything you did.`;
}

function giftLine(count: number): string {
  if (count === 1) {
    return 'So here is an avatar, already minted to your wallet — we did not charge you for it. To be clear: we have not sent SAKURA back to your wallet. The apology is the avatar.';
  }
  return `So here are ${count} avatars, already minted to your wallet — we did not charge you for any of them. To be clear: we have not sent SAKURA back to your wallet. The apology is the avatars.`;
}

function pickLine(count: number): string {
  if (count <= 1) return 'Put it on your profile whenever you like.';
  if (count === 2) {
    return 'Pick the one you want on your profile. The other one stays in your wallet, and you can switch between them anytime.';
  }
  return `Pick the one you want on your profile. The other ${count - 1} stay in your wallet, and you can switch between them anytime.`;
}

/**
 * The apology card. Message only — choosing is delegated to the existing
 * AvatarMintPickerModal, so there is one picker in the app, not two.
 *
 * Three exits, on purpose. "Pick" and "Keep" both need a wallet unlock, and an
 * unlock can return null (declined, sensor failure, biometric enrolment changed
 * after an OS update). A root-mounted full-screen Modal whose only exits depend
 * on a credential operation is a brick: the user this build exists to apologise
 * to could not reach the app at all. "Not now" and the backdrop are the
 * unconditional local escape — they hide the card for this session and leave the
 * server latch untouched, so it simply comes back next launch.
 */
export default function AvatarApologyModal({
  visible,
  grant,
  busy = false,
  onPick,
  onKeep,
  onLater,
}: Props) {
  const { colors } = useTheme();
  const count = grant.minted_count || grant.avatar_count;
  const previews = grant.preview_urls.slice(0, 4);

  const s = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        card: {
          width: '100%',
          maxWidth: 400,
          maxHeight: '88%',
          backgroundColor: colors.surface,
          borderRadius: 28,
          padding: 22,
          borderWidth: 1,
          borderColor: colors.borderLight,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 12 },
          shadowOpacity: 0.28,
          shadowRadius: 28,
          elevation: 12,
        },
        badge: {
          alignSelf: 'center',
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: colors.surfaceSecondary,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: Spacing.sm,
        },
        badgeText: { fontSize: 26 },
        title: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: FontSize.display,
          color: colors.text,
          textAlign: 'center',
          marginBottom: Spacing.sm,
        },
        body: {
          fontFamily: Fonts.body,
          fontSize: FontSize.md,
          lineHeight: 21,
          color: colors.textSecondary,
          marginBottom: Spacing.sm,
        },
        thumbs: {
          flexDirection: 'row',
          justifyContent: 'center',
          gap: Spacing.sm,
          marginVertical: Spacing.md,
        },
        thumb: {
          width: 58,
          height: 58,
          borderRadius: 29,
          backgroundColor: colors.surfaceSecondary,
          borderWidth: 2,
          borderColor: colors.borderLight,
        },
        primary: {
          backgroundColor: ACCENT,
          borderRadius: Radius.full,
          paddingVertical: 14,
          alignItems: 'center',
          marginTop: Spacing.sm,
          minHeight: 48,
          justifyContent: 'center',
        },
        primaryText: {
          fontFamily: Fonts.bodyBold,
          fontSize: FontSize.md,
          color: '#fff',
        },
        secondary: {
          paddingVertical: 12,
          alignItems: 'center',
        },
        secondaryText: {
          fontFamily: Fonts.bodyBold,
          fontSize: FontSize.sm,
          color: colors.textSecondary,
        },
        tertiary: {
          paddingVertical: 8,
          alignItems: 'center',
        },
        tertiaryText: {
          fontFamily: Fonts.body,
          fontSize: FontSize.sm,
          color: colors.textTertiary,
        },
        footnote: {
          fontFamily: Fonts.body,
          fontSize: FontSize.xs,
          color: colors.textTertiary,
          textAlign: 'center',
          marginTop: Spacing.xs,
        },
      }),
    [colors],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      // Android back is the same unconditional escape as the backdrop.
      onRequestClose={onLater}
    >
      <Pressable style={s.backdrop} onPress={busy ? undefined : onLater}>
        {/* Swallow taps inside the card so they do not dismiss it. */}
        <Pressable style={s.card} onPress={() => {}}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={s.badge}>
              <Text style={s.badgeText}>🌸</Text>
            </View>
            <Text style={s.title}>Sorry — this one&apos;s on us</Text>

            <Text style={s.body}>{lostLine(grant)}</Text>
            <Text style={s.body}>{giftLine(count)}</Text>
            <Text style={s.body}>
              Your original payment is still sitting unused on chain, so you can still forge the
              avatar you actually paid for whenever you want.
            </Text>

            {previews.length > 0 ? (
              <View style={s.thumbs}>
                {previews.map((url) => (
                  <Image key={url} source={{ uri: url }} style={s.thumb} contentFit="cover" />
                ))}
              </View>
            ) : null}

            <Text style={s.body}>{pickLine(count)}</Text>

            <TouchableOpacity style={s.primary} onPress={onPick} disabled={busy} activeOpacity={0.85}>
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.primaryText}>Pick my profile picture</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={s.secondary} onPress={onKeep} disabled={busy} activeOpacity={0.7}>
              <Text style={s.secondaryText}>Keep them all in my wallet</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.tertiary} onPress={onLater} disabled={busy} activeOpacity={0.7}>
              <Text style={s.tertiaryText}>Not now</Text>
            </TouchableOpacity>

            <Text style={s.footnote}>Either way they&apos;re yours to keep.</Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
