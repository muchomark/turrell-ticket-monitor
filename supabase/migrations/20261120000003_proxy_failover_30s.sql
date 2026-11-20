-- 30-second cadence + proxy routing state. NOTE: proxy support was removed; 0004 drops these proxy columns.

alter table public.turrell_monitor_status
  add column if not exists route        text,
  add column if not exists proxy_index  int not null default 0,
  add column if not exists proxy_until  timestamptz,
  add column if not exists force_proxy  boolean not null default false;

-- Throttle/lock window matches the 30s schedule.
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

-- Every 30 seconds (≈4 Eventbrite GETs/min from one IP). Same job name => replaces the 1-minute job.
select cron.schedule(
  'turrell-check',
  '30 seconds',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'turrell_project_url')
           || '/functions/v1/turrell-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'turrell_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $job$
);
