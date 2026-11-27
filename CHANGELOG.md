# Changelog

## 0.3.3

Nothing changes unless you set the new options; the default output is byte for byte as in 0.3.2.

### New

- **Body text size and spacing** (`theme.bodyFontSize`, `theme.bodyLineHeight`, `theme.paragraphGap`, see `docs/composing.md`): set the font size (12–24 px) and line height (1.2–2.4) of paragraphs and list items, and the space below each block (0–40 px). Headings, tables, code blocks and quotes keep their sizes. Out-of-range values throw when the template is created.

## 0.3.2

Nothing changes unless you set the new options; the default layout renders byte for byte as in 0.3.1.

### New

- **Full-width layout** (`layout: 'full'` in `createTemplate`, see `docs/composing.md`): one background colour, no card or border, content `width:100%` up to the theme width with 16 px side padding written inline, so phones show the text at nearly full width without relying on media queries. Unsubscribe link, postal address, web-version link, open pixel, headers and the pre-send check are unchanged.
- **Article image width for Outlook** (`theme.imageWidth`): article images get a `width` attribute so Outlook for Windows does not show them at file width; phones still scale them with `max-width:100%`.
- **Logo display size** (`logoWidth` / `logoHeight`): the header logo can be shown at a set size (serve a 2x image); invalid sizes throw when the template is created.

## 0.3.1

### Upgrading from 0.3.0

- **Two new D1 migrations, both additive:** `0008_tracking.sql` (adds `campaigns.links`) and `0009_welcome.sql` (adds `welcome_mails`). Existing rows are untouched; issues stored by 0.3.0 keep their content hash (the link table only enters the hash when present), so an approved 0.3.0 issue stays approved. Apply them before the new code runs (`npm run deploy` does).
- **New optional settings** (nothing changes until you set them): `TRACK_BASE_URL`, `TRACK_TOKEN_SECRET` (Secret), `TRACK_TOKEN_SECRET_PREVIOUS`, `TRACK_CONFIG` — see `docs/tracking.md`. Route the tracking host to the Worker. The welcome mail needs no new setting; it is stored per list and is off until switched on.
- **Behaviour changes:**
  - `listSubscribe` answers `{ status: 'subscribed', firstTime: boolean }` instead of `{ status: 'subscribed' }`. Callers that read `status` are unaffected; callers that compare the whole object must accept the extra field.
  - Issues composed with `trackBase` now need `TRACK_TOKEN_SECRET` and a matching `TRACK_BASE_URL`: without them (or when the tracking links are not under `TRACK_BASE_URL`) rendering fails and the issue pauses (`render_error`) — it never sends dead tracking links. `saveDraft` refuses `{{c:N}}` placeholders that have no entry in the issue's link table (`links_missing`); the desk command `create` sends the link table automatically. Issues created with the 0.3.0 command and `trackBase` must be created again.
  - Compose and pre-send check: bare URLs now run to the next whitespace or `<`, as on a GFM site (non-ASCII paths stay part of the URL and are percent-encoded in the destination; before, the link stopped at the first non-ASCII character and pointed to the wrong page). The plain-text version prints `text (tracked URL)` for every tracked link whose text is not the printed URL, so no word of the link text is lost. New errors (`unsupported_syntax`): a footnote reference the site would absorb into a bare URL, and a link inside the text of another link. New warning `url_glued_text` when a bare URL ends in full-width punctuation. Link text is no longer auto-linked a second time. Re-run `create` for drafts made with 0.3.0.
  - While newsletters are enabled and a list's welcome mail is switched on, a first-time subscriber gets one welcome mail (counts toward the daily cap).
  - **A complaint about a newsletter no longer blocks transactional mail.** Complaints that come back through the newsletter postman record the `unsubscribe` suppression ("no newsletters at all", `detail` starting `complaint`) instead of `complaint`: newsletters stop, sign-in and notification mail keep going. Complaints about transactional mail and hard bounces still block everything. Existing `complaint` rows keep blocking everything; nothing is migrated. The import status `complained` still records `complaint` (blocks everything). For callers of the list API nothing changes in meaning: the person is unsubscribed from every list, `listStatus` answers `unsubscribed` (`blocked` for someone who is not a member), `listMembers` rows have `suppressed: true`, and their own subscribe answers `blocked` until the suppression is lifted with `POST /v1/unsuppress` (`reasons: ["unsubscribe"]`). The only visible difference: `send()` to that address now answers `sent` instead of `suppressed`.
  - Tracking link destinations are stored normalised (non-ASCII paths percent-encoded).

