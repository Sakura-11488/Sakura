import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const SESSION_KEY = 'sakura_web_tx_auth_until';
const SESSION_MS = 20 * 60 * 1000;

type Resolver = { resolve: () => void; reject: (err: Error) => void };

function isSessionActive(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  const until = Number(sessionStorage.getItem(SESSION_KEY) || 0);
  return Date.now() < until;
}

function rememberSession(): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(SESSION_KEY, String(Date.now() + SESSION_MS));
  }
}

let pending: Resolver | null = null;
let openModal: ((reason: string) => void) | null = null;

/** Called from wallet storage before reading the embedded key on web. */
export async function requestWebTransactionAuth(reason: string): Promise<void> {
  if (Platform.OS !== 'web') return;
  if (isSessionActive()) return;
  if (!openModal) {
    throw new Error('Web transaction auth is not ready.');
  }
  return new Promise<void>((resolve, reject) => {
    pending = { resolve, reject };
    openModal!(reason);
  });
}

export function WebTransactionAuthProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const [reason, setReason] = useState('');
  const [remember, setRemember] = useState(false);
  const rememberRef = useRef(false);

  const finish = useCallback((ok: boolean) => {
    const current = pending;
    pending = null;
    setVisible(false);
    setReason('');
    rememberRef.current = false;
    setRemember(false);
    if (!current) return;
    if (ok) {
      current.resolve();
    } else {
      current.reject(new Error('Transaction cancelled.'));
    }
  }, []);

  openModal = useCallback((r: string) => {
    setReason(r);
    setVisible(true);
  }, []);

  useEffect(() => {
    return () => {
      openModal = null;
    };
  }, []);

  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  return (
    <>
      {children}
      <Modal transparent visible={visible} animationType="fade" onRequestClose={() => finish(false)}>
        <View style={styles.backdrop}>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]}>Confirm transaction</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {reason || 'Approve this action with your Sakura wallet.'}
            </Text>
            <TouchableOpacity
              style={styles.rememberRow}
              onPress={() => {
                setRemember((v) => {
                  const next = !v;
                  rememberRef.current = next;
                  return next;
                });
              }}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, remember && styles.checkboxOn]} />
              <Text style={[styles.rememberText, { color: colors.textSecondary }]}>
                Remember for this browser session
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.confirmBtn}
              onPress={() => {
                if (rememberRef.current) rememberSession();
                finish(true);
              }}
              activeOpacity={0.85}
            >
              <Text style={styles.confirmText}>Confirm</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => finish(false)} style={styles.cancelBtn} activeOpacity={0.7}>
              <Text style={[styles.cancelText, { color: colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

export function useWebTransactionAuthReady(): boolean {
  return Platform.OS !== 'web' || openModal != null;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: 22,
    gap: 12,
  },
  title: {
    fontFamily: Fonts.display,
    fontWeight: Fonts.displayWeight,
    fontSize: FontSize.lg,
  },
  body: {
    fontSize: FontSize.sm,
    lineHeight: 20,
  },
  rememberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#E84545',
  },
  checkboxOn: {
    backgroundColor: '#E84545',
  },
  rememberText: {
    fontSize: FontSize.xs,
    flex: 1,
  },
  confirmBtn: {
    marginTop: 8,
    backgroundColor: '#E84545',
    borderRadius: Radius.full,
    paddingVertical: 14,
    alignItems: 'center',
  },
  confirmText: {
    color: '#fff',
    fontWeight: FontWeight.bold,
    fontSize: FontSize.md,
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  cancelText: {
    fontSize: FontSize.sm,
  },
});
