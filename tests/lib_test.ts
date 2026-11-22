import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  backoffMinutes,
  buildHealthMessage,
  buildMessage,
  classify,
  COLOR_DOWN,
  COLOR_LIVE,
  COLOR_RECOVERED,
  COLOR_TEST,
  dayLabel,
  diff,
  END_UTC_MS,
  EVENT_URL,
  FETCH_TIMEOUT_MS,
  fetchAllPages,
  flipForTest,
  formatLocal,
  healthAlertDue,
  isExpired,
  kindForStatus,
  localParts,
  nyDate,
  type Session,
  shortTime,
  soonFlag,
  UpstreamError,
  validateRun,
} from "../supabase/functions/turrell-check/lib.ts";

// Fixtures captured 2026-11-20 ~17:30Z; first session starts 17:00Z... use a "now" just before it.
const NOW = Date.parse("2026-11-20T16:30:00Z");
const dir = new URL("../fixtures/", import.meta.url);
const load = (name: string) => Deno.readTextFile(new URL(name, dir));

/** Fake fetch serving page1 then page2 (by continuation param). */
function fakeFetch(page1: string, page2: string, opts: { status?: number; contentType?: string } = {}) {
  const calls: string[] = [];
  const fn = (url: string) => {
    calls.push(url);
    const body = new URL(url).searchParams.has("continuation") ? page2 : page1;
    return Promise.resolve(
      new Response(body, {
        status: opts.status ?? 200,
        headers: { "Content-Type": opts.contentType ?? "application/json" },
      }),
    );
  };
  return { fn, calls };
}

async function sessionsFrom(page1Name = "series_page1.json") {
  const { fn, calls } = fakeFetch(await load(page1Name), await load("series_page2.json"));
  const { events, objectCount } = await fetchAllPages(fn);
  return { sessions: events.map((e) => classify(e, NOW)), objectCount, calls };
}

const soldOutStore = (sessions: Session[]) => new Map(sessions.map((s) => [s.id, false]));

Deno.test("parses all 279 live sessions across 2 pages, 0 available", async () => {
  const { sessions, objectCount, calls } = await sessionsFrom();
  assertEquals(calls.length, 2);
  assertEquals(sessions.length, 279);
  assertEquals(objectCount, 279);
  assertEquals(validateRun(sessions, objectCount), null);
  assertEquals(sessions.filter((s) => s.state === "available").length, 0);
  assertEquals(sessions.filter((s) => s.state === "unavailable").length, 279);
  assert(new URL(calls[0]).searchParams.get("expand") === "ticket_availability");
});

Deno.test("first run on empty store with all sold out: baseline, no alert", async () => {
  const { sessions } = await sessionsFrom();
  const d = diff(sessions, new Map());
  assertEquals(d.opened.length, 0);
  assertEquals(d.upserts.length, 279);
});

Deno.test("one session flips available -> exactly 1 alert, rerun -> 0", async () => {
  const { sessions } = await sessionsFrom("series_page1_one_available.json");
  const store = soldOutStore(sessions);
  const d1 = diff(sessions, store);
  assertEquals(d1.opened.length, 1);
  assertEquals(d1.opened[0].id, "2004288220020");
  assertEquals(d1.availableNow, 1);
  // persist as the function would
  for (const r of d1.upserts) store.set(r.event_id, r.available);
  const d2 = diff(sessions, store);
  assertEquals(d2.opened.length, 0);
});

Deno.test("available -> sold_out produces no alert and stores false", async () => {
  const { sessions } = await sessionsFrom();
  const store = soldOutStore(sessions);
  store.set("2004288220020", true);
  const d = diff(sessions, store);
  assertEquals(d.opened.length, 0);
  assertEquals(d.upserts.find((r) => r.event_id === "2004288220020")?.available, false);
});

Deno.test("brand-new session id that is available alerts", async () => {
  const { sessions } = await sessionsFrom("series_page1_one_available.json");
  const store = soldOutStore(sessions);
  store.delete("2004288220020"); // newly added date, never seen
  assertEquals(diff(sessions, store).opened.map((s) => s.id), ["2004288220020"]);
});

