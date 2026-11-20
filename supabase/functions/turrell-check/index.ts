// Supabase Edge Function: checks the Eventbrite series and posts a Discord alert
// whenever any session goes sold-out -> available. Invoked by pg_cron every minute.
import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  backoffMinutes,
  buildMessage,
  classify,
  diff,
  type DiscordPayload,
  fetchAllPages,
  flipForTest,
  isExpired,
  UpstreamError,
  validateRun,
} from "./lib.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  // Newer projects expose secret keys as a JSON map.
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>;
    const first = parsed.default ?? Object.values(parsed)[0];
    if (first) return first;
  }
  throw new Error("no service key in env");
}

async function sendDiscord(payload: DiscordPayload): Promise<{ ok: boolean; detail: string }> {
  const hook = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!hook) return { ok: false, detail: "DISCORD_WEBHOOK_URL not set" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${hook}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      await res.body?.cancel();
      return { ok: true, detail: `discord ${res.status}` };
    }
    const text = await res.text();
    if (res.status === 429 && attempt === 0) {
      let retryAfter = 1;
      try {
        retryAfter = Number(JSON.parse(text).retry_after) || 1;
      } catch { /* default */ }
      if (retryAfter <= 10) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
    }
    return { ok: false, detail: `discord ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: false, detail: "discord retry exhausted" };
}

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
    auth: { persistSession: false },
  });

  // C8: shared secret generated inside Vault; verified by a security-definer RPC.
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: authorized, error: authErr } = await db.rpc("turrell_verify_secret", { s: secret });
  if (authErr || authorized !== true) return json({ error: "unauthorized" }, 401);

  const now = Date.now();
  if (isExpired(now)) return json({ skipped: "exhibition ended" });

  // C5: atomic claim doubles as the 50s throttle and the overlap lock.
  const { data: claimRows, error: claimErr } = await db.rpc("turrell_claim_run");
  if (claimErr) return json({ error: `claim: ${claimErr.message}` }, 500);
  const status = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (!status) return json({ skipped: "throttled" });

  const patchStatus = (patch: Record<string, unknown>) =>
    db.from("turrell_monitor_status").update(patch).eq("id", 1);

  if (status.backoff_until && Date.parse(status.backoff_until) > now) {
    return json({ skipped: "backoff", until: status.backoff_until });
  }

  // Jitter 0-8s so requests don't land exactly on the minute.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8000)));

  let events, objectCount;
  try {
    ({ events, objectCount } = await fetchAllPages(fetch));
  } catch (e) {
    const err = e as Error;
    const failures = (status.consecutive_failures ?? 0) + 1;
    const backoff = err instanceof UpstreamError && err.backoff;
    await patchStatus({
      last_checked_at: new Date().toISOString(),
      last_error: err.message,
      consecutive_failures: failures,
      backoff_until: backoff ? new Date(Date.now() + backoffMinutes(failures) * 60_000).toISOString() : null,
    });
    console.error("fetch failed", err.message);
    return json({ error: err.message, backoff });
  }

  const checkedAt = Date.now();
  const sessions = events.map((ev) => classify(ev, checkedAt));
  const invalid = validateRun(sessions, objectCount);
  if (invalid) {
    await patchStatus({
      last_checked_at: new Date().toISOString(),
      last_error: `invalid run: ${invalid}`,
      consecutive_failures: (status.consecutive_failures ?? 0) + 1,
    });
    console.error("invalid run", invalid);
    return json({ error: invalid });
  }

  const { data: rows, error: readErr } = await db
    .from("turrell_slot_state")
    .select("event_id, available");
  if (readErr) return json({ error: `read state: ${readErr.message}` }, 500);
  const stored = new Map<string, boolean>(rows!.map((r) => [r.event_id, r.available]));

  // C7: force test — flipped snapshot goes through the real diff + sender, never persisted.
  if (status.force_test) {
    const flipped = flipForTest(sessions, stored);
    if (!flipped) {
      await patchStatus({ last_error: "force_test: no stored sold-out session to flip" });
      return json({ error: "force_test: nothing to flip" });
    }
    const d = diff(flipped.sessions, stored);
    const sent = await sendDiscord(buildMessage(d.opened, { test: true }));
    if (sent.ok) {
      await patchStatus({ force_test: false, last_alert_at: new Date().toISOString(), last_error: null });
    } else {
      await patchStatus({ last_error: `force_test: ${sent.detail}` });
    }
    return json({ test: true, flipped: flipped.flippedId, opened: d.opened.length, discord: sent.detail });
  }

  const d = diff(sessions, stored);
  if (d.mismatches.length) console.warn("mismatch sessions", d.mismatches.map((s) => s.id));
  if (d.unknowns.length) console.warn("unknown sessions", d.unknowns.map((s) => s.id));

  let alerted = false;
  if (d.opened.length > 0) {
    const sent = await sendDiscord(buildMessage(d.opened));
    if (!sent.ok) {
      // C6: Discord failure does not back off Eventbrite; state not written so next run retries.
      await patchStatus({ last_checked_at: new Date().toISOString(), last_error: sent.detail });
      console.error("discord failed", sent.detail);
      return json({ error: sent.detail, opened: d.opened.length });
    }
    alerted = true;
  }

  if (d.upserts.length) {
    const { error } = await db.from("turrell_slot_state").upsert(
      d.upserts.map((r) => ({ ...r, last_seen_at: new Date().toISOString() })),
      { onConflict: "event_id" },
    );
    if (error) return json({ error: `upsert: ${error.message}` }, 500);
  }
  if (d.deletes.length) {
    await db.from("turrell_slot_state").delete().in("event_id", d.deletes);
  }

  const iso = new Date().toISOString();
  await patchStatus({
    last_checked_at: iso,
    last_ok_at: iso,
    last_error: d.mismatches.length ? `${d.mismatches.length} mismatch sessions` : null,
    consecutive_failures: 0,
    backoff_until: null,
    sessions_total: sessions.length,
    sessions_available: d.availableNow,
    ...(alerted ? { last_alert_at: iso } : {}),
  });

  return json({
    sessions: sessions.length,
    available: d.availableNow,
    opened: d.opened.length,
    mismatches: d.mismatches.length,
    unknown: d.unknowns.length,
  });
});
