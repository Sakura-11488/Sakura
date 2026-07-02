import React, { useMemo, useRef, useState } from 'react';
import { TouchableOpacity, Text, StyleSheet, Platform, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
} from 'react-native-reanimated';
import SakuraLottie from '@/components/ui/SakuraLottie';
import * as Haptics from 'expo-haptics';
import { playTap } from '@/lib/sound';
import { useWallet } from '@/lib/wallet/context';
import WalletModal from './WalletModal';
import { Radius, FontSize, FontWeight, Shadow, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

export default function WalletButton() {
  const [modalVisible, setModalVisible] = useState(false);
  const { connected, shortAddress, sakuraBalance } = useWallet();
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  const lottieRef = useRef<React.ElementRef<typeof SakuraLottie>>(null);

  const s = useMemo(() => StyleSheet.create({
    btn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: '#E84545',
      backgroundColor: colors.white,
      ...Shadow.sm,
    },
    btnConnected: {
      backgroundColor: '#E84545',
      borderColor: '#E84545',
    },
    lottie: {
      width: 28,
      height: 28,
    },
    label: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.bold,
      color: '#E84545',
      fontFamily: Fonts.body,
    },
    labelConnected: {
      color: '#fff',
    },
    lottieWrap: {
      pointerEvents: 'none',
    },
    webBtn: Platform.OS === 'web' ? ({ cursor: 'pointer' } as const) : {},
  }), [colors]);

  const btnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    setModalVisible(true);
    if (Platform.OS !== 'web') {
      scale.value = withSequence(
        withSpring(0.92, { damping: 12 }),
        withSpring(1, { damping: 10 })
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    try {
      lottieRef.current?.play();
    } catch {
      // lottie-react-native web can throw if composition is not ready
    }
    playTap();
  };

  const buttonContent = (
    <>
      <View style={s.lottieWrap}>
        <SakuraLottie
          ref={lottieRef}
          key={connected ? 'wallet-connected' : 'wallet-disconnected'}
          source={require('@/assets/lottie/wallet.json')}
          style={s.lottie}
          autoPlay
          loop
          speed={0.55}
        />
      </View>
      <Text style={[s.label, connected && s.labelConnected]}>
        {connected
          ? sakuraBalance !== null
            ? `${sakuraBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} SKR`
            : shortAddress ?? 'Account'
          : 'Connect'}
      </Text>
    </>
  );

  const buttonStyles = [s.btn, connected && s.btnConnected, s.webBtn];

  return (
    <>
      {Platform.OS === 'web' ? (
        <TouchableOpacity
          onPress={handlePress}
          activeOpacity={0.85}
          style={buttonStyles}
          accessibilityRole="button"
        >
          {buttonContent}
        </TouchableOpacity>
      ) : (
        <Animated.View style={btnStyle} pointerEvents="box-none">
          <TouchableOpacity
            onPress={handlePress}
            activeOpacity={1}
            style={buttonStyles}
          >
            {buttonContent}
          </TouchableOpacity>
        </Animated.View>
      )}

      <WalletModal visible={modalVisible} onClose={() => setModalVisible(false)} />
    </>
  );
}
