import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

/**
 * The write path for `creator_works` and `work_releases`.
 *
 * WHY THIS EXISTS. Until now there wasn't one. `lib/creator.ts` inserted both
 * tables straight from the client with the anon key, taking `creator_wallet`
 * from a function *argument* rather than from a signature — while the tables
 * carried `creator_works_public_insert` / `work_releases_public_insert`, both
 * `WITH CHECK (true)` for every role. So anyone holding the anon key (it ships
 * in the web bundle) could insert a work attributed to any wallet they liked.
 *
 * That was survivable while a work was only a shelf listing. It stops being
 * survivable the moment published works gate a creator coin: forging a work
 * under someone else's wallet forges the eligibility to launch a token as them.
 * `20260818000000_lock_writable_tables.sql:120-125` already listed both INSERTs
 * as knowingly open; this is the function that lets them be closed.
 *
 * THE SECURITY PROPERTY is the same one `manage-novel` states: `creator_wallet`
 * is never read from the body. On create it is set from the verified signature,
 * and there is no update branch here at all, so a work cannot be reassigned.
 * Releases inherit ownership by loading the parent work and refusing unless it
 * belongs to the signer — the same check `publish-creator-work` already makes.
 *
 * NOT FIXED HERE, and it is a separate live leak: `creator_works_public_read`
 * and `work_releases_public_read` are `USING (true)`, so every draft and private
 * row — including `work_releases.body_text`, which stores novel prose inline —
 * is readable by anyone with the anon key. Closing that requires moving the two
 * dashboard reads (`getCreatorWorks`, `getWorkReleases`) behind a signed
 * function too, because wallets are not Supabase auth users and RLS cannot
 * express "my own drafts" for `anon`. Deliberately left for its own change
 * rather than folded into a migration that would silently break the dashboard.
 */

const cors = corsHeaders();

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 4000;
const MAX_SUMMARY = 2000;
/** Matches manage-novel's chapter ceiling; body_text holds novel prose inline. */
const MAX_BODY = 200_000;
const MAX_GENRES = 8;
const MAX_GENRE_LEN = 32;

const VALID_KINDS = new Set(['novel', 'manga', 'anime']);
const VALID_SERIES_STATUS = new Set(['ongoing', 'completed', 'hiatus']);

/**
 * Strip control characters and clamp. Copied in spirit from manage-novel's
 * `clean` — a title is rendered in a lot of places and none of them want a
 * bidi override or a NUL.
 */
function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    // C0/C1 controls, and the bidi overrides that let a title render as
    // something other than what is stored.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e)) continue;
    out += ch;
    if (out.length >= max) break;
  }
  return out.trim();
}

