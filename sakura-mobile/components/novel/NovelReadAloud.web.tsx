import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { chunkForSpeech } from '@/lib/novel-text';
import type { NovelReadAloudProps, ReadAloudHandle } from './NovelReadAloud';

export type { ReadAloudHandle } from './NovelReadAloud';

/**
 * Read aloud with the browser's own voices (Web Speech API).
 *
 * One paragraph at a time, each split into utterances short enough that
 * Chrome does not cut them off (lib/novel-text.ts chunkForSpeech). The reader
 * highlights and follows the paragraph being spoken; at the end of a chapter
 * it moves to the next one and carries on.
 *
 * Pause is implemented as cancel-and-remember rather than speechSynthesis
 * .pause(): on Android Chrome pause() ends the utterance, and resuming then
 * never fires `end`, which used to leave players stuck. Resuming restarts the
 * current paragraph, which is what listeners expect after a pause anyway.
 */
export function readAloudSupported(): boolean {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  } catch {
    return false;
  }
}

/**
 * When a chapter finished while reading aloud, so the NEXT chapter's reader (a
 * fresh mount) starts speaking as soon as its text is ready.
 *
 * A timestamp with a short window rather than a flag: if the next chapter
 * never becomes readable (it fails to load, or the reader leaves while it
 * loads), a plain flag stayed set and the next chapter opened at any later
 * time — another book, an hour later — started talking on its own.
 */
let continueRequestedAt = 0;
const CONTINUE_WINDOW_MS = 20_000;
const continuing = () => continueRequestedAt > 0 && Date.now() - continueRequestedAt < CONTINUE_WINDOW_MS;

/** The reader calls this when it closes or its chapter cannot be shown. */
export function cancelReadAloudContinuation(): void {
  continueRequestedAt = 0;
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

function pickVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
    const base = lang.split('-')[0];
    return (
      voices.find((v) => v.default && v.lang.toLowerCase().startsWith(base)) ||
      voices.find((v) => v.lang.toLowerCase() === lang) ||
      voices.find((v) => v.lang.toLowerCase().startsWith(base)) ||
      voices.find((v) => v.default) ||
      null
    );
  } catch {
    return null;
  }
}

