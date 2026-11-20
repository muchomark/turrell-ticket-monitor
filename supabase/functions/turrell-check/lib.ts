// Pure logic for the Turrell ticket monitor. No Deno/Supabase globals here so
// everything is unit-testable against fixtures without network access.

export const SERIES_ID = "2004288042489";
export const EVENT_URL =
  "https://www.eventbrite.com/e/james-turrell-exhibition-at-almine-rech-new-york-tickets-2004288042489";
/** Series ends 2027-01-30 18:00 America/New_York. After this the monitor no-ops. */
export const END_UTC_MS = Date.parse("2027-01-30T23:00:00Z");
export const MAX_PAGES = 5;
export const FETCH_TIMEOUT_MS = 15_000;
export const DISCORD_LIMIT = 2000;
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export type SessionState = "available" | "unavailable" | "mismatch" | "unknown";

export interface Session {
  id: string;
  url: string;
  startUtc: string;
  startLocal: string;
  state: SessionState;
}

// deno-lint-ignore no-explicit-any
type RawEvent = Record<string, any>;

export function seriesUrl(continuation?: string): string {
  const u = new URL(`https://www.eventbrite.com/api/v3/series/${SERIES_ID}/events/`);
  u.searchParams.set("time_filter", "current_future");
  u.searchParams.set("page_size", "200");
  u.searchParams.set("expand", "ticket_availability");
  if (continuation) u.searchParams.set("continuation", continuation);
  return u.toString();
}

