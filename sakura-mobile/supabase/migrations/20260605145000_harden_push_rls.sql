-- Harden push notification tables.
-- Client writes should go through service-role Edge Functions, not direct anon table access.

drop policy if exists "push_tokens_public_all" on public.push_tokens;
drop policy if exists "push_manga_state_service" on public.push_manga_state;
drop policy if exists "push_delivery_log_service" on public.push_delivery_log;

revoke all on public.push_tokens from anon, authenticated;
revoke all on public.push_manga_state from anon, authenticated;
revoke all on public.push_delivery_log from anon, authenticated;

grant all on public.push_tokens to service_role;
grant all on public.push_manga_state to service_role;
grant all on public.push_delivery_log to service_role;

create policy "push_tokens_service_role_all"
  on public.push_tokens
  for all
  to service_role
  using (true)
  with check (true);

create policy "push_manga_state_service_role_all"
  on public.push_manga_state
  for all
  to service_role
  using (true)
  with check (true);

create policy "push_delivery_log_service_role_all"
  on public.push_delivery_log
  for all
  to service_role
  using (true)
  with check (true);
