# mailroom

**Must-deliver notification email for Cloudflare Workers.**
Sign-in links, invites, receipts, payment and security notices — the mail that has to arrive.

> Status: **v0.x preview.** It runs in production for a handful of small apps, but the interface may still change before 1.0.

## What it is (and isn't)

Your apps hand a message to one Worker; the Worker does everything it can to get it delivered, never sends the same key twice once it has succeeded, and keeps a ledger.

- **Multi-provider failover** — Resend first, SMTP2GO as backup (Cloudflare Email Sending optional). A timeout or 5xx from Resend is re-checked once with the same idempotency key before falling back. The design prefers a rare duplicate over a lost message: if a provider times out after actually sending, the fallback provider may deliver a second copy.
- **Idempotent sends** — every message carries a `(site, key)` pair. Once a key is recorded as `sent`, sending it again returns `duplicate` instead of a second email; a `failed` key can be retried. (A retry after a timeout can produce a duplicate — see above. Resend honours the idempotency key for 24 hours; SMTP2GO has no idempotency key.)
- **Suppression list** — hard bounces and spam complaints are recorded and future sends to that address are blocked (`suppressed`), across all your apps. A complaint about a newsletter only stops newsletters (sign-in and notification mail keep going).
- **Bounce / complaint feedback** — Resend webhooks (Svix-signed) and Cloudflare Email Sending events update the ledger and the suppression list.
- **A D1 ledger** — one row per message: recipient, sender, subject, provider, provider id, outcome, later events. Message bodies are never stored.

Transactional sends (`send()`, `POST /v1/send`) reject `stream: "marketing"`. Newsletters go through the separate, opt-in newsletter desk below (lists, unsubscribe, broadcasting, tracking), which only sends to people on a list they subscribed to. It is not for cold email, and never will be — only send to people who asked to hear from you.

## Composing (preview)

The `@joelincc/mailroom/compose` entry point turns a markdown source into an email (HTML + plain text), personalises it, and
runs a pre-send check that refuses to schedule a broken issue. It does not send anything. See [docs/composing.md](docs/composing.md).

## Broadcasting (preview)

The `@joelincc/mailroom/broadcast` entry point sends one newsletter issue to a frozen list: approval and pre-send check
before scheduling, waves, pacing under the provider's limits and your own daily cap, a warm-up ladder, automatic brakes
on bounces and complaints, and a reconciliation that must add up before an issue counts as done. Newsletter
postmans: Amazon SES with signed SNS events ([docs/ses.md](docs/ses.md)) and a fake one for development. See
[docs/broadcast.md](docs/broadcast.md).

Click and open tracking runs on your own tracking host: signed per-recipient tokens, redirects only to links stored with the
issue, scanner clicks and prefetched opens marked rather than deleted. See [docs/tracking.md](docs/tracking.md).

## How it works

```
your app ──(service binding or HTTPS + key)──▶ mailroom Worker
                                                 1. suppression list?   → suppressed
                                                 2. (site, key) seen?   → duplicate / in_flight
                                                 3. provider #1 → recheck → provider #2 …
                                                 4. write ledger row    → sent / failed
Resend / Cloudflare events ──▶ webhook / queue ──▶ ledger + suppression list
```

Two tiers share the same ledger and suppression list but use separate sender domains, so reputation problems in one don't leak into the other:

| | `notify` (default) | `remind` (optional) |
|---|---|---|
| For | sign-in, email change, invites, payments, receipts, security alerts | in-app notices, due-date reminders, digests (always triggered by a user event, never promotional) |
| Sender domain | `FROM_DOMAIN` | `REMIND_DOMAIN` |
| Provider order | `ROUTES`, default Resend → SMTP2GO | `ROUTES`, default Resend → SMTP2GO — Resend only if `RESEND_API_KEY_REMIND` is set (otherwise tier 2 silently uses SMTP2GO only) |

The `from` address must belong to the tier's domain.

## Supported providers

For transactional mail, mailroom supports exactly **three** providers: **Resend**, **SMTP2GO** and **Cloudflare Email Sending** (newsletters can use Amazon SES, see [docs/ses.md](docs/ses.md)). `ROUTES` only accepts those three names (`resend`, `smtp2go`, `cloudflare`); anything else is ignored. If you want another provider (SES, Postmark, Mailgun, a plain SMTP relay…), you have to write an adapter yourself in `src/transport.ts` and add its name to `MAIL_ROUTES` — there is no plugin interface, and no support for doing so.

## Verify your sender domain first

