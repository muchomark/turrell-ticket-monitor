-- Overlap lock + check duration. A new run starts only if the previous one has finished
-- (or its lease is stale after 120s, e.g. the function crashed), and >= 25s after the last start.

alter table public.turrell_monitor_status
  add column if not exists run_finished_at  timestamptz,
  add column if not exists last_duration_ms int;

create or replace function public.turrell_claim_run()
returns setof public.turrell_monitor_status
language sql security definer set search_path = '' as $$
  update public.turrell_monitor_status
     set run_claimed_at = now()
   where id = 1
     and (
       run_claimed_at is null
       or (
         run_claimed_at < now() - interval '25 seconds'
         and (run_finished_at >= run_claimed_at or run_claimed_at < now() - interval '120 seconds')
       )
     )
  returning *;
$$;
revoke all on function public.turrell_claim_run() from public, anon, authenticated;
grant execute on function public.turrell_claim_run() to service_role;

-- pg_net only records the HTTP call; give it room so slow checks don't log spurious timeouts.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'turrell-check'),
  command := replace(
    (select command from cron.job where jobname = 'turrell-check'),
    'timeout_milliseconds := 25000', 'timeout_milliseconds := 60000')
);
