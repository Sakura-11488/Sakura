create table if not exists public.chat_typing (
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  wallet_address text not null,
  updated_at timestamptz not null default now(),
  primary key (thread_id, wallet_address)
);

create index if not exists chat_typing_thread_updated_idx
  on public.chat_typing (thread_id, updated_at desc);

alter table public.chat_typing enable row level security;

create policy "chat_typing_service_only"
  on public.chat_typing
  for all
  to service_role
  using (true)
  with check (true);

grant all on public.chat_typing to service_role;
