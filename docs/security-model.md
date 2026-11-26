# Security model and data handling

Read this before you deploy mailroom or connect an app to it. It says what mailroom trusts, what it stores,
what each secret can do if it leaks, and what you should harden.

## Trust boundaries

| Caller | How it is identified | What it can do |
|---|---|---|
| A Worker on the same Cloudflare account (service binding) | Not authenticated — being bound **is** the trust. `site` is whatever the caller says. | `send`, `lookup` (full ledger row, including recipient), `drill`. No rate limit. |
| An app elsewhere (`POST /v1/send`) | Its own `HTTP_KEY_*`. The key decides `site`; a `site` in the body is ignored. | Send mail from the addresses allowed for it, to any recipient, with any content, within its rate limits. |
| The operator (`/v1/drill`, `/v1/lookup`, `/v1/report`, `/v1/unsuppress`) | `DRILL_TOKEN` | Send drill mail to any address (fixed text plus a caller-chosen `site` label), read status fields and per-domain counts, lift suppressions — and, as a side effect, find out whether a given address is on the suppression list. 20 requests/min, 200/day in total. |
| Resend (`POST /webhooks/resend`) | Svix signature, 5-minute window, event id de-duplicated | Update delivery status, add hard bounces and complaints to the suppression list. |
| Cloudflare Email Sending events | Arrive on your own queue | Same as above. |
| Amazon SES via SNS (`POST /webhooks/ses`) | SNS signature (SignatureVersion 2 by default) with a certificate fetched only from `sns.<region>.amazonaws.com`, topic ARN allowlist, 7-day window, SNS message id de-duplicated. Off (404) unless `SES_SNS_TOPIC_ARNS` is set. | Same as above, plus confirm its own SNS subscription. See [ses.md](ses.md). |
| Everyone else | — | `GET /` returns a plain-text health check. `POST /webhooks/resend` answers 401, 411 or 413. Everything else is 404. |

Mailroom does **not** check that a recipient opted in, does not scan message content, and does not sanitise HTML.
Whoever holds a client key can send anything, to anyone, from that client's allowed sender addresses.
The rate limits cap the damage; they do not prevent it.

## What is stored, and for how long

One D1 database, four tables:

| Table | Personal data | Notes |
|---|---|---|
| `messages` | recipient address, sender address, **subject line**; also whatever your apps put in the idempotency key and `kind`, and the provider's error code | Message bodies are never stored. Subjects often contain names or order details, and keys often contain a user id or address — treat the ledger as personal data. |
| `suppressions` | recipient address, bounce detail text from the provider | Kept until you lift the suppression. |
| `webhook_events` | none (event id, type, time) | |
| `rate_counters` | none | Rows older than two days are pruned opportunistically, on a small share of HTTP requests. |

**Retention is off until you turn it on.** Set `LEDGER_RETENTION_DAYS` (a positive integer, e.g. `180`) and add a cron trigger: each run then deletes `messages` rows and `webhook_events` rows older than that (up to 5,000 of each per run; rows still `sending` are kept). `suppressions` are never deleted automatically — they are a defence, not a log; remove entries with `/v1/unsuppress`. Without the variable or without a cron trigger nothing is deleted. You can also clean by hand, for example:

```bash
npx wrangler d1 execute mailroom --remote --command \
  "DELETE FROM messages WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-180 days'); DELETE FROM webhook_events WHERE received_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')"
```

Deleting a `messages` row also forgets its idempotency key, so only delete rows older than any retry window your apps use.
To erase one person on request, delete their rows from `messages` and (if they ask to receive mail again) `suppressions`.
Keeping a suppression row for someone who complained is usually the right thing to do — it is what stops you emailing them again.

Mailroom's own log lines contain site names, message kinds, provider error codes and counts — not recipients,
subjects, bodies or secrets. Please keep it that way in pull requests. Two things are outside that promise:
your apps choose `kind` and the idempotency key, so don't put personal data in `kind`; and Cloudflare's request
logs record request URLs, including the `site` and `key` query parameters of `/v1/lookup`.

Your providers (Resend, SMTP2GO, Cloudflare) receive the full message and keep their own logs under their own retention rules.

## If a secret leaks

| Secret | Worst case | What to do |
|---|---|---|
| `HTTP_KEY_<SITE>` | Someone sends mail as that app — phishing from your real domain — up to `HTTP_RATE_PER_MIN` / `HTTP_DAILY_LIMIT`. A `suppressed` reply also tells them an address bounced or complained, whichever of your apps it happened in. | Replace the secret (`wrangler secret put`), update the app, then check `/v1/report?days=1` for sends you don't recognise. |
| `DRILL_TOKEN` | Up to 200 drill emails a day to arbitrary addresses, suppressions lifted, per-domain statistics read, and addresses probed for "is this on the suppression list". Recipient lists, subjects and bodies are not exposed. | Replace or delete the secret. With it deleted, the operator paths return 404. |
| `RESEND_API_KEY`, `SMTP2GO_API_KEY` | Full sending access at the provider, outside mailroom and outside its limits. | Revoke at the provider first, then replace the secret. |
| `RESEND_WEBHOOK_SECRET` | Forged bounce and complaint events: an attacker can suppress any address, so real mail to it stops. | Rotate the signing secret in Resend, replace the secret, review recent `suppressions` rows. |

## Hardening checklist

- [ ] Every secret is a Cloudflare **Secret**, never a plain variable, never in `wrangler.jsonc`. `wrangler.jsonc` and `.dev.vars` stay git-ignored.
- [ ] Each HTTP client has its own key, and an `HTTP_FROM` entry listing exactly the sender addresses it may use. A client without an entry is refused (403 `from_allowlist_required`), and if `HTTP_FROM` is set but isn't valid JSON `/v1/send` refuses everything with a 500.
- [ ] `HTTP_RATE_PER_MIN` and `HTTP_DAILY_LIMIT` are set to what your busiest client really needs, not left at the defaults.
- [ ] Keys are long and random (`openssl rand -hex 32`). There is no lockout on wrong keys; length is the defence.
- [ ] `DRILL_TOKEN` is set only while you are running a drill or lifting a suppression, or is rotated regularly.
- [ ] Provider keys are scoped to the sending domain and to "send only" where the provider allows it.
- [ ] If you don't use webhooks or HTTP clients, `workers_dev` is `false`. If you do, consider a WAF rate-limiting rule in front of `/v1/*`.
- [ ] SPF, DKIM and DMARC are set up for every sender domain.
- [ ] You pin the mailroom version you deploy and read the diff before upgrading. Nothing here updates itself.
- [ ] `LEDGER_RETENTION_DAYS` is set and a cron trigger exists (see above), or you have your own retention job.
- [ ] After every deploy you run the drill from the README.

## Known limits

- A provider timeout can produce one duplicate email: the design prefers a duplicate over a lost message.
- Any Worker with a service binding can read ledger rows of other sites if it knows their keys. Don't bind Workers you don't trust.
- The suppression list is shared by all sites on the deployment, and Resend's webhook covers the whole Resend account.
- Rate limits count requests, not delivered messages, and apply only to the HTTP endpoints.
- `/v1/report` groups by recipient **domain**. For people who use a personal domain, that is close to identifying them.

Found something that isn't on this list? See [SECURITY.md](../SECURITY.md) — report it privately.
