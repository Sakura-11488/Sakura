-- Closing the write-open tables that carry money, identity, or both.
--
-- Apply in the Supabase SQL editor, alone. Never `supabase db push`.
-- `upsert-profile` must be deployed first — it is now the only write path for
-- both user_profiles and sakura_usernames.
--
-- The shape throughout: reads stay public where the app genuinely reads them,
-- writes go to service_role, and the one legitimate user-facing write goes
-- through a signature-verified edge function.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- sakura_usernames (31 rows) — handle takeover
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A handle resolves /u/<name> and @mentions, so controlling someone's row
-- redirects their public profile. The unique index on lower(username) already
-- stopped anyone claiming a handle that was in use — but UPDATE was open to
-- anon, so the move was: rename the victim's row to free the name, then claim
-- it. Both halves are now service_role.
--
-- Claiming happens inside upsert-profile against the verified wallet. The client
-- keeps its availability check for a fast error message, but that check is no
-- longer the enforcement — the unique index settles races between two people who
-- both passed it a moment apart.

drop policy if exists "sakura_usernames_insert_anon" on public.sakura_usernames;
drop policy if exists "sakura_usernames_update_anon" on public.sakura_usernames;
drop policy if exists "sakura_usernames_delete_anon" on public.sakura_usernames;
drop policy if exists "sakura_usernames_public_read" on public.sakura_usernames;
drop policy if exists "svc_sakura_usernames"         on public.sakura_usernames;

create policy "sakura_usernames_public_read" on public.sakura_usernames
  for select to anon, authenticated using (true);
create policy "svc_sakura_usernames" on public.sakura_usernames
  for all to service_role using (true) with check (true);

revoke all    on public.sakura_usernames from anon, authenticated;
grant  select on public.sakura_usernames to   anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- novels (3) / novel_chapters (24) / novel_unlocks (0) — the paywall
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `novels` holds price_per_chapter, paid_from_chapter, free_until_chapter and
-- allow_pass. All of it was editable by anon: the paywall was writable by the
-- people it charges. `novel_unlocks` is the record of who paid for what, and it
-- was INSERT-open, so a free unlock was one POST away.
--
-- Nothing in the repo writes any of the three — the client only SELECTs novels
-- and novel_chapters, and never touches novel_unlocks at all. So reads stay and
-- writes go, with no client change required.

do $do$
declare t text;
begin
  foreach t in array array['novels','novel_chapters'] loop
    execute format('drop policy if exists %I on public.%I', t || '_creator_write', t);
    execute format('drop policy if exists %I on public.%I', 'chapters_creator_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_public_read', t);
    execute format('drop policy if exists %I on public.%I', 'svc_' || t, t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_public_read', t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', 'svc_' || t, t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;

  -- novel_unlocks and perp_* have no client reader either.
  foreach t in array array['novel_unlocks','perp_users','perp_balances','perp_trades','perp_deposits'] loop
    execute format('drop policy if exists %I on public.%I', 'unlocks_all', t);
    execute format('drop policy if exists %I on public.%I', 'Service role full access', t);
    execute format('drop policy if exists %I on public.%I', 'svc_' || t, t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', 'svc_' || t, t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- perp_* — the policy was named for what it was supposed to be
-- ─────────────────────────────────────────────────────────────────────────────
--
-- All four tables carried a policy literally named "Service role full access"
-- that was granted to `public`. The name described the intent; the grant did the
-- opposite. Every table is empty and no code touches them, so this is the
-- cheapest moment this will ever be fixable — before the feature ships, not
-- after it holds balances.

-- ─────────────────────────────────────────────────────────────────────────────
-- Check your work — with REAL column names
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A malformed probe returns 400 for the wrong reason and looks like a refusal.
-- The first pass of this verification "passed" against columns that do not
-- exist (`is_locked`, `novel_unlocks.wallet_address`) and proved nothing. Use
-- columns from information_schema and check for 42501 specifically:
--
--   PATCH /rest/v1/novels?price_per_chapter=gte.0   {"price_per_chapter":0}
--     -> 42501 permission denied for table novels
--   POST  /rest/v1/novel_unlocks  {"user_wallet":"x","chapter_number":1,"amount":0}
--     -> 42501 permission denied for table novel_unlocks
--   PATCH /rest/v1/sakura_usernames?wallet_address=eq.<any>  {"username":"freed"}
--     -> 42501 permission denied for table sakura_usernames
--   GET   /rest/v1/novels?select=title,price_per_chapter   -> 200
--   GET   /rest/v1/sakura_usernames?select=username        -> 200
--
-- Verified 2026-08-18, all of the above.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Still open after this
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Roughly twenty tables remain `FOR ALL TO public USING (true)`. They are less
-- urgent because none of them gate money or identity, but they are real:
--
--   per-user state anyone can alter or wipe for anyone else —
--     manga_progress (564), anime_history (564), user_library (564),
--     user_settings (324), user_searches (327), reading_history, favorites,
--     novel_progress, novel_bookmarks, novel_downloads_index, pinned_chats,
--     user_blocks
--   impersonation and abuse —
--     chapter_comments (47), novel_comments, comment_reactions,
--     content_reports, user_reports
--   creator publishing —
--     creator_works INSERT (32), work_releases INSERT (31)
--
-- Each needs the same treatment: find the writers, route them through a signed
-- function, then revoke. The per-user tables would be better served by a real
-- owner predicate once wallets map to auth.uid(), rather than a function each.
