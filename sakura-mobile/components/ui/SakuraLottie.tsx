import React from 'react';
import LottieView, { type LottieViewProps } from 'lottie-react-native';

/**
 * Lottie wrapper that avoids stale composition caches and wildcard colorFilters
 * painting solid red blocks on iOS when props/state change.
 */
const SakuraLottie = React.forwardRef<LottieView, LottieViewProps>((props, ref) => {
  const { cacheComposition, renderMode, ...rest } = props;
  return (
    <LottieView
      ref={ref}
      {...rest}
      cacheComposition={cacheComposition ?? false}
      renderMode={renderMode ?? 'AUTOMATIC'}
    />
  );
});

SakuraLottie.displayName = 'SakuraLottie';

export default SakuraLottie;
