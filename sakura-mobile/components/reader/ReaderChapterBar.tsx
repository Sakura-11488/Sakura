import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { onTap } from '@/lib/sound';
import { Colors, Radius, FontSize, FontWeight } from '@/constants/theme';

/**
 * The reader's seek bar: page slider plus previous/next chapter jumps.
 *
 * Replaces a horizontal strip of per-page thumbnails. That strip mounted one
 * **full-resolution** page image per page of the chapter — the thumbnail and the
 * full-screen page used the identical URL and `loadChapterPages` never rewrote
 * it — and did so on chapter entry whether or not the overlay was ever shown.
 * A slider costs four Views and reaches page 300 in one drag.
 *
 * # The two things that make it feel right
 *
 * The knob is driven entirely on the UI thread by a shared value. The list's
 * scroll position writes `pageIndex` back down as a prop, so if the knob were
 * driven from that prop it would fight the finger — the classic seek-bar
 * stutter. Instead the resync effect stands down whenever a finger owns the knob
 * or a committed seek has not landed yet (`dragPage !== null`).
 *
 * The seek commits on **release**, not per frame. Only page-crossings cross the
 * bridge during a drag, throttled to one per `DETENT_MIN_MS`, because the
 * reading-activity effect in the parent has no debounce and would otherwise post
 * a lock-screen notification per frame.
 */

const KNOB = 16;
const TRACK_H = 36;
const RAIL_H = 4;
/** Hard cap on mounted tick Views. Spacing (below) is what normally decides. */
const MAX_TICKS = 100;
/** Below this the ticks stop being readable and start being a smear. A 45-page
 *  chapter on a ~250px track is 5.6px apart and keeps its ticks; a 120-page
 *  webtoon chapter is 2px apart and gets a plain rail. Self-tuning, so ordinary
 *  manga never silently loses the tick marks. */
const MIN_TICK_GAP = 5;
/** Floor on label+haptic updates during a scrub. The knob is unaffected — it
 *  lives on the UI thread. This only bounds the bridge hops: without it a
 *  200-page chapter dragged in 500ms fires hundreds of setStates and haptics. */
const DETENT_MIN_MS = 50;
const KNOB_SETTLE_MS = 160;
const SNAP_MS = 120;
/** Ceiling on how long the knob stays pinned to a seek target the list never
 *  reports arriving at. Normally the value-based latch clears first. */
const SEEK_SETTLE_MAX_MS = 2500;

/* ── Pure geometry ──────────────────────────────────────────────────────────
   Module-level and 'worklet'-marked so ONE implementation serves both the
   UI-thread gesture and the JS-thread resync. Taking geometry as arguments
   rather than closing over props is what lets the gesture object be built once
   and never rebuilt — a gesture that churns makes RNGH re-configure the native
   handler mid-drag. */

function pageForX(x: number, travel: number, n: number, rtl: boolean): number {
  'worklet';
  if (n <= 1 || travel <= 0) return 0;
  const raw = Math.min(Math.max(x / travel, 0), 1);
  const f = rtl ? 1 - raw : raw;
  return Math.min(Math.max(Math.round(f * (n - 1)), 0), n - 1);
}

function xForPage(i: number, travel: number, n: number, rtl: boolean): number {
  'worklet';
  if (n <= 1 || travel <= 0) return rtl ? travel : 0;
  // Clamped, and load-bearing: onViewableItemsChanged advances activeChapterId
  // on a divider row WITHOUT advancing activePageIndex, so for a frame or two
  // `i` still belongs to the previous chapter and can exceed n - 1. Leaving a
  // 60-page chapter for a 20-page one would otherwise translate the knob two
  // track-widths off screen (Views don't clip) and mirror-flip the fill.
  const c = Math.min(Math.max(i, 0), n - 1);
  const f = c / (n - 1);
  return (rtl ? 1 - f : f) * travel;
}

const SkipIcon = React.memo(({ pointing, dim }: { pointing: 'left' | 'right'; dim?: boolean }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
    <Path
      d={pointing === 'left' ? 'M17 6l-7 6 7 6M7 5v14' : 'M7 6l7 6-7 6M17 5v14'}
      stroke={Colors.white}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={dim ? 0.32 : 1}
    />
  </Svg>
));
SkipIcon.displayName = 'SkipIcon';

