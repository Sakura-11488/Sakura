-- Pin name resolution for existing functions. Their non-built-in references
-- are schema-qualified.
alter function public.delete_user() set search_path = '';
alter function public.touch_sakura_usernames_updated_at() set search_path = '';
alter function public.touch_sakura_ai_memories_updated_at() set search_path = '';
alter function public.jwt_wallet_address() set search_path = '';
alter function public._seed_b58(bytea) set search_path = '';
alter function public.is_chat_thread_member(uuid) set search_path = '';
alter function public.sync_follow_counts() set search_path = '';

-- Anonymous clients must not invoke security-definer routines.
-- Keep authenticated execution for delete_user and RLS membership checks.
revoke execute on function public.delete_user() from public, anon;
revoke execute on function public.is_chat_thread_member(uuid) from public, anon;
revoke execute on function public.sync_follow_counts() from public, anon;