Deno.test("mismatch (is_sold_out=false but has_available!=true) does not alert; unknown preserves state", async () => {
  const { sessions, objectCount } = await sessionsFrom("series_page1_mismatch_unknown.json");
  assertEquals(validateRun(sessions, objectCount), null);
  const mismatch = sessions.find((s) => s.id === "2004288222026")!;
  const unknown = sessions.find((s) => s.id === "2004288225035")!;
  assertEquals(mismatch.state, "mismatch");
  assertEquals(unknown.state, "unknown");
  const store = soldOutStore(sessions);
  store.set("2004288225035", true); // previously available
  const d = diff(sessions, store);
  assertEquals(d.opened.length, 0);
  assertEquals(d.mismatches.length, 1);
  assertEquals(d.unknowns.length, 1);
  // unknown is not written (stored value survives); mismatch is stored as not-available
  assert(!d.upserts.some((r) => r.event_id === "2004288225035"));
  assertEquals(d.upserts.find((r) => r.event_id === "2004288222026")?.available, false);
  assertEquals(d.deletes.length, 0);
});

Deno.test("available -> mismatch -> available alerts again (no stuck 'true')", async () => {
  const { sessions } = await sessionsFrom("series_page1_mismatch_unknown.json");
  const store = soldOutStore(sessions);
  store.set("2004288222026", true); // was available, now mismatch
  for (const r of diff(sessions, store).upserts) store.set(r.event_id, r.available);
  assertEquals(store.get("2004288222026"), false);
  const reopened = sessions.map((
    s,
  ) => (s.id === "2004288222026" ? { ...s, state: "available" as const } : s));
  assertEquals(diff(reopened, store).opened.map((s) => s.id), ["2004288222026"]);
});

Deno.test("sessions gone from response are deleted without alert", async () => {
  const { sessions } = await sessionsFrom();
  const store = soldOutStore(sessions);
  store.set("999", true);
  const d = diff(sessions, store);
  assertEquals(d.deletes, ["999"]);
  assertEquals(d.opened.length, 0);
});

Deno.test("past session is never available", () => {
  const ev = {
    id: "1",
    status: "live",
    start: { utc: "2026-11-20T16:00:00Z", local: "2026-11-20T11:00:00" },
    ticket_availability: { has_available_tickets: true, is_sold_out: false },
  };
  assertEquals(classify(ev, NOW).state, "unavailable");
  assertEquals(classify({ ...ev, start: { utc: "2026-11-21T16:00:00Z" } }, NOW).state, "available");
  assertEquals(
    classify({ ...ev, status: "canceled", start: { utc: "2026-11-21T16:00:00Z" } }, NOW).state,
    "unavailable",
  );
});

Deno.test("run validation fails closed", async () => {
  const { sessions } = await sessionsFrom();
  assertStringIncludes(validateRun([], 0)!, "0 sessions");
  assertStringIncludes(validateRun(sessions.slice(0, 200), 279)!, "object_count");
  const mostlyUnknown = sessions.map((s, i) => (i < 200 ? { ...s, state: "unknown" as const } : s));
  assertStringIncludes(validateRun(mostlyUnknown, 279)!, "unknown");
});

Deno.test("challenge HTML, HTTP 403/429 and bad JSON throw UpstreamError", async () => {
  const html = await load("challenge.html");
  const e1 = await assertRejects(
    () => fetchAllPages(fakeFetch(html, html, { contentType: "text/html" }).fn),
    UpstreamError,
  );
  assert(e1.backoff);
  const e2 = await assertRejects(
    () => fetchAllPages(fakeFetch("{}", "{}", { status: 403 }).fn),
    UpstreamError,
  );
  assert(e2.backoff && e2.status === 403);
  const e3 = await assertRejects(
    () => fetchAllPages(fakeFetch("{}", "{}", { status: 429 }).fn),
    UpstreamError,
  );
  assert(e3.backoff);
  const e4 = await assertRejects(() => fetchAllPages(fakeFetch("{not json", "").fn), UpstreamError);
  assert(!e4.backoff);
  const e5 = await assertRejects(() => fetchAllPages(fakeFetch('{"pagination":{}}', "").fn), UpstreamError);
  assertStringIncludes(e5.message, "events");
  // page 2 failing fails the whole run
  const p1 = await load("series_page1.json");
  await assertRejects(() => fetchAllPages(fakeFetch(p1, html).fn), UpstreamError);
});