Providers refuse to send, or the mail lands in spam, until the domain in your `from` address is verified. Do this for every sender domain (`FROM_DOMAIN`, and `REMIND_DOMAIN` if you use tier 2), **at each provider you enable**. Using a dedicated subdomain such as `notify.example.com` keeps this mail's reputation apart from your main domain.

1. In the provider's dashboard (Resend → Domains, SMTP2GO → Sending → Verified Senders → Sender Domains, Cloudflare → Email Sending), add the domain. The provider then shows you the exact DNS records to create — copy them from there, because the values are specific to your account.
2. Add those records at your DNS host. They normally come in three kinds:

   | Record | What it does | Typical shape (example values — use the ones your provider shows) |
   |---|---|---|
   | **SPF** (TXT) | Lists who may send for the domain. Providers usually put theirs on a provider-specific sub-label (for example `send.notify.example.com`) so it doesn't collide with your own. If you add one on the sending domain itself, there must be **only one** SPF record per name: merge them (`v=spf1 include:provider-a.example include:provider-b.example ~all`), never publish two. | `TXT  notify.example.com  "v=spf1 include:spf.provider.example ~all"` |
   | **DKIM** (TXT or CNAME) | A public key the provider signs each message with, so receivers can check it wasn't altered and really came from you. Each provider gives its own selector, so several providers can coexist. | `CNAME  s1._domainkey.notify.example.com  →  s1.dkim.provider.example` (or a TXT with `v=DKIM1; k=rsa; p=…`) |
   | **DMARC** (TXT, once per domain) | Tells receivers what to do when SPF/DKIM fail, and where to send reports. Start with monitoring only. | `TXT  _dmarc.notify.example.com  "v=DMARC1; p=none; rua=mailto:dmarc@example.com"` |

3. Wait for the provider to show the domain as **Verified** (DNS can take minutes to hours). DMARC passes when SPF or DKIM passes *and aligns* with the `from` domain, so check that your provider's records authenticate the same domain you put in `FROM_DOMAIN`.
4. Send a drill (below) to a mailbox you control, open "show original" and confirm `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`. Once that is stable you can tighten DMARC to `p=quarantine` or `p=reject`.

If a provider key can be scoped to one domain (Resend can), create it after the domain is verified.

## Quick deploy

You need a Cloudflare account, Node.js ≥ 22, and at least one provider account (Resend and/or SMTP2GO) with your sender domain verified.

```bash
git clone <this repo> mailroom && cd mailroom
npm ci
cp wrangler.example.jsonc wrangler.jsonc          # git-ignored: your ids stay local
npx wrangler d1 create mailroom                   # paste the database_id into wrangler.jsonc
# edit FROM_DOMAIN in wrangler.jsonc (uncomment REMIND_DOMAIN only if you use tier 2)
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SMTP2GO_API_KEY
# npx wrangler secret put RESEND_API_KEY_REMIND  # only if you enable tier 2 (REMIND_DOMAIN)
npx wrangler secret put RESEND_WEBHOOK_SECRET     # from the Resend webhook you point at /webhooks/resend
npx wrangler secret put DRILL_TOKEN               # any long random string, e.g. `openssl rand -hex 32`
npm run deploy                                    # tests + typecheck + D1 migrations + wrangler deploy
```

Then run the drill below to prove failover works before you point real traffic at it.

## Sending mail

**From a Worker on the same Cloudflare account (recommended)** — add a service binding to the sending app's `wrangler.jsonc`:

```jsonc
"services": [{ "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom" }]
```

```ts
const r = await env.MAILROOM.send({
  site: 'billing',                       // your app's name: [a-z0-9-], max 40
  key: `invoice-paid:${invoice.id}`,     // idempotency key, unique per message
  kind: 'invoice_paid',                  // optional label for your own reporting
  from: 'Billing <billing@notify.example.com>',
  to: customer.email,
  subject: 'Your invoice has been paid',
  html, text,
  // tier: 'remind', replyTo: 'help@example.com'
});
```

**From anywhere else** — `POST /v1/send` with `Authorization: Bearer <HTTP_KEY_SITE>` and the same JSON body. The key decides which `site` the message belongs to; a `site` in the body is ignored. Enable a client by adding its name to `HTTP_CLIENTS`, setting the secret `HTTP_KEY_<NAME_UPPERCASE>` (dashes become underscores) and listing its allowed sender addresses in `HTTP_FROM`.

### Responses

| `status` | Meaning | What your app should do |
|---|---|---|
| `sent` | Delivered to a provider on this call | done |
| `duplicate` | This `(site, key)` was already sent | done — do not send again |
| `in_flight` | The same key is being sent right now | ask again shortly |
| `suppressed` | Recipient hard-bounced or complained | don't retry; show the user a "check your address" message |
| `failed` | Every provider failed | if `retryable: true`, queue it and retry later **with the same key** |
| `rejected` | The request itself is invalid (`reason` says why) | fix the request; don't retry |

