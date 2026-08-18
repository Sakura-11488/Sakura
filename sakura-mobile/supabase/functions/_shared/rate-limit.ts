import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSec?: number;
};

/**
 * Per-bucket rate limiting, counted atomically in Postgres.
 *
 * The previous implementation read `hits`, decided, then wrote `hits + 1` as
 * three separate statements. Concurrent requests all read the same value before
 * any of them wrote, so N simultaneous requests cost **one** hit. Measured
 * against production before the fix: **40 requests fired at once all passed a
 * 12/minute limit** — a 28-request overshoot. On a wallet's very first burst it
 * was worse still, because every request took the insert branch and the
 * primary-key collisions were swallowed as warnings.
 *
 * That mattered more than a tidy-up: the whole premise of the AI gate was that
 * `GROQ_API_KEY` had been effectively public, and a limiter a burst walks
 * straight past is not a limiter.
 *
 * `bump_rate_bucket` does it in one `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * statement. The row lock serialises concurrent bumps and the returned count is
 * this request's own position in the window.
 */
export async function checkRateLimit(
  supabase: SupabaseClient,
  bucket: string,
  maxHits: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { data, error } = await supabase.rpc('bump_rate_bucket', {
    p_bucket: bucket,
    p_max_hits: maxHits,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    // Fail CLOSED. The old code returned `allowed: true` on any read error,
    // which turns a database blip into an open door on the one control standing
    // between a public anon key and a metered vendor bill. Closing costs
    // nothing in practice: every caller needs the same database a moment later
    // for entitlement or its own writes, so a genuine outage fails the request
    // regardless — this only changes *which* error the user sees.
    console.error('[rate-limit] bump failed, refusing:', error.message);
    return { allowed: false, retryAfterSec: 5 };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== 'boolean') {
    console.error('[rate-limit] unexpected shape from bump_rate_bucket:', JSON.stringify(row));
    return { allowed: false, retryAfterSec: 5 };
  }

  return {
    allowed: row.allowed,
    retryAfterSec: Number(row.retry_after_sec ?? 0) || undefined,
  };
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  return forwarded || cf || 'unknown';
}
