import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { Image } from 'expo-image';
import { resolveAvatarUri, type AvatarProfileFields } from '@/lib/user-avatar';
import { Radius } from '@/constants/theme';

type Props = {
  profile: AvatarProfileFields;
  size?: number;
  style?: StyleProp<ViewStyle>;
  borderColor?: string;
};

export default function ProfileAvatar({ profile, size = 88, style, borderColor }: Props) {
  const uri = resolveAvatarUri(profile);

  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: borderColor ?? 'transparent',
        },
        style,
      ]}
    >
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        contentFit="cover"
        recyclingKey={uri}
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
