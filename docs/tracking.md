# Click and open tracking

The engine tracks clicks and opens itself; it does not use the email provider's tracking. That keeps the numbers comparable if
the provider changes, lets you use your own tracking host, and writes everything into the same `events` table that the
analytics export reads (`docs/export.md`).

## Setup

| Setting | What it does |
|---|---|
| `TRACK_BASE_URL` | the tracking origin, e.g. `https://t.example.com` (https, no path). Route that host to the Worker. Use the same value as `trackBase` when composing. |
| `TRACK_TOKEN_SECRET` | Secret, at least 16 characters. Signs the per-recipient link and pixel tokens. |
| `TRACK_TOKEN_SECRET_PREVIOUS` | optional, comma-separated: old secrets still accepted during a rotation (never used to sign; if the current secret is missing or too short, tracking is off rather than falling back to an old one). |
| `TRACK_CONFIG` | optional JSON, only the fields you want to change (see below). |

Without `TRACK_BASE_URL` and a secret, the endpoints do not exist (other routes handle the request as before). Content composed
with `trackBase` cannot be sent without both, or when its tracking links are not under `TRACK_BASE_URL`: rendering fails and the
issue pauses (`render_error`) instead of sending links that would not work. Link destinations are stored normalised
(`new URL(url).href`: non-ASCII paths percent-encoded), because a redirect header can only carry ASCII. Issues composed without `trackBase` are sent untracked as before.

The desk command `create` stores the issue's link table (`links`, from `compose()`) with the issue. `saveDraft` refuses content
that uses `{{c:N}}` without a link table entry for every N (`links_missing`), and the link table is part of the content hash, so
changing where a link goes requires a new approval.

## Endpoints

| Request | Response |
|---|---|
| `GET` / `HEAD /c/{token}` | `302` to link N of that issue; records a `click` |
| `GET` / `HEAD /o/{token}.gif` | a 1×1 transparent GIF, always (also for invalid tokens); records an `open` when the token is valid and the request is a `GET` |

Responses carry `cache-control: no-store` and `referrer-policy: no-referrer`.

### Why it cannot be used as an open redirect, or to look up readers

- A token holds only `kind | issue | contact id | link number` and a 128-bit HMAC-SHA-256 signature. **The destination is not in
  the token.** The redirect looks up link N in the issue's stored link table, so it can only lead to a URL that is in that issue.
- Tokens are verified before the database is touched. A forged or altered token, an unknown issue and an unknown link number all
  get the same `404` with the same body, so the endpoint does not reveal which issues or contact ids exist. The pixel answers
  the same GIF either way.
- Events carry the issue and contact id, never the address. Anything shaped like an address in `detail` is scrubbed.
- Contact id `0` is a test mail: it redirects and records nothing.
- If reading the link table fails, the answer is `503` (try again), never a redirect somewhere else.

### Speed and failure

The redirect needs one read (the issue's link table, cached per Worker instance for 5 minutes). Writing the event happens after
the response (`waitUntil`); if the write fails it is logged and the reader is redirected anyway.

## Event rules

| Event | `provider_event_id` (dedupe) | `detail` |
|---|---|---|
| click | `self:c:{issue}:{contact}:{link}:{window}` — one per link per `clickDedupeSeconds` (default 60) | `url`, `linkIndex`, `asn`, `ua` (first 200 chars), `suspect` / `scannerRule` when marked |
| open | `self:o:{issue}:{contact}:{p|h}:{window}` — one per `openDedupeSeconds` (default 3600), prefetch and non-prefetch counted separately | `prefetch: true` when detected, `asn`, `ua` |

The window is a fixed time bucket, so two clicks a second apart can still land in two buckets near a boundary. Non-suspect clicks
update `list_members.last_click_at`; non-prefetch opens update `last_open_at`.

### Scanner clicks (`detail.suspect = "scanner"`)

Marked, never deleted; leave them out when counting clicks. A click is marked when:

| `scannerRule` | Rule |
|---|---|
| `burst` | the message got clicks on 3 or more different links within 60 seconds of being sent (`detectScannerClicks`; `scannerWindowMs`, `scannerMinLinks`). All clicks of that message inside the window are marked. |
| `head` | the request was a `HEAD` (link checkers; people's browsers use `GET`). |
| `asn` | the request came from a network listed in `scannerAsns` (default: none). |

Basis: mail security products (for example Microsoft Defender for Office 365 Safe Links) rewrite and check links, and scanners
fetch links before delivery or right after it, often several at once; analysts treat clicks that arrive within seconds of
delivery or in tight clusters as automated. Known limits: a scanner that clicks only one or two links, or clicks later, is not
caught; a person who opens the mail immediately and clicks three links within a minute is marked. `scannerAsns` is empty by
default because people behind corporate proxies or on cloud desktops can come from the same networks as scanners — add networks
only after checking your own data.

### Prefetched opens (`detail.prefetch = true`)

Apple Mail Privacy Protection loads remote images through Apple's proxy servers when the message is delivered, whether or not it
is read, so every such load looks like an open. The engine writes `prefetch: true` explicitly (the contract in `docs/export.md`)
when the request comes from a network in `prefetchAsns` (default `[714]`, the autonomous system Apple operates, read from
Cloudflare's `request.cf.asn`) or its user agent contains a string in `prefetchUserAgents` (default none).

Known limits: this flags any image load from Apple's network, so a real open in Apple Mail with protection turned on is also
flagged (it cannot be told apart — that is the point of the feature). Other clients that cache images on delivery are not
detected by default. Gmail's image proxy normally fetches when the message is opened and is counted as an open. Treat open
rates as indicative and compare them only within the same tracking method; check a real message end to end before relying on
the flag.

## `TRACK_CONFIG`

```json
{ "scannerWindowMs": 60000, "scannerMinLinks": 3, "scannerAsns": [], "prefetchAsns": [714],
  "prefetchUserAgents": [], "clickDedupeSeconds": 60, "openDedupeSeconds": 3600 }
```

Unreadable values fall back to the defaults. The ledger site used to match a click to its message is the broadcast `site`.

## Not tracked

Only links in the article body are rewritten (`docs/composing.md`): the unsubscribe link, `mailto:`/`tel:` links and the
web-version link are never tracked. Test mail redirects but records nothing.
