# T001 — How Eventbrite exposes availability (event 2004288042489)

## Shape
- Series parent (isSeries/isParentEvent/isTimedEntry = true), free ($0), venue Almine Rech NY, 361 Broadway.
- 279 current/future hourly child sessions (11:00–17:00 ET starts), first 2026-11-20 12:00, **last session 2027-01-30 17:00 ET** (series end 2027-01-30 18:00 ET = 23:00Z). Ticket sales end 2027-01-30 16:00 ET (21:00Z).
- Child IDs are not contiguous (e.g. 2004288217011 … 2004633038381), so dates were added in batches; new dates may appear → must re-enumerate every check.
- At 2026-11-20 ~17:30Z all 279 sessions: is_sold_out=true, has_available_tickets=false, waitlist_available=false.

## Signals compared
| Source | Verdict |
|---|---|
| Event page HTML `__NEXT_DATA__` `context.salesStatus.salesStatus` | parent-level only; CloudFront `s-maxage=300, stale-while-revalidate=43200` → can be minutes–hours stale. **Reject.** |
| JSON-LD `offersSchema.availability` | says `InStock` while sold out. **Wrong — reject.** |
| `/api/v3/destination/events/?event_ids=<parent>` | parent shows `sales_status: on_sale`, `is_sold_out: null`. **Misleading for parent.** Works per child id (sold_out/tickets_sold_out). |
| **`/api/v3/series/2004288042489/events/?time_filter=current_future&page_size=200&expand=ticket_availability`** | No token needed. `cache-control: no-cache, no-store`, CloudFront Miss → live. Each child has `ticket_availability.{is_sold_out, has_available_tickets, waitlist_available, start_sales_date}`, plus `start.local`, `url`, `status`. 279 sessions = **2 requests** (page 2 via `continuation`). **CHOSEN.** |

## Availability rule (per child)
available := `ticket_availability.has_available_tickets === true` OR `ticket_availability.is_sold_out === false`, and child `status` in (live, started), and start time in the future.
Missing ticket_availability on a child → treat as "unknown", never as available (record error).

## Politeness
- Full check = 2 GETs. At 1 check/min ≈ 2 req/min; at 30s ≈ 4 req/min. Both negligible.
- No rate-limit headers observed. Use a browser-like UA, backoff on 403/429/5xx.

## Fixtures (notes/fixtures/)
page.html, next_data.json, destination.json, dest_children.json, series_full.json (page 1, 200), series_full_p2.json (page 2, 79), *.headers.txt.
