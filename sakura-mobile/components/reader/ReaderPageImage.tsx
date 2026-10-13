import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ReaderImage from './ReaderImage';

const IMAGE_TIMEOUT_MS = 15_000;

/** Loading deadlines apply only to visible pages, not mounted lazy images. */
export default function ReaderPageImage({
  uri, pageId, pageNumber, width, height, viewportHeight, mirrored = false, isVisible = true, onLoad, onBack,
}: {
  uri: string;
  pageId: string;
  pageNumber: number;
  width: number;
  height: number;
  viewportHeight: number;
  mirrored?: boolean;
  isVisible?: boolean;
  onLoad: (width?: number, height?: number) => void;
  onBack: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const requestId = `${pageId}:${uri}:${attempt}`;
  const [result, setResult] = useState<{ requestId: string; status: 'ready' | 'failed' } | null>(null);
  const status = result?.requestId === requestId ? result.status : 'loading';
  const currentRequest = useRef('');
  currentRequest.current = requestId;
  const visible = useRef(isVisible);
  visible.current = isVisible;

  useEffect(() => {
    // On web an offscreen <img loading="lazy"> may not have made a request
    // yet. Mount time is therefore not the start of its loading deadline.
    if (!isVisible || status !== 'loading') return;
    const timeout = setTimeout(() => {
      if (currentRequest.current === requestId && visible.current) {
        setResult((current) => current?.requestId === requestId && current.status === 'ready'
          ? current : { requestId, status: 'failed' });
      }
    }, IMAGE_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [requestId, isVisible, status]);

  return (
    // The parent FlatList mirrors all its children in RTL mode. Counter-mirror
    // the whole page so both the artwork and recovery controls read normally.
    <View style={[{ width, height }, mirrored && styles.mirrored]}>
      <ReaderImage
        key={requestId}
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        transition={0}
        recyclingKey={requestId}
        isVisible={isVisible}
        retryAttempt={attempt}
        accessibilityLabel={`Page ${pageNumber}`}
        onLoad={(event) => {
          if (currentRequest.current !== requestId) return;
          setResult({ requestId, status: 'ready' });
          onLoad(event?.source?.width, event?.source?.height);
        }}
        onError={() => {
          if (currentRequest.current === requestId) setResult({ requestId, status: 'failed' });
        }}
      />
      {status === 'loading' ? (
        <View style={[styles.message, { height: Math.min(height, viewportHeight) }]} accessibilityLiveRegion="polite">
          <ActivityIndicator color="#fff" />
          <Text style={styles.description}>Loading page {pageNumber}…</Text>
        </View>
      ) : status === 'failed' ? (
        <View style={[styles.message, { height: Math.min(height, viewportHeight) }]} accessibilityLiveRegion="polite">
          <Text style={styles.title}>Page {pageNumber} could not load</Text>
          <Text style={styles.description}>The image source is unavailable. Try again or choose another chapter.</Text>
          <TouchableOpacity accessibilityRole="button" style={styles.retry} onPress={() => {
            setAttempt((value) => value + 1);
          }}>
            <Text style={styles.retryLabel}>Retry page</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={onBack} style={styles.back}>
            <Text style={styles.backLabel}>Back to chapters</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mirrored: { transform: [{ scaleX: -1 }] },
  message: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12, backgroundColor: '#111' },
  title: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  description: { color: '#ccc', fontSize: 14, lineHeight: 21, maxWidth: 320, textAlign: 'center' },
  retry: { borderRadius: 20, backgroundColor: '#E84545', paddingHorizontal: 20, paddingVertical: 12 },
  retryLabel: { color: '#fff', fontWeight: '600' },
  back: { padding: 12 },
  backLabel: { color: '#ddd', textDecorationLine: 'underline' },
});
