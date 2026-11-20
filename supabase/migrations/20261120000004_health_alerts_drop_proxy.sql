-- Proxy failover removed (proxies unreachable; direct monitoring only).
-- Add health-alert state: Discord notice when the monitor is blocked/broken, plus recovery.

alter table public.turrell_monitor_status
  drop column if exists route,
  drop column if exists proxy_index,
  drop column if exists proxy_until,
  drop column if exists force_proxy,
  add column if not exists health_state      text not null default 'ok',
  add column if not exists health_alerted_at timestamptz,
  add column if not exists health_down_since timestamptz,
  add column if not exists force_health_test boolean not null default false;

-- Recreate so the returned row type reflects the new columns.
create or replace function public.turrell_claim_run()
returns setof public.turrell_monitor_status
language sql security definer set search_path = '' as $$
  update public.turrell_monitor_status
     set run_claimed_at = now()
   where id = 1
     and (run_claimed_at is null or run_claimed_at < now() - interval '25 seconds')
  returning *;
$$;
revoke all on function public.turrell_claim_run() from public, anon, authenticated;
grant execute on function public.turrell_claim_run() to service_role;
