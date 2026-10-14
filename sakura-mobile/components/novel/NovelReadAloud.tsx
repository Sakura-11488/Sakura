import React, { forwardRef } from 'react';
import type { NovelReaderPalette } from '@/lib/novel-reader-prefs';

export interface ReadAloudHandle {
  toggle: () => void;
  stop: () => void;
}

export interface NovelReadAloudProps {
  paragraphs: string[];
  palette: NovelReaderPalette;
  rate: number;
  onRateChange: (rate: number) => void;
  /** Paragraph to start from (the one being read). */
  startIndex: () => number;
  /** Paragraph being spoken, or null when speech stops. */
  onParagraph: (index: number | null) => void;
  onChapterEnd: () => void;
  hasNextChapter: boolean;
  title: string;
  bottomOffset: number;
}

/**
 * Read-aloud is web-only for now (Web Speech API). Native would need
 * expo-speech, a new native module that ships in a store build, not over the
 * air — so the button is hidden on native rather than offered and broken.
 */
export function readAloudSupported(): boolean {
  return false;
}

/** Web: forget a pending "carry on into the next chapter". Nothing to forget on native. */
export function cancelReadAloudContinuation(): void {}

const NovelReadAloud = forwardRef<ReadAloudHandle, NovelReadAloudProps>(function NovelReadAloud() {
  return null;
});

export default NovelReadAloud;
