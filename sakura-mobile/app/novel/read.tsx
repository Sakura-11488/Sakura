import React, { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import NovelReader from '@/components/novel/NovelReader';
import { useSafeBack } from '@/components/novel/useSafeBack';

function decodeParam(value?: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Novel reader route.
 *
 * The reader itself lives in components/novel/NovelReader.tsx and is keyed by
 * chapter path: moving to the previous/next chapter swaps the route params in
 * place (router.setParams — the back button still returns to the book, the
 * stack does not grow, and the web URL always names the open chapter) and
 * remounts the reader with clean per-chapter state.
 *
 * Params: path (chapter), o (0–1 progress hint; legacy pixel values from
 * reading history are ignored), title (novel), cover, chapter (chapter title),
 * novelPath (series detail path). `offline` is accepted for old links but no
 * longer needed: downloaded chapters are always read from the device first.
 */
export default function NovelReaderScreen() {
  const { path, o, title, cover, chapter, novelPath } = useLocalSearchParams<{
    path: string;
    o?: string;
    title?: string;
    cover?: string;
    chapter?: string;
    offline?: string;
    novelPath?: string;
  }>();
  const router = useRouter();
  const chapterPath = decodeParam(path);
  const seriesPath = decodeParam(novelPath);

  const openChapter = useCallback(
    (target: { path: string; title?: string; seriesPath?: string; novelTitle?: string; cover?: string }) => {
      router.setParams({
        path: target.path,
        chapter: target.title || undefined,
        novelPath: target.seriesPath || undefined,
        title: target.novelTitle || undefined,
        cover: target.cover || undefined,
        // A new chapter opens at its own saved place (or the top), never at the old hint.
        o: undefined,
        offline: undefined,
      });
    },
    [router],
  );

  const safeBack = useSafeBack();
  const exit = useCallback(
    (series?: string) => safeBack(series ? { pathname: '/novel/ext', params: { path: series } } : '/novel'),
    [safeBack],
  );

  return (
    <NovelReader
      key={chapterPath}
      chapterPath={chapterPath}
      resumeParam={typeof o === 'string' ? o : undefined}
      novelTitleParam={typeof title === 'string' && title ? title : undefined}
      coverParam={typeof cover === 'string' && cover ? cover : undefined}
      chapterTitleParam={typeof chapter === 'string' && chapter ? chapter : undefined}
      seriesPathParam={seriesPath || undefined}
      onOpenChapter={openChapter}
      onExit={exit}
    />
  );
}
