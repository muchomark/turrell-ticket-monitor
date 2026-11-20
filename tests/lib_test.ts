import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildMessage,
  classify,
  diff,
  END_UTC_MS,
  EVENT_URL,
  fetchAllPages,
  flipForTest,
  formatLocal,
  isExpired,
  type Session,
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
  // neither is written, so stored values survive
  assert(!d.upserts.some((r) => r.event_id === "2004288222026" || r.event_id === "2004288225035"));
  assertEquals(d.deletes.length, 0);
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

Deno.test("message: no mentions, links, <=2000 chars even with 25 sessions", async () => {
  const { sessions } = await sessionsFrom();
  const opened = sessions.slice(0, 25).map((s) => ({ ...s, state: "available" as const }));
  const msg = buildMessage(opened);
  assert(msg.content.length <= 2000, `length ${msg.content.length}`);
  assertEquals(msg.allowed_mentions, { parse: [] });
  assert(!msg.content.includes("@everyone") && !msg.content.includes("@here"));
  const listed = msg.content.split("\n").filter((l) => l.startsWith("• ")).length;
  const more = Number(/\+(\d+) more/.exec(msg.content)?.[1]);
  assert(listed >= 10 && listed <= 15, `listed ${listed}`);
  assertEquals(listed + more, 25);
  assertStringIncludes(msg.content, `<${EVENT_URL}>`);
  assertStringIncludes(msg.content, "Fri Nov 20, 12:00 PM ET");
  const one = buildMessage(opened.slice(0, 1));
  assertStringIncludes(one.content, "1 session just opened");
  assertStringIncludes(one.content, `<${opened[0].url}>`);
});

Deno.test("formatLocal renders ET wall time", () => {
  assertEquals(formatLocal("2027-01-30T17:00:00"), "Sat Jan 30, 5:00 PM ET");
  assertEquals(formatLocal("2026-11-21T11:00:00"), "Sat Nov 21, 11:00 AM ET");
  assertEquals(formatLocal("2026-11-21T12:30:00"), "Sat Nov 21, 12:30 PM ET");
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
  const flipped = flipForTest(sessions, store)!;
  assert(flipped);
  // original snapshot untouched (never persisted)
  assertEquals(sessions.filter((s) => s.state === "available").length, 0);
  const d = diff(flipped.sessions, store);
  assertEquals(d.opened.map((s) => s.id), [flipped.flippedId]);
  const msg = buildMessage(d.opened, { test: true });
  assertStringIncludes(msg.content, "TEST ALERT");
  assertEquals(msg.allowed_mentions, { parse: [] });
  // nothing flippable on an empty store
  assertEquals(flipForTest(sessions, new Map()), null);
});
