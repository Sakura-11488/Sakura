import React, { forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, View } from 'react-native';
import type { WebVideoPlayerHandle, WebVideoPlayerProps } from './player-types';
export type { WebVideoPlayerHandle } from './player-types';

const WebVideoPlayer = forwardRef<WebVideoPlayerHandle, WebVideoPlayerProps>(function WebVideoPlayer(
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
