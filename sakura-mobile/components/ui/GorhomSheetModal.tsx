import React, { useCallback, useMemo } from 'react';
import { Modal, View, StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { useTheme } from '@/lib/theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  snapPoints?: string[];
  children: React.ReactNode;
  keyboardBehavior?: 'interactive' | 'extend' | 'fillParent';
};

export default function GorhomSheetModal({
  visible,
  onClose,
  snapPoints = ['75%'],
  children,
  keyboardBehavior = 'interactive',
}: Props) {
  const { colors } = useTheme();
  const points = useMemo(() => snapPoints, [snapPoints]);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.55}
        pressBehavior="close"
      />
    ),
    [],
  );

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <BottomSheet
          index={0}
          snapPoints={points}
          enableDynamicSizing={false}
          enablePanDownToClose
          onClose={onClose}
          backdropComponent={renderBackdrop}
          backgroundStyle={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
          }}
          handleIndicatorStyle={{ backgroundColor: colors.border, width: 44, height: 5 }}
          keyboardBehavior={keyboardBehavior}
        >
          {children}
        </BottomSheet>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