const NovelReadAloud = forwardRef<ReadAloudHandle, NovelReadAloudProps>(function NovelReadAloud(
  { paragraphs, palette, rate, onRateChange, startIndex, onParagraph, onChapterEnd, hasNextChapter, title, bottomOffset },
  ref,
) {
  const [state, setState] = useState<'idle' | 'playing' | 'paused'>('idle');
  const [index, setIndex] = useState(0);
  const session = useRef(0);
  const indexRef = useRef(0);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const props = useRef({ paragraphs, onParagraph, onChapterEnd, hasNextChapter });
  props.current = { paragraphs, onParagraph, onChapterEnd, hasNextChapter };

  const cancelSpeech = useCallback(() => {
    session.current++;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Nothing is speaking.
    }
  }, []);

  const speakFrom = useCallback(
    (start: number) => {
      cancelSpeech();
      const id = session.current;
      const list = props.current.paragraphs;
      if (start >= list.length) {
        setState('idle');
        props.current.onParagraph(null);
        if (props.current.hasNextChapter) {
          continueRequestedAt = Date.now();
          props.current.onChapterEnd();
        }
        return;
      }
      indexRef.current = start;
      setIndex(start);
      setState('playing');
      props.current.onParagraph(start);
      const chunks = chunkForSpeech(list[start]);
      if (!chunks.length) {
        speakFrom(start + 1);
        return;
      }
      const voice = pickVoice();
      chunks.forEach((chunk, i) => {
        const u = new SpeechSynthesisUtterance(chunk);
        u.rate = rateRef.current;
        if (voice) {
          // Some engines reject a voice that went away (voiceschanged); the
          // default voice is a fine fallback.
          try {
            u.voice = voice;
            u.lang = voice.lang;
          } catch {
            // keep the default voice
          }
        }
        if (i === chunks.length - 1) {
          u.onend = () => {
            if (session.current === id) speakFrom(start + 1);
          };
        }
        u.onerror = (e) => {
          // 'interrupted' / 'canceled' are our own cancel(); anything else stops cleanly.
          const err = (e as SpeechSynthesisErrorEvent).error;
          if (session.current !== id || err === 'interrupted' || err === 'canceled') return;
          session.current++;
          setState('idle');
          props.current.onParagraph(null);
        };
        try {
          window.speechSynthesis.speak(u);
        } catch {
          session.current++;
          setState('idle');
          props.current.onParagraph(null);
        }
      });
    },
    [cancelSpeech],
  );

  const pause = useCallback(() => {
    cancelSpeech();
    setState('paused');
  }, [cancelSpeech]);

  const stop = useCallback(() => {
    cancelSpeech();
    continueRequestedAt = 0;
    setState('idle');
    props.current.onParagraph(null);
  }, [cancelSpeech]);

  const play = useCallback(() => {
    speakFrom(state === 'paused' ? indexRef.current : Math.max(0, Math.min(props.current.paragraphs.length - 1, startIndex())));
  }, [speakFrom, startIndex, state]);

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => (state === 'playing' ? pause() : play()),
      stop: () => {
        // Called on chapter change: keep going only when the chapter ended by itself.
        cancelSpeech();
        if (!continuing()) props.current.onParagraph(null);
      },
    }),
    [state, pause, play, cancelSpeech],
  );

  // Carry on from the previous chapter.
  useEffect(() => {
    if (!continuing()) return;
    continueRequestedAt = 0;
    const t = setTimeout(() => speakFrom(0), 400);
    return () => clearTimeout(t);
  }, [speakFrom]);

  // Leaving the chapter (or the reader) stops the voice, unless the next chapter continues it.
  useEffect(
    () => () => {
      session.current++;
      if (!continuing()) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
      }
    },
    [],
  );

  // A new speed applies from the next paragraph without losing the place.
  const lastRate = useRef(rate);
  useEffect(() => {
    if (lastRate.current === rate) return;
    lastRate.current = rate;
    if (state === 'playing') speakFrom(indexRef.current);
  }, [rate, state, speakFrom]);

  // Headset and media keys where the browser routes them to the page.
  useEffect(() => {
    const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
    if (!ms || state === 'idle') return;
    try {
      if (typeof MediaMetadata === 'function') ms.metadata = new MediaMetadata({ title, artist: 'Sakura · Read aloud' });
      ms.playbackState = state === 'playing' ? 'playing' : 'paused';
      ms.setActionHandler('play', () => speakFrom(indexRef.current));
      ms.setActionHandler('pause', pause);
      ms.setActionHandler('stop', stop);
      ms.setActionHandler('nexttrack', () => speakFrom(indexRef.current + 1));
      ms.setActionHandler('previoustrack', () => speakFrom(Math.max(0, indexRef.current - 1)));
    } catch {
      // Some actions are unsupported in some browsers; the on-screen controls remain.
    }
    return () => {
      try {
        for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'] as const) ms.setActionHandler(a, null);
      } catch {
        // ignore
      }
    };
  }, [state, title, speakFrom, pause, stop]);

  if (state === 'idle') return null;
  const nextRate = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
  return (
    <View style={[s.bar, { bottom: bottomOffset, backgroundColor: palette.card, borderColor: palette.rule }]} accessibilityRole="toolbar" accessibilityLabel="Read aloud">
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Previous paragraph" onPress={() => speakFrom(Math.max(0, indexRef.current - 1))} style={s.btn}>
        <Text style={[s.glyph, { color: palette.text }]}>⏮</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={state === 'playing' ? 'Pause reading aloud' : 'Resume reading aloud'}
        onPress={() => (state === 'playing' ? pause() : speakFrom(indexRef.current))}
        style={[s.play, { backgroundColor: palette.accent }]}
      >
        <Text style={[s.glyph, { color: palette.bg }]}>{state === 'playing' ? '❚❚' : '▶'}</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Next paragraph" onPress={() => speakFrom(indexRef.current + 1)} style={s.btn}>
        <Text style={[s.glyph, { color: palette.text }]}>⏭</Text>
      </TouchableOpacity>
      <Text style={[s.where, { color: palette.muted }]} numberOfLines={1}>
        ¶ {index + 1}/{paragraphs.length}
      </Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Reading speed ${rate}x. Change to ${nextRate}x`} onPress={() => onRateChange(nextRate)} style={[s.rate, { borderColor: palette.rule }]}>
        <Text style={[s.rateText, { color: palette.text }]}>{rate}×</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Stop reading aloud" onPress={stop} style={s.btn}>
        <Text style={[s.glyph, { color: palette.text }]}>✕</Text>
      </TouchableOpacity>
    </View>
  );
});

export default NovelReadAloud;

const s = StyleSheet.create({
  bar: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: '94%',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  btn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  play: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 15, fontWeight: '700' },
  where: { fontSize: 11, fontVariant: ['tabular-nums'], paddingHorizontal: 4, minWidth: 54, textAlign: 'center' },
  rate: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, height: 30, justifyContent: 'center' },
  rateText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
