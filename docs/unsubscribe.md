# Unsubscribe, bounces and complaints

Every newsletter carries a one-click unsubscribe. This module issues the unsubscribe token, serves the page and endpoint,
accepts unsubscribe-by-email, and turns bounce and complaint events into suppressions. It does not send anything and does not
talk to any mail provider: events arrive already normalised (see "Feeding events in").

## The token

One token per recipient per list (optionally tagged with the issue it came from). Format: `1.<list>.<contact>.<issue or ->.<signature>`.

- Signed with HMAC-SHA256. It holds no email address and **has no expiry** (people unsubscribe from old emails).
- Changing the list, the contact or the issue invalidates the signature. Only one spelling of a signature is accepted.
- `UNSUB_TOKEN_SECRET` (a Secret, at least 16 characters) signs and verifies. To rotate it, put the old value in
  `UNSUB_TOKEN_SECRET_PREVIOUS` (comma-separated if several): old tokens keep verifying, new ones are signed with the new key.
  Remove the old value after a transition period (13 months covers a year of old emails).

## Links and headers for a send

```ts
import { unsubscribeLinks, unsubSecrets } from '@joelincc/mailroom/unsub';

const links = await unsubscribeLinks(
  unsubSecrets(env.UNSUB_TOKEN_SECRET, env.UNSUB_TOKEN_SECRET_PREVIOUS),
  { baseUrl: 'https://u.example.com', mailtoAddress: 'unsubscribe@mail.example.com' },
  { list: 'weekly', contactId: 42, campaign: 'weekly-7' },
);
links.url      // https://u.example.com/u/<token>      → compose's `unsubscribe_url`
links.mailto   // mailto:unsubscribe@mail.example.com?subject=<token> → `unsubscribe_mailto`
links.headers  // { 'List-Unsubscribe': '<url>, <mailto>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
```

Over the service binding: `env.MAILROOM.unsubscribeLinks({ list, email, campaign? })` (needs `UNSUB_BASE_URL`, optional `UNSUB_MAILTO`).
`baseUrl` must be `https`. Use a domain you control, not a shared `workers.dev` hostname.

## Endpoints (served by the Worker's `fetch`)

| Request | What it does |
|---|---|
| `GET /u/{token}` | Confirmation page with an optional reason. **Writes nothing**: corporate mail scanners prefetch links. |
| `POST /u/{token}` | Unsubscribes. The page button posts `reason=...`; mailbox providers post `List-Unsubscribe=One-Click` (RFC 8058). Repeating it returns the same success page and keeps the first timestamp and source. |
| `POST /u/{token}/resubscribe` | "Pressed by mistake": restores the subscription with the same token, within 30 days, only for self-service unsubscribes (not complaints, imports or API removals), and not for suppressed addresses. |

- The POST body may be urlencoded or multipart (RFC 8058 allows both) and is read as a stream, capped at 8 KB (413 above that).
- An invalid token returns `404` with a generic page and no detail. A database failure returns `503` (providers retry one-click).
- Pages send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a strict CSP and `noindex`; they run no script and load nothing external.
- Unsubscribing affects **only that list** (`list_members`); it never touches other lists or the global suppression list.
- Reasons: `too_many`, `not_relevant`, `never_subscribed`, `other` (stored in `list_members.unsub_reason`). There is no "send me fewer" option.

### Page text

The engine ships neutral English. Override any field with `UNSUB_PAGE` (a JSON object; only the fields you set change; `{list}` becomes the list name):

```json
{ "lang": "en", "confirmTitle": "Leave {list}?", "confirmButton": "Yes, unsubscribe", "reasons": { "other": "Another reason" }, "css": "body{max-width:40rem}" }
```

Fields: `lang`, `confirmTitle`, `confirmBody`, `confirmButton`, `reasonLegend`, `reasons`, `doneTitle`, `doneBody`, `resubscribeLead`, `resubscribeButton`,
`resubscribedTitle`, `resubscribedBody`, `resubscribeFailedTitle`, `resubscribeFailedBody`, `invalidTitle`, `invalidBody`, `retryTitle`, `retryBody`, `css`.

## Unsubscribe by email

Route `unsubscribe@your-mail-domain` (Cloudflare Email Routing) to the Worker. Its `email()` handler looks for a token in the **subject**
and unsubscribes (`unsub_source = 'mailto'`). It does not reply (no mail loops) and does not read the body. An encoded subject (`=?UTF-8?B?...?=` or `?Q?`) is decoded before the token is looked for.

### When an unsubscribe does not go through

A reader who wrote in has clearly asked to stop, so these three cases raise an alert instead of disappearing:

