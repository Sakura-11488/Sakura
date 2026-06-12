import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, isWallet, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type ChatBody = {
  action?: 'start' | 'send' | 'threads' | 'messages' | 'block' | 'report';
  recipient_wallet?: string;
  thread_id?: string;
  content?: string;
  reason?: string;
};

const cors = corsHeaders();

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
      return jsonResponse(200, { threads: data ?? [] }, cors);
    }

    if (action === 'messages') {
      if (!body.thread_id) return jsonResponse(400, { error: 'Missing thread_id.' }, cors);
      const { data: member } = await supabase
        .from('chat_members')
        .select('thread_id')
        .eq('thread_id', body.thread_id)
        .eq('wallet_address', walletAddress)
        .maybeSingle();
      if (!member) return jsonResponse(403, { error: 'Not a thread member.' }, cors);
      const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('thread_id', body.thread_id)
        .neq('moderation_state', 'removed')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return jsonResponse(500, { error: error.message }, cors);
      return jsonResponse(200, { messages: (data ?? []).reverse() }, cors);
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
      const { data: block } = await supabase
        .from('message_blocks')
        .select('blocker_wallet')
        .or(`and(blocker_wallet.eq.${walletAddress},blocked_wallet.eq.${recipient}),and(blocker_wallet.eq.${recipient},blocked_wallet.eq.${walletAddress})`)
        .maybeSingle();
      if (block) return jsonResponse(403, { error: 'Chat is blocked.' }, cors);

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
      const { data: member } = await supabase
        .from('chat_members')
        .select('thread_id')
        .eq('thread_id', threadId)
        .eq('wallet_address', walletAddress)
        .maybeSingle();
      if (!member) return jsonResponse(403, { error: 'Not a thread member.' }, cors);
      const { data: message, error } = await supabase
        .from('chat_messages')
        .insert({
          thread_id: threadId,
          sender_wallet: walletAddress,
          content: body.content.trim().slice(0, 2000),
        })
        .select('*')
        .single();
      if (error) return jsonResponse(500, { error: error.message }, cors);
      await supabase.from('chat_threads').update({ last_message_at: new Date().toISOString() }).eq('id', threadId);
      return jsonResponse(200, { ok: true, thread_id: threadId, message }, cors);
    }

    return jsonResponse(200, { ok: true, thread_id: threadId }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Chat request failed.' }, cors);
  }
});