### New

- **Compose rewrite** (#16): HTML comments, code and blocks are decided in one CommonMark-style pass; leaked-comment safety nets; randomized comparison against a reference renderer (`tests/compose-fuzz.test.ts`).
- **Compose fixes**: bare URLs with text or non-ASCII characters right after them, footnote references glued to URLs, nested links (see the behaviour changes above); randomized comparison baseline updated in `docs/composing.md`.
- **Click and open tracking** (`docs/tracking.md`): `GET /c/{token}` redirects only to a link stored with the issue, `GET /o/{token}.gif` serves the pixel. Signed per-recipient tokens (HMAC-SHA-256, rotation supported); forged tokens get the same 404 without a database read; events carry no addresses; writes happen after the response and a failed write still redirects. Dedupe windows, scanner marking (`burst`, `HEAD`, configured networks) and an explicit `detail.prefetch = true` for opens from Apple's network (configurable). Test mail redirects without recording.
- **Newsletter complaints stop newsletters only** (`docs/unsubscribe.md`): `applyFeedback` complaint events take `scope: 'all' | 'marketing'`; lifting a newsletter complaint needs `reasons: ["unsubscribe", "complaint"]`.
- **Welcome mail** (`docs/welcome.md`): one mail for first-time subscribers through the newsletter postman with unsubscribe headers, deduplicated by the ledger key `welcome:{list}:{contact}`; never for re-subscribes, imports or suppressed addresses; nothing while newsletters are switched off. Admin route `PUT`/`GET /v1/lists/{id}/welcome` and desk command `welcome`. Names are only used when they pass an allowlist (letters, marks, spaces, apostrophes, hyphens, initials).

## 0.3.0

This release also contains everything planned for 0.2.0, which was never published on its own: install 0.3.0 directly.

The notes below are grouped as they were written; the 0.2.0 section further down lists its breaking changes (the `HTTP_FROM` requirement and migration `0004`) — read it before upgrading from 0.1.0. New migrations since 0.1.0: `0004` to `0007`.

- **Newsletter desk commands** (`bin/mailroom.mjs`, `@joelincc/mailroom/cli`; see `docs/desk-commands.md`). One command set for a whole issue: create (compose + pre-send check), preview, test mail, approve, schedule, start, status, pause, resume/release, cancel, retry-failed, resolve, reconcile, hold release. Every command that changes state is a dry run unless `--yes` is given; every command prints a summary for people and, with `--json`, one JSON object. New read endpoints `GET /v1/campaigns/{id}/preview` and `/audience`; `POST …/preview` marks the content as previewed, `POST …/test` sends test mail to the addresses in `TEST_RECIPIENTS` only. Pause explanations (`pauseExplain`) in the status answer.
- **Behaviour changes in broadcasting** (all of them make sending *more* careful, none loosens who receives mail or when it stops):
  - Approval now requires that the current content has been previewed (`POST …/preview`); editing the content invalidates the preview. Calling `approveCampaign` directly is unchanged.
  - `saveDraft` refuses a second issue with the same web-version URL, the same source reference, or the same list and body as a non-cancelled issue (`duplicate_content`).
  - New settings `domainMinComplaints` (default 1: no change, max 10), `waveGateMinSent` (default 1: no change, max 100) and `startGraceMinutes` (default 360, max 2880): a scheduled issue that is more than that many minutes past its time is moved back to `draft` (approval and preview cleared) with a yellow alert instead of starting late; an issue that started but handed no mail to the provider for that long is paused (`brake:start_stale`). Scheduled issues no longer start while the provider's limits cannot be read (`provider_unreachable`).
  - Events for test mail never suppress an address or unsubscribe anyone. A run of permanent failures (`brake:permanent_streak`) is explained as a configuration problem that needs `--force` to resume.
  - `saveDraft` compares web-version URLs after normalising them (case, trailing slash, `utm_*`, fragment); a reused source reference only conflicts with an issue that is not finished.
  - The CLI is compiled to `dist/` on `prepack` and exposed as `@joelincc/mailroom/cli` (compiled) and the `mailroom` binary.
  - Unsubscribe alerts: a failed write is never rate limited, and when the per-minute budget drops alerts, one summary alert (`unsub_alerts_suppressed`) follows when the window ends (also flushed by the cron).

- **Unsubscribe follow-ups.** Failed unsubscribes no longer vanish: mail without a token, a token that fails verification and a database failure while handling a mail raise an alert to `UNSUB_ALERT_WEBHOOK` (optional `UNSUB_ALERT_TOKEN`), always with the full detail in the log; a failed write also rejects the mail (`setReject`). Encoded (MIME) subjects are decoded; one-click POSTs accept multipart and are read with a streaming size cap; transient bounces carry a `cause` and only mailbox-level ones count toward the three-in-a-row rule; the Resend and Cloudflare event routes now call `applyFeedback`, so a complaint unsubscribes the person from every list.

- **Unsubscribe and feedback** (see `docs/unsubscribe.md`). Signed unsubscribe tokens, `List-Unsubscribe` / one-click headers, `GET`/`POST /u/{token}` (GET only shows a confirmation page), resubscribe within 30 days, unsubscribe by email (`email()` handler), and `applyFeedback` for bounces and complaints (hard bounce and complaint → global suppression; three transient bounces in a row → hard bounce). New migration `0007_unsubscribe.sql`. `listMembers` rows now include `suppressed` and `unsubReason`. The list admin routes moved to `src/list-routes.ts` and reject a non-object `expected`. Set `UNSUB_TOKEN_SECRET` (and `UNSUB_BASE_URL`) to enable; nothing changes for existing sends.

- **Newsletter lists** (see `docs/lists.md`). New D1 migration `0005_lists.sql` (`contacts`, `lists`, `list_members`); internal `listSubscribe` / `listUnsubscribe` / `listStatus` / `listMembers`; admin endpoints `PUT /v1/lists/{id}`, `POST /v1/lists/{id}/import`, `POST /v1/lists/{id}/segments`. Nothing changes for existing sends.

- **Compose module** (`@joelincc/mailroom/compose`): markdown → email HTML and plain text, a configurable template factory, personalisation (`{{name}}`, `{{email}}`, `{{unsubscribe_url}}`, `{{web_url}}`), tracking-link and open-pixel placeholders, a pre-send check that blocks scheduling, and preview output. No new migration, no new dependency. Pre-send checks cover the whole final HTML (footer included), refuse offline mode and a missing web-version URL, and an optional `unsubscribe_mailto` header segment and `detectScannerClicks()` are available. See `docs/composing.md`.

## 0.2.0 (not published separately; included in 0.3.0)

Breaking / behaviour changes — read before upgrading:

- **HTTP clients must have an `HTTP_FROM` entry.** A site that sends over `POST /v1/send` and has no sender allowlist is now refused (`403`, `reason: "from_allowlist_required"`). Before, it only logged a warning and could use any address on the tier's domain. Add the entry for every name in `HTTP_CLIENTS` *before* upgrading. Service-binding callers are unaffected.
- **New D1 migration `0004_last_error.sql`** (adds `messages.last_error`). `npm run deploy` applies it; apply it before the new code runs if you deploy another way.

New:

- **Ledger retention.** Set `LEDGER_RETENTION_DAYS` (positive integer) and add a cron trigger; each run deletes `messages` and `webhook_events` rows older than that (5,000 of each per run, never `sending` rows, never the suppression list). Unset = nothing is deleted, as before.
- **Previous failure reason kept.** When a failed key is retried, the earlier error is copied to `last_error`, so it can still be looked up after the retry succeeds. `GET /v1/lookup` returns it.
- The scheduled handler now also prunes old rate counters.
- README: supported providers (exactly Resend, SMTP2GO, Cloudflare Email Sending), and a sender-domain verification guide (SPF, DKIM, DMARC).
- GitHub Actions in the workflows are pinned to commit SHAs.

## 0.1.0

First public release.
