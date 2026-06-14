-- Realtime read access for chat messages via wallet-bound Supabase JWT.

create or replace function public.jwt_wallet_address()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'wallet_address', '');
$$;

create or replace function public.is_chat_thread_member(p_thread_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_members m
    where m.thread_id = p_thread_id
      and m.wallet_address = public.jwt_wallet_address()
  );
$$;

revoke all on public.chat_messages from authenticated;
grant select on public.chat_messages to authenticated;

grant execute on function public.jwt_wallet_address() to authenticated;
grant execute on function public.is_chat_thread_member(uuid) to authenticated;

drop policy if exists "thread members read messages" on public.chat_messages;
create policy "thread members read messages"
  on public.chat_messages
  for select
  to authenticated
  using (
    moderation_state <> 'removed'
    and public.is_chat_thread_member(thread_id)
  );

alter table public.chat_messages replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;
