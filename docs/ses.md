# Amazon SES as the newsletter postman

The broadcast engine can hand newsletter mail to Amazon SES (API v2) and read SES delivery events back. Code:
`src/broadcast/ses.ts` (sending and limits), `src/ses-events.ts` (events), `src/aws-sigv4.ts` (request signing, no AWS SDK,
no extra dependency). SES is used for newsletters only; transactional mail keeps its own providers and sending domain.

Everything below uses example values (`mail.example.com`, `us-east-1`, account `123456789012`).

## What it does

- **Send** — `SendEmail` with Simple content, UTF-8 subject and bodies, the two unsubscribe headers
  (`List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) produced by `render`, a configuration set,
  and two message tags (`campaign`, `contact`) so events can be matched back to the issue and the person. Display names
  outside ASCII are RFC 2047 encoded. A custom MAIL FROM domain is a property of the SES identity, not of the request:
  set it on the identity and it applies to every message.
- **Limits** — `GetAccount` once per `limitsRefreshMinutes`: `MaxSendRate` (per second), `Max24HourSend`,
  `SentLast24Hours` and `EnforcementStatus`. The 24-hour quota is rolling, so today's cap is at most "already sent today
  + what SES says is left". If sending is disabled or the status is not `HEALTHY`, the engine stops handing over mail.
- **Events** — configuration set → SNS topic → HTTPS subscription → `POST /webhooks/ses`.

## Error mapping

SES has no idempotency key, so the postman only reports "not sent" when SES gave a definite answer:

| SES answer | Postman result | What the engine does |
|---|---|---|
| 200 with `MessageId` | ok | ledger row `sent` |
| 429, `TooManyRequestsException`, `Throttling` (rate) | `throttled` | that mail retries in 30 s, the next minute releases half |
| `Throttling` "Daily message quota exceeded" | `account_paused` | issue paused (no retry loop) |
| `AccountSuspendedException`, `SendingPausedException`, `MailFromDomainNotVerifiedException`, `NotFoundException` (configuration set), any 403 (keys, permissions) | `account_paused` | issue paused: every mail would fail the same way |
| other 4xx (`MessageRejected`, `BadRequestException`, e.g. an unverified recipient in the sandbox) | `permanent` | that recipient `failed` |
| 5xx, timeout, network error, 200 without `MessageId` | throws | recipient marked `uncertain`, never re-sent automatically |

## Events

Every request to `/webhooks/ses` is verified before anything is read from it
([AWS: verifying SNS message signatures](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)):

1. `TopicArn` must be in `SES_SNS_TOPIC_ARNS` and in `SES_REGION`.
2. `SigningCertURL` must be `https://sns.<SES_REGION>.amazonaws.com/SimpleNotificationService-….pem` — no other host,
   port, user info or query. The certificate is fetched over HTTPS, cached for an hour, and must be within its validity
   period.
3. The signature is checked over the documented string to sign. `SignatureVersion 2` (SHA-256) only, unless
   `SES_SNS_ALLOW_SHA1 = "true"`. Set the topic's signature version to 2.
4. `Timestamp` older than 7 days or more than 15 minutes in the future is refused. Inside that window a replay is
   ignored because the SNS `MessageId` is recorded in `webhook_events` (shared with the other providers).

A subscription confirmation is accepted only after the same checks, and only if `SubscribeURL` is the same SNS host
with `Action=ConfirmSubscription` and the same topic. Unsubscribe confirmations are logged and ignored.

Notifications are normalised to provider events (one per recipient) and handed to `ingestEvent`:

| SES `eventType` | Event | Feedback |
|---|---|---|
| `Send` | `send` | — |
| `Delivery` | `delivery` | ends a transient-bounce streak |
| `Bounce`, `bounceType: Permanent` (any subtype) | `bounce` / `Permanent` | global suppression `hard_bounce` |
| `Bounce`, `Transient` / `MailboxFull` | `bounce` / `Transient`, cause `mailbox` | counts toward the streak (3 issues → `hard_bounce`) |
| `Bounce`, `Transient` / `MessageTooLarge`, `ContentRejected`, `AttachmentRejected` | cause `content` | not counted |
| `Bounce`, `Transient` / `General`, `CustomTimeoutExceeded`; `Undetermined` | no cause | not counted |
| `Complaint` | `complaint` | global suppression `complaint`, unsubscribed from every list |
| `Complaint` with feedback type `not-spam` | — | ignored (a correction, not a complaint) |
| `Reject`, `Rendering Failure` | `reject` | — |
| `DeliveryDelay` | `delay` | — |
| `Open`, `Click`, `Subscription` | — | ignored (opens and clicks are tracked by the engine itself) |

A recipient named in an event only counts if it was a recipient of the original message (`mail.destination`). mailroom
sends one recipient per message, so an event naming a different address (for example the target of an automatic
forward) is attributed to that one recipient.

## Setup

AWS side (one region):

1. Verify the sending domain as an SES identity (Easy DKIM) and set a custom MAIL FROM subdomain on it.
2. IAM user for the Worker with only `ses:SendEmail` on the identity and the configuration set, and `ses:GetAccount`.
3. SNS topic (standard), signature version 2. Subscribe `https://<your worker>/webhooks/ses` (HTTPS protocol, raw
   message delivery **off**). The endpoint confirms the subscription itself.
4. Configuration set with an SNS event destination for Send, Delivery, Bounce, Complaint, Reject, Rendering Failure
   and Delivery Delay, pointing at that topic.
5. Account-level suppression list on for bounces and complaints (optional but recommended).

Worker:

```jsonc
"vars": {
  "MARKETING_DOMAIN": "mail.example.com",
  "NEWSLETTER_POSTMAN": "ses",
  "SES_REGION": "us-east-1",
  "SES_CONFIGURATION_SET": "newsletter-events",
  "SES_SNS_TOPIC_ARNS": "arn:aws:sns:us-east-1:123456789012:newsletter-events"
}
// Secrets: SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY
```

Without `SES_SNS_TOPIC_ARNS` and `SES_REGION`, `/webhooks/ses` answers 404. Without all four `SES_*` sending values,
`NEWSLETTER_POSTMAN = "ses"` disables broadcasting (and logs why) rather than sending without events.

## Testing in the SES sandbox

The sandbox only delivers to verified addresses and to the SES mailbox simulator (`success@`, `bounce@`,
`complaint@`, `ooto@`, `suppressionlist@simulator.amazonses.com`). Simulator mail does not count toward your
bounce and complaint rates. A newsletter list used for sandbox tests should contain only those addresses.