If your app can't reach the mailroom at all, queue the message locally and retry with the same key — a key already recorded as `sent` won't be sent again.

## Public endpoints

| Path | Purpose | Protection |
|---|---|---|
| `POST /webhooks/resend` | Resend events (delivered, bounced, complained, failed, delayed); permanent bounces and complaints go into the suppression list | Svix signature (`RESEND_WEBHOOK_SECRET`), 5-minute timestamp window |
| `POST /v1/send` | Sending from apps outside your Cloudflare account | per-client `HTTP_KEY_*`; rate limits `HTTP_RATE_PER_MIN` (default 60) and `HTTP_DAILY_LIMIT` (default 2000 per UTC day); sender allowlist `HTTP_FROM` (required per client) |
| `POST /v1/drill`, `GET /v1/lookup`, `GET /v1/report`, `POST /v1/unsuppress` | Operator tools (see below) | `DRILL_TOKEN`; **if it isn't set these paths return 404**; 20 requests/min and 200/day in total |
| `GET`/`POST /u/{token}`, `POST /u/{token}/resubscribe` | Unsubscribe page and one-click unsubscribe ([docs/unsubscribe.md](docs/unsubscribe.md)) | the unsubscribe token itself |
| `PUT /v1/lists/{id}`, `POST /v1/lists/{id}/import`, `POST /v1/lists/{id}/segments`, `PUT`/`GET /v1/lists/{id}/welcome` | Newsletter list management ([docs/lists.md](docs/lists.md)) and the welcome mail ([docs/welcome.md](docs/welcome.md)) | `DRILL_TOKEN`, same quota; bodies capped at 1.5 MB |
| `GET /c/{token}`, `GET /o/{token}.gif` on the `TRACK_BASE_URL` host | Click redirect and open pixel ([docs/tracking.md](docs/tracking.md)) | the signed token itself |
| `/v1/campaigns/*`, `/v1/throttle`, `/v1/warmup/*`, `/v1/broadcast/release-hold` | Newsletter broadcasting ([docs/broadcast.md](docs/broadcast.md)); 404 unless `MARKETING_DOMAIN` is set; test mail only if `TEST_RECIPIENTS` is set | `DRILL_TOKEN`, same quota; bodies capped at 3 MB |

Apart from `GET /` (a plain-text health check), anything else returns 404. Unknown keys get a 404, not a 401, so the endpoint doesn't confirm that it exists. The operator endpoints only return status fields — never recipients, senders or subjects — so a leaked `DRILL_TOKEN` can't be used to read your mail log. It **can** still be used to send drill emails from your domain to any address (capped by the limit above) and to lift suppressions, so treat it like a password: set it only when you need it, and rotate it after use (`wrangler secret put DRILL_TOKEN`, or `wrangler secret delete DRILL_TOKEN` to switch the endpoints off). Request bodies must carry a `Content-Length` header (411 otherwise) and are capped at 3 MB (`/v1/send`) and 256 KB (webhook). Someone holding a leaked token can also use up the operator quota for the day, locking you out until you rotate the token.

The webhook needs a public URL, which is why `workers_dev` is on in the template. If you don't use Resend webhooks or HTTP clients, set `"workers_dev": false` and the Worker is reachable only through service bindings.

**Required for every HTTP client:** set `HTTP_FROM` (`{ "shop": ["orders@notify.example.com"] }`) with the exact sender addresses that client may use. A client listed in `HTTP_CLIENTS` that has no entry is **refused** (`403`, `reason: "from_allowlist_required"`) — a leaked key must never be usable with every address on your domain. (Before 0.2.0 this only logged a warning.)

## Operating it

**Drill** — proves failover, de-duplication and lookup in one go:

```bash
URL=https://mailroom.<your-subdomain>.workers.dev
curl -X POST $URL/v1/drill -H "Authorization: Bearer $DRILL_TOKEN" \
  -d '{"to":"you@example.com","mode":"fallback","key":"d1"}'     # expect route: smtp2go (Resend key is deliberately wrong)
# same command again                                               → expect status: duplicate
curl "$URL/v1/lookup?site=drill&key=drill:d1" -H "Authorization: Bearer $DRILL_TOKEN"   # → the ledger row
```

Drill keys are always prefixed with `drill:` so a drill can never claim a real message's key. Options: `"mode": "normal"`, `"tier": "remind"`, `"only": "smtp2go"` (test a single provider).

