# Composing an issue

This is the "compose" side of the newsletter desk: it turns one markdown source into an email — HTML and plain text — and
refuses to let a broken issue be scheduled. It only **produces** content. Click redirects, open pixels and event logging
are separate parts; this module just emits the placeholders they will fill in.

Import from the `./compose` entry point. It has no Cloudflare-specific imports, so it runs in Node, in a Worker and in tests:

```ts
import { compose, createTemplate, preflight, personalize, buildPreview } from '@joelincc/mailroom/compose';
```

## What goes in, what comes out

```ts
const template = createTemplate({
  brandName: 'Example Weekly',
  greeting: 'Hi {{name}},',                 // omitted for readers without a name
  footerLines: ['You get this because you subscribed.'],
  postalAddress: '1 Example Street, Sample City 00000',
});

const issue = compose({
  source,                                    // markdown, optional frontmatter (title, description)
  template,
  issue: '2026-01-05',                       // becomes utm_campaign
  trackBase: 'https://t.example.com',        // omit to skip link rewriting and the open pixel
  siteBase: 'https://example.com',           // resolves relative links
  assetBase: 'https://cdn.example.com',      // resolves relative image URLs
});
```

`compose()` returns `subject`, `preheader`, `html`, `text`, `headers` (the two unsubscribe headers), `links`
(every rewritten link: index, final URL, original URL, text), `images`, `problems` and `htmlBytes`.
The HTML is stored once per issue — it is never rendered per recipient until send time.

### Markdown that works

Headings, paragraphs (a single newline becomes a line break), bold, italic, inline code, links, bare URLs (trailing
punctuation is not part of the URL), images, lists (nested, ordered), block quotes, tables (with alignment), fenced code, rules.
Raw HTML is **not** passed through: an unknown tag or an unknown block syntax (for example `:::note`) is recorded as an
`error` problem and the pre-send check fails, so nothing half-converted can be sent. The exception is embedded content
(`<iframe>`, `<video>`, …): it becomes a "view on the website" link card and an `info` problem.

### Links, tracking and personalisation

| Placeholder | Filled by `personalize()` with |
|---|---|
| `{{name}}` | the reader's name; wrap a whole element in `{{#name}}…{{/name}}` to drop it when there is no name |
| `{{email}}` | the address (use `{{#email}}…{{/email}}` the same way) |
| `{{unsubscribe_url}}` | the unsubscribe page URL (never rewritten) |
| `{{web_url}}` | the web version of the issue (never rewritten) |
| `{{c:N}}` | the signature for link N (inside `https://t.example.com/c/{{c:N}}`) |
| `{{o}}` | the signature for the open pixel (`https://t.example.com/o/{{o}}.gif`) |

Only these are accepted. Every body link (except placeholders, `mailto:` and `tel:`) is rewritten to the tracking URL and its
destination gets `utm_source=newsletter`, `utm_medium=email`, `utm_campaign=<issue>` unless already set. `javascript:` and
`data:` links are refused. `personalize()` escapes values for HTML, flattens the name to one line (max 60 characters),
expands everything in a single pass (a name containing `{{email}}` stays literal), and **throws** if `email`,
`unsubscribe_url` or `web_url` is missing or not `https`, or if any placeholder is left over.

## Pre-send check

```ts
const check = await preflight(issue, { template, webUrl });   // check.ok === false ⇒ do not schedule
```

Every `error` blocks scheduling. `warn` and `info` are recorded only.

| Code | Blocks when |
|---|---|
| `html_too_large` | HTML (plus an allowance for signatures and personalisation) is 90,000 bytes or more (`maxHtmlBytes`) |
| `text_missing` | no plain-text version |
| `unsubscribe_link_missing`, `unsubscribe_text_missing` | the HTML or the text has no unsubscribe link |
| `unsubscribe_header_missing`, `unsubscribe_post_header_missing` | `List-Unsubscribe` or `List-Unsubscribe-Post` is missing |
| `address_missing`, `address_todo`, `address_not_in_html`, `address_not_in_text` | the template has no postal address, it is still a TODO marker, or it did not make it into the mail |
| `todo_marker` | `[[TODO: …]]` / `【待補：…】` is still visible anywhere in the mail |
| `image_alt_missing` | an image has no alt text |
| `subject_missing`, `subject_too_long`, `subject_invalid` | no subject, more than 80 characters (counted as characters, not bytes), or a control character / newline in it |
| `preheader_missing` | no preview text |
| `unknown_placeholder`, `unbalanced_section` | any `{{…}}` that is not on the list above, or an unmatched `{{#name}}` |
| `link_broken`, `image_broken` | HTTP 404 or 410 (only these two) |
| `link_invalid`, `link_private_host` | a malformed URL, or one pointing at localhost / a private address |
| `unsupported_html`, `unsupported_syntax`, `unsafe_link`, `link_not_absolute`, `image_not_absolute`, `issue_invalid`, `track_base_invalid` | reported by `compose()` itself |

Timeouts, network errors and other status codes (403, 429, 5xx…) are recorded as `warn` (`link_unverified`,
`link_status`) and do not block. Pass your own `fetch` to test, or `checkLinks: false` to run offline.

## Preview

`buildPreview(issue, check)` returns a map of file name → content: `email.html` and `email.txt` (rendered for a sample
reader), `check.json`, `links.json`, and `index.html` — one page with the check results, the mail at phone and desktop
width, and the plain text. With `withoutName: true` it also renders the no-name version. Writing the files is up to the caller.

## Templates

A template is configuration, not code: `createTemplate()` takes a brand name, optional logo, greeting, footer lines or a
trusted `footerHtml` / `footerText` block, labels, a theme and the postal address. The layout is table-based with inline CSS
(Outlook-safe), 600 px wide, with a dark-mode override. Keep brand templates in your own configuration; the engine ships
none. The compose module is tested against a made-up issue in `tests/fixtures/`.
