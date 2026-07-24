import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { xpToLevel } from '../_shared/xp.ts';

/**
 * Trusted reading-event ingest + server-authoritative XP / streaks / quests /
 * badges. The client posts a batch of local reading deltas; this is the ONLY
 * place XP is awarded, and it never trusts client-reported XP — an event earns
 * XP only when it looks like a genuine read (completed or >=90% progress AND a
 * minimum dwell time). Per-chapter/day uniqueness + an idempotent ledger make
 * awards exactly-once, and day/time are server-set so streaks can't be backdated.
 */

const cors = corsHeaders();
const MIN_DWELL_MS = Number(Deno.env.get('READ_MIN_DWELL_MS') || '15000');
const XP_PER_CHAPTER = Number(Deno.env.get('READ_XP_PER_CHAPTER') || '50');
const MAX_XP_EVENTS_PER_DAY = Number(Deno.env.get('READ_MAX_XP_EVENTS_PER_DAY') || '50');

type InEvent = {
  kind?: string;
  content_id?: string;
  chapter_id?: string;
  series_id?: string;
  progress?: number;
  dwell_ms?: number;
  completed?: boolean;
  client_reported_at?: string;
};

function utcDay(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'reading-ingest');
    const body = (await req.json().catch(() => ({}))) as { events?: InEvent[] };
    const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const rl = await checkRateLimit(supabase, `read-ingest:${walletAddress}`, 120, 60);
    if (!rl.allowed) {
      return jsonResponse(429, { error: 'Slow down.', retryAfterSec: rl.retryAfterSec }, cors);
    }

    const today = utcDay();

    // Daily XP-eligible-event cap (count events that already earned XP today).
    const { count: awardedTodayCount } = await supabase
      .from('reading_events')
      .select('*', { count: 'exact', head: true })
      .eq('wallet_address', walletAddress)
      .eq('day', today)
      .gt('xp_awarded', 0);
    let remaining = Math.max(0, MAX_XP_EVENTS_PER_DAY - (awardedTodayCount ?? 0));

    let awardedXp = 0;
    let newEventsAwarded = 0;

    for (const ev of events) {
      const kind = String(ev.kind || '').trim();
      const contentId = String(ev.content_id || '').trim();
      const chapterId = String(ev.chapter_id || '').trim();
      if (!['manga', 'novel', 'anime'].includes(kind) || !contentId || !chapterId) continue;

      const progress = Number(ev.progress) || 0;
      const dwellMs = Number(ev.dwell_ms) || 0;
      const completed = ev.completed === true;
      const eligible = (completed || progress >= 0.9) && dwellMs >= MIN_DWELL_MS;
      const willAward = eligible && remaining > 0;
      const xp = willAward ? XP_PER_CHAPTER : 0;

      const { error: insErr } = await supabase.from('reading_events').insert({
        wallet_address: walletAddress,
        kind,
        content_id: contentId,
        chapter_id: chapterId,
        series_id: String(ev.series_id || contentId),
        progress,
        dwell_ms: dwellMs,
        completed,
        day: today,
        client_reported_at: ev.client_reported_at ?? null,
        xp_awarded: xp,
      });

      // Effective values after reconciling with any earlier visit today.
      let effProgress = progress;
      let effDwell = dwellMs;
      let effCompleted = completed;
      let alreadyAwarded = false;

      if (insErr) {
        // Unique(wallet,kind,content,chapter,day) violation: this chapter was
        // already touched today. Previously we dropped the event outright, so a
        // 3-second peek permanently burned the slot and the REAL read of that
        // chapter could never earn XP that day. Instead, merge the observations:
        // keep the furthest progress, accumulate reading time, and stay
        // completed once completed.
        const { data: prior } = await supabase
          .from('reading_events')
          .select('progress, dwell_ms, completed, xp_awarded')
          .eq('wallet_address', walletAddress)
          .eq('kind', kind)
          .eq('content_id', contentId)
          .eq('chapter_id', chapterId)
          .eq('day', today)
          .maybeSingle();
        if (!prior) continue; // not a duplicate — a genuine insert failure

        alreadyAwarded = Number(prior.xp_awarded) > 0;
        effProgress = Math.max(Number(prior.progress) || 0, progress);
        effDwell = (Number(prior.dwell_ms) || 0) + dwellMs;
        effCompleted = prior.completed === true || completed;

        await supabase
          .from('reading_events')
          .update({ progress: effProgress, dwell_ms: effDwell, completed: effCompleted })
          .eq('wallet_address', walletAddress)
          .eq('kind', kind)
          .eq('content_id', contentId)
          .eq('chapter_id', chapterId)
          .eq('day', today);
      }

      // Re-evaluate against the merged totals so a qualifying read still counts.
      const effEligible = (effCompleted || effProgress >= 0.9) && effDwell >= MIN_DWELL_MS;
      if (alreadyAwarded || !effEligible || remaining <= 0) continue;

      // xp_ledger's unique (wallet, ref_key) keeps this exactly-once even if two
      // batches race, so re-crediting a merged row can never double-pay.
      const refKey = `read:${kind}:${contentId}:${chapterId}:${today}`;
      const { error: ledgerErr } = await supabase.from('xp_ledger').insert({
        wallet_address: walletAddress,
        source: 'read_chapter',
        xp_delta: XP_PER_CHAPTER,
        ref_key: refKey,
      });
      if (!ledgerErr) {
        awardedXp += XP_PER_CHAPTER;
        newEventsAwarded += 1;
        remaining -= 1;
        if (insErr || xp === 0) {
          // The stored row didn't record the award yet (merged, or inserted
          // before it qualified) — keep xp_awarded truthful for the daily
          // chapter/series counts and the per-day cap.
          await supabase
            .from('reading_events')
            .update({ xp_awarded: XP_PER_CHAPTER })
            .eq('wallet_address', walletAddress)
            .eq('kind', kind)
            .eq('content_id', contentId)
            .eq('chapter_id', chapterId)
            .eq('day', today);
        }
      }
    }

    // ── Recompute XP / streak state ──
    const { data: prev } = await supabase
      .from('user_xp_state')
      .select('*')
      .eq('wallet_address', walletAddress)
      .maybeSingle();

    const activeToday = newEventsAwarded > 0 || (awardedTodayCount ?? 0) > 0;
    let currentStreak = prev?.current_streak ?? 0;
    let longestStreak = prev?.longest_streak ?? 0;
    let lastActive: string | null = prev?.last_active_day ?? null;

    if (activeToday && lastActive !== today) {
      if (lastActive === utcDay(-1)) currentStreak += 1;
      else currentStreak = 1;
      lastActive = today;
      longestStreak = Math.max(longestStreak, currentStreak);
    }

    const newXp = Number(prev?.xp ?? 0) + awardedXp;
    const level = xpToLevel(newXp);

    await supabase.from('user_xp_state').upsert(
      {
        wallet_address: walletAddress,
        xp: newXp,
        level,
        current_streak: currentStreak,
        longest_streak: longestStreak,
        last_active_day: lastActive,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'wallet_address' },
    );

    // ── Quests (today) ──
    const { data: dayEvents } = await supabase
      .from('reading_events')
      .select('series_id')
      .eq('wallet_address', walletAddress)
      .eq('day', today)
      .gt('xp_awarded', 0);
    const chaptersToday = dayEvents?.length ?? 0;
    const seriesToday = new Set((dayEvents ?? []).map((r) => r.series_id)).size;

    const { data: quests } = await supabase.from('quests').select('*').eq('active', true);
    for (const q of quests ?? []) {
      const progress = q.metric === 'series_touched' ? seriesToday : chaptersToday;
      const completed = progress >= q.target;
      await supabase.from('user_quest_progress').upsert(
        {
          wallet_address: walletAddress,
          quest_code: q.code,
          day: today,
          progress,
          target: q.target,
          completed,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'wallet_address,quest_code,day' },
      );
      if (completed && q.xp_reward > 0) {
        const refKey = `quest:${q.code}:${today}`;
        const { error: qErr } = await supabase.from('xp_ledger').insert({
          wallet_address: walletAddress,
          source: 'quest',
          xp_delta: q.xp_reward,
          ref_key: refKey,
        });
        if (!qErr) {
          // fold quest XP into state
          const bumped = newXp + q.xp_reward;
          await supabase
            .from('user_xp_state')
            .update({ xp: bumped, level: xpToLevel(bumped) })
            .eq('wallet_address', walletAddress);
        }
      }
    }

    // ── Badges (unlock on threshold) ──
    const { count: totalChapters } = await supabase
      .from('reading_events')
      .select('*', { count: 'exact', head: true })
      .eq('wallet_address', walletAddress)
      .gt('xp_awarded', 0);
    const { data: allSeries } = await supabase
      .from('reading_events')
      .select('series_id')
      .eq('wallet_address', walletAddress)
      .gt('xp_awarded', 0);
    const distinctSeries = new Set((allSeries ?? []).map((r) => r.series_id)).size;

    const { data: state } = await supabase
      .from('user_xp_state')
      .select('*')
      .eq('wallet_address', walletAddress)
      .maybeSingle();

    const { data: badges } = await supabase.from('badges').select('code, criteria');
    const unlocks: { wallet_address: string; badge_code: string }[] = [];
    for (const b of badges ?? []) {
      const c = (b.criteria ?? {}) as { chapters?: number; streak?: number; level?: number; series?: number };
      const ok =
        (c.chapters != null && (totalChapters ?? 0) >= c.chapters) ||
        (c.streak != null && (state?.current_streak ?? 0) >= c.streak) ||
        (c.level != null && (state?.level ?? 1) >= c.level) ||
        (c.series != null && distinctSeries >= c.series);
      if (ok) unlocks.push({ wallet_address: walletAddress, badge_code: b.code });
    }
    if (unlocks.length) {
      await supabase.from('user_badges').upsert(unlocks, { onConflict: 'wallet_address,badge_code' });
    }

    return jsonResponse(
      200,
      {
        ok: true,
        awarded_xp: awardedXp,
        xp: state?.xp ?? newXp,
        level: state?.level ?? level,
        current_streak: state?.current_streak ?? currentStreak,
        longest_streak: state?.longest_streak ?? longestStreak,
        chapters_today: chaptersToday,
      },
      cors,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Ingest failed.';
    const status = /wallet|signature|expired/i.test(message) ? 401 : 500;
    return jsonResponse(status, { error: message }, cors);
  }
});