**Report** — `GET /v1/report?days=7` groups the ledger by site, tier, provider, outcome and recipient *domain* (never full addresses).

**Lift a suppression** — when someone fixed their mailbox or a bounce was a false positive:

```bash
curl -X POST $URL/v1/unsuppress -H "Authorization: Bearer $DRILL_TOKEN" \
  -d '{"email":"someone@example.com","reasons":["hard_bounce"]}'
```

`reasons` is required (`hard_bounce`, `complaint`, `unsubscribe`) so you can't accidentally clear a complaint. A complaint about a newsletter is stored as `unsubscribe` with detail `complaint…`; lifting it needs both `"unsubscribe"` and `"complaint"` in `reasons` (with `"unsubscribe"` alone it stays and is not listed in `removed`). Providers keep their own suppression lists (e.g. Resend → Suppressions); clear those there.

**Roll back** — Cloudflare dashboard → Workers → mailroom → Deployments → Rollback, or `npx wrangler rollback`.

### Configuration reference

Variables (`wrangler.jsonc` → `vars`): `FROM_DOMAIN`, `REMIND_DOMAIN`, `ROUTES`, `HTTP_CLIENTS`, `HTTP_RATE_PER_MIN`, `HTTP_DAILY_LIMIT` (non-negative integers only; missing, blank or invalid → default; an explicit `0` means unlimited), `HTTP_FROM`, `LEDGER_RETENTION_DAYS` (positive integer; with a cron trigger, each run deletes `messages` and `webhook_events` rows older than that many days — missing, blank or invalid means nothing is deleted automatically; see below), `DAILY_DRILL` (optional scheduled drill: `{ "until": "YYYY-MM-DD", "to": ["you@example.com"], "tier": "remind", "utcOffsetHours": 0 }` — `until` is inclusive and compared in UTC unless you set `utcOffsetHours`; sends at most one round per day — extra cron runs that day return `duplicate` — so add a daily cron trigger).

**Ledger retention** — set `LEDGER_RETENTION_DAYS` (for example `180`) and add a cron trigger (`"triggers": { "crons": ["17 3 * * *"] }` in `wrangler.jsonc`). Each run deletes up to 5,000 `messages` rows and 5,000 `webhook_events` rows older than the limit (rows still `sending` are kept; the suppression list is never touched) and continues on the next run. Without a cron trigger nothing runs, so nothing is deleted. Deleting a `messages` row also forgets its idempotency key, so choose a period longer than any retry window your apps use.

**Previous failure reason** — when a failed key is retried, the earlier error is copied to `last_error` before `error` is cleared, so `GET /v1/lookup` still shows why the first attempt failed even if the retry succeeded.

Secrets (always add as **Secret**, never as a plain variable): `RESEND_API_KEY`, `SMTP2GO_API_KEY`, `RESEND_WEBHOOK_SECRET`, `DRILL_TOKEN`, `HTTP_KEY_*`, `RESEND_API_KEY_REMIND` (Resend keys can be scoped to one domain, so tier 2 can have its own).

Provider order (`ROUTES`): keys are `site:tier` or `*:tier`, values are lists of `resend`, `smtp2go`, `cloudflare`. Example: `{ "*:remind": ["cloudflare", "resend"] }`. Cloudflare Email Sending also needs the `send_email` binding and, for bounce events, the queue consumer — both are in the template, commented out.

## Development

```bash
npm test           # node --test; runs the real migrations/*.sql against Node's built-in SQLite
npm run typecheck
npm run clean-scan # blocks keys, account ids and real email addresses from ever being committed
```

`src/core.ts` (ledger), `src/transport.ts` (providers) and `src/webhook.ts` (events) don't import `cloudflare:*`, so they run under plain Node in tests. `src/index.ts` is the Worker shell. Code comments are currently in Traditional Chinese.

## Contributing, support and security

Forks are welcome — that's what the MIT license is for. Issues and pull requests are welcome too, but this is maintained on a best-effort basis: **no support, no guaranteed response, no roadmap commitments.** Please don't email the author about it, and please don't send unsolicited (cold) email pitches.

Pull requests run tests and a clean-scan; changes to `src/`, `migrations/`, workflows or dependencies wait for an owner review. Details, including the rules for AI-assisted contributions, are in [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

Before you deploy, read [docs/security-model.md](docs/security-model.md): who mailroom trusts, what personal data the ledger holds (and how to set an automatic retention limit), what each secret can do if it leaks, and a hardening checklist. Security issues: see [SECURITY.md](SECURITY.md) — please report privately, not in a public issue.

## License

[MIT](LICENSE)
