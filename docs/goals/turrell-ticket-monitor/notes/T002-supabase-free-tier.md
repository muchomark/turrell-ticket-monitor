# T002 — Supabase free-tier facts

- Only visible org "le gaz" (rtonentaifoanfzwqhyg) is **Pro** → new project there costs compute (~$10/mo, credit already used by legaz). **Violates $0.**
  Owner decision (2026-11-20): create a **new free-plan org** in the dashboard; create `turrell-monitor` there. MCP may need reconnect to see the new org.
- pg_cron + pg_net available on all plans; docs pattern: Vault secrets `project_url` + key, `cron.schedule(... net.http_post(...))`.
  Supabase Cron (pg_cron ≥1.5) supports sub-minute schedules like '30 seconds'.
- Edge Function quota on Free: 500K invocations/mo. 30s cadence ≈ 86K/mo, 1-min ≈ 43K/mo → fine.
- Pausing: Free projects with "low activity over 7 days" are paused; "a few user requests to the database each day" is typically enough. The function upserts state every run via PostgREST (user DB activity) → expected to prevent pausing. Warning email arrives ~1 week before. No GitHub Actions keep-alive needed initially (avoids `workflow` scope); README documents the fallback.
- Egress test (Edge → Eventbrite) deferred to T005 (needs the project). From a residential IP the series API returned 200 with no challenge.
