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
 * READING YOUR OWN DRAFTS also lives here, for the same reason. The SELECT
 * policies on both tables used to be `USING (true)`, so every draft was
 * readable with the anon key — including `work_releases.body_text`, which
 * stores novel prose inline. RLS cannot express "my own drafts" for `anon`,
 * because wallets are not Supabase auth users and there is no session to key
 * on. So the policies now expose only published rows, and the owner-scoped
 * reads come through `list_works` / `list_releases` under a signature.
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
  action?: 'create_work' | 'create_release' | 'update_work' | 'update_release' | 'list_works' | 'list_releases' | 'list_assets' | 'discard_draft';
  // create_work
  kind?: string;
  title?: string;
  description?: string;
  price_sakura?: number;
  genres?: unknown;
  series_status?: string;
  // create_release
  work_id?: string;
  release_id?: string;
  summary?: string;
  body_text?: string;
  sequence_number?: number;
  expected_page_count?: number;
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
      const { data: creator, error: creatorErr } = await supabase.from('sakura_usernames')
        .select('wallet_address').eq('wallet_address', walletAddress).maybeSingle();
      if (creatorErr) return jsonResponse(500, { error: creatorErr.message }, cors);
      if (!creator) return jsonResponse(403, { error: 'Claim a creator username before publishing.' }, cors);
      const kind = typeof body.kind === 'string' ? body.kind : '';
      if (!VALID_KINDS.has(kind)) {
        return jsonResponse(400, { error: 'kind must be novel, manga, or anime.' }, cors);
      }
      const title = clean(body.title, MAX_TITLE);
      if (!title) return jsonResponse(400, { error: 'Title is required.' }, cors);
      const price = body.price_sakura ?? 0;
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 ||
        price > 1_000_000_000 || Math.round(price * 1_000_000) !== price * 1_000_000) {
        return jsonResponse(400, { error: 'Enter a valid SAKURA price with up to six decimal places.' }, cors);
      }

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
          price_sakura: price,
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
        .select('id, creator_wallet, kind, publication_status')
        .eq('id', body.work_id)
        .maybeSingle();
      if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
      if (!work) return jsonResponse(404, { error: 'Work not found.' }, cors);
      // Ownership is inherited from the parent, exactly as publish-creator-work
      // checks it. A release cannot be attached to somebody else's work.
      if (work.creator_wallet !== walletAddress) {
        return jsonResponse(403, { error: 'Not your work.' }, cors);
      }
      if (!['draft', 'published'].includes(work.publication_status)) {
        return jsonResponse(409, { error: 'This series cannot accept new chapters.' }, cors);
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
      const expectedPageCount =
        work.kind === 'manga' && Number.isInteger(body.expected_page_count) &&
        (body.expected_page_count ?? 0) >= 1 && (body.expected_page_count ?? 0) <= 60
          ? body.expected_page_count
          : null;
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
          release_metadata: expectedPageCount ? { expected_page_count: expectedPageCount } : {},
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

    if (body.action === 'update_work') {
      if (!body.work_id) return jsonResponse(400, { error: 'work_id is required.' }, cors);
      const title = clean(body.title, MAX_TITLE);
      if (!title) return jsonResponse(400, { error: 'Title is required.' }, cors);
      const { data, error } = await supabase.from('creator_works')
        .update({ title, description: clean(body.description, MAX_DESCRIPTION), updated_at: new Date().toISOString() })
        .eq('id', body.work_id).eq('creator_wallet', walletAddress)
        .eq('publication_status', 'draft').select('*').maybeSingle();
      if (error) return jsonResponse(500, { error: error.message }, cors);
      if (!data) return jsonResponse(403, { error: 'Draft work not found for this wallet.' }, cors);
      return jsonResponse(200, { ok: true, work: data }, cors);
    }

    if (body.action === 'update_release') {
      if (!body.work_id || !body.release_id) {
        return jsonResponse(400, { error: 'work_id and release_id are required.' }, cors);
      }
      const { data: work, error: workErr } = await supabase.from('creator_works')
        .select('id, creator_wallet, kind, publication_status').eq('id', body.work_id).maybeSingle();
      if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
      if (!work || work.creator_wallet !== walletAddress ||
        !['draft', 'published'].includes(work.publication_status)) {
        return jsonResponse(403, { error: 'Work not found for this wallet.' }, cors);
      }
      const title = clean(body.title, MAX_TITLE);
      if (!title) return jsonResponse(400, { error: 'Release title is required.' }, cors);
      const { data: release, error: releaseErr } = await supabase.from('work_releases')
        .select('id, release_metadata').eq('id', body.release_id)
        .eq('work_id', body.work_id).eq('publication_status', 'draft').maybeSingle();
      if (releaseErr) return jsonResponse(500, { error: releaseErr.message }, cors);
      if (!release) return jsonResponse(404, { error: 'Draft release not found.' }, cors);
      const metadata = { ...(release.release_metadata ?? {}) };
      if (work.kind === 'manga' && Number.isInteger(body.expected_page_count) &&
        (body.expected_page_count ?? 0) >= 1 && (body.expected_page_count ?? 0) <= 60) {
        metadata.expected_page_count = body.expected_page_count;
      }
      const { data, error } = await supabase.from('work_releases')
        .update({ title, summary: clean(body.summary, MAX_SUMMARY),
          body_text: clean(body.body_text, MAX_BODY), release_metadata: metadata,
          updated_at: new Date().toISOString() })
        .eq('id', body.release_id).eq('work_id', body.work_id)
        .eq('publication_status', 'draft').select('*').maybeSingle();
      if (error) return jsonResponse(500, { error: error.message }, cors);
      if (!data) return jsonResponse(409, { error: 'Release is no longer a draft.' }, cors);
      return jsonResponse(200, { ok: true, release: data }, cors);
    }

    // ── read your own works, drafts included ─────────────────────────────────
    if (body.action === 'list_works') {
      const { data, error } = await supabase
        .from('creator_works')
        .select('*')
        .eq('creator_wallet', walletAddress)
        .order('updated_at', { ascending: false });
      if (error) return jsonResponse(500, { error: error.message }, cors);
      return jsonResponse(200, { ok: true, works: data ?? [] }, cors);
    }

    if (body.action === 'list_releases') {
      if (!body.work_id) return jsonResponse(400, { error: 'work_id is required.' }, cors);
      // Ownership is checked on the parent before any release is returned —
      // otherwise this would be the same leak with extra steps.
      const { data: work, error: workErr } = await supabase
        .from('creator_works')
        .select('id, creator_wallet')
        .eq('id', body.work_id)
        .maybeSingle();
      if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
      if (!work) return jsonResponse(404, { error: 'Work not found.' }, cors);
      if (work.creator_wallet !== walletAddress) {
        return jsonResponse(403, { error: 'Not your work.' }, cors);
      }
      const { data, error } = await supabase
        .from('work_releases')
        .select('*')
        .eq('work_id', body.work_id)
        .order('sequence_number', { ascending: true });
      if (error) return jsonResponse(500, { error: error.message }, cors);
      return jsonResponse(200, { ok: true, releases: data ?? [] }, cors);
    }

    if (body.action === 'list_assets') {
      if (!body.work_id) return jsonResponse(400, { error: 'work_id is required.' }, cors);
      const { data: work, error: workErr } = await supabase.from('creator_works')
        .select('id, creator_wallet').eq('id', body.work_id).maybeSingle();
      if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
      if (!work || work.creator_wallet !== walletAddress) {
        return jsonResponse(403, { error: 'Not your work.' }, cors);
      }
      const { data, error } = await supabase.from('work_assets')
        .select('release_id, role, sort_order, asset_files(status, original_filename, size_bytes)')
        .eq('work_id', body.work_id);
      if (error) return jsonResponse(500, { error: error.message }, cors);
      return jsonResponse(200, { ok: true, assets: data ?? [] }, cors);
    }

    if (body.action === 'discard_draft') {
      if (!body.work_id) return jsonResponse(400, { error: 'work_id is required.' }, cors);
      const { data: work, error: workErr } = await supabase.from('creator_works')
        .select('id, creator_wallet, publication_status').eq('id', body.work_id).maybeSingle();
      if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
      if (!work || work.creator_wallet !== walletAddress || work.publication_status !== 'draft') {
        return jsonResponse(403, { error: 'Draft work not found for this wallet.' }, cors);
      }
      const { count: mintCount, error: mintErr } = await supabase.from('work_mints')
        .select('*', { count: 'exact', head: true }).eq('work_id', body.work_id);
      if (mintErr) return jsonResponse(500, { error: mintErr.message }, cors);
      if (mintCount) return jsonResponse(409, { error: 'This draft has an on-chain record and cannot be discarded.' }, cors);
      const { data: links, error: linksErr } = await supabase.from('work_assets')
        .select('asset_file_id, asset_files(storage_provider, bucket, object_path)')
        .eq('work_id', body.work_id);
      if (linksErr) return jsonResponse(500, { error: linksErr.message }, cors);
      const { data: deleted, error: deleteErr } = await supabase.from('creator_works')
        .delete().eq('id', body.work_id).eq('creator_wallet', walletAddress)
        .eq('publication_status', 'draft').select('id').maybeSingle();
      if (deleteErr) return jsonResponse(500, { error: deleteErr.message }, cors);
      if (!deleted) return jsonResponse(409, { error: 'Draft changed while discarding it.' }, cors);
      const assetIds = [...new Set((links ?? []).map((link) => link.asset_file_id))];
      if (assetIds.length) {
        const { data: otherLinks, error: otherErr } = await supabase.from('work_assets')
          .select('asset_file_id').in('asset_file_id', assetIds);
        if (otherErr) console.error('[manage-creator-work] asset reference check failed:', otherErr);
        const retained = new Set((otherLinks ?? []).map((link) => link.asset_file_id));
        const removable = otherErr ? [] : assetIds.filter((id) => !retained.has(id));
        if (removable.length) {
          const { error: assetErr } = await supabase.from('asset_files').delete().in('id', removable);
          if (assetErr) console.error('[manage-creator-work] asset cleanup failed:', assetErr);
        }
        for (const link of links ?? []) {
          const file = link.asset_files;
          if (removable.includes(link.asset_file_id) && file?.storage_provider === 'supabase') {
            const { error: storageErr } = await supabase.storage.from(file.bucket).remove([file.object_path]);
            if (storageErr) console.error('[manage-creator-work] storage cleanup failed:', storageErr);
          }
        }
      }
      return jsonResponse(200, { ok: true, discarded: true }, cors);
    }

    return jsonResponse(400, {
      error: 'Unknown creator-work action.',
    }, cors);
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? e.message : 'Request failed.' }, cors);
  }
});
