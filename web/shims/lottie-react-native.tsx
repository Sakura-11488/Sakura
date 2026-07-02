import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Lottie from 'lottie-react';

type LottieSource = number | { uri?: string } | object;

type Props = {
  source: LottieSource;
  style?: StyleProp<ViewStyle>;
  autoPlay?: boolean;
  loop?: boolean;
  speed?: number;
  cacheComposition?: boolean;
  renderMode?: string;
};

function resolveAnimationData(source: LottieSource): object | null {
  if (typeof source === 'object' && source !== null) {
    if ('uri' in source && typeof source.uri === 'string') return null;
    return source as object;
  }
  return null;
}

const LottieView = React.forwardRef<View, Props>(function LottieView(
  { source, style, autoPlay = true, loop = true, speed = 1 },
  ref,
) {
  const animationData = resolveAnimationData(source);
  if (!animationData) {
    return <View ref={ref} style={style} />;
  }

  return (
    <View ref={ref} style={style}>
      <Lottie animationData={animationData} loop={loop} autoplay={autoPlay} style={{ width: '100%', height: '100%' }} />
    </View>
  );
});

export default LottieView;
