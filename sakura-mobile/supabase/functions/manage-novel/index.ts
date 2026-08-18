import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

/**
 * The write path for `novels` and `novel_chapters`.
 *
 * Until now there wasn't one. Nothing in the codebase wrote either table — the
 * three rows that exist were inserted by hand, and the one novel actually
 * readable in the app (`humour-me`) is a hardcoded object literal in
 * `lib/sakura-novels.ts`, cover URL and all. Meanwhile both tables were
 * `FOR ALL TO public USING (true)`, so the paywall columns — price_per_chapter,
 * paid_from_chapter, free_until_chapter — were editable by anyone holding the
 * anon key, and novel_unlocks was INSERT-open, meaning a free unlock was one
 * POST away.
 *
 * Those policies are now service_role only, which is what makes this function
 * necessary rather than merely nice.
 *
 * The security property is ownership: every mutating branch loads the novel
 * first and refuses unless `creator_wallet` equals the wallet that signed the
 * request. `creator_wallet` is never read from the body — on create it is set
 * from the signature, and on update it is not writable at all, so a novel
 * cannot be reassigned to someone else.
 *
 * Cover URLs are fetched and checked before they are stored. That is not
 * belt-and-braces: the existing "Heroes Of The Sky" row has a
 * `https://share.google/...` link, which returns 200 with `text/html`. It can
 * never render as a cover, and nothing told anyone. Prefer an upload through
 * `upload-work-media` with role `cover` (public bucket `creator-covers`); a
 * direct URL is accepted but must actually serve an image.
 */

const cors = corsHeaders();

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 4000;
const MAX_CHAPTER_TITLE = 200;
const MAX_CHAPTER_CONTENT = 200_000;
const MAX_GENRES = 8;
const MAX_GENRE_LEN = 32;
/** The reader resolves /novel/ext?path=<slug>, so a slug is the novel's public
 *  address. Derived from the title unless one is given; uniqueness is enforced
 *  by a unique index on lower(slug), which is what settles two creators
 *  publishing the same title at the same moment. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const VALID_STATUS = new Set(['ongoing', 'completed', 'hiatus']);

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    // Keep newlines and tabs — chapter prose needs them. Drop the rest of the
    // control range plus invisible/bidi formatting.
    const isControl = (c < 0x20 && c !== 0x0a && c !== 0x09) || (c >= 0x7f && c <= 0x9f);
    const isInvisible =
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff;
    if (!isControl && !isInvisible) out += ch;
  }
  return out.trim().slice(0, max);
}

function intOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * A cover has to actually be an image.
 *
 * HEAD first because it is cheap; some hosts do not implement it, so fall back
 * to a ranged GET rather than rejecting a perfectly good image. Anything that
 * is not `image/*` is refused with the content type it really returned, so the
 * person pasting a share link is told what is wrong instead of discovering a
 * blank cover later.
 */
async function validateCoverUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Cover must be a full URL, or upload an image instead.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Cover URL must be https.' };
  }

  const check = async (method: 'HEAD' | 'GET') => {
    const res = await fetch(parsed.toString(), {
      method,
      redirect: 'follow',
      headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, type: res.headers.get('content-type') ?? '' };
  };

  let result: { status: number; type: string };
  try {
    result = await check('HEAD');
    if (result.status >= 400 || !result.type) result = await check('GET');
  } catch {
    return { ok: false, error: "Couldn't reach that cover URL." };
  }

  if (result.status >= 400) {
    return { ok: false, error: `Cover URL returned ${result.status}.` };
  }
  if (!result.type.toLowerCase().startsWith('image/')) {
    return {
      ok: false,
      error: `That link is ${result.type.split(';')[0] || 'not an image'}, not an image. Use the image address, or upload the file.`,
    };
  }
  return { ok: true };
}

/** Loads a novel and refuses unless the signer owns it. */
async function ownedNovel(
  supabase: SupabaseClient,
  novelId: string,
  wallet: string,
): Promise<{ ok: true; novel: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const { data, error } = await supabase
    .from('novels')
    .select('id, creator_wallet, title')
    .eq('id', novelId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: 'Could not load that novel.' };
  if (!data) return { ok: false, status: 404, error: 'No such novel.' };
  if (data.creator_wallet !== wallet) {
    return { ok: false, status: 403, error: 'That novel belongs to someone else.' };
  }
  return { ok: true, novel: data as Record<string, unknown> };
}

