# Newsletter broadcasting (preview)

Sends one newsletter issue to a frozen list, in waves, at a steady pace, with automatic brakes. Code: `src/broadcast/`
(exported as `@joelincc/mailroom/broadcast`), tables: migration `0006_broadcast.sql`. Status: **preview** — the only
built-in newsletter postman is a fake one; a real provider plugs in through the `Postman` interface.

Everything below uses example values (`mail.example.com`, a 2,000-person list). Your real numbers belong in your private config.

## One issue, start to finish

```
draft ──approve──▶ approved ──schedule──▶ scheduled ──(cron, at time)──▶ sending ⇄ paused ──▶ done
  ▲                   │  ▲                    │                                       │
  └── content edited ─┘  └──── unschedule ────┘                 cancelled ◀── (draft / approved / scheduled / paused)
```

1. **Draft** — `PUT /v1/campaigns/{id}` with subject, sender (must be on `MARKETING_DOMAIN`), HTML, text, the web version
   URL (`webUrl`, required before scheduling), extra headers (only `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`
   and `X-…`) and the audience. Editing a draft,
   an approved or a scheduled issue sends it back to `draft` and clears approval and the pre-send check.
   After `sending` the content is locked.
2. **Pre-send check** — run the compose module's `preflight()` (it needs the network to check links), then
   `POST /v1/campaigns/{id}/preflight` with the result. It is tied to a hash of the content; any edit invalidates it.
3. **Approve** — `POST /v1/campaigns/{id}/approve { note }`. The note is required ("who said yes, when, where").
4. **Schedule** — `POST /v1/campaigns/{id}/schedule { at }`. Refused unless the approval and a passing pre-send check
   match the current content.
5. **Start** (cron, once `scheduled_at` has passed) — the issue moves to `sending` and the list is **frozen** into
   `campaign_recipients`: every member who is `subscribed` at that moment. Members on the global suppression list are
   written as `skipped/suppressed`; members outside this issue's audience as `skipped/warmup`. People who subscribe later
   are not part of this issue. People who unsubscribe or get suppressed later are checked again right before their mail
   is handed over, and skipped (`skipped/unsubscribed`, `skipped/suppressed`).
6. **Waves and pacing** (cron, every minute) — recipients are released into the `mailroom-broadcast` queue, wave by wave,
   in audience order. Per minute the engine releases the smallest of:
   - provider speed: `perSecond × 60 × rateFactor` (default 0.8), halved for one minute after a throttling reply;
   - what is left today: your own daily cap (`maxPerDay`, local day, default UTC+8) and the provider's 24-hour quota,
     minus mails already handed over;
   - the pace: `ceil(people to send ÷ paceMinutes)` (default 150 → a 2,000-person issue takes about 2½ hours);
   - what is left in the current wave.
   A new wave starts no earlier than `waveGapMinutes` (60) after the previous one started and `waveGateWaitMinutes` (30)
   after its last mail, and only if the previous wave's hard-bounce rate is below `waveGateBounceRate` (2%).