// Helpers for message tests. NOW = Fri Nov 20 2026, 11:30 AM ET.
const at = (sessions: Session[], local: string) => sessions.find((s) => s.startLocal === local)!;
const open = (xs: Session[]) => xs.map((s) => ({ ...s, state: "available" as const }));

Deno.test("message: single session tomorrow -> date+time headline, one CTA, embed only", async () => {
  const { sessions } = await sessionsFrom();
  const s = at(sessions, "2026-11-21T13:00:00");
  const msg = buildMessage(open([s]), {
    nowMs: NOW,
    allSessions: sessions,
    nowIso: "2026-11-20T16:30:00.000Z",
  });
  assertEquals(Object.keys(msg).sort(), ["allowed_mentions", "embeds", "username"]); // no plain-text content
  assertEquals(msg.allowed_mentions, { parse: [] });
  const e = msg.embeds[0];
  assertEquals(e.title, "Tomorrow · Sat, Nov 21 · 1 PM just opened");
  assertEquals(e.url, s.url);
  assertEquals(e.color, COLOR_LIVE);
  assertStringIncludes(e.description, `**[Reserve this slot →](${s.url})**`);
  assert(!e.description.includes("⚡"));
  assertEquals(e.fields, undefined);
});

Deno.test("message: single session starting soon gets the ⚡ flag", async () => {
  const { sessions } = await sessionsFrom();
  const s = at(sessions, "2026-11-20T12:00:00"); // 12 PM ET = 30 min after NOW
  const e = buildMessage(open([s]), { nowMs: NOW, allSessions: sessions }).embeds[0];
  assertEquals(e.title, "Today · Fri, Nov 20 · 12 PM just opened");
  assertStringIncludes(e.description, "⚡ in 30 min");
});

Deno.test("message: many sessions -> day grid, 'All N times' collapse, CTA last", async () => {
  const { sessions } = await sessionsFrom();
  const picked = [
    at(sessions, "2026-11-20T15:00:00"),
    at(sessions, "2026-11-20T16:00:00"),
    ...sessions.filter((s) => s.startLocal.startsWith("2026-11-21")), // whole Saturday (7)
    at(sessions, "2026-11-24T11:00:00"),
    at(sessions, "2026-11-24T14:00:00"),
  ];
  const e = buildMessage(open(picked), { nowMs: NOW, allSessions: sessions }).embeds[0];
  assertEquals(e.title, "11 Turrell sessions just opened");
  assertEquals(e.url, picked[0].url);
  assertEquals(e.description, "3 days · earliest Today 3 PM");
  const f = e.fields!;
  assertEquals(f.length, 4);
  assertEquals(f[0].name, "Today · Fri, Nov 20");
  assertEquals(f[0].value, `[3 PM](${picked[0].url}) · [4 PM](${picked[1].url})`);
  assert(f[0].inline);
  assertEquals(f[1].name, "Tomorrow · Sat, Nov 21");
  assertEquals(f[1].value, `[All 7 times](${picked[2].url}) · 11 AM–5 PM`);
  assertEquals(f[2].name, "Tue, Nov 24");
  assertEquals(f[2].value.split(" · ").length, 2);
  assertStringIncludes(f[3].value, `[Reserve the earliest slot →](${picked[0].url})`);
  assert(!f[3].inline);
});

Deno.test("message: today's remaining sessions all open collapses too", async () => {
  const { sessions } = await sessionsFrom();
  const later = Date.parse("2026-11-20T19:30:00Z"); // 2:30 PM ET: 3, 4, 5 PM remain
  const rest = sessions.filter((s) =>
    s.startLocal.startsWith("2026-11-20") && Date.parse(s.startUtc) > later
  );
  const other = at(sessions, "2026-11-24T11:00:00");
  const e = buildMessage(open([...rest, other]), { nowMs: later, allSessions: sessions }).embeds[0];
  assertEquals(e.fields![0].value, `[All 3 times](${rest[0].url}) · 3 PM–5 PM`);
  assertStringIncludes(e.description, "⚡ in 30 min");
});