/**
 * The reader resolves a work by slug, so it is the work's public address. The
 * random suffix is what stops two creators publishing the same title at the
 * same moment from colliding — mirrors `slugify` in lib/creator.ts:80.
 */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${base || 'work'}-${suffix}`;
}

function contentTypeForKind(kind: string): string {
  if (kind === 'manga') return 'manga_chapter';
  if (kind === 'anime') return 'anime_episode';
  return 'novel_chapter';
}

type Body = {
  action?: 'create_work' | 'create_release';
  // create_work
  kind?: string;
  title?: string;
  description?: string;
  genres?: unknown;
  series_status?: string;
  // create_release
  work_id?: string;
  summary?: string;
  body_text?: string;
  sequence_number?: number;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  let walletAddress: string;
  try {
    ({ walletAddress } = verifyWalletHeaders(req.headers, 'creator-manage-work'));
  } catch (e) {
    // Auth failures alone are 401. Everything below is 4xx/5xx on its own
    // terms, so a database error is never reported as a signature problem.
    return jsonResponse(401, { error: e instanceof Error ? e.message : 'Unauthorized.' }, cors);
  }

  try {
    const body = (await req.json()) as Body;
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const limit = await checkRateLimit(supabase, `creator-manage-work:${walletAddress}`, 60, 3600);
    if (!limit.allowed) {
      return jsonResponse(429, { error: 'Too many requests. Try again shortly.' }, cors);
    }

    // ── create a work ────────────────────────────────────────────────────────
    if (body.action === 'create_work') {
      const kind = typeof body.kind === 'string' ? body.kind : '';
      if (!VALID_KINDS.has(kind)) {
        return jsonResponse(400, { error: 'kind must be novel, manga, or anime.' }, cors);
      }
      const title = clean(body.title, MAX_TITLE);
      if (!title) return jsonResponse(400, { error: 'Title is required.' }, cors);

      const seriesStatus =
        typeof body.series_status === 'string' && VALID_SERIES_STATUS.has(body.series_status)
          ? body.series_status
          : 'ongoing';

      const genres = Array.isArray(body.genres)
        ? body.genres
            .map((g) => clean(g, MAX_GENRE_LEN))
            .filter((g) => g.length > 0)
            .slice(0, MAX_GENRES)
        : [];

      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('creator_works')
        .insert({
          // From the signature. Never from the body — this is the whole point
          // of the function.
          creator_wallet: walletAddress,
          kind,
          title,
          slug: slugify(title),
          description: clean(body.description, MAX_DESCRIPTION),
          genres: genres.length ? genres : ['General'],
          language: 'en',
          series_status: seriesStatus,
          publication_status: 'draft',
          visibility: 'private',
          minting_enabled: false,
          release_metadata: {},
          created_at: now,
          updated_at: now,
        })
        .select('*')
        .single();
      if (error) return jsonResponse(500, { error: error.message }, cors);
      return jsonResponse(200, { ok: true, work: data }, cors);
    }

    // ── create a release under a work you own ────────────────────────────────
    if (body.action === 'create_release') {
      if (!body.work_id) return jsonResponse(400, { error: 'work_id is required.' }, cors);
      const title = clean(body.title, MAX_TITLE);
      if (!title) return jsonResponse(400, { error: 'Release title is required.' }, cors);

      const { data: work, error: workErr } = await supabase
        .from('creator_works')
        .select('id, creator_wallet, kind')
        .eq('id', body.work_id)
        .maybeSingle();
      if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
      if (!work) return jsonResponse(404, { error: 'Work not found.' }, cors);
      // Ownership is inherited from the parent, exactly as publish-creator-work
      // checks it. A release cannot be attached to somebody else's work.
      if (work.creator_wallet !== walletAddress) {
        return jsonResponse(403, { error: 'Not your work.' }, cors);
      }

      // A client-supplied sequence is accepted (the upload screen computes one)
      // but must be a sane positive integer — the column is used for ordering
      // and a negative or fractional value sorts a chapter somewhere nobody
      // asked for. Collisions are left to UNIQUE (work_id, sequence_number).
      let sequence =
        typeof body.sequence_number === 'number' &&
        Number.isInteger(body.sequence_number) &&
        body.sequence_number > 0 &&
        body.sequence_number <= 100_000
          ? body.sequence_number
          : null;
      if (sequence == null) {
        const { count, error: countErr } = await supabase
          .from('work_releases')
          .select('*', { count: 'exact', head: true })
          .eq('work_id', body.work_id);
        if (countErr) return jsonResponse(500, { error: countErr.message }, cors);
        sequence = (count ?? 0) + 1;
      }

      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('work_releases')
        .insert({
          work_id: body.work_id,
          sequence_number: sequence,
          title,
          summary: clean(body.summary, MAX_SUMMARY),
          content_type: contentTypeForKind(work.kind),
          publication_status: 'draft',
          visibility: 'private',
          body_text: clean(body.body_text, MAX_BODY),
          release_metadata: {},
          created_at: now,
          updated_at: now,
        })
        .select('*')
        .single();
      if (error) {
        // UNIQUE (work_id, sequence_number) — two chapters submitted at once.
        if (String(error.message).includes('duplicate key')) {
          return jsonResponse(409, { error: 'That chapter number already exists.' }, cors);
        }
        return jsonResponse(500, { error: error.message }, cors);
      }
      return jsonResponse(200, { ok: true, release: data }, cors);
    }

    return jsonResponse(400, { error: 'action must be create_work or create_release.' }, cors);
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? e.message : 'Request failed.' }, cors);
  }
});
