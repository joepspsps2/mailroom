# Newsletter lists

Lists are the source of truth for "who gets the newsletter". They live in the same D1 database as the ledger
(migration `0005_lists.sql`: `contacts`, `lists`, `list_members`). Sending is a separate step and is not covered here.

## Model

- `contacts`: one row per address, shared by every list. Addresses are trimmed and lower-cased.
- `lists`: one row per newsletter (`weekly`, `promo`, ...). Create one with `PUT /v1/lists/{id}`.
- `list_members`: a person's state on one list: `subscribed` or `unsubscribed`, where they came from, an optional engagement group.
- `suppressions` (existing): global refusals. It only holds hard bounces, complaints and "no newsletters at all".
  **Unsubscribing from one list is recorded in `list_members` only**, so someone on two lists can leave one and keep the other.

## Rules

1. **Subscribe** is refused (`blocked`) when the address has any suppression (`hard_bounce`, `complaint`, `unsubscribe`).
   Lift one deliberately with `POST /v1/unsuppress`.
2. **Re-subscribe**: a person who unsubscribed can subscribe again. Only the person's own subscribe action does this:
   status goes back to `subscribed`, the unsubscribe fields are cleared and `source` records the new entry point.
3. **Imports and syncs never turn `unsubscribed` into `subscribed`.** They can only make someone "not sent to".
4. Unsubscribing twice is harmless: the first timestamp and source are kept.
5. New members get `segment = '新進觀察群'` ("new, unobserved") until a real group is written in.

## Internal interface (service binding)

```ts
env.MAILROOM.listSubscribe({ list, email, source, consentVersion, name? })   // 'subscribed' | 'already' | 'blocked'
env.MAILROOM.listUnsubscribe({ list, email, source })                         // 'unsubscribed' | 'not_member'
env.MAILROOM.listStatus({ list, email })                                      // 'subscribed' | 'unsubscribed' | 'not_found' | 'blocked'
env.MAILROOM.listMembers({ list, status?, cursor?, limit? })                  // { members, next }, 1,000 per page
```

Each `listMembers` row has `suppressed` (the address is on the global suppression list, same meaning as `listStatus` = `blocked`) and `unsubReason`.
Bad input returns `{ status: 'rejected', reason }` (`bad_email`, `bad_list`, `unknown_list`, `bad_source`, ...) instead of throwing.
`listStatus` reports `blocked` for a subscribed member who is on the global suppression list; an unsubscribed member always shows `unsubscribed`.
`source` for unsubscribe is one of `link`, `one_click`, `mailto`, `api`, `import`, `import-removed`, `complaint` (default `api`).

## Admin endpoints (bearer `DRILL_TOKEN`, shared admin rate limit)

| Request | Body | Notes |
|---|---|---|
| `PUT /v1/lists/{id}` | `{ name, fromAddr?, replyTo?, welcomeTemplate? }` | create or update |
| `POST /v1/lists/{id}/segments` | `{ items: [{ email, segment, segmentLabel? }] }` | up to 5,000 per call; updates existing members only; idempotent |
| `POST /v1/lists/{id}/import` | `{ importedFrom, rows, dryRun?, expected? }` | up to 2,000 rows per call; see below |

## Importing

Each row is `{ email, status, name?, subscribedAt?, unsubscribedAt?, source?, consentVersion? }` with `status` one of:

| Status | Where it lands |
|---|---|
| `subscribed` | `list_members` subscribed. Skipped if the address is suppressed (`blocked`) or already unsubscribed (`kept_unsubscribed`). |
| `unsubscribed` | `list_members` unsubscribed, `unsub_source = 'import'`. |
| `removed` | `list_members` unsubscribed, `unsub_source = 'import-removed'`. Not sent to, but **not** added to the global suppression list. |
| `bounced` | `suppressions` `hard_bounce`, `source = 'import'`. No list membership. |
| `complained` | `suppressions` `complaint`, `source = 'import'`. No list membership. |

- The whole call is validated first. Any invalid row (bad address, unknown status) or an `expected` count that does not match
  the de-duplicated input rejects the call with nothing written. `expected` is `{ subscribed: n, ... }` and is for reconciliation against the source system.
- The same address twice in one call: the most restrictive status wins (`complained` > `bounced` > `removed` > `unsubscribed` > `subscribed`); counted in `duplicates`.
- Re-running the same import changes nothing and creates no duplicates.
- `dryRun: true` returns the same report without writing.
- Large imports: split into calls of at most 2,000 rows; each call is idempotent, so a failed call can simply be repeated.
  The report's `outcomes` are for that call only; add them up across calls to reconcile.

A leaked `DRILL_TOKEN` can also add, remove and re-label list members through these endpoints (it cannot read recipients' mail or the ledger). Treat it as described in the README.
