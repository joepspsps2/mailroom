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
Also understood: `<https://…>` autolinks, `<a href="…">text</a>` (only the `href` and the text are kept — every other
attribute is dropped and the link goes through the normal checks and tracking), and paired `<b>` / `<strong>` / `<i>` / `<em>`.
HTML character references (`&nbsp;`, `&amp;`, `&#39;` …) are decoded once and escaped once.

HTML comments (`<!-- … -->`) are removed wherever they appear — on their own line, right under a paragraph, inside a list item, inline, or across lines — except inside a code fence. Comments inside inline code (`` `<!--` ``) and inside code fences — including fences indented in lists or block quotes — are not comments and are left alone. A line that holds only `<div>`, `<div lang="…">` or `</div>` (a language wrapper) is dropped and its content converted normally; a `div` with any other attribute (`hidden`, `style`, `class` …) is an error, so text meant to be hidden can never reach readers. Angle-bracket words that only look like tags (`<Research.example>`, `</p/100110>`) are reported with a hint to rewrite them or put them in backticks.

Everything else is **not** passed through: an unknown tag or an unknown block syntax (for example `:::note`) is recorded
as an `error` problem and the pre-send check fails, so nothing half-converted can be sent. So are an unclosed `<!--` comment
(`unclosed_comment`, wherever it starts) and an unclosed code fence (`unclosed_fence`) — both would silently swallow the rest of the issue; the text after them is kept in the output.
The exception is content that cannot work in an email — `<iframe>`, `<video>`, `<audio>`, `<embed>`, `<object>`, `<canvas>`
and a ```` ```mermaid ```` fence: it becomes a "view on the website" link card and an `info` problem.

To write a literal `{{` in an article, escape it as `\{\{` (a code span or fence containing `{{` is escaped for you).
An unescaped `{{…}}` that is not one of the placeholders below fails the check.

### Links, tracking and personalisation

| Placeholder | Filled by `personalize()` with |
|---|---|
| `{{name}}` | the reader's name; wrap a whole element in `{{#name}}…{{/name}}` to drop it when there is no name |
| `{{email}}` | the address (use `{{#email}}…{{/email}}` the same way) |
| `{{unsubscribe_url}}` | the unsubscribe page URL (never rewritten) |
| `{{unsubscribe_mailto}}` | a `mailto:` unsubscribe link (e.g. `mailto:unsub@example.com?subject=<token>`); only used in the `List-Unsubscribe` header, and only when `compose({ unsubscribeMailto: true })`. Then `personalize()` requires `unsubscribe_mailto` in the recipient data and throws if it is missing or not a plain `mailto:` link |
| `{{web_url}}` | the web version of the issue (never rewritten) |
| `{{c:N}}` | the signature for link N (inside `https://t.example.com/c/{{c:N}}`) |
| `{{o}}` | the signature for the open pixel (`https://t.example.com/o/{{o}}.gif`) |

Only these are accepted. Two shapes of `List-Unsubscribe` pass the check: `<{{unsubscribe_url}}>` and
`<{{unsubscribe_url}}>, <{{unsubscribe_mailto}}>`; `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is always required.
The interface for whoever builds the unsubscribe flow: put the per-recipient URL in `unsubscribe_url` and, if you accept
unsubscribe-by-mail, the per-recipient mailto in `unsubscribe_mailto`; both must be free of CR/LF.

Only the links written in the article body are tracked and get `utm_*`. The links the template adds (the "view in browser"
link, footer links, the unsubscribe link) are left as they are: no tracking redirect, no `utm_*`.
Every body link (except placeholders, `mailto:` and `tel:`) (except placeholders, `mailto:` and `tel:`) is rewritten to the tracking URL and its
destination gets `utm_source=newsletter`, `utm_medium=email`, `utm_campaign=<issue>` appended to the original query string
(which is otherwise left byte-for-byte as written; an existing `utm_*` is not overwritten). `javascript:` and
`data:` links are refused. `personalize()` escapes values for HTML, flattens the name to one line (max 60 characters),
expands everything in a single pass (a name containing `{{email}}` stays literal), and **throws** if `email`,
`unsubscribe_url` or `web_url` is missing or not `https`, or if any placeholder is left over.

## Pre-send check

```ts
const check = await preflight(issue, { template, webUrl });   // schedule only if check.ok && check.linksChecked && check.webChecked
```

Every `error` blocks scheduling. `warn` and `info` are recorded only. The result also carries `linksChecked` and `webChecked`:
scheduling a real send requires `ok && linksChecked && webChecked` — offline mode (`checkLinks: false`) and a missing `webUrl`
are errors (`links_unchecked`, `web_url_unchecked`), not warnings. Links and images are taken from the **final HTML**, so
the template's footer is checked too, not only the article.

| Code | Blocks when |
|---|---|
| `html_too_large` | HTML (plus an allowance for signatures and personalisation) is 90,000 bytes or more (`maxHtmlBytes`) |
| `text_missing` | no plain-text version |
| `unsubscribe_link_missing`, `unsubscribe_text_missing` | the HTML or the text has no unsubscribe link |
| `unsubscribe_header_missing`, `unsubscribe_post_header_missing` | `List-Unsubscribe` or `List-Unsubscribe-Post` is missing |
| `address_missing`, `address_todo`, `address_not_in_html`, `address_not_in_text` | the template has no postal address, it is still a TODO marker, or it did not make it into the mail |
| `todo_marker` | `[[TODO: …]]` / `【待補：…】` is still present anywhere in the mail, including inside an `href` or `src` |
| `links_unchecked`, `web_url_unchecked` | offline mode, or no web-version URL was given |
| `image_alt_missing` | an image has no alt text |
| `subject_missing`, `subject_too_long`, `subject_invalid` | no subject, more than 80 characters (counted as characters, not bytes), or a control character / newline in it |
| `preheader_missing` | no preview text |
| `unknown_placeholder`, `unbalanced_section` | any `{{…}}` that is not on the list above, or an unmatched `{{#name}}` |
| `link_broken`, `image_broken` | HTTP 404 or 410 (only these two; a HEAD that returns 404/410/405/501 is retried once with GET before judging) |
| `link_invalid`, `link_private_host` | a malformed URL, or one pointing at localhost / a private or reserved address (IPv4, IPv6, IPv4-mapped IPv6, 100.64/10…) |
| `link_redirect_private`, `link_redirect_bad` | a redirect leads to a private address, a non-http(s) URL, or loops past 5 hops |
| `unsupported_html`, `unsupported_syntax`, `unsafe_link`, `link_not_absolute`, `image_not_absolute`, `issue_invalid`, `track_base_invalid` | reported by `compose()` itself |

Redirects are followed by hand, one hop at a time, and every hop goes through the private-address check again. The check looks at the host as written; it does not resolve DNS, so run `preflight` from a network that cannot reach your internal services if the content is not written by you.

Timeouts, network errors and other status codes (403, 429, 5xx…) are recorded as `warn` (`link_unverified`,
`link_status`) and do not block. Pass your own `fetch` to test, or `checkLinks: false` to run offline.

## Scanner clicks

Security scanners click every link in a message right after it is delivered. `detectScannerClicks(clicks, sentAt)` is the rule
for spotting that (pure function; recording events belongs to the redirect side): when one message gets clicks on **3 or more
different links within 60 seconds of being sent**, every click of that message inside the window is returned for marking as
`detail.suspect = 'scanner'`. Mark, don't delete; exclude the marked ones when counting clicks. Window and threshold are
adjustable (`windowMs`, `minDistinctLinks`). Opens are kept as they are (mail-client preloading cannot be told apart reliably).

## Preview

`buildPreview(issue, check)` returns a map of file name → content: `email.html` and `email.txt` (rendered for a sample
reader), `check.json`, `links.json`, and `index.html` — one page with the check results, the mail at phone and desktop
width, and the plain text. With `withoutName: true` it also renders the no-name version. Writing the files is up to the caller.

## Templates

A template is configuration, not code: `createTemplate()` takes a brand name, optional logo, greeting, footer lines or a
trusted `footerHtml` / `footerText` block, labels, a theme and the postal address. The layout is table-based with inline CSS
(Outlook-safe), 600 px wide, with a dark-mode override. Keep brand templates in your own configuration; the engine ships
none. The compose module is tested against a made-up issue in `tests/fixtures/`.
