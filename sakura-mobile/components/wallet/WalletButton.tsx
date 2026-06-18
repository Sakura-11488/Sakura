import React, { useMemo, useRef, useState } from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
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
  }), [colors]);

  const btnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = async () => {
    scale.value = withSequence(
      withSpring(0.92, { damping: 12 }),
      withSpring(1, { damping: 10 })
    );
    lottieRef.current?.play();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    setModalVisible(true);
  };

  return (
    <>
      <Animated.View style={btnStyle}>
        <TouchableOpacity
          onPress={handlePress}
          activeOpacity={1}
          style={[s.btn, connected && s.btnConnected]}
        >
          <SakuraLottie
            ref={lottieRef}
            key={connected ? 'wallet-connected' : 'wallet-disconnected'}
            source={require('@/assets/lottie/wallet.json')}
            style={s.lottie}
            autoPlay
            loop
            speed={0.55}
          />
          <Text style={[s.label, connected && s.labelConnected]}>
            {connected
              ? sakuraBalance !== null
                ? `${sakuraBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} SKR`
                : shortAddress ?? 'Account'
              : 'Connect'}
          </Text>
        </TouchableOpacity>
      </Animated.View>

      <WalletModal visible={modalVisible} onClose={() => setModalVisible(false)} />
    </>
  );
}
