// Pure logic for the Turrell ticket monitor. No Deno/Supabase globals here so
// everything is unit-testable against fixtures without network access.

export const SERIES_ID = "2004288042489";
export const EVENT_URL =
  "https://www.eventbrite.com/e/james-turrell-exhibition-at-almine-rech-new-york-tickets-2004288042489";
/** Series ends 2027-01-30 18:00 America/New_York. After this the monitor no-ops. */
export const END_UTC_MS = Date.parse("2027-01-30T23:00:00Z");
export const MAX_PAGES = 5;
export const FETCH_TIMEOUT_MS = 15_000;
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
export const SOON_MINUTES = 120; // flag sessions starting within 2 hours
const TZ = "America/New_York";
// Discord limits: embed total 6000, description 4096, field value 1024, 25 fields.
const EMBED_BUDGET = 5500;
const MAX_DAY_FIELDS = 18; // 6 rows of 3 inline fields
const ZWSP = "\u200b";

export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  url: string;
  description: string;
  color: number;
  fields?: DiscordField[];
  footer: { text: string };
  timestamp: string;
}

export interface DiscordPayload {
  username: string;
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: never[] };
}

/** "1 PM", "12:30 PM" from "2026-11-20T13:00:00". */
export function shortTime(local: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(local);
  if (!m) return local;
  const h = Number(m[1]);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${m[2] === "00" ? "" : `:${m[2]}`} ${h < 12 ? "AM" : "PM"}`;
}

/** Calendar date (YYYY-MM-DD) in New York for an instant. */
export function nyDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "Today · Fri, Nov 20", "Tomorrow · Sat, Nov 21", "Sun, Nov 29", "Sat, Jan 30, 2027" (year only if not this year). */
export function dayLabel(dayKey: string, nowMs: number): string {
  const today = nyDate(nowMs);
  const { day } = localParts(`${dayKey}T00:00`);
  const withYear = dayKey.slice(0, 4) !== today.slice(0, 4) ? `${day}, ${dayKey.slice(0, 4)}` : day;
  if (dayKey === today) return `Today · ${withYear}`;
  if (dayKey === addDays(today, 1)) return `Tomorrow · ${withYear}`;
  return withYear;
}

/** "⚡ in 40 min" / "⚡ in 1 h 5 min" when the session starts within SOON_MINUTES, else "". */
export function soonFlag(startUtc: string, nowMs: number): string {
  const mins = Math.round((Date.parse(startUtc) - nowMs) / 60_000);
  if (!(mins > 0 && mins <= SOON_MINUTES)) return "";
  const h = Math.floor(mins / 60);
  return `⚡ in ${h ? `${h} h ${mins % 60} min` : `${mins} min`}`;
}

interface DayGroup {
  key: string;
  sessions: Session[];
}

function groupByDay(sessions: Session[]): DayGroup[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.startLocal.slice(0, 10);
    map.set(key, [...(map.get(key) ?? []), s]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, sessions]) => ({
    key,
    sessions,
  }));
}

/** Field value for one day: linked times, or "All N times · 11 AM–5 PM" when every remaining time opened. */
function dayValue(g: DayGroup, remainingThatDay: number): string {
  const s = g.sessions;
  if (s.length >= 2 && s.length >= remainingThatDay) {
    const range = `${shortTime(s[0].startLocal)}–${shortTime(s[s.length - 1].startLocal)}`;
    return `[All ${s.length} times](${s[0].url}) · ${range}`;
  }
  return s.map((x) => `[${shortTime(x.startLocal)}](${x.url})`).join(" · ");
}

function embedSize(e: DiscordEmbed): number {
  return e.title.length + e.description.length + e.footer.text.length +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/**
 * C6: one embed-only message, no mentions.
 * - 1 session: date + time is the headline, single "Reserve this slot" CTA.
 * - many: one inline field per day (grid), "All N times" collapsing, capped by Discord's
 *   size limits with "+N more days" linking to the event page; CTA to the earliest slot.
 * `allSessions` (the full classified snapshot) lets us detect when a whole day opened.
 */
export function buildMessage(
  opened: Session[],
  opts: { test?: boolean; nowMs?: number; nowIso?: string; allSessions?: Session[] } = {},
): DiscordPayload {
  const nowMs = opts.nowMs ?? Date.now();
  const sorted = [...opened].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const first = sorted[0];
  const testPrefix = opts.test ? "TEST · " : "";
  const testNote = opts.test
    ? "**Test alert.** One sold-out session was flipped in memory to preview this. Nothing is actually available.\n\n"
    : "";
  const footer = { text: "Almine Rech · 361 Broadway, Tribeca · Times in ET · Checked every minute" };
  const base = {
    color: opts.test ? COLOR_TEST : COLOR_LIVE,
    footer,
    timestamp: opts.nowIso ?? new Date(nowMs).toISOString(),
  };
  const wrap = (embed: DiscordEmbed): DiscordPayload => ({
    username: "Turrell Watch",
    embeds: [embed],
    allowed_mentions: { parse: [] },
  });

  if (!first) {
    return wrap({ ...base, title: `${testPrefix}Turrell tickets`, url: EVENT_URL, description: testNote });
  }

  const firstDay = dayLabel(first.startLocal.slice(0, 10), nowMs);
  const firstSoon = soonFlag(first.startUtc, nowMs);

  // Single session: the date and time are the headline.
  if (sorted.length === 1) {
    return wrap({
      ...base,
      title: `${testPrefix}${firstDay} · ${shortTime(first.startLocal)} just opened`,
      url: first.url,
      description:
        `${testNote}James Turrell at Almine Rech · free, timed entry${firstSoon ? `\n${firstSoon}` : ""}` +
        `\n\n**[Reserve this slot →](${first.url})**`,
    });
  }

  // Many sessions: grid of day fields.
  const groups = groupByDay(sorted);
  const remaining = new Map<string, number>();
  for (const s of opts.allSessions ?? sorted) {
    if (Date.parse(s.startUtc) > nowMs) {
      const k = s.startLocal.slice(0, 10);
      remaining.set(k, (remaining.get(k) ?? 0) + 1);
    }
  }
  const earliest = `earliest ${firstDay.split(" · ")[0]} ${shortTime(first.startLocal)}${
    firstSoon ? ` ${firstSoon}` : ""
  }`;
  const embed: DiscordEmbed = {
    ...base,
    title: `${testPrefix}${sorted.length} Turrell sessions just opened`,
    url: first.url,
    description: `${testNote}${groups.length} day${groups.length === 1 ? "" : "s"} · ${earliest}`,
    fields: [],
  };
  const cta: DiscordField = { name: ZWSP, value: `**[Reserve the earliest slot →](${first.url})**` };
  const moreField = (n: number): DiscordField => ({
    name: `+${n} more day${n === 1 ? "" : "s"}`,
    value: `[See all dates on Eventbrite →](${EVENT_URL})`,
  });
  let shown = 0;
  for (const g of groups) {
    const field = {
      name: dayLabel(g.key, nowMs),
      value: dayValue(g, remaining.get(g.key) ?? 0),
      inline: true,
    };
    const projected = embedSize({ ...embed, fields: [...embed.fields!, field, moreField(99), cta] });
    if (shown >= MAX_DAY_FIELDS || projected > EMBED_BUDGET || field.value.length > 1024) break;
    embed.fields!.push(field);
    shown++;
  }
  if (shown < groups.length) embed.fields!.push(moreField(groups.length - shown));
  embed.fields!.push(cta);
  return wrap(embed);
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
