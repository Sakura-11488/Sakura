import React from 'react';
import { View, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { MAX_CONTENT_WIDTH, MAX_CONTENT_WIDTH_DESKTOP, isWideWeb } from '@/constants/layout';
import WebTopNav from './WebTopNav';

export default function WebAppShell({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();

  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  // Desktop: top navigation bar over a centered wide content column.
  //
  // Was a left rail. The bar is the shape every streaming site uses and it
  // returns 232px of horizontal space to content on every screen.
  if (isWideWeb(width)) {
    return (
      <View style={styles.desktopCol}>
        <WebTopNav />
        <View style={styles.desktopContentOuter}>
          <View style={styles.desktopContentCol}>{children}</View>
        </View>
      </View>
    );
  }

  // Mobile web: original phone-style centered column (floating bottom bar).
  return (
    <View style={styles.outer}>
      <View style={styles.column}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    alignItems: 'center',
  },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
  },
  desktopCol: {
    flex: 1,
    flexDirection: 'column',
  },
  desktopContentOuter: {
    flex: 1,
    alignItems: 'center',
  },
  desktopContentCol: {
    flex: 1,
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH_DESKTOP,
  },
});
