import React, { forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, View, type ViewStyle, type StyleProp } from 'react-native';
import type { SubtitleMode } from '@/lib/anime-playback-overrides';

export type WebVideoPlayerHandle = {
  seekTo: (seconds: number) => void;
};

type Props = {
  uri: string;
  headers?: Record<string, string>;
  isM3U8?: boolean;
  subtitleMode?: SubtitleMode;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onError?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  startAt?: number;
};

const WebVideoPlayer = forwardRef<WebVideoPlayerHandle, Props>(function WebVideoPlayer(
  _props,
  ref,
) {
  useImperativeHandle(ref, () => ({
    seekTo: () => {},
  }));
  return <View style={styles.fill} />;
});

export default WebVideoPlayer;

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