/** Raised for upstream failures that should trigger Eventbrite backoff. */
export class UpstreamError extends Error {
  constructor(message: string, readonly status: number | null, readonly backoff: boolean) {
    super(message);
    this.name = "UpstreamError";
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetch every page of the series listing. Throws UpstreamError on any failure (fail closed). */
export async function fetchAllPages(
  fetchFn: FetchFn,
): Promise<{ events: RawEvent[]; objectCount: number }> {
  const events: RawEvent[] = [];
  let continuation: string | undefined;
  let objectCount = -1;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchFn(seriesUrl(continuation), {
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new UpstreamError(`network error: ${(e as Error).message}`, null, true);
    }
    const body = await res.text();
    if (!res.ok) {
      const backoff = res.status === 403 || res.status === 429 || res.status >= 500;
      throw new UpstreamError(`HTTP ${res.status} on page ${page + 1}`, res.status, backoff);
    }
    const trimmed = body.trimStart();
    if (trimmed.startsWith("<")) {
      throw new UpstreamError(`non-JSON (HTML/challenge) on page ${page + 1}`, res.status, true);
    }
    let json: RawEvent;
    try {
      json = JSON.parse(body);
    } catch {
      throw new UpstreamError(`invalid JSON on page ${page + 1}`, res.status, false);
    }
    if (!Array.isArray(json.events)) {
      throw new UpstreamError(`missing events[] on page ${page + 1}`, res.status, false);
    }
    events.push(...json.events);
    const p = json.pagination ?? {};
    if (typeof p.object_count === "number") objectCount = p.object_count;
    if (p.has_more_items && p.continuation) {
      continuation = p.continuation;
      continue;
    }
    return { events, objectCount };
  }
  throw new UpstreamError(`more than ${MAX_PAGES} pages`, null, false);
}

/** C2: strict availability rule. */
export function classify(ev: RawEvent, nowMs: number): Session {
  const startUtc: string = ev?.start?.utc ?? "";
  const base = {
    id: String(ev?.id ?? ""),
    url: String(ev?.url ?? EVENT_URL),
    startUtc,
    startLocal: String(ev?.start?.local ?? ""),
  };
  const ta = ev?.ticket_availability;
  if (!ta || typeof ta !== "object") return { ...base, state: "unknown" };
  const startMs = Date.parse(startUtc);
  const liveStatus = ev?.status === "live" || ev?.status === "started";
  if (!liveStatus || !(startMs > nowMs)) return { ...base, state: "unavailable" };
  if (ta.has_available_tickets === true && ta.is_sold_out !== true) {
    return { ...base, state: "available" };
  }
  if (ta.is_sold_out === false && ta.has_available_tickets !== true) {
    return { ...base, state: "mismatch" };
  }
  return { ...base, state: "unavailable" };
}

/** C4: returns an error string if the run must be discarded, else null. */
export function validateRun(sessions: Session[], objectCount: number): string | null {
  if (sessions.length === 0) return "0 sessions parsed";
  if (sessions.some((s) => !s.id)) return "session without id";
  if (objectCount >= 0 && sessions.length !== objectCount) {
    return `collected ${sessions.length} sessions but pagination.object_count=${objectCount}`;
  }
  const unknown = sessions.filter((s) => s.state === "unknown").length;
  if (unknown * 2 > sessions.length) return `${unknown}/${sessions.length} sessions unknown`;
  return null;
}

export interface StateRow {
  event_id: string;
  start_utc: string;
  start_local: string;
  url: string;
  available: boolean;
}

export interface DiffResult {
  opened: Session[];
  upserts: StateRow[];
  deletes: string[];
  mismatches: Session[];
  unknowns: Session[];
  availableNow: number;
}

/** C3/C5: compute transitions vs stored state. stored maps event_id -> available. */
export function diff(sessions: Session[], stored: Map<string, boolean>): DiffResult {
  const opened: Session[] = [];
  const upserts: StateRow[] = [];
  const mismatches: Session[] = [];
  const unknowns: Session[] = [];
  const seen = new Set<string>();
  let availableNow = 0;
  for (const s of sessions) {
    seen.add(s.id);
    const row = (available: boolean): StateRow => ({
      event_id: s.id,
      start_utc: s.startUtc,
      start_local: s.startLocal,
      url: s.url,
      available,
    });
    switch (s.state) {
      case "available":
        availableNow++;
        if (stored.get(s.id) !== true) opened.push(s);
        upserts.push(row(true));
        break;
      case "unavailable":
        upserts.push(row(false));
        break;
      case "mismatch":
        mismatches.push(s); // keep stored value, never written
        break;
      case "unknown":
        unknowns.push(s); // keep stored value, never written
        break;
    }
  }
  const deletes = [...stored.keys()].filter((id) => !seen.has(id));
  opened.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  return { opened, upserts, deletes, mismatches, unknowns, availableNow };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Split an America/New_York wall time "2026-11-20T15:00:00" into { day: "Fri, Nov 20", time: "3:00 PM" }. */
export function localParts(local: string): { day: string; time: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return { day: local, time: "" };
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return {
    day: `${wd}, ${MONTHS[mo - 1]} ${d}`,
    time: `${hour12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`,
  };
}

/** "2026-11-20T15:00:00" -> "Fri, Nov 20 · 3:00 PM ET" */
export function formatLocal(local: string): string {
  const { day, time } = localParts(local);
  return time ? `${day} · ${time} ET` : day;
}

export const COLOR_LIVE = 0x22c55e; // green: real availability
export const COLOR_TEST = 0xf59e0b; // amber: test alert
const EMBED_DESC_LIMIT = 4096;
const MAX_SESSIONS_IN_EMBED = 40;

export interface DiscordEmbed {
  title: string;
  url: string;
  description: string;
  color: number;
  footer: { text: string };
  timestamp: string;
}

export interface DiscordPayload {
  username: string;
  content: string;
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: never[] };
}

/** Group sessions by day: "**Sat, Nov 21**\n[11:00 AM](url) · [1:00 PM](url)". */
function sessionLines(sessions: Session[]): string[] {
  const lines: string[] = [];
  let currentDay = "";
  let slots: string[] = [];
  const flush = () => {
    if (currentDay) lines.push(`**${currentDay}**\n${slots.join("  ·  ")}`);
  };
  for (const s of sessions) {
    const { day, time } = localParts(s.startLocal);
    if (day !== currentDay) {
      flush();
      currentDay = day;
      slots = [];
    }
    slots.push(`[${time || s.startLocal}](${s.url})`);
  }
  flush();
  return lines;
}

/**
 * C6: one message, no mentions. A short plain-text line drives the push-notification preview;
 * the embed carries sessions grouped by day (each time is a link) and one primary CTA.
 */
export function buildMessage(
  opened: Session[],
  opts: { test?: boolean; nowIso?: string } = {},
): DiscordPayload {
  const n = opened.length;
  const sessionsWord = `${n} free session${n === 1 ? "" : "s"}`;
  const first = opened[0];
  const ctaUrl = first?.url ?? EVENT_URL;
  const firstWhen = first ? formatLocal(first.startLocal) : "";

  const content = opts.test
    ? `TEST · This is what a Turrell ticket alert looks like. No tickets opened.`
    : `Turrell tickets just opened: ${sessionsWord} at Almine Rech NY. Earliest: ${firstWhen}`;

  const intro = opts.test
    ? "**This is a test.** One sold-out session was flipped in memory to preview the alert. Nothing is actually available."
    : `**${sessionsWord}** just went from sold out to available. These sold out before, so book now.`;
  const cta = opts.test ? `[Open the event page →](${EVENT_URL})` : `**[Reserve a free slot →](${ctaUrl})**`;

  let shown = Math.min(n, MAX_SESSIONS_IN_EMBED);
  let description = "";
  for (;;) {
    const parts = [intro, "", ...sessionLines(opened.slice(0, shown))];
    if (n > shown) parts.push(`+${n - shown} more on the [event page](${EVENT_URL})`);
    parts.push("", cta);
    description = parts.join("\n");
    if (description.length <= EMBED_DESC_LIMIT || shown <= 1) break;
    shown--;
  }

  return {
    username: "Turrell Watch",
    content: content.slice(0, DISCORD_LIMIT),
    embeds: [{
      title: `${opts.test ? "TEST · " : ""}Tickets open: James Turrell at Almine Rech`,
      url: opts.test ? EVENT_URL : ctaUrl,
      description: description.slice(0, EMBED_DESC_LIMIT),
      color: opts.test ? COLOR_TEST : COLOR_LIVE,
      footer: { text: "361 Broadway, Tribeca · Free, timed entry · Checked every minute" },
      timestamp: opts.nowIso ?? new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

export function isExpired(nowMs: number): boolean {
  return nowMs >= END_UTC_MS;
}

/**
 * C7: force-test helper. Flip the earliest future 'unavailable' session to 'available'
 * in memory only. Returns null when nothing can be flipped.
 */
export function flipForTest(
  sessions: Session[],
  stored: Map<string, boolean>,
  nowMs: number,
): { sessions: Session[]; flippedId: string } | null {
  const candidate = sessions
    .filter((s) => s.state === "unavailable" && stored.get(s.id) === false && Date.parse(s.startUtc) > nowMs)
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc))[0];
  if (!candidate) return null;
  return {
    flippedId: candidate.id,
    sessions: sessions.map((s) => (s.id === candidate.id ? { ...s, state: "available" } : s)),
  };
}

export function backoffMinutes(consecutiveFailures: number): number {
  return Math.min(2 ** Math.max(consecutiveFailures, 1), 30);
}
