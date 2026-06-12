import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import WalletButton from '@/components/wallet/WalletButton';
import { Spacing } from '@/constants/theme';

interface HeaderProps {
  showWallet?: boolean;
}

export default function Header({ showWallet = true }: HeaderProps) {
  return (
    <View style={s.row}>
      {/* Left: mascot + text logo */}
      <View style={s.brand}>
        <Image
          source={require('@/assets/images/logo.png')}
          style={s.mascot}
          contentFit="contain"
        />
        <Image
          source={require('@/assets/images/sakura-textlogo.png')}
          style={s.textLogo}
          contentFit="contain"
        />
      </View>

      {showWallet && <WalletButton />}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 4,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  mascot: {
    width: 40,
    height: 40,
  },
  textLogo: {
    width: 80,
    height: 48,
  },
});
