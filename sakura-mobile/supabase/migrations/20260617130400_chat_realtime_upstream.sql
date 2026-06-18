-- Supplemental realtime publication for chat_members and chat_typing.
-- chat_messages realtime + JWT RLS already applied in 20260616120000_chat_messages_realtime.sql.

alter table if exists public.chat_members replica identity full;
alter table if exists public.chat_typing replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.chat_members;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.chat_typing;
exception when duplicate_object then null;
end $$;

-- Read receipts: keep JWT-scoped access where possible; allow authenticated reads for members.
alter table if exists public.chat_members enable row level security;

drop policy if exists "chat_members_realtime_select" on public.chat_members;
create policy "chat_members_realtime_select"
  on public.chat_members
  for select
  to authenticated
  using (public.is_chat_thread_member(thread_id));

grant select on public.chat_members to authenticated;

-- Typing indicators: thread members only (service role writes via edge function).
alter table if exists public.chat_typing enable row level security;

drop policy if exists "chat_typing_read" on public.chat_typing;
create policy "chat_typing_read"
  on public.chat_typing
  for select
  to authenticated
  using (public.is_chat_thread_member(thread_id));

grant select on public.chat_typing to authenticated;