Deno.test("message: huge release stays within Discord limits with '+N more days'", async () => {
  const { sessions } = await sessionsFrom();
  const e = buildMessage(open(sessions.filter((s) => Date.parse(s.startUtc) > NOW)), {
    nowMs: NOW,
    allSessions: sessions,
  }).embeds[0];
  const size = e.title.length + e.description.length + e.footer.text.length +
    e.fields!.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert(size <= 6000, `size ${size}`);
  assert(e.fields!.length <= 25);
  assert(e.description.length <= 4096);
  assert(e.fields!.every((f) => f.value.length <= 1024 && f.name.length <= 256));
  const more = e.fields!.find((f) => f.name.startsWith("+"))!;
  const dayFields = e.fields!.filter((f) => f.inline).length;
  assertEquals(dayFields + Number(/\+(\d+)/.exec(more.name)![1]), 40);
  assertStringIncludes(more.value, EVENT_URL);
  assertStringIncludes(e.fields!.at(-1)!.value, "Reserve the earliest slot");
  assertStringIncludes(e.fields![1].value, "[All 7 times]"); // full Saturday collapses
});

Deno.test("message: test variant is amber and clearly labelled", async () => {
  const { sessions } = await sessionsFrom();
  const msg = buildMessage(open([at(sessions, "2026-11-24T11:00:00")]), { test: true, nowMs: NOW });
  const e = msg.embeds[0];
  assert(e.title.startsWith("TEST · "));
  assertEquals(e.color, COLOR_TEST);
  assertStringIncludes(e.description, "**Test alert.**");
  assert(!JSON.stringify(msg).match(/@everyone|@here/));
});

Deno.test("labels: short times, day labels, year only when needed, soon flag", () => {
  assertEquals(shortTime("2026-11-21T13:00:00"), "1 PM");
  assertEquals(shortTime("2026-11-21T12:30:00"), "12:30 PM");
  assertEquals(shortTime("2026-11-21T00:00:00"), "12 AM");
  assertEquals(nyDate(Date.parse("2026-11-21T03:00:00Z")), "2026-11-20"); // 10 PM ET still the 20th
  assertEquals(dayLabel("2026-11-20", NOW), "Today · Fri, Nov 20");
  assertEquals(dayLabel("2026-11-21", NOW), "Tomorrow · Sat, Nov 21");
  assertEquals(dayLabel("2026-11-24", NOW), "Tue, Nov 24");
  assertEquals(dayLabel("2027-01-30", NOW), "Sat, Jan 30, 2027");
  assertEquals(dayLabel("2027-01-30", Date.parse("2027-01-29T15:00:00Z")), "Tomorrow · Sat, Jan 30");
  assertEquals(soonFlag("2026-11-20T17:00:00Z", NOW), "⚡ in 30 min");
  assertEquals(soonFlag("2026-11-20T18:05:00Z", NOW), "⚡ in 1 h 35 min");
  assertEquals(soonFlag("2026-11-20T18:31:00Z", NOW), "");
  assertEquals(soonFlag("2026-11-20T16:00:00Z", NOW), "");
  assertEquals(formatLocal("2027-01-30T17:00:00"), "Sat, Jan 30 · 5:00 PM ET");
  assertEquals(localParts("2026-11-21T12:30:00"), { day: "Sat, Nov 21", time: "12:30 PM" });
});

Deno.test("isExpired boundary at 2027-01-30T23:00Z", () => {
  assertEquals(END_UTC_MS, Date.parse("2027-01-30T23:00:00Z"));
  assertEquals(isExpired(END_UTC_MS - 1), false);
  assertEquals(isExpired(END_UTC_MS), true);
  assertEquals(isExpired(NOW), false);
});

