import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@/lib/theme';
import { FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

export type ActionSheetAction = {
  id: string;
  label: string;
  destructive?: boolean;
  onPress?: () => void;
};

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  actions: ActionSheetAction[];
  onClose: () => void;
  loading?: boolean;
};

export default function AvatarActionSheet({
  visible,
  title,
  message,
  actions,
  onClose,
  loading = false,
}: Props) {
  const { colors } = useTheme();

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => undefined}>
          <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            {!!message && (
              <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
            )}
            {loading ? (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            ) : (
              actions.map((action) => (
                <TouchableOpacity
                  key={action.id}
                  style={[styles.actionBtn, { borderTopColor: colors.border }]}
                  onPress={() => {
                    onClose();
                    action.onPress?.();
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.actionText,
                      { color: action.destructive ? '#FF3B30' : colors.primary },
                    ]}
                  >
                    {action.label}
                  </Text>
                </TouchableOpacity>
              ))
            )}
            <TouchableOpacity
              style={[styles.cancelBtn, { borderTopColor: colors.border }]}
              onPress={onClose}
              activeOpacity={0.7}
            >
              <Text style={[styles.cancelText, { color: colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
    padding: Spacing.md,
  },
  sheet: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
  },
  title: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    textAlign: 'center',
    paddingTop: 18,
    paddingHorizontal: 20,
  },
  message: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  loader: {
    paddingVertical: 24,
  },
  actionBtn: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    alignItems: 'center',
  },
  actionText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
  },
  cancelBtn: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
  },
});