/** Fields a creator may set on their own novel. creator_wallet is NOT here. */
async function novelPatch(
  body: Record<string, unknown>,
): Promise<{ ok: true; patch: Record<string, unknown> } | { ok: false; error: string }> {
  const patch: Record<string, unknown> = {};

  if ('title' in body) {
    const title = clean(body.title, MAX_TITLE);
    if (!title) return { ok: false, error: 'A title is required.' };
    patch.title = title;
  }
  if ('description' in body) patch.description = clean(body.description, MAX_DESCRIPTION);

  if ('cover_url' in body) {
    const cover = clean(body.cover_url, 600);
    if (cover) {
      const check = await validateCoverUrl(cover);
      if (!check.ok) return { ok: false, error: check.error };
      patch.cover_url = cover;
    } else {
      patch.cover_url = '';
    }
  }

  if ('genres' in body) {
    const raw = Array.isArray(body.genres) ? body.genres : [];
    patch.genres = raw
      .map((g) => clean(g, MAX_GENRE_LEN))
      .filter(Boolean)
      .slice(0, MAX_GENRES);
  }

  if ('status' in body) {
    const status = clean(body.status, 20).toLowerCase();
    if (!VALID_STATUS.has(status)) {
      return { ok: false, error: `Status must be one of: ${[...VALID_STATUS].join(', ')}.` };
    }
    patch.status = status;
  }

  if ('language' in body) patch.language = clean(body.language, 8) || 'en';
  if ('published' in body) patch.published = body.published === true;
  if ('allow_pass' in body) patch.allow_pass = body.allow_pass !== false;

  // ── Paywall ─────────────────────────────────────────────────────────────
  // Validated together because they only make sense together: a paid_from at or
  // below free_until means the "free" chapters are charged for, which is the
  // kind of thing you only notice from a refund request.
  const free = 'free_until_chapter' in body ? intOrNull(body.free_until_chapter) : undefined;
  const paid = 'paid_from_chapter' in body ? intOrNull(body.paid_from_chapter) : undefined;

  if (free !== undefined) {
    if (free === null || free < 0) return { ok: false, error: 'free_until_chapter must be 0 or more.' };
    patch.free_until_chapter = free;
  }
  if (paid !== undefined) {
    if (paid === null || paid < 1) return { ok: false, error: 'paid_from_chapter must be 1 or more.' };
    patch.paid_from_chapter = paid;
  }
  if (free !== undefined && paid !== undefined && paid <= free) {
    return { ok: false, error: 'paid_from_chapter must be greater than free_until_chapter.' };
  }

  if ('price_per_chapter' in body) {
    const price = typeof body.price_per_chapter === 'number'
      ? body.price_per_chapter
      : Number(body.price_per_chapter);
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: 'price_per_chapter must be 0 or more.' };
    }
    patch.price_per_chapter = price;
  }

  return { ok: true, patch };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  let wallet: string;
  try {
    wallet = verifyWalletHeaders(req.headers, 'manage-novel').walletAddress;
  } catch {
    return jsonResponse(401, { error: 'Could not verify your wallet.' }, cors);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const rl = await checkRateLimit(supabase, `manage-novel:${wallet}`, 30, 60);
    if (!rl.allowed) {
      return jsonResponse(429, { error: 'Slow down.', retryAfterSec: rl.retryAfterSec }, cors);
    }

    // ── Read your own catalogue, drafts included ────────────────────────────
    if (action === 'list_mine') {
      const { data, error } = await supabase
        .from('novels')
        .select('*')
        .eq('creator_wallet', wallet)
        .order('created_at', { ascending: false });
      if (error) return jsonResponse(500, { error: 'Could not load your novels.' }, cors);
      return jsonResponse(200, { ok: true, novels: data ?? [] }, cors);
    }

    if (action === 'create') {
      const built = await novelPatch(body);
      if (!built.ok) return jsonResponse(400, { error: built.error }, cors);
      if (!built.patch.title) return jsonResponse(400, { error: 'A title is required.' }, cors);

      const requestedSlug = clean(body.slug, 80);
      const slug = slugify(requestedSlug || String(built.patch.title ?? ''));
      if (!slug) return jsonResponse(400, { error: 'Could not derive a URL from that title.' }, cors);

      const { data, error } = await supabase
        .from('novels')
        .insert({
          ...built.patch,
          slug,
          creator_wallet: wallet, // from the signature, never the body
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();
      if (error) {
        // 23505 is the unique index on lower(slug) doing its job.
        if ((error as { code?: string }).code === '23505') {
          return jsonResponse(409, {
            error: 'A novel with that name already exists. Pick a different title or set a slug.',
          }, cors);
        }
        console.error('[manage-novel] create failed', error.message);
        return jsonResponse(500, { error: 'Could not create that novel.' }, cors);
      }
      return jsonResponse(200, { ok: true, novel: data }, cors);
    }

    const novelId = typeof body.novel_id === 'string' ? body.novel_id : '';

    if (action === 'update') {
      if (!novelId) return jsonResponse(400, { error: 'novel_id is required.' }, cors);
      const owned = await ownedNovel(supabase, novelId, wallet);
      if (!owned.ok) return jsonResponse(owned.status, { error: owned.error }, cors);

      const built = await novelPatch(body);
      if (!built.ok) return jsonResponse(400, { error: built.error }, cors);

      const { data, error } = await supabase
        .from('novels')
        .update({ ...built.patch, updated_at: new Date().toISOString() })
        .eq('id', novelId)
        .select('*')
        .single();
      if (error) {
        console.error('[manage-novel] update failed', error.message);
        return jsonResponse(500, { error: 'Could not save that novel.' }, cors);
      }
      return jsonResponse(200, { ok: true, novel: data }, cors);
    }

    if (action === 'upsert_chapter') {
      if (!novelId) return jsonResponse(400, { error: 'novel_id is required.' }, cors);
      const owned = await ownedNovel(supabase, novelId, wallet);
      if (!owned.ok) return jsonResponse(owned.status, { error: owned.error }, cors);

      const number = intOrNull(body.chapter_number);
      if (number === null || number < 1) {
        return jsonResponse(400, { error: 'chapter_number must be 1 or more.' }, cors);
      }
      const content = clean(body.content, MAX_CHAPTER_CONTENT);
      const row = {
        novel_id: novelId,
        chapter_number: number,
        title: clean(body.title, MAX_CHAPTER_TITLE),
        content,
        word_count: wordCount(content), // computed here; a client-supplied count is just a claim
        is_free_override: body.is_free_override === true,
        published: body.published === true,
        release_time:
          typeof body.release_time === 'string' && body.release_time ? body.release_time : null,
      };

      // No unique constraint on (novel_id, chapter_number), so upsert by hand.
      const { data: existing } = await supabase
        .from('novel_chapters')
        .select('id')
        .eq('novel_id', novelId)
        .eq('chapter_number', number)
        .maybeSingle();

      const q = existing
        ? supabase.from('novel_chapters').update(row).eq('id', existing.id)
        : supabase.from('novel_chapters').insert(row);

      const { data, error } = await q.select('*').single();
      if (error) {
        console.error('[manage-novel] chapter write failed', error.message);
        return jsonResponse(500, { error: 'Could not save that chapter.' }, cors);
      }
      return jsonResponse(200, { ok: true, chapter: data, created: !existing }, cors);
    }

    if (action === 'delete_chapter') {
      if (!novelId) return jsonResponse(400, { error: 'novel_id is required.' }, cors);
      const owned = await ownedNovel(supabase, novelId, wallet);
      if (!owned.ok) return jsonResponse(owned.status, { error: owned.error }, cors);

      const number = intOrNull(body.chapter_number);
      if (number === null) return jsonResponse(400, { error: 'chapter_number is required.' }, cors);

      const { error, count } = await supabase
        .from('novel_chapters')
        .delete({ count: 'exact' })
        .eq('novel_id', novelId)
        .eq('chapter_number', number);
      if (error) return jsonResponse(500, { error: 'Could not delete that chapter.' }, cors);
      return jsonResponse(200, { ok: true, deleted: count ?? 0 }, cors);
    }

    return jsonResponse(400, {
      error: 'Unknown action. Use create, update, upsert_chapter, delete_chapter or list_mine.',
    }, cors);
  } catch (e) {
    console.error('[manage-novel] request failed', e instanceof Error ? e.message : e);
    return jsonResponse(500, { error: 'Could not process that request.' }, cors);
  }
});
