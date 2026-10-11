import React, { type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

export default function WatchViewport({ children }: PropsWithChildren) {
  return <View style={styles.fill}>{children}</View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
