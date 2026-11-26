# Changelog

## Unreleased

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

## 0.2.0

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
