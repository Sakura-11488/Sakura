import React, { useCallback, useEffect, useState, createElement } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useTheme } from '@/lib/theme';
import { FontSize, FontWeight, Radius, Fonts } from '@/constants/theme';
import {
  buildTransakBuySolUrl,
  isTransakConfigured,
  isTransakOrderSuccessEvent,
} from '@/lib/wallet/transak';

type Props = {
  visible: boolean;
  walletAddress: string;
  onClose: () => void;
  onPurchaseComplete?: () => void;
};

export default function TransakWebModal({
  visible,
  walletAddress,
  onClose,
  onPurchaseComplete,
}: Props) {
  const { colors } = useTheme();
  const [loading, setLoading] = useState(true);
  const [orderComplete, setOrderComplete] = useState(false);
  const configured = isTransakConfigured();
  const transakUrl = configured ? buildTransakBuySolUrl(walletAddress) : '';

  useEffect(() => {
    if (!visible) {
      setLoading(true);
      setOrderComplete(false);
    }
  }, [visible]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (isTransakOrderSuccessEvent(event.data)) {
        setOrderComplete(true);
        onPurchaseComplete?.();
      }
      if ((event.data as { event_id?: string })?.event_id === 'TRANSAK_WIDGET_CLOSE') {
        onClose();
      }
    },
    [onClose, onPurchaseComplete],
  );

  useEffect(() => {
    if (!visible) return;
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [visible, handleMessage]);

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.text }]}>Buy SOL with Card</Text>
              <Text style={[styles.sub, { color: colors.textSecondary }]}>
                Purchase SOL, then swap to SAKURA
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
              <Text style={[styles.closeText, { color: colors.textSecondary }]}>✕</Text>
            </TouchableOpacity>
          </View>

          {!configured ? (
            <View style={styles.setup}>
              <Text style={[styles.setupTitle, { color: colors.text }]}>Transak setup required</Text>
              <Text style={[styles.setupBody, { color: colors.textSecondary }]}>
                Add EXPO_PUBLIC_TRANSAK_API_KEY to your web build environment, then redeploy.
              </Text>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://dashboard.transak.com')}
                activeOpacity={0.8}
              >
                <Text style={styles.link}>Get a free API key at dashboard.transak.com</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {loading && (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color="#E84545" />
                  <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
                    Loading payment provider…
                  </Text>
                </View>
              )}
              {orderComplete && (
                <View style={styles.successBanner}>
                  <Text style={styles.successText}>
                    Purchase complete. SOL will arrive in your wallet shortly.
                  </Text>
                </View>
              )}
              {createElement('iframe', {
                src: transakUrl,
                title: 'Transak',
                style: {
                  width: '100%',
                  height: 520,
                  border: 'none',
                  borderRadius: 12,
                  opacity: loading ? 0 : 1,
                },
                allow: 'camera; microphone; payment',
                onLoad: () => setLoading(false),
              })}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: 16,
    maxHeight: '92vh',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
    gap: 8,
  },
  title: {
    fontFamily: Fonts.display,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.lg,
  },
  sub: {
    fontSize: FontSize.sm,
    marginTop: 2,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    fontSize: 18,
  },
  setup: {
    paddingVertical: 24,
    gap: 10,
  },
  setupTitle: {
    fontFamily: Fonts.display,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.md,
  },
  setupBody: {
    fontSize: FontSize.sm,
    lineHeight: 20,
  },
  link: {
    color: '#E84545',
    fontSize: FontSize.sm,
    textDecorationLine: 'underline',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  loadingText: {
    fontSize: FontSize.sm,
  },
  successBanner: {
    backgroundColor: '#34C75922',
    borderRadius: Radius.md,
    padding: 10,
    marginBottom: 8,
  },
  successText: {
    color: '#34C759',
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
});
