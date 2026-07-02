/** Type stubs for native modules replaced by web/shims in metro.config.js */
declare module 'lottie-react-native' {
  import type { ComponentType } from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';

  type LottieProps = {
    source: number | { uri?: string } | object;
    style?: StyleProp<ViewStyle>;
    autoPlay?: boolean;
    loop?: boolean;
    speed?: number;
    colorFilters?: Array<{ keypath: string; color: string }>;
  };

  const LottieView: ComponentType<LottieProps>;
  export default LottieView;
}

declare module 'react-native-webview' {
  import type { ComponentType } from 'react';
  import type { ViewProps } from 'react-native';

  export type WebViewProps = ViewProps & {
    source?: { uri?: string; html?: string };
    onMessage?: (event: { nativeEvent: { data: string } }) => void;
    onError?: (event: unknown) => void;
    injectedJavaScript?: string;
    javaScriptEnabled?: boolean;
    domStorageEnabled?: boolean;
    allowsFullscreenVideo?: boolean;
    mediaPlaybackRequiresUserAction?: boolean;
  };

  const WebView: ComponentType<WebViewProps>;
  export default WebView;
}

declare module 'expo-updates' {
  export function checkForUpdateAsync(): Promise<{ isAvailable: boolean }>;
  export function fetchUpdateAsync(): Promise<void>;
  export function reloadAsync(): Promise<void>;
}

declare module 'expo-widgets' {
  const Widgets: unknown;
  export default Widgets;
}
