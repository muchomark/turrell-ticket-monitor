-- Turrell ticket monitor: state tables, claim/lock RPC, Vault-generated cron secret.
-- RLS is enabled with no policies: only the service role (used by the Edge Function) can touch these.

create table if not exists public.turrell_slot_state (
  event_id     text primary key,
  start_utc    timestamptz,
  start_local  text,
  url          text,
  available    boolean not null,
  last_seen_at timestamptz not null default now(),
  changed_at   timestamptz not null default now()
);

create table if not exists public.turrell_monitor_status (
  id                   int primary key default 1 check (id = 1),
  run_claimed_at       timestamptz,
  last_checked_at      timestamptz,
  last_ok_at           timestamptz,
  last_error           text,
  consecutive_failures int not null default 0,
  backoff_until        timestamptz,
  sessions_total       int,
  sessions_available   int,
  force_test           boolean not null default false,
  last_alert_at        timestamptz
);
insert into public.turrell_monitor_status (id) values (1) on conflict (id) do nothing;

alter table public.turrell_slot_state enable row level security;
alter table public.turrell_monitor_status enable row level security;
revoke all on public.turrell_slot_state, public.turrell_monitor_status from anon, authenticated;

-- Track when a session's availability actually flips.
create or replace function public.turrell_touch_changed_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.available is distinct from old.available then
    new.changed_at := now();
  else
    new.changed_at := old.changed_at;
  end if;
  return new;
end $$;

drop trigger if exists turrell_slot_state_changed on public.turrell_slot_state;
create trigger turrell_slot_state_changed before update on public.turrell_slot_state
for each row execute function public.turrell_touch_changed_at();

-- Atomic claim: lock against overlapping runs + 50s throttle (one row back = proceed).
create or replace function public.turrell_claim_run()
returns setof public.turrell_monitor_status
language sql security definer set search_path = '' as $$
  update public.turrell_monitor_status
     set run_claimed_at = now()
   where id = 1
     and (run_claimed_at is null or run_claimed_at < now() - interval '50 seconds')
  returning *;
$$;

-- Shared secret between pg_cron and the function, generated inside Vault (never in git).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'turrell_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'turrell_cron_secret',
      'x-cron-secret header value for turrell-check');
  end if;
end $$;

create or replace function public.turrell_verify_secret(s text)
returns boolean
language sql security definer set search_path = '' as $$
  select coalesce(length(s) > 0 and s = (
    select decrypted_secret from vault.decrypted_secrets where name = 'turrell_cron_secret'
  ), false);
$$;

revoke all on function public.turrell_claim_run() from public, anon, authenticated;
revoke all on function public.turrell_verify_secret(text) from public, anon, authenticated;
grant execute on function public.turrell_claim_run() to service_role;
grant execute on function public.turrell_verify_secret(text) to service_role;
