import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSec?: number;
};

export async function checkRateLimit(
  supabase: SupabaseClient,
  bucket: string,
  maxHits: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  const { data: row, error: readErr } = await supabase
    .from('api_rate_buckets')
    .select('hits, window_start')
    .eq('bucket', bucket)
    .maybeSingle();

  if (readErr) {
    console.error('rate-limit read failed', readErr.message);
    return { allowed: true };
  }

  if (!row) {
    const { error: insertErr } = await supabase.from('api_rate_buckets').insert({
      bucket,
      hits: 1,
      window_start: new Date(now).toISOString(),
    });
    if (insertErr) console.error('rate-limit insert failed', insertErr.message);
    return { allowed: true };
  }

  const windowStart = new Date(row.window_start as string).getTime();
  const elapsed = now - windowStart;

  if (elapsed >= windowMs) {
    const { error: resetErr } = await supabase
      .from('api_rate_buckets')
      .update({ hits: 1, window_start: new Date(now).toISOString() })
      .eq('bucket', bucket);
    if (resetErr) console.error('rate-limit reset failed', resetErr.message);
    return { allowed: true };
  }

  const hits = (row.hits as number) ?? 0;
  if (hits >= maxHits) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
    return { allowed: false, retryAfterSec };
  }

  const { error: bumpErr } = await supabase
    .from('api_rate_buckets')
    .update({ hits: hits + 1 })
    .eq('bucket', bucket);
  if (bumpErr) console.error('rate-limit bump failed', bumpErr.message);

  return { allowed: true };
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  return forwarded || cf || 'unknown';
}
