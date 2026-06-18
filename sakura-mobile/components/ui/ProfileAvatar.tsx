import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Image } from 'expo-image';
import {
  resolveAvatarUri,
  hasMintedAvatar,
  walletAccentColor,
  type AvatarProfileFields,
} from '@/lib/user-avatar';

type Props = {
  profile: AvatarProfileFields;
  size?: number;
  style?: StyleProp<ViewStyle>;
  borderColor?: string;
};

export default function ProfileAvatar({ profile, size = 88, style, borderColor }: Props) {
  const uri = resolveAvatarUri(profile);
  const minted = hasMintedAvatar(profile);
  const accent = walletAccentColor(profile.wallet_address);
  const resolvedBorder = borderColor ?? (minted ? 'transparent' : accent);

  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: resolvedBorder,
          borderWidth: minted ? 2 : 3,
        },
        !minted && { backgroundColor: `${accent}22` },
        style,
      ]}
    >
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        contentFit="cover"
        recyclingKey={`${profile.wallet_address}:${uri}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    borderWidth: 2,
  },
});
