import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme';
import MessagesInbox from '@/components/social/MessagesInbox';

export default function MessagesTabScreen() {
  const { colors } = useTheme();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <MessagesInbox />
    </SafeAreaView>
  );
}
