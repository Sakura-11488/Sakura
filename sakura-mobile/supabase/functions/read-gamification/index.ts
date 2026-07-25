import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, isWallet, jsonResponse } from '../_shared/wallet-auth.ts';

/**
 * Public read of a wallet's gamification state — XP/level/streak, today's
 * quests, and badges — for the streak widget + quests/badges screens. No
 * signature required (these are non-sensitive display stats; earning happens in
 * the signed reading-progress-ingest function).
 */

const cors = corsHeaders('POST, OPTIONS');
const utcDay = () => new Date().toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const body = (await req.json().catch(() => ({}))) as { wallet_address?: string };
    const wallet = String(body.wallet_address || '').trim();
    if (!isWallet(wallet)) return jsonResponse(400, { error: 'Valid wallet_address required.' }, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const today = utcDay();

    const [stateRes, questsRes, uqpRes, badgesRes, ubadgesRes, chaptersRes] = await Promise.all([
      supabase.from('user_xp_state').select('*').eq('wallet_address', wallet).maybeSingle(),
      supabase.from('quests').select('*').eq('active', true).order('sort_order'),
      supabase.from('user_quest_progress').select('*').eq('wallet_address', wallet).eq('day', today),
      supabase.from('badges').select('*').order('sort_order'),
      supabase.from('user_badges').select('badge_code, unlocked_at').eq('wallet_address', wallet),
      supabase
        .from('reading_events')
        .select('*', { count: 'exact', head: true })
        .eq('wallet_address', wallet)
        .gt('xp_awarded', 0),
    ]);

    const state = stateRes.data ?? {
      xp: 0,
      level: 1,
      current_streak: 0,
      longest_streak: 0,
      last_active_day: null,
    };
    const uqpByCode = new Map((uqpRes.data ?? []).map((r) => [r.quest_code, r]));
    const quests = (questsRes.data ?? []).map((q) => {
      const p = uqpByCode.get(q.code);
      return {
        code: q.code,
        title: q.title,
        description: q.description,
        target: q.target,
        xp_reward: q.xp_reward,
        progress: p?.progress ?? 0,
        completed: p?.completed ?? false,
      };
    });
    const unlocked = new Map((ubadgesRes.data ?? []).map((r) => [r.badge_code, r.unlocked_at]));
    const badges = (badgesRes.data ?? []).map((b) => ({
      code: b.code,
      title: b.title,
      description: b.description,
      icon: b.icon,
      tier: b.tier,
      unlocked: unlocked.has(b.code),
      unlocked_at: unlocked.get(b.code) ?? null,
    }));

    return jsonResponse(
      200,
      {
        xp: Number(state.xp ?? 0),
        // Lifetime xp keeps driving level and badges; xp_spent is what has been
        // committed to swaps, so the swappable balance is the difference.
        xp_spent: Number((state as { xp_spent?: number }).xp_spent ?? 0),
        level: Number(state.level ?? 1),
        current_streak: Number(state.current_streak ?? 0),
        longest_streak: Number(state.longest_streak ?? 0),
        chapters_total: chaptersRes.count ?? 0,
        quests,
        badges,
      },
      cors,
    );
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? e.message : 'Read failed.' }, cors);
  }
});