export interface ReaderChapterBarProps {
  /** 0-based page within the chapter on screen, in reading order. */
  pageIndex: number;
  totalPages: number;
  /** Pass `isRtlPageMode`, NOT `readDirection` — direction is inert in webtoon
   *  mode and the list is not mirrored there. */
  rtl: boolean;
  modeLabel: string;
  onSeek: (pageIndex: number) => void;
  /** Fired as the finger settles on a page, throttled. Lets the parent warm the
   *  destination image before its cell mounts. */
  onSeekPreview: (pageIndex: number) => void;
  onSeekStart: () => void;
  onSeekEnd: () => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  /** Named canGoPrev/canGoNext rather than hasPrevChapter: the reader already
   *  has a local `hasPrevChapter` meaning "backward continuous flow could pull
   *  one in", which is also a boolean and means something else entirely. */
  canGoPrev: boolean;
  canGoNext: boolean;
  onOpenSettings: () => void;
}

function ReaderChapterBar({
  pageIndex,
  totalPages,
  rtl,
  modeLabel,
  onSeek,
  onSeekPreview,
  onSeekStart,
  onSeekEnd,
  onPrevChapter,
  onNextChapter,
  canGoPrev,
  canGoNext,
  onOpenSettings,
}: ReaderChapterBarProps) {
  const [trackW, setTrackW] = useState(0);
  /** Page under the finger, or a committed seek target the list hasn't reached
   *  yet. `null` at rest — which is also the signal the resync effect uses to
   *  decide whether it is allowed to move the knob. */
  const [dragPage, setDragPage] = useState<number | null>(null);

  const travel = Math.max(trackW - KNOB, 0);

  /* Props behind refs so every runOnJS target and the gesture itself have []
     deps. onSeek depends on activeSegment in the parent, which changes at every
     chapter boundary. */
  const cbs = useRef({ onSeek, onSeekPreview, onSeekStart, onSeekEnd });
  cbs.current = { onSeek, onSeekPreview, onSeekStart, onSeekEnd };
  const geo = useRef({ travel, totalPages, rtl });
  geo.current = { travel, totalPages, rtl };

  /* Geometry mirrored into shared values so the worklets read live numbers
     without the gesture closure having to be rebuilt. */
  const travelSV = useSharedValue(0);
  const nSV = useSharedValue(1);
  const rtlSV = useSharedValue(0);
  useEffect(() => {
    travelSV.value = travel;
    nSV.value = totalPages;
    rtlSV.value = rtl ? 1 : 0;
  }, [travel, totalPages, rtl, travelSV, nSV, rtlSV]);

  const dragX = useSharedValue(0);
  const panActive = useSharedValue(0);
  const lastDetent = useSharedValue(-1);

  /** JS-thread mirror of dragX. Reading `.value` from the JS thread in
   *  Reanimated 4 either returns a stale cache or performs a blocking hop, so we
   *  never read it — we track what we last wrote. */
  const lastXRef = useRef(0);
  const holdRef = useRef(false);
  const seekTargetRef = useRef<number | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detentRef = useRef<{ at: number; pending: number; timer: ReturnType<typeof setTimeout> | null }>({
    at: 0,
    pending: -1,
    timer: null,
  });

  /* ── JS-thread side of the drag ─────────────────────────────────────────── */

  const applyDetent = useCallback((i: number) => {
    setDragPage(i);
    // The tactile equivalent of the tick marks, at zero render cost.
    void Haptics.selectionAsync().catch(() => undefined);
    cbs.current.onSeekPreview(i);
  }, []);

  /** Leading-edge throttle with a trailing flush, so the last page crossed is
   *  never dropped. */
  const reportDetent = useCallback(
    (i: number) => {
      const d = detentRef.current;
      d.pending = i;
      const now = Date.now();
      if (now - d.at >= DETENT_MIN_MS) {
        d.at = now;
        if (d.timer) {
          clearTimeout(d.timer);
          d.timer = null;
        }
        applyDetent(i);
        return;
      }
      if (d.timer) return;
      d.timer = setTimeout(() => {
        d.timer = null;
        d.at = Date.now();
        applyDetent(d.pending);
      }, DETENT_MIN_MS - (now - d.at));
    },
    [applyDetent],
  );

  const holdStart = useCallback(() => {
    if (holdRef.current) return;
    holdRef.current = true;
    cbs.current.onSeekStart();
  }, []);

  const holdEnd = useCallback(() => {
    if (!holdRef.current) return;
    holdRef.current = false;
    cbs.current.onSeekEnd();
  }, []);

  const commitSeek = useCallback(
    (i: number) => {
      const d = detentRef.current;
      if (d.timer) {
        clearTimeout(d.timer);
        d.timer = null;
      }
      const g = geo.current;
      lastXRef.current = xForPage(i, g.travel, g.totalPages, g.rtl);
      // Pin the label and knob to the target until the list actually arrives —
      // deliberately NOT a fixed timer. A webtoon seek goes through
      // onScrollToIndexFailed, whose retry alone is 350ms and whose viewability
      // then needs another minimumViewTime, so any short window expires onto an
      // intermediate page and the knob visibly rubber-bands.
      seekTargetRef.current = i;
      setDragPage(i);
      cbs.current.onSeek(i);
      holdEnd();
      if (settleRef.current) clearTimeout(settleRef.current);
      settleRef.current = setTimeout(() => {
        settleRef.current = null;
        seekTargetRef.current = null;
        setDragPage(null);
      }, SEEK_SETTLE_MAX_MS);
    },
    [holdEnd],
  );

  /* ── Gesture. Built once: every dep below is stable. ─────────────────────── */

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      // Directionally gated rather than activating on touch-down. This screen is
      // registered with a vertical full-screen dismiss gesture, so a downward
      // drag anywhere closes the reader — and the bar sits at the bottom edge,
      // exactly where a thumb arc curves downward. failOffsetY hands a vertical
      // drift back to the navigator; the Tap below is what preserves
      // tap-to-seek, which an always-active pan used to carry.
      .activeOffsetX([-6, 6])
      .failOffsetY([-14, 14])
      .onBegin(() => {
        // Fires on touch-down, before activation, and is paired with onFinalize
        // even when the pan never activates.
        runOnJS(holdStart)();
      })
      .onStart((e) => {
        panActive.value = 1;
        const x = Math.min(Math.max(e.x - KNOB / 2, 0), travelSV.value);
        dragX.value = x;
        const i = pageForX(x, travelSV.value, nSV.value, rtlSV.value === 1);
        lastDetent.value = i;
        runOnJS(reportDetent)(i);
      })
      .onUpdate((e) => {
        if (panActive.value !== 1) return;
        // The knob updates every frame here on the UI thread; only a page
        // CROSSING goes over the bridge.
        dragX.value = Math.min(Math.max(e.x - KNOB / 2, 0), travelSV.value);
        const i = pageForX(dragX.value, travelSV.value, nSV.value, rtlSV.value === 1);
        if (i === lastDetent.value) return;
        lastDetent.value = i;
        runOnJS(reportDetent)(i);
      })
      // onFinalize, never onEnd: a gesture the system cancels never reaches
      // onEnd, and the auto-hide hold would then stay open for the rest of the
      // session with the knob stuck where the finger left it.
      .onFinalize(() => {
        lastDetent.value = -1;
        if (panActive.value !== 1) {
          runOnJS(holdEnd)();
          return;
        }
        panActive.value = 0;
        const i = pageForX(dragX.value, travelSV.value, nSV.value, rtlSV.value === 1);
        dragX.value = withTiming(xForPage(i, travelSV.value, nSV.value, rtlSV.value === 1), {
          duration: SNAP_MS,
        });
        runOnJS(commitSeek)(i);
      });

    const tap = Gesture.Tap()
      .maxDuration(300)
      .maxDistance(12)
      .onEnd((e, success) => {
        if (!success) return;
        const x = Math.min(Math.max(e.x - KNOB / 2, 0), travelSV.value);
        const i = pageForX(x, travelSV.value, nSV.value, rtlSV.value === 1);
        dragX.value = withTiming(xForPage(i, travelSV.value, nSV.value, rtlSV.value === 1), {
          duration: SNAP_MS,
        });
        runOnJS(commitSeek)(i);
      });

    // Pan takes priority; the tap only resolves once the pan has failed, which
    // for a stationary touch happens on release — no perceptible delay.
    return Gesture.Exclusive(pan, tap);
  }, [holdStart, holdEnd, reportDetent, commitSeek, dragX, panActive, lastDetent, travelSV, nSV, rtlSV]);

  /* ── Resync from state, only at rest ─────────────────────────────────────── */

  const prevGeom = useRef({ rtl, totalPages, travel });
  useEffect(() => {
    // dragPage covers both "a finger owns the knob" and "a committed seek has
    // not landed", so no shared value ever has to be read from this thread.
    if (dragPage !== null) return;
    const g = prevGeom.current;
    const geometryChanged = g.rtl !== rtl || g.totalPages !== totalPages || g.travel !== travel;
    prevGeom.current = { rtl, totalPages, travel };

    const x = xForPage(pageIndex, travel, totalPages, rtl);
    const step = totalPages > 1 ? travel / (totalPages - 1) : travel;
    // Animate only for a real jump. Viewability fires roughly every 80ms during
    // a fling, so a 160ms timing would be restarted before it could complete and
    // the knob would permanently trail the content, catching up in a lurch.
    // A direction flip is also assigned instantly: the mapping has just
    // inverted, and sliding across a track that now means the opposite thing
    // reads as a glitch.
    const animate = !geometryChanged && Math.abs(x - lastXRef.current) > step * 1.5;
    lastXRef.current = x;
    dragX.value = animate ? withTiming(x, { duration: KNOB_SETTLE_MS }) : x;
  }, [pageIndex, totalPages, rtl, travel, dragPage, dragX]);

  /** Value-based settle: release the pin the moment the list reports arriving. */
  useEffect(() => {
    if (seekTargetRef.current === null || pageIndex !== seekTargetRef.current) return;
    seekTargetRef.current = null;
    if (settleRef.current) {
      clearTimeout(settleRef.current);
      settleRef.current = null;
    }
    setDragPage(null);
  }, [pageIndex]);

  useEffect(
    () => () => {
      if (settleRef.current) clearTimeout(settleRef.current);
      if (detentRef.current.timer) clearTimeout(detentRef.current.timer);
      // RNGH does not deliver onFinalize when the detector unmounts mid-gesture,
      // and this component is conditionally rendered. A hold that is never
      // released would disable auto-hide for the rest of the session.
      if (holdRef.current) {
        holdRef.current = false;
        cbs.current.onSeekEnd();
      }
    },
    [],
  );

  /* ── Derived render values ──────────────────────────────────────────────── */

  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dragX.value }] }));
  // A transform, not a width: width animates through layout, scaleX doesn't.
  const fillStyle = useAnimatedStyle(() => {
    const t = travelSV.value;
    const f = t > 0 ? Math.min(Math.max(dragX.value / t, 0), 1) : 0;
    return { transform: [{ scaleX: rtlSV.value === 1 ? 1 - f : f }] };
  });

  const ticks = useMemo(() => {
    if (totalPages < 2 || totalPages > MAX_TICKS || travel <= 0) return [];
    const gap = travel / (totalPages - 1);
    if (gap < MIN_TICK_GAP) return [];
    // Evenly spaced ticks map onto themselves under the RTL `1 - f` flip, so
    // they need no direction branch — only the knob, fill and label order flip.
    return Array.from({ length: totalPages }, (_, k) => k * gap + KNOB / 2 - 0.5);
  }, [totalPages, travel]);

  const onTrackLayout = useCallback((e: LayoutChangeEvent) => setTrackW(e.nativeEvent.layout.width), []);

  // Leading label is the live page; during a scrub it reads the page under the
  // finger. Clamped for the same stale-index reason as xForPage.
  const shownPage = Math.min((dragPage ?? pageIndex) + 1, Math.max(totalPages, 1));

  return (
    // box-none the whole way down. This bar sits in a full-width band at the
    // bottom of a list that, in webtoon mode, scrolls vertically — flicks
    // routinely start here. Only the buttons, the track and the caption may
    // claim a touch; everything else must fall through to the list.
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={[styles.row, rtl && styles.rowRtl]} pointerEvents="box-none">
        <TouchableOpacity
          style={[styles.chapterBtn, !canGoPrev && styles.chapterBtnOff]}
          disabled={!canGoPrev}
          activeOpacity={0.75}
          hitSlop={6}
          onPress={onTap(onPrevChapter)}
        >
          {/* Glyph by SCREEN direction: row-reverse moves the button in RTL but
              cannot turn the arrow round. */}
          <SkipIcon pointing={rtl ? 'right' : 'left'} dim={!canGoPrev} />
        </TouchableOpacity>

        <Text style={styles.endLabel}>{shownPage}</Text>

        <GestureDetector gesture={gesture}>
          <View style={styles.trackHit} onLayout={onTrackLayout}>
            <View style={styles.rail} pointerEvents="none" />
            <Animated.View
              pointerEvents="none"
              style={[styles.railFill, rtl && styles.railFillRtl, fillStyle]}
            />
            {ticks.map((left, k) => (
              <View key={k} pointerEvents="none" style={[styles.tick, { left }]} />
            ))}
            <Animated.View pointerEvents="none" style={[styles.knob, knobStyle]} />
          </View>
        </GestureDetector>

        <Text style={styles.endLabel}>{totalPages}</Text>

        <TouchableOpacity
          style={[styles.chapterBtn, !canGoNext && styles.chapterBtnOff]}
          disabled={!canGoNext}
          activeOpacity={0.75}
          hitSlop={6}
          onPress={onTap(onNextChapter)}
        >
          <SkipIcon pointing={rtl ? 'left' : 'right'} dim={!canGoNext} />
        </TouchableOpacity>
      </View>

      {/* Names the settings that decide how this bar behaves and opens the sheet
          that owns them, so it is a control rather than decoration. */}
      <TouchableOpacity
        style={styles.captionBtn}
        onPress={onTap(onOpenSettings)}
        hitSlop={8}
        activeOpacity={0.7}
      >
        <Text style={styles.caption}>{modeLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default React.memo(ReaderChapterBar);

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 44 },
  /** Reverses buttons, labels and track from one property. Deliberately not a
   *  scaleX mirror like the page list uses: a mirrored bar renders the digits
   *  backwards and would need counter-transforms on the knob and every tick. */
  rowRtl: { flexDirection: 'row-reverse' },
  chapterBtn: {
    width: 34,
    height: 34,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  chapterBtnOff: { backgroundColor: 'rgba(255,255,255,0.05)' },
  endLabel: {
    minWidth: 28,
    textAlign: 'center',
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    // minWidth is what stops the row re-measuring as the digit count changes;
    // fontVariant only takes effect on iOS.
    fontVariant: ['tabular-nums'],
    // A label is not a control — let scrolls started on it reach the list.
    pointerEvents: 'none',
  },
  trackHit: {
    flex: 1,
    height: TRACK_H,
    justifyContent: 'center',
    // A 4px rail is only a thumb-sized target because the hit area is 36px.
    ...(Platform.OS === 'web' ? { cursor: 'pointer' as const } : null),
  },
  rail: {
    height: RAIL_H,
    borderRadius: RAIL_H / 2,
    marginHorizontal: KNOB / 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  railFill: {
    position: 'absolute',
    left: KNOB / 2,
    right: KNOB / 2,
    top: (TRACK_H - RAIL_H) / 2,
    height: RAIL_H,
    borderRadius: RAIL_H / 2,
    backgroundColor: Colors.primary,
    transformOrigin: 'left',
  },
  railFillRtl: { transformOrigin: 'right' },
  tick: {
    position: 'absolute',
    top: (TRACK_H - 8) / 2,
    width: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.34)',
  },
  knob: {
    position: 'absolute',
    left: 0,
    top: (TRACK_H - KNOB) / 2,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    backgroundColor: Colors.white,
  },
  captionBtn: { alignSelf: 'center', paddingBottom: 2 },
  caption: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
    textAlign: 'center',
  },
});
