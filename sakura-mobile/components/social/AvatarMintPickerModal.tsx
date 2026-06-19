import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import GorhomSheetModal from '@/components/ui/GorhomSheetModal';
import { solanaExplorerToken } from '@/lib/wallet/config';
import type { AvatarMintItem } from '@/lib/user-avatar';
import { Linking } from 'react-native';

type Props = {
  visible: boolean;
  mints: AvatarMintItem[];
  loading?: boolean;
  selectingId?: string | null;
  onClose: () => void;
  onSelect: (mint: AvatarMintItem) => void;
};

function formatMintDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function AvatarMintPickerModal({
  visible,
  mints,
  loading = false,
  selectingId = null,
  onClose,
  onSelect,
}: Props) {
  const { colors } = useTheme();
  const snapPoints = useMemo(() => ['72%'], []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        header: {
          paddingHorizontal: Spacing.md,
          paddingTop: Spacing.sm,
          paddingBottom: Spacing.md,
        },
        title: {
          fontFamily: Fonts.bodyBold,
          fontSize: FontSize.lg,
          color: colors.text,
        },
        subtitle: {
          marginTop: 4,
          fontFamily: Fonts.body,
          fontSize: FontSize.sm,
          color: colors.textSecondary,
        },
        list: {
          paddingHorizontal: Spacing.md,
          paddingBottom: Spacing.xl,
          gap: Spacing.sm,
        },
        card: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: Spacing.md,
          padding: Spacing.sm,
          borderRadius: Radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          backgroundColor: colors.surfaceSecondary,
        },
        cardActive: {
          borderColor: colors.primary,
          borderWidth: 2,
        },
        thumb: {
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: colors.borderLight,
        },
        meta: { flex: 1 },
        name: {
          fontFamily: Fonts.bodyMedium,
          fontSize: FontSize.md,
          color: colors.text,
        },
        detail: {
          marginTop: 2,
          fontFamily: Fonts.body,
          fontSize: FontSize.xs,
          color: colors.textSecondary,
        },
        activePill: {
          alignSelf: 'flex-start',
          marginTop: 6,
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: Radius.full,
          backgroundColor: `${colors.primary}22`,
        },
        activeText: {
          fontFamily: Fonts.bodyMedium,
          fontSize: FontSize.xs,
          color: colors.primary,
        },
        empty: {
          padding: Spacing.lg,
          alignItems: 'center',
        },
        emptyText: {
          fontFamily: Fonts.body,
          fontSize: FontSize.sm,
          color: colors.textSecondary,
          textAlign: 'center',
        },
      }),
    [colors],
  );

  const openMint = useCallback((mintAddress: string) => {
    Linking.openURL(solanaExplorerToken(mintAddress));
  }, []);

  return (
    <GorhomSheetModal visible={visible} onClose={onClose} snapPoints={snapPoints}>
      <View style={styles.header}>
        <Text style={styles.title}>Your Sakura avatars</Text>
        <Text style={styles.subtitle}>Pick which forged avatar shows on your profile.</Text>
      </View>
      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : mints.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No forged avatars yet.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {mints.map((mint) => {
            const busy = selectingId === mint.id;
            return (
              <TouchableOpacity
                key={mint.id}
                style={[styles.card, mint.is_active && styles.cardActive]}
                onPress={() => onSelect(mint)}
                disabled={busy || mint.is_active}
                activeOpacity={0.85}
              >
                {mint.public_url ? (
                  <Image source={{ uri: mint.public_url }} style={styles.thumb} contentFit="cover" />
                ) : (
                  <View style={styles.thumb} />
                )}
                <View style={styles.meta}>
                  <Text style={styles.name}>
                    {mint.mode === 'tastes' ? 'Taste avatar' : 'Fresh avatar'}
                  </Text>
                  <Text style={styles.detail}>{formatMintDate(mint.created_at)}</Text>
                  {mint.mint_address ? (
                    <Text style={styles.detail}>{mint.mint_address.slice(0, 8)}…</Text>
                  ) : null}
                  {mint.is_active ? (
                    <View style={styles.activePill}>
                      <Text style={styles.activeText}>Active on profile</Text>
                    </View>
                  ) : null}
                </View>
                {busy ? (
                  <ActivityIndicator color={colors.primary} />
                ) : mint.mint_address ? (
                  <TouchableOpacity onPress={() => openMint(mint.mint_address!)} hitSlop={8}>
                    <Ionicons name="open-outline" size={20} color={colors.textSecondary} />
                  </TouchableOpacity>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </GorhomSheetModal>
  );
}
