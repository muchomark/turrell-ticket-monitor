-- Schedules the monitor. Requires a Vault secret named 'turrell_project_url'
-- (e.g. https://<project-ref>.supabase.co), created once at deploy time — see README.
-- This file references Vault secret NAMES only; no project URLs or keys are committed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every minute (≈2 Eventbrite GETs per run). The function adds 0–8s jitter.
select cron.schedule(
  'turrell-check',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'turrell_project_url')
           || '/functions/v1/turrell-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'turrell_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

-- Auto-stop: on Jan 31 (first occurrence: 2027-01-31 05:00 UTC, after the series ends
-- 2027-01-30 23:00 UTC) remove all three jobs. The function also no-ops after the end date.
select cron.schedule(
  'turrell-stop',
  '0 5 31 1 *',
  $job$
  select cron.unschedule('turrell-check');
  select cron.unschedule('turrell-net-cleanup');
  select cron.unschedule('turrell-stop');
  $job$
);

-- Keep pg_net's response log small.
select cron.schedule(
  'turrell-net-cleanup',
  '17 * * * *',
  $job$ delete from net._http_response where created < now() - interval '6 hours' $job$
);
