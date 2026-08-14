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
import { ShimmerBox } from '@/components/ui/ShimmerLoader';
import { useTheme } from '@/lib/theme';
import type { AvatarApologyGrantStatus } from '@/lib/user-avatar';

const ACCENT = '#E84545';

interface Props {
  visible: boolean;
  grant: AvatarApologyGrantStatus;
  busy?: boolean;
  /** 1-based progress while the free avatars are being forged. */
  forging?: { index: number; total: number } | null;
  /** Last forge outcome, already phrased for the user by the bridge. */
  error?: string | null;
  /** Forges what is still owed, or opens the picker when nothing is. */
  onPrimary: () => void;
  /** Durable "don't ask me again" — writes the server-side latch. */
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

/**
 * Only ever claims a refund that was actually recorded. This user noticed a
 * missing balance once already and will check again within seconds of reading
 * this; an unbacked promise here is the second broken promise in a row. Refunds
 * are sent by hand, so refund_sakura stays 0 until the transfer has confirmed.
 */
function refundLine(grant: AvatarApologyGrantStatus): string | null {
  if (grant.refund_sakura <= 0) return null;
  return `We have sent your ${grant.refund_sakura.toLocaleString()} SAKURA back to this wallet.`;
}

/**
 * The gift, in whatever tense is TRUE right now.
 *
 * The old copy said "already minted to your wallet" and was written for a flow
 * that pre-minted everything before the card appeared. Under the credit model
 * nothing exists until he taps Forge, so that sentence would be false at exactly
 * the moment he reads it — to the one audience that has already been told
 * something untrue by this feature.
 */
function giftLine(owned: number, left: number): string {
  if (left > 0 && owned === 0) {
    return left === 1
      ? 'So there is an avatar here waiting for you, on us. Forging it costs you nothing — no SAKURA, and no network fee.'
      : `So there are ${left} avatars here waiting for you, on us. Forging them costs you nothing — no SAKURA, and no network fee.`;
  }
  if (left > 0) {
    const have = owned === 1 ? 'One is' : `${owned} are`;
    return left === 1
      ? `${have} already minted to this wallet, and one more is still waiting. That one is free too.`
      : `${have} already minted to this wallet. The other ${left} are still waiting, and they cost you nothing either.`;
  }
  if (owned === 1) return 'It is minted to your wallet now — we did not charge you for it.';
  return `All ${owned} are minted to your wallet now — we did not charge you for any of them.`;
}

/** What happens next, in the state he is actually in. */
function nextLine(owned: number, left: number): string {
  if (left > 0) {
    // Measured: every avatar this platform has ever forged took between 5.3 and
    // 8.6 seconds end to end. Do not promise "about a minute" — an eight-second
    // success then reads as something having gone wrong.
    return left === 1
      ? 'It takes a few seconds. You can close this and come back — nothing is lost and nothing is charged.'
      : 'They forge one at a time, a few seconds each. You can close this and come back — nothing is lost and nothing is charged.';
  }
  if (owned <= 1) return 'Put it on your profile whenever you like.';
  if (owned === 2) {
    return 'Pick the one you want on your profile. The other one stays in your wallet, and you can switch between them anytime.';
  }
  return `Pick the one you want on your profile. The other ${owned - 1} stay in your wallet, and you can switch between them anytime.`;
}

function primaryLabel(owned: number, left: number): string {
  if (left <= 0) return 'Pick my profile picture';
  if (owned > 0) return left === 1 ? 'Forge the last one' : `Forge my other ${left}`;
  return left === 1 ? 'Forge my free avatar' : `Forge my ${left} free avatars`;
}

/**
 * "Keep them all" implies possession he does not have yet, and "No thanks" would
 * imply the offer is gone afterwards — it is not. Dismissing stops the CARD; the
 * credits stay claimable from the ordinary forge, and the footnote says so.
 */
function keepLabel(owned: number): string {
  if (owned === 0) return 'Don’t show this again';
  return owned === 1 ? 'Keep it in my wallet' : 'Keep them all in my wallet';
}

/**
 * The apology card. Message only — choosing is delegated to the existing
 * AvatarMintPickerModal, so there is one picker in the app, not two. Forging is
 * driven by the bridge and reported back through `forging`, so the card stays
 * mounted throughout rather than swapping in a second Modal.
 *
 * Three exits, on purpose. "Forge"/"Pick" and "Keep" both need a wallet unlock,
 * and an unlock can return null (declined, sensor failure, biometric enrolment
 * changed after an OS update). A root-mounted full-screen Modal whose only exits
 * depend on a credential operation is a brick: the user this build exists to
 * apologise to could not reach the app at all. "Not now" and the backdrop are
 * the unconditional local escape — they hide the card for this session and leave
 * the server latch untouched, so it simply comes back next launch. They stay
 * live DURING a forge too: the credits live in Postgres, the in-flight request
 * completes server-side whether or not anyone is listening, and trapping him
 * behind a progress bar is the same brick in a slower form.
 */
export default function AvatarApologyModal({
  visible,
  grant,
  busy = false,
  forging = null,
  error = null,
  onPrimary,
  onKeep,
  onLater,
}: Props) {
  const { colors } = useTheme();
  const owned = grant.minted_count;
  const left = grant.credits_remaining;
  const paused = grant.credits_paused;
  const inReview = grant.credits_in_review;
  const previews = grant.preview_urls.slice(0, 4);
  // One placeholder per avatar he is owed but does not have yet, so the row is
  // never empty and fills in for real as each mint lands.
  const pending = Math.max(0, Math.min(left + paused + inReview, 4 - previews.length));

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
        progress: {
          fontFamily: Fonts.bodyBold,
          fontSize: FontSize.sm,
          color: colors.textSecondary,
          textAlign: 'center',
          marginBottom: Spacing.sm,
        },
        notice: {
          fontFamily: Fonts.body,
          fontSize: FontSize.sm,
          lineHeight: 19,
          color: ACCENT,
          marginBottom: Spacing.sm,
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
        primaryBusy: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: Spacing.sm,
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

  const refund = refundLine(grant);
  // Nothing to forge and nothing minted: the only honest primary action is none.
  const primaryDisabled = busy || (left <= 0 && owned <= 0);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      // Android back is the same unconditional escape as the backdrop, forging
      // or not.
      onRequestClose={onLater}
    >
      <Pressable style={s.backdrop} onPress={onLater}>
        {/* Swallow taps inside the card so they do not dismiss it. */}
        <Pressable style={s.card} onPress={() => {}}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={s.badge}>
              <Text style={s.badgeText}>🌸</Text>
            </View>
            <Text style={s.title}>Sorry — this one&apos;s on us</Text>

            <Text style={s.body}>{lostLine(grant)}</Text>
            {refund ? <Text style={s.body}>{refund}</Text> : null}
            <Text style={s.body}>{giftLine(owned, left)}</Text>

            {refund ? null : (
              <Text style={s.body}>
                To be clear: we have not sent SAKURA back to your wallet
                {left > 0 || owned > 1 ? ' — the apology is the avatars.' : ' — the apology is the avatar.'}
              </Text>
            )}

            {/* True in BOTH branches, and worth 100,000 SAKURA to him: all four
                original payment signatures are still unclaimed on chain. A free
                forge does not touch them, and free mints no longer start the 24h
                clock, so he can redeem one straight afterwards. */}
            <Text style={s.body}>
              Your original payment is still sitting unused on chain, so you can still forge the
              avatar you actually paid for whenever you want.
            </Text>

            {previews.length > 0 || pending > 0 ? (
              <View style={s.thumbs}>
                {previews.map((url) => (
                  <Image key={url} source={{ uri: url }} style={s.thumb} contentFit="cover" />
                ))}
                {Array.from({ length: pending }).map((_, i) => (
                  <ShimmerBox key={`pending-${i}`} width={58} height={58} borderRadius={29} />
                ))}
              </View>
            ) : null}

            {forging ? (
              <Text style={s.progress}>
                Forging {forging.index} of {forging.total} — a few seconds each
              </Text>
            ) : null}

            {error ? <Text style={s.notice}>{error}</Text> : null}

            {inReview > 0 ? (
              <Text style={s.notice}>
                {inReview === 1
                  ? 'One of them may already have been minted — check your wallet. We are confirming it and nothing was charged.'
                  : `${inReview} of them may already have been minted — check your wallet. We are confirming them and nothing was charged.`}
              </Text>
            ) : null}

            {paused > 0 ? (
              <Text style={s.notice}>
                {paused === 1 ? 'One free avatar is' : `${paused} free avatars are`} paused for a
                moment while we check something on our side. Nothing is lost — they are still yours.
              </Text>
            ) : null}

            <Text style={s.body}>{nextLine(owned, left)}</Text>

            <TouchableOpacity
              style={s.primary}
              onPress={onPrimary}
              disabled={primaryDisabled}
              activeOpacity={0.85}
            >
              {busy ? (
                <View style={s.primaryBusy}>
                  <ActivityIndicator color="#fff" />
                  {forging ? (
                    <Text style={s.primaryText}>
                      Forging {forging.index} of {forging.total}…
                    </Text>
                  ) : null}
                </View>
              ) : (
                <Text style={s.primaryText}>{primaryLabel(owned, left)}</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={s.secondary} onPress={onKeep} disabled={busy} activeOpacity={0.7}>
              <Text style={s.secondaryText}>{keepLabel(owned)}</Text>
            </TouchableOpacity>

            {/* Never disabled: this is the escape hatch, and a forge in flight is
                exactly when it matters most. */}
            <TouchableOpacity style={s.tertiary} onPress={onLater} activeOpacity={0.7}>
              <Text style={s.tertiaryText}>Not now</Text>
            </TouchableOpacity>

            <Text style={s.footnote}>
              {left > 0
                ? 'Free either way. If you close this, they stay waiting for you under your profile picture.'
                : 'Either way they’re yours to keep.'}
            </Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
