import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, isWallet, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { PUSH_NOTIFICATION_SOUND, sendExpoPushBatch } from '../_shared/expo-push.ts';

type ChatBody = {
  action?: 'start' | 'send' | 'threads' | 'messages' | 'mark_read' | 'block' | 'report' | 'typing' | 'status';
  recipient_wallet?: string;
  thread_id?: string;
  content?: string;
  message_type?: string;
  reason?: string;
  mark_read?: boolean;
  typing?: boolean;
};

const cors = corsHeaders();
const SEND_RATE_LIMIT = 30;
const TYPING_TTL_MS = 5000;

function shortenWallet(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

const MEDIA_PREFIX = 'sakura-media:';

function chatMessagePreview(content: string, messageType?: string): string {
  if (messageType === 'gif') return 'GIF';
  if (messageType === 'sticker') return 'Sticker';
  if (content.startsWith(MEDIA_PREFIX)) {
    try {
      const parsed = JSON.parse(content.slice(MEDIA_PREFIX.length)) as { kind?: string };
      if (parsed.kind === 'sticker') return 'Sticker';
      if (parsed.kind === 'gif') return 'GIF';
    } catch {
      // ignore malformed media payload
    }
  }
  return content.trim().slice(0, 120);
}

async function assertThreadMember(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  walletAddress: string,
) {
  const { data: member } = await supabase
    .from('chat_members')
    .select('thread_id')
    .eq('thread_id', threadId)
    .eq('wallet_address', walletAddress)
    .maybeSingle();
  return !!member;
}

async function markThreadRead(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  walletAddress: string,
) {
  const { error } = await supabase
    .from('chat_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('thread_id', threadId)
    .eq('wallet_address', walletAddress);
  if (error) throw new Error(error.message);
}

async function clearTyping(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  walletAddress: string,
) {
  await supabase
    .from('chat_typing')
    .delete()
    .eq('thread_id', threadId)
    .eq('wallet_address', walletAddress);
}

async function setTyping(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  walletAddress: string,
  active: boolean,
) {
  if (!active) {
    await clearTyping(supabase, threadId, walletAddress);
    return;
  }
  const { error } = await supabase.from('chat_typing').upsert(
    {
      thread_id: threadId,
      wallet_address: walletAddress,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'thread_id,wallet_address' },
  );
  if (error) throw new Error(error.message);
}

async function isBlockedBetween(
  supabase: ReturnType<typeof createClient>,
  walletA: string,
  walletB: string,
): Promise<boolean> {
  const { data: block } = await supabase
    .from('message_blocks')
    .select('blocker_wallet')
    .or(
      `and(blocker_wallet.eq.${walletA},blocked_wallet.eq.${walletB}),and(blocker_wallet.eq.${walletB},blocked_wallet.eq.${walletA})`,
    )
    .maybeSingle();
  return !!block;
}

async function getPeerWallet(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  senderWallet: string,
): Promise<string | null> {
  const { data: members } = await supabase
    .from('chat_members')
    .select('wallet_address')
    .eq('thread_id', threadId);
  return (members ?? [])
    .map((m) => m.wallet_address as string)
    .find((w) => w !== senderWallet) ?? null;
}

async function getThreadPresence(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  walletAddress: string,
) {
  const peerWallet = await getPeerWallet(supabase, threadId, walletAddress);
  if (!peerWallet) {
    return { peer_wallet: null, peer_last_read_at: null, peer_is_typing: false };
  }

  const [{ data: peerMember }, { data: typingRow }] = await Promise.all([
    supabase
      .from('chat_members')
      .select('last_read_at')
      .eq('thread_id', threadId)
      .eq('wallet_address', peerWallet)
      .maybeSingle(),
    supabase
      .from('chat_typing')
      .select('updated_at')
      .eq('thread_id', threadId)
      .eq('wallet_address', peerWallet)
      .maybeSingle(),
  ]);

  const typingAt = typingRow?.updated_at ? new Date(typingRow.updated_at as string).getTime() : 0;
  const peerIsTyping = typingAt > 0 && Date.now() - typingAt <= TYPING_TTL_MS;

  return {
    peer_wallet: peerWallet,
    peer_last_read_at: (peerMember?.last_read_at as string | null) ?? null,
    peer_is_typing: peerIsTyping,
  };
}

async function getSenderLabel(
  supabase: ReturnType<typeof createClient>,
  senderWallet: string,
): Promise<{ displayName: string; username: string | null }> {
  const [{ data: usernameRow }, { data: profileRow }] = await Promise.all([
    supabase.from('sakura_usernames').select('username, display_name').eq('wallet_address', senderWallet).maybeSingle(),
    supabase.from('user_profiles').select('display_name').eq('wallet_address', senderWallet).maybeSingle(),
  ]);
  const username = usernameRow?.username ?? null;
  const displayName =
    profileRow?.display_name?.trim() ||
    usernameRow?.display_name?.trim() ||
    (username ? `@${username}` : shortenWallet(senderWallet));
  return { displayName, username };
}

async function notifyRecipientOnSend(
  supabase: ReturnType<typeof createClient>,
  input: {
    threadId: string;
    senderWallet: string;
    recipientWallet: string;
    messageId: string;
    content: string;
    messageType?: string;
  },
) {
  const { displayName, username } = await getSenderLabel(supabase, input.senderWallet);
  const preview = chatMessagePreview(input.content, input.messageType);
  const route = `/messages/${input.threadId}`;

  const { error: notifyErr } = await supabase.from('creator_notifications').insert({
    recipient_wallet: input.recipientWallet,
    actor_wallet: input.senderWallet,
    notification_type: 'chat_message',
    title: displayName,
    body: preview,
    route,
    chat_thread_id: input.threadId,
    metadata: { message_id: input.messageId, sender_username: username },
  });
  if (notifyErr) console.error('chat notification insert failed', notifyErr.message);

  try {
    const { data: tokens, error: tokenErr } = await supabase
      .from('push_tokens')
      .select('expo_push_token')
      .eq('wallet_address', input.recipientWallet)
      .eq('enabled', true);
    if (tokenErr) {
      console.error('chat push token lookup failed', tokenErr.message);
      return;
    }

    const pushMessages = (tokens ?? [])
      .filter((row) => row.expo_push_token)
      .map((row) => ({
        to: row.expo_push_token as string,
        title: displayName,
        body: preview,
        sound: PUSH_NOTIFICATION_SOUND,
        data: {
          type: 'chat_message',
          threadId: input.threadId,
          wallet: input.senderWallet,
          peerName: displayName,
          peerUsername: username ?? '',
        },
      }));

    if (pushMessages.length) {
      await sendExpoPushBatch(pushMessages);
    }
  } catch (pushErr) {
    console.error('chat push send failed', pushErr);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-chat');
    const body = (await req.json()) as ChatBody;
    const action = body.action ?? 'threads';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (action === 'threads') {
      const { data, error } = await supabase
        .from('chat_members')
        .select('thread_id, role, last_read_at, chat_threads(*)')
        .eq('wallet_address', walletAddress)
        .order('joined_at', { ascending: false });
      if (error) return jsonResponse(500, { error: error.message }, cors);

      const enriched = [];
      for (const row of data ?? []) {
        const threadId = row.thread_id as string;
        const presence = await getThreadPresence(supabase, threadId, walletAddress);

        let peer_username: string | null = null;
        let peer_display_name: string | null = null;
        let peer_avatar_url: string | null = null;
        let peer_avatar_seed: string | null = null;

        if (presence.peer_wallet) {
          const [{ data: usernameRow }, { data: profileRow }] = await Promise.all([
            supabase.from('sakura_usernames').select('username, display_name').eq('wallet_address', presence.peer_wallet).maybeSingle(),
            supabase.from('user_profiles').select('display_name, avatar_url, avatar_seed').eq('wallet_address', presence.peer_wallet).maybeSingle(),
          ]);
          peer_username = usernameRow?.username ?? null;
          peer_display_name = profileRow?.display_name ?? usernameRow?.display_name ?? null;
          peer_avatar_url = profileRow?.avatar_url ?? null;
          peer_avatar_seed = profileRow?.avatar_seed ?? presence.peer_wallet.slice(0, 8);
        }

        const { data: lastMessage } = await supabase
          .from('chat_messages')
          .select('content, created_at, sender_wallet')
          .eq('thread_id', threadId)
          .neq('moderation_state', 'removed')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        enriched.push({
          thread_id: threadId,
          role: row.role,
          last_read_at: row.last_read_at,
          peer_wallet: presence.peer_wallet,
          peer_last_read_at: presence.peer_last_read_at,
          peer_is_typing: presence.peer_is_typing,
          peer_username,
          peer_display_name,
          peer_avatar_url,
          peer_avatar_seed,
          last_message: lastMessage?.content ?? null,
          last_message_at: lastMessage?.created_at ?? (row as { chat_threads?: { last_message_at?: string } }).chat_threads?.last_message_at ?? null,
          last_message_sender: lastMessage?.sender_wallet ?? null,
        });
      }

      return jsonResponse(200, { threads: enriched }, cors);
    }

    if (action === 'status') {
      if (!body.thread_id) return jsonResponse(400, { error: 'Missing thread_id.' }, cors);
      const member = await assertThreadMember(supabase, body.thread_id, walletAddress);
      if (!member) return jsonResponse(403, { error: 'Not a thread member.' }, cors);
      const presence = await getThreadPresence(supabase, body.thread_id, walletAddress);
      return jsonResponse(200, presence, cors);
    }

    if (action === 'typing') {
      if (!body.thread_id) return jsonResponse(400, { error: 'Missing thread_id.' }, cors);
      const member = await assertThreadMember(supabase, body.thread_id, walletAddress);
      if (!member) return jsonResponse(403, { error: 'Not a thread member.' }, cors);
      await setTyping(supabase, body.thread_id, walletAddress, body.typing !== false);
      return jsonResponse(200, { ok: true }, cors);
    }

    if (action === 'mark_read') {
      if (!body.thread_id) return jsonResponse(400, { error: 'Missing thread_id.' }, cors);
      const member = await assertThreadMember(supabase, body.thread_id, walletAddress);
      if (!member) return jsonResponse(403, { error: 'Not a thread member.' }, cors);
      await markThreadRead(supabase, body.thread_id, walletAddress);
      return jsonResponse(200, { ok: true }, cors);
    }

    if (action === 'messages') {
      if (!body.thread_id) return jsonResponse(400, { error: 'Missing thread_id.' }, cors);
      const member = await assertThreadMember(supabase, body.thread_id, walletAddress);
      if (!member) return jsonResponse(403, { error: 'Not a thread member.' }, cors);

      const [{ data, error }, presence] = await Promise.all([
        supabase
          .from('chat_messages')
          .select('*')
          .eq('thread_id', body.thread_id)
          .neq('moderation_state', 'removed')
          .order('created_at', { ascending: false })
          .limit(50),
        getThreadPresence(supabase, body.thread_id, walletAddress),
      ]);
      if (error) return jsonResponse(500, { error: error.message }, cors);

      if (body.mark_read) {
        await markThreadRead(supabase, body.thread_id, walletAddress);
      }

      return jsonResponse(200, {
        messages: (data ?? []).reverse(),
        peer_last_read_at: presence.peer_last_read_at,
        peer_is_typing: presence.peer_is_typing,
      }, cors);
    }

    if (action === 'block') {
      const blocked = body.recipient_wallet?.trim() ?? '';
      if (!isWallet(blocked) || blocked === walletAddress) return jsonResponse(400, { error: 'Invalid wallet.' }, cors);
      const { error } = await supabase
        .from('message_blocks')
        .upsert({ blocker_wallet: walletAddress, blocked_wallet: blocked }, { onConflict: 'blocker_wallet,blocked_wallet' });
      if (error) return jsonResponse(500, { error: error.message }, cors);
      return jsonResponse(200, { ok: true }, cors);
    }

    if (action === 'report') {
      if (!body.thread_id || !body.reason?.trim()) return jsonResponse(400, { error: 'Missing report details.' }, cors);
      const { error } = await supabase.from('message_reports').insert({
        reporter_wallet: walletAddress,
        thread_id: body.thread_id,
        reason: body.reason.trim().slice(0, 500),
      });
      if (error) return jsonResponse(500, { error: error.message }, cors);
      return jsonResponse(200, { ok: true }, cors);
    }

    let threadId = body.thread_id;
    const recipient = body.recipient_wallet?.trim() ?? '';

    if (action === 'start') {
      if (!isWallet(recipient) || recipient === walletAddress) return jsonResponse(400, { error: 'Invalid recipient.' }, cors);
      if (await isBlockedBetween(supabase, walletAddress, recipient)) {
        return jsonResponse(403, { error: 'Chat is blocked.' }, cors);
      }

      const { data: existingMembers } = await supabase
        .from('chat_members')
        .select('thread_id')
        .in('wallet_address', [walletAddress, recipient]);
      const counts = new Map<string, number>();
      for (const member of existingMembers ?? []) counts.set(member.thread_id, (counts.get(member.thread_id) ?? 0) + 1);
      threadId = [...counts.entries()].find(([, count]) => count >= 2)?.[0];

      if (!threadId) {
        const { data: thread, error: threadErr } = await supabase
          .from('chat_threads')
          .insert({ created_by_wallet: walletAddress, thread_type: 'direct' })
          .select('id')
          .single();
        if (threadErr) return jsonResponse(500, { error: threadErr.message }, cors);
        threadId = thread.id;
        const { error: memberErr } = await supabase.from('chat_members').insert([
          { thread_id: threadId, wallet_address: walletAddress, role: 'member' },
          { thread_id: threadId, wallet_address: recipient, role: 'member' },
        ]);
        if (memberErr) return jsonResponse(500, { error: memberErr.message }, cors);
      }
    }

    if (action === 'send') {
      if (!threadId || !body.content?.trim()) return jsonResponse(400, { error: 'Missing message.' }, cors);
      const member = await assertThreadMember(supabase, threadId, walletAddress);
      if (!member) return jsonResponse(403, { error: 'Not a thread member.' }, cors);

      const peerWallet = await getPeerWallet(supabase, threadId, walletAddress);
      if (peerWallet && await isBlockedBetween(supabase, walletAddress, peerWallet)) {
        return jsonResponse(403, { error: 'Chat is blocked.' }, cors);
      }

      const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
      const { count: recentCount, error: rateErr } = await supabase
        .from('chat_messages')
        .select('*', { count: 'exact', head: true })
        .eq('sender_wallet', walletAddress)
        .gte('created_at', oneMinuteAgo);
      if (rateErr) return jsonResponse(500, { error: rateErr.message }, cors);
      if ((recentCount ?? 0) >= SEND_RATE_LIMIT) {
        return jsonResponse(429, { error: 'Too many messages. Please wait a moment.' }, cors);
      }

      const trimmed = body.content.trim().slice(0, 2000);
      const messageType = body.message_type?.trim() || 'text';
      const allowedTypes = new Set(['text', 'gif', 'sticker']);
      const resolvedType = allowedTypes.has(messageType) ? messageType : 'text';
      const { data: message, error } = await supabase
        .from('chat_messages')
        .insert({
          thread_id: threadId,
          sender_wallet: walletAddress,
          content: trimmed,
          message_type: resolvedType,
        })
        .select('*')
        .single();
      if (error) return jsonResponse(500, { error: error.message }, cors);

      await Promise.all([
        supabase.from('chat_threads').update({ last_message_at: new Date().toISOString() }).eq('id', threadId),
        clearTyping(supabase, threadId, walletAddress),
      ]);

      if (peerWallet) {
        await notifyRecipientOnSend(supabase, {
          threadId,
          senderWallet: walletAddress,
          recipientWallet: peerWallet,
          messageId: message.id as string,
          content: trimmed,
          messageType: resolvedType,
        });
      }

      return jsonResponse(200, { ok: true, thread_id: threadId, message }, cors);
    }

    return jsonResponse(200, { ok: true, thread_id: threadId }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Chat request failed.' }, cors);
  }
});
