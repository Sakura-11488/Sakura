import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, TouchableOpacity, Platform } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const ACCENT = '#E84545';
const VERSION_URL = '/app/version.json';
const POLL_MS = 5 * 60 * 1000;

/** How long "Refresh now" waits for the new worker before reloading anyway. */
const WORKER_WAIT_MS = 20_000;

/**
 * Fetch the deployed service worker and wait, bounded, until it has activated.
 *
 * Every deploy ships a byte-different sw.js (the build's precache list is
 * stamped into it), so update() finds a new worker. Its install caches the new
 * build's document and bundle, replacing the offline shell only as a complete
 * pair, so once it is active the shell it falls back to is the new build — the
 * reload lands on it even when the network is too slow and the worker answers
 * from cache. If the bundle could not be fetched, the previous complete shell
 * stays. On timeout the reload goes ahead regardless; navigations are
 * network-first, so the user still gets the new build online.
 */
export async function activateLatestWorker(timeoutMs: number): Promise<void> {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!container?.getRegistration) return;
  // The deadline covers registration lookup and update() too. A captive portal
  // can leave update() pending forever, before there even is a worker to watch.
  await new Promise<void>((resolve) => {
    let pending: ServiceWorker | undefined;
    let finished = false;
    const onChange = () => {
      if (pending?.state !== 'activated' && pending?.state !== 'redundant') return;
      finish();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending?.removeEventListener('statechange', onChange);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void (async () => {
      const reg = await container.getRegistration('/app/');
      if (finished) return;
      if (!reg) return finish();
      await reg.update();
      if (finished) return;
      pending = reg.installing || reg.waiting || undefined;
      if (!pending) return finish();
      pending.addEventListener('statechange', onChange);
      onChange();
    })().catch(finish);
  });
}

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

  /**
   * Genuine hard refresh: install the new deploy's service worker, then reload.
   *
   * This deliberately deletes no caches. It used to delete every
   * `sakura-shell-*` cache before reloading (and before that, every cache —
   * including the user's downloads). Dropping the shell was never needed to get
   * a new build, since navigations are network-first and bundles are
   * content-hashed, but it was dangerous: if the reload then failed — a train
   * tunnel, a captive portal — the installed app had no shell left and could
   * not open offline, downloads and all. Instead this waits for the new
   * worker, which caches the new build's shell before it takes over and prunes
   * the old bundle itself.
   */
  const hardRefresh = useCallback(async () => {
    setBusy(true);
    try {
      await activateLatestWorker(WORKER_WAIT_MS);
    } catch {
      // never block the reload on the worker
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
