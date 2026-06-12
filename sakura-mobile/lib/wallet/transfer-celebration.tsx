import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import SakuraLottie from '@/components/ui/SakuraLottie';
import { Fonts, FontSize } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

export type TransferAsset = 'sakura' | 'sol';

export type TransferCelebrationPayload = {
  role: 'sent' | 'received' | 'swap';
  asset?: TransferAsset;
  amount?: number;
  counterparty?: string;
  title?: string;
  subtitle?: string;
  onFinish?: () => void;
};

type TransferCelebrationContextValue = {
  showCelebration: (payload: TransferCelebrationPayload) => void;
};

const TransferCelebrationContext = createContext<TransferCelebrationContextValue | null>(null);

function shortenWallet(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatAmount(amount: number, asset: TransferAsset): string {
  if (asset === 'sol') {
    return amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  }
  return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function unitLabel(asset: TransferAsset): string {
  return asset === 'sol' ? 'SOL' : 'SAKURA';
}

function defaultTitle(payload: TransferCelebrationPayload): string {
  const asset = payload.asset ?? 'sakura';
  const unit = unitLabel(asset);
  if (payload.role === 'received') return `${unit} received!`;
  if (payload.role === 'swap') return 'Swap complete!';
  return `${unit} sent!`;
}

function defaultSubtitle(payload: TransferCelebrationPayload): string {
  if (payload.subtitle) return payload.subtitle;
  const asset = payload.asset ?? 'sakura';
  const unit = unitLabel(asset);
  if (payload.role === 'swap' && payload.amount != null) {
    return `You received ~${formatAmount(payload.amount, 'sakura')} SAKURA`;
  }
  if (payload.role === 'received' && payload.amount != null && payload.counterparty) {
    return `You received ${formatAmount(payload.amount, asset)} ${unit} from ${shortenWallet(payload.counterparty)}`;
  }
  if (payload.amount != null && payload.counterparty) {
    return `You sent ${formatAmount(payload.amount, asset)} ${unit} to ${shortenWallet(payload.counterparty)}`;
  }
  return '';
}

export function TransferCelebrationProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const [payload, setPayload] = useState<TransferCelebrationPayload | null>(null);
  const finishRef = useRef<(() => void) | undefined>(undefined);

  const showCelebration = useCallback((next: TransferCelebrationPayload) => {
    finishRef.current = next.onFinish;
    setPayload(next);
    setVisible(true);
  }, []);

  const handleFinish = useCallback(() => {
    setVisible(false);
    setPayload(null);
    finishRef.current?.();
    finishRef.current = undefined;
  }, []);

  const value = useMemo(() => ({ showCelebration }), [showCelebration]);

  const title = payload ? (payload.title ?? defaultTitle(payload)) : '';
  const subtitle = payload ? defaultSubtitle(payload) : '';

  return (
    <TransferCelebrationContext.Provider value={value}>
      {children}
      <Modal visible={visible} transparent animationType="fade" onRequestClose={handleFinish}>
        <View style={styles.overlay}>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
            <SakuraLottie
              source={require('@/assets/lottie/sent.json')}
              style={styles.lottie}
              autoPlay
              loop={false}
              onAnimationFinish={handleFinish}
            />
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
          </View>
        </View>
      </Modal>
    </TransferCelebrationContext.Provider>
  );
}

export function useTransferCelebration() {
  const ctx = useContext(TransferCelebrationContext);
  if (!ctx) {
    throw new Error('useTransferCelebration must be used within TransferCelebrationProvider');
  }
  return ctx;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 24,
    borderWidth: 1,
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 8,
  },
  lottie: {
    width: 200,
    height: 200,
  },
  title: {
    fontFamily: Fonts.display,
    fontWeight: Fonts.displayWeight,
    fontSize: FontSize.xl,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: Fonts.body,
    fontSize: FontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
});