| Case | Alert `event` | What else happens |
|---|---|---|
| Mail without a token | `unsub_mail_no_token` | accepted; a person handles it |
| Token fails verification | `unsub_token_invalid` | page returns 404. From the web page only tokens of the right shape (a plausible token with a bad signature) alert; random strings typed into the URL are only logged |
| Database write failed while handling a mail | `unsub_write_failed` | the mail is **rejected** with `setReject` (permanent SMTP rejection carrying a short "use the link instead" text), so the sender is told it did not work |

The alert is a plain webhook, not tied to any service: `POST` JSON `{ event, at, from?, subject?, token?, via?, text, content }` to `UNSUB_ALERT_WEBHOOK`
(https only; optional `UNSUB_ALERT_TOKEN` is sent as a Bearer token; 5-second timeout; a failing webhook never breaks request handling).
`token` is the full token and `claims` (`list`, `contactId`, `campaign`) is read from it when its shape is right, so a person can tell who it was. Control characters are stripped from `from`, `subject` and `token`; web-page alerts are capped at 20 per minute and mail alerts at 60 per minute per Worker instance (separate budgets, so noise typed into the web page never hides a real unsubscribe mail; the rest are only logged). **`unsub_write_failed` is exempt from the budget** (a lost one can mean mail to someone who asked to stop). When a window dropped alerts, one summary alert `unsub_alerts_suppressed` (`suppressed`: how many) is sent when the window ends: by the next alert, or by the cron (`flushUnsubAlerts`). `text` and `content` hold the same one-line summary so common chat webhooks work through a small relay.

**If `UNSUB_ALERT_WEBHOOK` is not set**, nothing is lost silently: the same payload is written to the Worker log (`console.error`, visible only to the account owner; the log carries only the first 8 characters of the token plus `claims`, since a full token can unsubscribe that person),
and a warning is logged once per isolate (and on each scheduled run).

Why `setReject` and not `throw`: the Cloudflare docs only state that `setReject()` is a permanent SMTP error; they do not say what the sender sees when `email()` throws, so the documented call is used.

## Bounces and complaints

`applyFeedback(db, event, options?)` (in `src/feedback.ts`, exported as `@joelincc/mailroom/feedback`) is the only place that decides what an event does:

| Event | Effect |
|---|---|
| `bounce` / `permanent` | `suppressions` `hard_bounce`. Blocks **every** stream, including sign-in notices. List membership is left alone. |
| `complaint` | `suppressions` `complaint` (blocks every stream) **and** every list the person is on becomes `unsubscribed` with `unsub_source = 'complaint'` (earlier self-unsubscribes keep their own time and source). |
| `bounce` / `transient` | Not blocked. Only `cause: 'mailbox'` bounces (mailbox full, receiving server temporarily down, recipient-side throttling) are counted: one row per (address, issue) in `bounce_streaks`, the same issue twice counts once. **Three different issues in a row** (no delivery in between) → treated as a hard bounce (`detail = transient_streak:3`). `cause: 'content'` (content or attachment rejected, message too large) says nothing about the mailbox and is **not** counted; a missing `cause` or a missing issue id is not counted either. |
| `delivery` | Clears the address's transient streak. |

Everything is idempotent: the same event twice leaves the same state. Lifting a suppression stays a manual act (`POST /v1/unsuppress`).

### Feeding events in

The provider layer (SNS verification, Resend webhooks, a fake provider in tests) must verify authenticity and de-duplicate, then call
`applyFeedback` once per recipient with an already normalised event:

```ts
await applyFeedback(db, { type: 'bounce', kind: 'permanent', email, source: 'ses', detail: 'NoEmail' });
await applyFeedback(db, { type: 'bounce', kind: 'transient', email, campaign: 'weekly-7', cause: 'mailbox', source: 'ses' });
await applyFeedback(db, { type: 'complaint', email, source: 'ses' });
await applyFeedback(db, { type: 'delivery', email });
```

Mapping for SES transient bounces: `General` and `MailboxFull` → `cause: 'mailbox'`; `ContentRejected`, `AttachmentRejected` and `MessageTooLarge` → `cause: 'content'`.

The existing Resend webhook (`webhook.ts`) and Cloudflare event consumer (`cf-events.ts`) already go through `applyFeedback` for hard bounces and complaints, so a complaint from any provider also unsubscribes the person from every list. Their transient bounces and delivery events are not wired in yet (they carry no issue id).

It returns `hard_bounce`, `complaint`, `transient_counted`, `transient_promoted`, `transient_no_campaign`, `transient_not_counted`, `delivery` or `rejected` (bad address or unknown type).

## Migration

`0007_unsubscribe.sql`: `list_members.unsub_reason` and the `bounce_streaks` table. Nothing changes for existing sends.
