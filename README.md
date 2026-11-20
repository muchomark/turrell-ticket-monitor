# turrell-ticket-monitor

Watches the sold-out Eventbrite timed-entry series
**[James Turrell – Exhibition at Almine Rech New York](https://www.eventbrite.com/e/james-turrell-exhibition-at-almine-rech-new-york-tickets-2004288042489)**
and posts a Discord webhook message the moment **any** session (any date, any time slot) goes from sold out → available.

- Runs on a **free** Supabase project: an Edge Function triggered every **30 seconds** by `pg_cron` + `pg_net`. Costs $0.
- **Notify only.** It never reserves, carts, or buys anything.
- One alert per sold-out → available change, batched into a single message per check, with **no @mentions**.
- Stops itself after the exhibition ends (2027-01-30 18:00 ET).

## How it works

```
pg_cron (every 30 seconds)
  └─ net.http_post ─▶ Edge Function turrell-check   (x-cron-secret header, value lives in Vault)
        ├─ claim run (atomic lock + 25s throttle)  ─ turrell_claim_run()
        ├─ 0–4s jitter
        ├─ GET /api/v3/series/2004288042489/events/?time_filter=current_future&page_size=200&expand=ticket_availability
        │     (2 pages per check ≈ 4 requests per minute from one IP; uncached, no token needed)
        ├─ classify every child session
        ├─ diff against turrell_slot_state
        └─ newly available sessions? ─▶ Discord webhook ─▶ then persist state
```

**Why this endpoint:** the event is a *series parent* with ~279 hourly child sessions. Some parent-level signals give the
wrong answer here: the page's JSON-LD says `InStock`, the parent's sales status says `on_sale`, and the HTML is cached
by CloudFront for up to 12 hours. Only the per-child `ticket_availability` is trustworthy, so that's what it reads.

**A session counts as available** only if `has_available_tickets === true`, `is_sold_out !== true`, its status is
`live`/`started`, and it hasn't started yet. Contradictory data (`is_sold_out: false` but no available tickets) is logged
as a *mismatch*: it never alerts, and it's stored as not available, so a later real reopening still alerts. A run that fails partway (an HTTP error, a bot challenge, a missing page, a count
mismatch, or more than 50% unparseable sessions) writes nothing and alerts nobody.

**Staying unblocked:** about 4 GETs a minute from a single IP, with jitter. HTTP 403/429/5xx, a challenge page or a timeout triggers exponential backoff (2, 4, 8… up to 30 min). It never rotates IPs or retries harder to get around a block.

## Setup (one time)

1. **Create a free Supabase project.** It needs to be in a *Free-plan* org, because a project in a Pro org costs money.
2. **Apply the migrations in order** (SQL editor, `supabase db push`, or the Supabase MCP):
   - `supabase/migrations/20261120000001_turrell_monitor.sql`: creates the tables, the lock and secret RPCs, and generates the `turrell_cron_secret` in Vault.
   - Before running the second file, store your project URL in Vault:
     ```sql
     select vault.create_secret('https://<your-project-ref>.supabase.co', 'turrell_project_url');
     ```
   - `supabase/migrations/20261120000002_turrell_cron.sql`: schedules `turrell-check`, `turrell-stop` (auto-stop) and `turrell-net-cleanup`.
   - `20261120000003_*` and `20261120000004_*`: move to a 30-second cadence and add the health-alert columns.
3. **Deploy the function** with JWT verification **off**, since it authenticates the cron call with the Vault secret instead:
   ```sh
   supabase functions deploy turrell-check --no-verify-jwt
   ```
4. **Add the Discord webhook** as a function secret (Dashboard → Edge Functions → Secrets):
   `DISCORD_WEBHOOK_URL = https://discord.com/api/webhooks/...`
   Never commit it. This repo is public.

## Is it working?

**Health alerts:** if checks fail **2 times in a row** (blocked by Eventbrite, rate-limited, unreachable, or Eventbrite's data format changed), a red **"Turrell Watch is blocked…"** embed is posted to the same Discord channel. It says what happened, how long it's been failing, when the next retry is, and what to do. While it stays down you get a reminder every 6 hours, and a blue **"Turrell Watch is back"** message when checks succeed again.

It can't alert you if the Supabase project itself is paused or deleted, because nothing runs then. You can also check health directly:

```sql
select last_ok_at, last_checked_at, last_error, consecutive_failures, backoff_until,
       sessions_total, sessions_available, last_alert_at
from turrell_monitor_status;
```

`last_ok_at` should be under about 2 minutes old. Note that `cron.job_run_details` only proves the HTTP request was *queued*. To
see the function's actual responses:

```sql
select created, status_code, left(content::text, 200) from net._http_response order by created desc limit 10;
```

Per-session state: `select * from turrell_slot_state order by start_utc;`

## Send a test alert

```sql
update turrell_monitor_status set force_test = true where id = 1;
```

On the next run, the function takes the live data, flips one sold-out session to available **in memory only**, runs it
through the real diff, message builder and webhook, and posts an amber embed titled **TEST · Tickets open…**. The flag
resets itself after Discord accepts the message. The fake state is never saved.

## Send a test health alert

```sql
update turrell_monitor_status set force_health_test = true where id = 1;
```

Posts an example red "blocked" embed labelled **TEST** on the next run, without touching real monitoring.

## Stop / pause

```sql
select cron.unschedule('turrell-check');   -- stop checking
-- resume: re-run supabase/migrations/20261120000002_turrell_cron.sql
```

It stops automatically: the function no-ops after 2027-01-30 23:00 UTC, and the `turrell-stop` job removes all
three cron jobs on 2027-01-31.

**Free-project pausing:** Supabase pauses free projects with low database activity over 7 days. The per-minute state
writes should count as activity. If you ever get a "project will be paused" email, open the dashboard once, or add a
daily keep-alive ping (for example, a GitHub Actions workflow calling the project's REST endpoint).

## Development

```sh
deno test --allow-read      # pure logic against captured fixtures (no network)
deno check supabase/functions/turrell-check/index.ts
deno lint && deno fmt --check
```

`fixtures/` holds trimmed copies of the live API response captured on 2026-11-20 (all 279 sessions sold out), plus
synthetic variants: one session available, mismatch/unknown cases, and a bot-challenge page.

`docs/goals/turrell-ticket-monitor/` is the GoalBuddy planning board this was built from.

## License

MIT
