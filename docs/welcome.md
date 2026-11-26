# Welcome mail

When someone joins a list for the first time, the mailroom can send them one welcome mail. It goes the newsletter way: the
newsletter postman, the newsletter sender domain, the two unsubscribe headers, a ledger row, today's daily cap.

## When exactly it is sent

All of these must hold:

1. **Newsletters are enabled** on the deployment: `MARKETING_DOMAIN`, `NEWSLETTER_POSTMAN` and the `BROADCAST` queue are set
   and the postman can be built. While newsletters are switched off, nothing is queued and nothing is sent.
2. **The list has a welcome mail and it is switched on** (`enabled`). A new list has none; storing one requires saying
   `enabled: true` or `false` every time.
3. **The person subscribed through `listSubscribe`** (the service binding) and was **never a member of that list before**
   (`firstTime: true` in the answer). Someone who unsubscribed and comes back gets `firstTime: false` and no second welcome.
   Imports (`POST /v1/lists/{id}/import`) and segment writes never send one; an imported person (subscribed, unsubscribed or
   removed) is not first-time when they subscribe later.
4. At sending time they are still subscribed, not on the suppression list, the sender domain is not on hold, the provider is
   healthy and today's cap has room. A domain hold, an unhealthy provider or a full cap retries every 15 minutes for up to 48
   hours, then gives up (an old welcome is not sent late).
5. The ledger key `welcome:{list}:{contact}` has not been sent. Two subscribe calls at the same time, or a queue message
   delivered twice, still send one mail.

`listSubscribe` answers as before, with one extra field: `{ status: 'subscribed', firstTime: boolean }`. Queueing happens after
the member is written; if it fails it is logged and the subscribe still succeeds.

Only call `listSubscribe` for addresses whose owner confirmed the subscription (for example after a confirmation mail): the
welcome mail goes out automatically. Because the name is supplied by whoever subscribes, only names made of letters, combining marks,
spaces, apostrophes and hyphens (a dot only after a single letter, as in initials; at most 40 characters, after Unicode NFKC
normalisation) are used; any other name is dropped from the welcome mail (the greeting section is left out).

A welcome mail is not tracked (no click redirect, no open pixel). Events for it carry `campaign = "_welcome-{list}"`, which can
never collide with an issue id. Bounces and complaints are handled like any other newsletter mail.

## Content

The content is configuration, composed outside the Worker like an issue. With the desk command:

```sh
mailroom welcome --list weekly --source welcome.md --web-url https://example.com/newsletter --disable --yes   # store it off
mailroom welcome --list weekly                                                                              # look at it
mailroom welcome --list weekly --source welcome.md --web-url https://example.com/newsletter --enable --yes    # switch it on
```

The command composes the markdown with your template (without `trackBase`), runs the pre-send check, and stores the result with
`PUT /v1/lists/{id}/welcome` (admin token). `GET /v1/lists/{id}/welcome` returns what is stored. The engine refuses content
without `{{unsubscribe_url}}` in both HTML and text, with tracking placeholders, with unknown placeholders, or with a sender
outside the newsletter domain. Placeholders: `{{name}}` (`{{#name}}…{{/name}}`), `{{email}}`, `{{unsubscribe_url}}`,
`{{web_url}}` (the URL you pass, e.g. the archive page). The engine adds `List-Unsubscribe` (with the unsubscribe mailto when
`UNSUB_MAILTO` is set) and `List-Unsubscribe-Post` itself.

An example source (keep your real one in your own configuration):

```markdown
---
title: Welcome to Example Weekly
description: One email a week. Here is what to expect.
---

Thanks for subscribing. Every Monday you will get one email with the week's notes.

- Past issues are on the [archive page](https://example.com/newsletter).
- Reply to any issue to reach us.
```

## Storage

Migration `0009_welcome.sql` adds `welcome_mails` (one row per list: subject, sender, HTML, text, web URL, content hash,
`enabled`). The older `lists.welcome_template` column is left as it was and is not used by the engine.
