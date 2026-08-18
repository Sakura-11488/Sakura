import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, TouchableOpacity, Platform } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const ACCENT = '#E84545';
const VERSION_URL = '/app/version.json';
const POLL_MS = 5 * 60 * 1000;

/**
 * Web-only "a new version is available" prompt.
 *
 * A single-page app keeps running whatever bundle it loaded, so a user who
 * leaves the tab open never sees a deploy — they sit on stale code until they
 * happen to hard-refresh. The build step stamps the bundle hash into the page
 * (window.__SAKURA_BUILD__) and publishes the same hash at /app/version.json;
 * this polls that file and offers a genuine hard refresh when they diverge.
 *
 * Native renders the no-op variant (.native.tsx) — it has its own APK/OTA flow.
 */
export default function WebUpdateBanner() {
  const { colors } = useTheme();
  const [outdated, setOutdated] = useState(false);
  const [busy, setBusy] = useState(false);

  const currentBuild = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return (window as unknown as { __SAKURA_BUILD__?: string }).__SAKURA_BUILD__ || '';
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (!currentBuild) return; // pre-stamp build: nothing reliable to compare
    let cancelled = false;

    const check = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        // Cache-bust so we read the deployed file, not the one in the SW/HTTP cache.
        const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { build?: string };
        if (!cancelled && data?.build && data.build !== currentBuild) setOutdated(true);
      } catch {
        // offline or a blip — try again on the next tick
      }
    };

    check();
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [currentBuild]);

  /** Genuine hard refresh: drop caches + the old service worker, then reload. */
  const hardRefresh = useCallback(async () => {
    setBusy(true);
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        // Build caches only. This used to delete every key, which would wipe a
        // user's downloaded chapters behind a button labelled "Update" — the
        // library lives in `sakura-offline-*` and is user data, not build
        // output. Getting a fresh build never requires destroying it.
        await Promise.all(
          keys.filter((k) => k.startsWith('sakura-shell-')).map((k) => caches.delete(k)),
        );
      }
      if (navigator.serviceWorker?.getRegistrations) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
      }
    } catch {
      // never block the reload on cleanup
    }
    // Cache-busted URL so even a stubborn intermediary serves the new document.
    const url = new URL(window.location.href);
    url.searchParams.set('v', Date.now().toString(36));
    window.location.replace(url.toString());
  }, []);

  const s = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        card: {
          width: '100%',
          maxWidth: 400,
          backgroundColor: colors.surface,
          borderRadius: 28,
          borderWidth: 1,
          borderColor: colors.borderLight,
          padding: 22,
        },
        badge: {
          alignSelf: 'center',
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: `${ACCENT}18`,
          borderWidth: 1,
          borderColor: `${ACCENT}40`,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
        },
        badgeText: { fontSize: 26 },
        title: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 20,
          color: colors.text,
          textAlign: 'center',
        },
        sub: {
          color: colors.textSecondary,
          fontSize: FontSize.sm,
          textAlign: 'center',
          marginTop: 6,
          lineHeight: 20,
        },
        btn: {
          backgroundColor: ACCENT,
          borderRadius: Radius.full,
          paddingVertical: 14,
          alignItems: 'center',
          marginTop: 20,
        },
        btnText: {
          color: '#fff',
          fontSize: FontSize.md,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
        },
        later: { paddingVertical: 12, alignItems: 'center', marginTop: 2 },
        laterText: { color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
      }),
    [colors],
  );

  if (Platform.OS !== 'web' || !outdated) return null;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={() => setOutdated(false)}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setOutdated(false)} />
        <Animated.View entering={FadeInDown.duration(240)} style={s.card}>
          <View style={s.badge}>
            <Text style={s.badgeText}>🌸</Text>
          </View>
          <Text style={s.title}>New version available</Text>
          <Text style={s.sub}>
            Sakura has been updated. Refresh to get the latest version — it only takes a second.
          </Text>
          <TouchableOpacity style={s.btn} activeOpacity={0.85} onPress={hardRefresh} disabled={busy}>
            <Text style={s.btnText}>{busy ? 'Refreshing…' : 'Refresh now'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.later} activeOpacity={0.7} onPress={() => setOutdated(false)}>
            <Text style={s.laterText}>Not now</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}