Deno.test("force test: flips one stored-sold-out session through real diff, labelled TEST", async () => {
  const { sessions } = await sessionsFrom();
  const store = soldOutStore(sessions);
  const flipped = flipForTest(sessions, store, NOW)!;
  assert(flipped);
  // original snapshot untouched (never persisted)
  assertEquals(sessions.filter((s) => s.state === "available").length, 0);
  const d = diff(flipped.sessions, store);
  assertEquals(d.opened.map((s) => s.id), [flipped.flippedId]);
  const msg = buildMessage(d.opened, { test: true, nowMs: NOW, allSessions: flipped.sessions });
  assert(!("content" in msg));
  assert(msg.embeds[0].title.startsWith("TEST · "));
  assertEquals(msg.embeds[0].color, COLOR_TEST);
  assertStringIncludes(msg.embeds[0].description, "Test alert.");
  assertEquals(msg.allowed_mentions, { parse: [] });
  // nothing flippable on an empty store
  assertEquals(flipForTest(sessions, new Map(), NOW), null);
  // never flips a session that has already started
  const later = Date.parse("2026-11-20T19:30:00Z");
  const f2 = flipForTest(sessions, store, later)!;
  assert(Date.parse(f2.sessions.find((s) => s.id === f2.flippedId)!.startUtc) > later);
});

// ---- health alerts ----
Deno.test("health: alert after 2 consecutive failures, reminder every 6h, not before", () => {
  assertEquals(healthAlertDue(1, "ok", null, NOW), null); // single blip: quiet
  assertEquals(healthAlertDue(2, "ok", null, NOW), "down");
  assertEquals(healthAlertDue(5, "down", NOW - 60_000, NOW), null); // already alerted
  assertEquals(healthAlertDue(50, "down", NOW - 6 * 3_600_000, NOW), "reminder");
});

Deno.test("health: down message is a red embed with what/when/next/todo and no mentions", () => {
  const msg = buildHealthMessage("down", {
    kind: "blocked",
    detail: "HTTP 403 on page 1",
    failures: 2,
    downSinceIso: "2026-11-20T18:00:00Z",
    nextRetryIso: "2026-11-20T18:04:00Z",
    nowIso: "2026-11-20T18:01:00Z",
  });
  assertEquals(Object.keys(msg).sort(), ["allowed_mentions", "embeds", "username"]);
  assertEquals(msg.allowed_mentions, { parse: [] });
  const e = msg.embeds[0];
  assertEquals(e.title, "Turrell Watch is blocked by Eventbrite");
  assertEquals(e.color, COLOR_DOWN);
  assertStringIncludes(e.description, "You won't get ticket alerts until this clears.");
  assertStringIncludes(e.description, "**What happened:** HTTP 403 on page 1");
  assertStringIncludes(e.description, `<t:${Date.parse("2026-11-20T18:00:00Z") / 1000}:R>`);
  assertStringIncludes(e.description, "2 failed checks in a row");
  assertStringIncludes(e.description, "**Next retry:**");
  assertStringIncludes(e.description, "You'll get a message when it recovers.");
});

Deno.test("health: reminder, recovered, format and test variants", () => {
  const nowIso = "2026-11-20T18:01:00Z";
  const r = buildHealthMessage("reminder", { kind: "rate_limited", nowIso }).embeds[0];
  assert(r.title.startsWith("Still down: "));
  assert(!r.description.includes("when it recovers"));
  const back = buildHealthMessage("recovered", { downSinceIso: "2026-11-20T17:00:00Z", nowIso }).embeds[0];
  assertEquals(back.title, "Turrell Watch is back");
  assertEquals(back.color, COLOR_RECOVERED);
  assertStringIncludes(back.description, "Ticket alerts are active.");
  const fmt = buildHealthMessage("down", { kind: "format", nowIso }).embeds[0];
  assertStringIncludes(fmt.title, "data changed");
  const t = buildHealthMessage("down", { kind: "blocked", nowIso, test: true }).embeds[0];
  assert(t.title.startsWith("TEST · "));
  assertStringIncludes(t.description, "Nothing is actually wrong.");
});

Deno.test("backoff: slowness caps at 5 min, blocks/rate limits at 30", () => {
  assertEquals([1, 2, 3, 4, 8].map((n) => backoffMinutes(n, "network")), [2, 4, 5, 5, 5]);
  assertEquals(backoffMinutes(3, "server"), 5);
  assertEquals([1, 3, 5, 9].map((n) => backoffMinutes(n, "blocked")), [2, 8, 30, 30]);
  assertEquals(backoffMinutes(6, "rate_limited"), 30);
});

Deno.test("fetch timeout allows Eventbrite's slow first page (observed ~10.6s)", () => {
  assert(FETCH_TIMEOUT_MS >= 20_000);
});
