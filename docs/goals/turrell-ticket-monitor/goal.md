# Turrell Eventbrite ticket monitor

## Objective

Build and deploy a $0 always-on monitor for
https://www.eventbrite.com/e/james-turrell-exhibition-at-almine-rech-new-york-tickets-2004288042489
that posts a Discord webhook alert as soon as **any** ticket, slot or date moves from sold out to available. Ship it as a public GitHub repo, `muchomark/turrell-ticket-monitor`, and run it on a new free-tier Supabase project, `turrell-monitor`, using Edge Function + pg_cron + pg_net. It must turn itself off after the exhibition's last date.

## Original Request

> "I want to create a github repo for this project... create a monitor for [the Eventbrite URL]. I want to get tickets to this event but they are currently listed as sold out. We need to create a monitor that sends us a discord webhook once tickets are available again."

## Intake Summary

- Input shape: `specific`
- Audience: the repo owner (GitHub `muchomark`) and their Discord channel
- Authority: `approved` for: creating the public GitHub repo, creating the new Supabase project `turrell-monitor` (after confirming $0), deploying to it, and sending a live test alert to the user's Discord
- Proof type: `demo`
- Completion proof: a real alert from the deployed function lands in the user's Discord (forced or simulated "available" state), *and* the pg_cron run history shows successful 1-minute checks recording the live sold-out state
- Goal oracle: see below
- Likely misfire: the parser reads the wrong signal (page text, one ticket class only, or the parent of a series event instead of its child dates), so it **never fires**, or it fires falsely. A green "sold out" read proves nothing on its own. The proof has to include a forced "available" path through the same parser and alert code.
- Blind spots considered:
  - Eventbrite bot protection may block Supabase/AWS egress IPs. Test a real fetch **from a deployed Edge Function** before building the rest.
  - Free Supabase projects pause after about 7 days of inactivity. Check whether cron/pg_net traffic counts as activity, and if it doesn't, add a $0 keep-alive. A GitHub Actions keep-alive needs `gh auth refresh -s workflow`, because the current gh token lacks the `workflow` scope.
  - Silent failure: the user chose availability-only alerts, so errors go only to the function logs and a `last_error` / `last_checked_at` state column. The README has to say so plainly and explain how to check health.
  - Public repo: the webhook URL and keys live only in Supabase secrets or Vault. Nothing secret gets committed.
  - Rate politeness: one request a minute (plus jitter), a generic User-Agent, exponential backoff on 403/429/5xx, and a conditional GET where possible.
  - Timed-entry events can add new dates later. "Any slot" includes newly added dates that are on sale.
- Existing plan facts (owner decisions from the interview, to preserve):
  - Hosting: Supabase Edge Function (Deno) + pg_cron + pg_net, **free tier only**
  - Supabase project: **new** `turrell-monitor`. Do **not** touch the existing `legaz` project.
  - Frequency: as fast as possible without cost or a ban. Target a 1-minute cron.
  - Trigger: any ticket class, slot or date going from sold out to available. The alert lists which slots opened, with the ticket link.
  - Alerts: **availability only**, one alert per sold-out → available change, **no @mention**. No heartbeat, sold-out-again or error messages to Discord.
  - Scope: **notify only**. No auto-purchase, login, cart or checkout automation.
  - Webhook: the user pastes the URL during the run → store it as a Supabase secret `DISCORD_WEBHOOK_URL`.
  - Repo: **public** GitHub repo under `muchomark`. The gh CLI is authenticated with scopes `repo, gist, read:org`.
  - Lifetime: auto-stop after the exhibition's last date (cron unschedules itself or the function no-ops).

## Goal Oracle

The oracle for this goal is:

`(1) public repo muchomark/turrell-ticket-monitor contains the function, migrations, parser tests and README; (2) the deployed turrell-check function in Supabase project turrell-monitor runs on pg_cron about every minute and has >=10 minutes of successful runs recording the live state of every slot; (3) a forced or simulated "available" run through the same parser and alert path posts a real no-mention alert with the ticket link and opened slots into the user's Discord, confirmed by the user; (4) auto-disable after the exhibition's last date is in place; (5) total cost is $0.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Continuous execution through to a live, verified monitor: discover how Eventbrite exposes availability, prove that the Edge Function can fetch it, build the function, tests and migrations, deploy to a new free project, verify live with a real Discord alert, push the public repo, and run the final audit.

## Non-Negotiable Constraints

- **$0.** Do not create anything that costs money. Before creating the Supabase project, check the cost and confirm $0 with the user.
- **Do not modify the `legaz` Supabase project** in any way.
- **No secrets in git.** Store `DISCORD_WEBHOOK_URL` and any keys only in Supabase secrets or Vault. `.env*` files are git-ignored.
- **Notify only.** No purchasing, carting, login or checkout automation.
- **Be polite to Eventbrite.** At most about 1 request a minute to Eventbrite, with jitter, backoff on 403/429/5xx, and no request bursts during development or testing. Save fixtures once and test against them.
- **No @mention** in alerts. One alert per sold-out → available change, no repeats.
- Eventbrite is the source of truth. Do not scrape third-party sites.
- Outward-facing steps the user already approved: creating the public repo, creating the `turrell-monitor` project, and posting test alerts to the user's Discord. Anything else outward-facing needs a fresh confirmation.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if the user asked for working software or automation and a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package and continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

Do not create one Worker/Judge pair per repeated file, table, route, or helper. Put repeated same-shape work into one Worker package and review the package as a whole.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice. A Worker should finish the whole assigned slice. A Judge should judge the whole assigned slice.

Do not stop because a slice needs owner input, such as the webhook URL, cost confirmation or the gh `workflow` scope. Mark that exact slice blocked with a receipt, keep doing all local, non-destructive work, and ask the user once with the exact thing needed.

## Board Health

The PM owns board health. If the board looks stale, misleading, offline, or inconsistent, run:

```bash
node ~/.claude/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/turrell-ticket-monitor
```

If the local board is running (http://goalbuddy.localhost:41737/turrell-ticket-monitor/), compare `state.yaml` to the live board API. Repair only GoalBuddy control files unless an active Worker or PM task explicitly allows product-file edits.

## Canonical Board

Machine truth lives at:

`docs/goals/turrell-ticket-monitor/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/turrell-ticket-monitor/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the intake: original request, input shape, authority, proof, blind spots, existing plan facts, and likely misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task (agents `goal-scout`, `goal-judge` and `goal-worker` are installed).
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker package and continue unless blocked.
10. If a problem, suggestion, or follow-up should become a repo artifact, create an approved issue/PR or ask the operator whether to create one.
11. Review at phase, risk, rejected-verification, ambiguity, or final-completion boundaries; do not review every small Worker by habit.
12. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.
