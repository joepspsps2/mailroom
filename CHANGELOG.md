# Changelog

## Unreleased

- **Newsletter lists** (see `docs/lists.md`). New D1 migration `0005_lists.sql` (`contacts`, `lists`, `list_members`); internal `listSubscribe` / `listUnsubscribe` / `listStatus` / `listMembers`; admin endpoints `PUT /v1/lists/{id}`, `POST /v1/lists/{id}/import`, `POST /v1/lists/{id}/segments`. Nothing changes for existing sends.

- **Compose module** (`@joelincc/mailroom/compose`): markdown → email HTML and plain text, a configurable template factory, personalisation (`{{name}}`, `{{email}}`, `{{unsubscribe_url}}`, `{{web_url}}`), tracking-link and open-pixel placeholders, a pre-send check that blocks scheduling, and preview output. No new migration, no new dependency. See `docs/composing.md`.

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
