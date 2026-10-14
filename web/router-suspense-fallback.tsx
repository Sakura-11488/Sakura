/**
 * What a lazily loaded screen shows while its chunk downloads (web only).
 *
 * The web build loads most screens on first visit (router-context.js), and
 * expo-router renders its SuspenseFallback until the chunk arrives. Its own
 * production fallback renders nothing, and in lazy mode it ignores any
 * fallback a layout provides, so a first tap on a tab painted an empty frame
 * for a round trip. metro.config.js resolves expo-router's SuspenseFallback
 * module to this file instead.
 *
 * Same look as app/index.web.tsx's launch state: the theme's background, then
 * a spinner. The spinner waits a beat, because most chunks arrive from the
 * service worker's cache or an idle-time prefetch well within it, and a
 * spinner that flashes for one frame reads as a glitch.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTheme } from '@/lib/theme';

const SPINNER_DELAY_MS = 300;

export function SuspenseFallback(_props: { route: string; params?: object }) {
  const { colors } = useTheme();
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      {showSpinner ? <ActivityIndicator color={colors.primary} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