7. **Hand-over** (queue consumer, one at a time, spaced to the provider's per-second limit) — each recipient is one ledger
   row in `messages` (`stream='marketing'`, `tier='marketing'`, key `c:{issue}:{contact}`).
8. **Reconcile** — when nobody is left to send, the engine checks
   `frozen = sent + skipped (per reason) + failed + uncertain + pending`, that every sent recipient has a `sent` ledger
   row and the ledger has no extra ones, and that provider events show no second mail to anyone. Only then is the issue
   `done`. Any mismatch pauses it (`reconcile_mismatch:…`) for a person to look at. Events that simply have not arrived
   yet (deliveries, late complaints) are listed as `awaiting`, not as a mismatch. Run `POST /v1/campaigns/{id}/reconcile`
   again later (for example after 72 hours) for the final numbers.

## Never twice

- One idempotency key per person per issue. A ledger row that is already `sent` only ever answers `duplicate`.
- The ledger row is created **before** the mail is handed to the provider. Unlike transactional mail, a newsletter row
  stuck in `sending` is never re-claimed: if the Worker died mid-hand-over, or the provider threw (we cannot know whether
  it accepted the mail), that recipient becomes `uncertain`. A provider event for that mail settles it as sent; otherwise
  a person decides with `POST /v1/campaigns/{id}/resolve { contact, as: 'sent' | 'failed', note }`. An issue with
  `uncertain` recipients cannot reach `done`.
- Queue redelivery, the same person released twice, or a stuck release re-sent after `stuckMinutes` (10): the consumer
  only hands over recipients whose state is `enqueued`, and the ledger key catches the rest.
- Nothing is handed over while the issue is not `sending` or the sender domain is on hold.

## Brakes

| Level | Condition (defaults) | What happens |
|---|---|---|
| Wave gate | previous wave's hard bounces ≥ 2% | issue paused before the next wave |
| Issue brake | ≥ 200 sent in this issue and hard bounces ≥ 4%; or ≥ 3 complaints and ≥ 0.1% (no sent minimum: the 3 complaints are the floor) | issue paused |
| Provider | provider reports the account as not `HEALTHY`, or answers "account paused" | sending issues paused, scheduled issues do not start, queued mails are not handed over |
| Queue stalled | work handed to the queue but no result for 30 minutes | issue paused |
| Domain stop | among newsletter mails sent in the last 30 days (and since the last release): ≥ 200 sent and hard bounces ≥ 4% or complaints ≥ 0.08% | **all** newsletters on the domain stop; scheduled issues do not start |
| Warm-up gate | see below | the ladder does not move up; after 2 failures in a row it locks |

Every brake waits for a person: `POST /v1/campaigns/{id}/resume { note }` (refused while the domain is on hold) and
`POST /v1/broadcast/release-hold { note }`. After a resume, **only the brake that paused the issue** (bounce rate,
complaint rate or wave gate) restarts counting from the resume; every other rate keeps counting the whole issue. After a
release, the domain rate counts only mails sent after the release. An issue that finishes with failed recipients is
`done` (they were tried `maxAttempts` times) and raises a yellow alert. Newsletter ledger rows are kept at least 400
days even if `LEDGER_RETENTION_DAYS` is shorter (de-duplication and the domain rate depend on them). Transactional mail (the "must
deliver" desk) is not affected by any of this: it uses another sender domain and its own providers.

Alerts (started, paused, finished, blocked) go to the `alert` hook you pass in; the engine does not send them itself.

## Warm-up ladder

```http
PUT /v1/warmup/ramp/1   { "waves": [["core"], ["steady", "returning"], ["new"]] }
PUT /v1/warmup/ramp/2   { "waves": [["core"], ["steady", "returning"], ["new"], ["quiet"]] }
PUT /v1/warmup/ramp/3   { "waves": [["core"], ["steady", "returning"], ["new"], ["quiet"], ["*"]], "maxCount": 1800 }
```

An issue with `"audience": { "plan": "ramp" }` is sent to the **current step** (the highest released step; step 1 needs
no release). Segment names come from `list_members.segment`; `"*"` means everyone not matched earlier (it must be last).
`maxCount` caps the step; the people beyond it (last waves first) are `skipped/warmup`.

After an issue has been `done` for 72 hours:

```http
POST /v1/warmup/ramp/evaluate { "campaign": "weekly-12", "baselineOpenRate": 0.52 }
```

`baselineOpenRate` is **the same people's** average open rate before the switch (computed by your analytics, not by the
engine; comparing with the whole list would make a step that only mails the most engaged readers look better than it
is). Pass: hard bounces ≤ 2%, complaints ≤ 0.1%, open rate not more than 5 points below the baseline, and the issue
reconciled cleanly → the next step is released. Fail → the next issue stays on the same step. Two failures in a row lock
the ladder: scheduled issues on it do not start until `POST /v1/warmup/ramp/unblock { note }`. Each issue is evaluated
once. Open rate = people with an open event ÷ (sent − hard bounces).

## Status

- `GET /v1/campaigns/{id}` — state, approval, pre-send check, recipients by state/reason/wave, rates (no content, no addresses).
- `GET /v1/throttle` — today's cap and usage, provider speed and health, domain hold, issues in flight.

## Postmen

```ts
interface Postman {
  name: string;
  send(mail: PostmanMail): Promise<{ ok: true; providerId: string } | { ok: false; kind: 'temporary' | 'permanent' | 'throttled' | 'account_paused'; error: string }>;
  limits(): Promise<{ perSecond: number; perDay: number; sentLast24h?: number; enforcement: string }>;
}
```

Return a failure **only when you are sure the provider did not accept the mail**; throw when you do not know. One postman
per deployment; switching is a config change and a deploy, never automatic.

Provider feedback enters through one function, whatever the provider:

```ts
await ingestEvent(db, { provider, providerEventId, providerMessageId, type, subtype, at, email, campaign, contact }, { feedback })
```

`type` is one of `send`, `delivery`, `bounce` (`subtype` `Permanent…` / `Transient` / `Undetermined`), `complaint`,
`reject`, `delay`, `open`, `click`, `unsubscribe`. Re-deliveries of the same `providerEventId` are ignored. Without a
`feedback` hook, bounces, complaints and deliveries go through `applyFeedback` (see [docs/unsubscribe.md](unsubscribe.md)).
An `unsubscribe` event that names an issue unsubscribes the person from that issue's list.

### The fake postman

`FakePostman` sends nothing. Addresses whose local part is `success`, `bounce`, `complaint`, `ooto` or
`suppressionlist` (optionally `+tag`) behave like a provider's mailbox simulator and produce the matching events after a
short delay. `rules` can make any address answer `temporary`, `permanent`, `throttle`, `account_paused`, `delay`,
`soft_bounce` or `crash` (throw), optionally only the first `times` calls. In the Worker, set
`NEWSLETTER_POSTMAN = "fake"`; its events come back through the broadcast queue.

## Worker setup

```jsonc
"vars": {
  "MARKETING_DOMAIN": "mail.example.com",
  "NEWSLETTER_POSTMAN": "fake",
  "NEWSLETTER_MAX_PER_DAY": 3000,
  "BROADCAST_CONFIG": { "paceMinutes": 150 }
},
"queues": {
  "producers": [{ "binding": "BROADCAST", "queue": "mailroom-broadcast" }],
  "consumers": [{ "queue": "mailroom-broadcast", "max_batch_size": 10, "max_concurrency": 1, "max_retries": 10, "dead_letter_queue": "mailroom-broadcast-dlq" }]
},
"triggers": { "crons": ["* * * * *"] }
```

Keep `max_concurrency: 1`: the per-second spacing is applied inside one consumer. Keep a dead-letter queue: send
messages lost there are re-released after `stuckMinutes`, but provider events (bounces, complaints) are not, and the
brakes would undercount them. Do not give an HTTP client the same site name as `BROADCAST_CONFIG.site`.

Personalisation per recipient goes through `render(campaign, recipient)`. The Worker default fills the compose
placeholders (`{{name}}`, `{{email}}`, `{{web_url}}`, `{{unsubscribe_url}}`, `{{unsubscribe_mailto}}`, also inside the
headers) with a signed unsubscribe token per recipient (`UNSUB_TOKEN_SECRET`, `UNSUB_BASE_URL`, optional `UNSUB_MAILTO`;
see [docs/unsubscribe.md](unsubscribe.md)). Without them every issue pauses with `render_error` instead of sending mail
without an unsubscribe link. Headers produced by a custom `render` are checked against the same allowlist.

### All settings (`BROADCAST_CONFIG`)

| Key | Default | Meaning |
|---|---|---|
| `site` | `newsletter` | ledger `site` for newsletter rows |
| `maxPerDay` | 3000 | your own daily cap (also `NEWSLETTER_MAX_PER_DAY`) |
| `rateFactor` | 0.8 | share of the provider's speed to use |
| `paceMinutes` | 150 | spread one issue over this many minutes |
| `waveGapMinutes` / `waveGateWaitMinutes` / `waveGateBounceRate` | 60 / 30 / 0.02 | wave timing and gate |
| `brakeMinSent` / `brakeHardBounceRate` / `brakeComplaintCount` / `brakeComplaintRate` | 200 / 0.04 / 3 / 0.001 | issue brake |
| `domainWindowDays` / `domainMinSent` / `domainBounceRate` / `domainComplaintRate` | 30 / 200 / 0.04 / 0.0008 | domain stop |
| `stuckMinutes` / `stallMinutes` | 10 / 30 | re-release / queue-stalled brake |
| `maxAttempts` / `throttleRetrySeconds` | 3 / 30 | temporary failures / throttling |
| `utcOffsetHours` | 8 | which local day the daily cap uses |
| `limitsRefreshMinutes` | 60 | how often provider limits and health are read |
| `gateWaitHours` / `gateBounceRate` / `gateComplaintRate` / `gateOpenDrop` / `gateMaxFails` | 72 / 0.02 / 0.001 / 0.05 / 2 | warm-up gate |

Invalid values fall back to the default; they never switch a check off.
