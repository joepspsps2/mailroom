# Analytics export

Hand the delivery events, issues, frozen recipient lists and list members to an outside analytics pipeline as paged NDJSON.
All endpoints need the admin bearer token (a wrong or missing token gets `404`, so the endpoints do not reveal themselves)
and have their own rate bucket (`_export`: 60 per minute, 1000 per day), separate from the other admin endpoints.

| Endpoint | Cursor | Rows |
|---|---|---|
| `GET /v1/export/events?cursor=&limit=` | event `id` | every row of `events` (provider feedback plus open/click/unsubscribe), oldest first |
| `POST /v1/export/events/ack` `{ "through": id }` | | sets `exported_at` on events with `id <= through` |
| `GET /v1/export/campaigns?cursor=&limit=` | row number | one row per issue (state, timestamps) |
| `GET /v1/export/recipients?campaign=&cursor=&limit=` | `contact_id` | the frozen list of one issue: who it was for and their segment **at send time** |
| `GET /v1/export/members?list=&cursor=&limit=` | `contact_id` | everyone on one list now, with address and segment (for the weekly snapshot) |

`limit` defaults to 2000, at most 5000. Each response is one JSON object per line. Paging state is in response headers:
`x-export-count`, `x-export-has-more` (`1`/`0`) and `x-export-next-cursor` (pass it back as `cursor`; empty when done).

## Guarantees

- **Reads change nothing.** Pulling the same cursor again returns the same rows (plus anything newer at the end). A consumer that
  fails half way restarts from the last cursor it durably stored: nothing is skipped and nothing is stored twice as long as the
  consumer de-duplicates on `id` / `provider_event_id`.
- **`ack` is a marker, not a position.** The consumer keeps its own cursor; it calls `ack` only after the pulled rows are safely
  stored. `ack` can be repeated, never marks beyond the current highest id, and can be used later to decide which events are old
  enough to purge.
- **Order.** D1 commits writes one at a time, so when `id` N+1 is visible N is too; paging by `id` never skips a row.
- **No addresses in events, campaigns or recipients.** Events carry `contact_id`; join to the members export for the address.
  Only the members export contains addresses, so keep its output as private as the list itself.

## Event shape

```json
{ "id": 812, "provider": "self", "provider_event_id": "…", "message_id": 77, "provider_message_id": "…",
  "campaign_id": "weekly-163", "contact_id": 12, "type": "click", "subtype": null,
  "at": "2027-03-01T01:07:00.000Z", "detail": { "url": "https://…", "linkIndex": 1, "suspect": "scanner" }, "exported_at": null }
```

`detail` is the stored JSON (or `null`). Anything shaped like an email address is replaced with `[email]` when the event is recorded and again on export (`@channel`-style handles are not addresses and stay). Contract the analytics side relies on:

- `detail.suspect = "scanner"` marks a click that a security scanner made (see `docs/composing.md`). Keep these rows, do not count them.
- **`detail.prefetch = true` must be written explicitly by the tracking service** for opens that mail-privacy prefetching made. The user-agent string (`detail.ua`) is only a fallback hint and is not reliable; check a real message end to end once the tracker exists.
- `detail.linkIndex` / `detail.url` identify the link of a click.
- Unsubscribes are recorded by the engine itself when someone goes from subscribed to unsubscribed through the unsubscribe page, the one-click endpoint or an unsubscribe mail: `type = "unsubscribe"`, `detail = { via: "link" | "one_click" | "mailto", list, reason? }`. Repeating the request records nothing more.

## Test data

`tests/export-fixture.ts` builds two complete issues with the fake postman (bounces, a complaint, opens, prefetch opens, clicks,
scanner clicks, unsubscribes) using only `@example.com` addresses. Run
`node --experimental-strip-types tests/export-fixture.ts <dir>` to write the same data as NDJSON files for an outside pipeline's tests.
