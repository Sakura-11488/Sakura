import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { fetchCreatorChatMessages, sendCreatorChatMessage, startCreatorChat } from '@/lib/creator-social';
import { useWallet } from '@/lib/wallet/context';
import { FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

type ChatMessage = { id: string; sender_wallet: string; content: string; created_at: string };

export default function CreatorChatScreen() {
  const { wallet, thread } = useLocalSearchParams<{ wallet?: string; thread?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { address, signWithBiometrics } = useWallet();
  const [threadId, setThreadId] = useState(thread ?? '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const authHeaders = useCallback(async () => {
    const keypair = await signWithBiometrics();
    if (!keypair) throw new Error('Wallet approval is required.');
    return buildWalletAuthHeaders(keypair, 'creator-chat');
  }, [signWithBiometrics]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!address) return;
      const headers = await authHeaders();
      const id = threadId || (wallet ? await startCreatorChat({ recipientWallet: wallet, authHeaders: headers }) : '');
      if (!id || !active) return;
      setThreadId(id);
      const rows = await fetchCreatorChatMessages({ threadId: id, authHeaders: headers });
      if (active) setMessages(rows);
    })().catch((error) => Alert.alert('Chat unavailable', error instanceof Error ? error.message : 'Please try again.'));
    return () => {
      active = false;
    };
  }, [address, authHeaders, threadId, wallet]);

  const send = useCallback(async () => {
    if (!threadId || !draft.trim()) return;
    setBusy(true);
    try {
      const headers = await authHeaders();
      const message = await sendCreatorChatMessage({ threadId, content: draft, authHeaders: headers });
      setMessages((current) => [...current, message]);
      setDraft('');
    } catch (error) {
      Alert.alert('Message failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [authHeaders, draft, threadId]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
        back: { color: colors.primary, fontWeight: FontWeight.bold },
        title: { color: colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
        list: { flex: 1, paddingHorizontal: Spacing.md },
        bubble: { maxWidth: '82%', borderRadius: Radius.lg, padding: Spacing.sm, marginBottom: Spacing.sm },
        mine: { alignSelf: 'flex-end', backgroundColor: colors.primary },
        theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface },
        text: { fontSize: FontSize.sm, lineHeight: 19 },
        inputRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderLight },
        input: { flex: 1, borderRadius: Radius.full, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: Spacing.md },
        send: { borderRadius: Radius.full, backgroundColor: colors.primary, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
        sendText: { color: '#fff', fontWeight: FontWeight.bold },
      }),
    [colors],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}><Text style={styles.back}>Back</Text></TouchableOpacity>
          <Text style={styles.title}>Creator Chat</Text>
          <View style={{ width: 38 }} />
        </View>
        <FlatList
          style={styles.list}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const mine = item.sender_wallet === address;
            return (
              <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                <Text style={[styles.text, { color: mine ? '#fff' : colors.text }]}>{item.content}</Text>
              </View>
            );
          }}
        />
        <View style={styles.inputRow}>
          <TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder="Message..." placeholderTextColor={colors.textTertiary} />
          <TouchableOpacity style={styles.send} onPress={send} disabled={busy} activeOpacity={0.85}>
            <Text style={styles.sendText}>{busy ? '...' : 'Send'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
