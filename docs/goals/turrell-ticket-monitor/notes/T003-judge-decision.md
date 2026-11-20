# T003 — Judge decision: approved_with_changes

Base design (PM proposal): series endpoint w/ expand=ticket_availability, paginate via continuation; per-child classify; one batched Discord alert per run on transitions; force_test flag via SQL only; auto-stop after 2027-01-30T23:00Z; Vault-name-only cron SQL in repo.

Required changes (all accepted by PM):
- C1 cron '* * * * *' (2 GETs/min) + 0–8s jitter; claim throttle 50s. No 30s cadence.
- C2 available := has_available_tickets===true AND is_sold_out!==true AND status∈{live,started} AND start.utc>now. is_sold_out===false && has_available!==true → 'mismatch' (log, no alert).
- C3 unknown/mismatch keep stored value; never written as false. Sessions gone from response → delete, no alert.
- C4 run error (no write, no alert) if any page fails / non-JSON or challenge HTML / 0 sessions / collected != object_count / >50% unknown.
- C5 atomic claim: UPDATE ... SET run_claimed_at=now() WHERE id=1 AND (null OR < now()-50s) RETURNING via security-definer RPC (service role only).
- C6 Discord failures don't trigger Eventbrite backoff; honor retry_after; content ≤2000 chars (≤15 sessions then +N more); start.local ET; allowed_mentions {parse:[]}.
- C7 force test runs flipped snapshot through real diff; flipped never persisted; force_test reset only after Discord 2xx.
- C8 shared-secret header x-cron-secret. PM amendment: secret generated in Vault (turrell_cron_secret) and verified by security-definer RPC, so no extra user-entered secret; verify_jwt=false.
- C9 net.http_post timeout 60s, fetch AbortSignal 15s; README: health = monitor_status.last_ok_at / net._http_response, not cron.job_run_details.
- C10 .gitignore: .env*, supabase/.temp, supabase/.branches, docs/goals/**/notes/fixtures/ (headers carry cookies).
