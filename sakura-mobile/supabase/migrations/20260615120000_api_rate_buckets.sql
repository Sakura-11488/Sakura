-- Generic edge-function rate limiting buckets (service role only).

create table if not exists public.api_rate_buckets (
  bucket text primary key,
  hits integer not null default 0,
  window_start timestamptz not null default now()
);

alter table public.api_rate_buckets enable row level security;

revoke all on public.api_rate_buckets from anon, authenticated;
grant all on public.api_rate_buckets to service_role;

drop policy if exists "service role manages api rate buckets" on public.api_rate_buckets;
create policy "service role manages api rate buckets"
  on public.api_rate_buckets for all to service_role using (true) with check (true);
