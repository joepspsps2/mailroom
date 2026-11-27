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

Headings, paragraphs (a single newline becomes a line break), bold, italic, inline code, links, bare URLs, images, lists (nested, ordered, with their start number), block quotes, tables (with alignment), fenced and indented code, rules.
Also understood: `<https://…>` autolinks, `<a href="…">text</a>` (only the `href` and the text are kept — every other
attribute is dropped and the link goes through the normal checks and tracking), and paired `<b>` / `<strong>` / `<i>` / `<em>`.
HTML character references (`&nbsp;`, `&amp;`, `&#39;` …) are decoded once and escaped once.

A bare `http://` / `https://` URL is cut where the site cuts it: it runs to the next whitespace (a full-width space
or a no-break space counts) or `<`, and ASCII punctuation at the very end (`.` `,` `:` `;` `!` `?` `'` `*` `_` `~` `]`, an
unbalanced `)`) is not part of it. (One known difference: the rare ASCII characters `"` `{` `}` `|` `^` `\` end the link in
the email but not on the site; the text after them stays visible.) Everything else belongs to the link, including non-ASCII characters: a Japanese or Chinese path
(`https://ja.wikipedia.org/wiki/写真`), full-width punctuation, and words glued to the URL without a space
(`詳見https://example.com/a這篇文章`, `https://example.com/p/1看完再說`) — on the site all of that is link text, so it is link
text in the email too, and the destination carries the non-ASCII characters as `%XX`, as on the site. Such a link usually
points to a page that does not exist; the pre-send link check reports it (`link_broken`), and a URL whose last character is
full-width punctuation (`（https://example.com/a）`, `https://example.com/a。`) gets a `url_glued_text` warning. The fix in
the article is a space after the URL. The link text of `[text](url)` is never autolinked again (the site does not put a
link inside a link).

In the plain-text version a link is printed as `text (url)`, where `url` is the tracking URL (or the final URL without
tracking). The text is left out only when it adds nothing: when it is empty, when it is the printed URL itself, or when it
is a URL contained in the printed URL (an untracked link, which only gains `utm_*`). So a bare URL prints as
`https://example.com/a (https://t.example.com/c/…)`: the reader sees what the site shows, glued words included, and the
mail never silently drops text.

Block structure follows CommonMark (with GFM tables) for everything the email supports: the parser first decides which lines form which block — fenced or indented code, HTML comment block, paragraph, list item, quote, table, heading (ATX or setext) — and only then parses the inline content of each block. HTML comments are handled **in that same single pass**; there is no separate comment-stripping step that could disagree with the parser about where code is. A line that starts with `<!--` (indented at most three spaces) is a comment block that ends on the line containing `-->` (blank lines in between included); it can interrupt a paragraph, a list item or a quote, exactly as on a CommonMark site, and any text after `-->` on its last line is kept. Inside a paragraph, heading or table cell, inline code and comments are recognised in one left-to-right scan, so whichever starts first wins: `` `<!--` `` is code, `<!-- a ` b -->` is a comment. Inline code never crosses a block boundary, so a multi-line code span that meets a line starting with `<!--` ends there and that line is a comment (CommonMark behaviour). Code fences (``` and ~~~, longer fences, fences in lists and quotes) and indented code keep their `<!--` and `-->` text verbatim. Lazy continuation lines join a quote or list item only when its last block is an open paragraph.

Two safety nets run after that. First, a reconciliation: every `<!--` in the source must be accounted for as either a hidden comment or text inside code; if one is left over (a backslash-escaped `\<!--`, a `<!--` in image alt text or a URL), the issue gets a `comment_leaked` error. Second, the final email HTML and plain text are rendered again with code contents masked; if anything outside code still contains `<!--` (for example from `&lt;!--`), that is also a `comment_leaked` error. A bare URL followed directly by a backtick, and an unfinished `<tag` after a comment on the same line, are errors too. Comments containing `--!>` (browsers end a comment there early) are an error (`comment_ambiguous`). Constructs that a website would pass through as raw HTML or hide in other ways are blocked with an error rather than imitated: a line holding a single tag such as `<em>`, `<br>` or `<a href="…">` on its own (an HTML block — inline tags inside a paragraph are fine), `<?…>`, `<!X…>` and `<![CDATA[…]]>` (`unsupported_html`), and link reference definitions `[name]: url` (`unsupported_syntax`), and footnote definitions the site would not show: a definition is kept only when it is a one-line paragraph line starting at column 0 (consecutive definition lines are fine), its label has no spaces and is defined once (labels are case-insensitive), its content is plain text (not a list, quote, heading, code, HTML or another definition), no indented continuation follows it, and a real footnote reference `[^x]` appears in the text (references inside code, comments, URLs, escapes, entities or the definitions themselves do not count, nor does one written right after a bare URL or email address, which the site absorbs into the link); anything else is an error, and so is a footnote reference inside link text. A link inside the text of another link is an error too (the site shows the outer brackets and URL literally; the mail would lose them). A footnote reference that the site absorbs into a preceding bare URL — also when brackets or emphasis wrap the URL, as in `(www.example.com**[^1]***)` or `**https://example.com**[^1]` — is itself an error (`unsupported_syntax`, fix: put a space before the reference), even if the same footnote is referenced properly elsewhere. Every URL in the run of non-space characters before the reference is checked, not only the first; a URL counts as closed only when it is the destination of something that really is a link on the site (`[text](url)`, `![alt](url)`, `<url>`, `<a href>`) — when link text contains another link, the site does not treat the outer brackets as a link, and its `](url)` is a bare URL. A tab in the structure at the start of a line (indentation, after `>`, after a list marker) is an error (`unsupported_syntax`): how a site lays it out depends on every enclosing container, so it cannot be predicted reliably; use spaces. Tabs inside fenced code (Go, Makefiles), also in lists and quotes, are fine and kept as they are; in indented code only the four columns of indentation must be spaces. Like the site's renderer, an ordered list that does not start at 1, or an empty list item, is not recognised right after an indented code block or as the first block of a list item or quote that interrupts a paragraph; that line becomes a paragraph. A table needs a delimiter row containing `|` that is indented less than four spaces; a list item, heading or quote line never becomes a table header. These rules are checked by `tests/compose-fuzz.test.ts`, which generates random combinations of comments, code and blocks and compares the output with a CommonMark reference renderer (a dev dependency): nothing hidden on the site may appear in the email, nothing visible may disappear, and `<!--` / `-->` inside code stay verbatim — unless the issue is blocked with an error. CI runs a small sample; run `MAILROOM_FUZZ_N=24000 npm test` for a long run. A bare URL that has `[`, `*` or a backtick glued to it in the same word (or an HTML entity right before it), `![^x]`, and a footnote reference after nested brackets are errors as well: the site absorbs such runs into one link. Baseline at the time of writing (keep it current when the parser changes): the built-in generator gives zero violations on 4 × 24,000 samples (about 40 % of them blocked with an error). Several additional adversarial generators written during review (nested containers with tabs, footnotes, inline-symbol soup) were run for about 350,000 more samples; all were clean except an inline-symbol generator that glues bare URLs, emphasis, links, footnote references and code without spaces. On 40,000 such samples it used to leave 213 cases (200 where words glued to a bare URL vanished from the plain-text email, 8 where code was split differently from the site, 5 where a footnote hidden on the site was printed in the email, inside runs like `(www.example.com**[^1]***)`); with the bare-URL and footnote rules above it leaves none: the 200 are now handled correctly (178) or blocked (22), and the other 13 are blocked (about 65 % of these samples are blocked in all). The other review generators were re-run for 320,000 samples with the same results as before. One known layout difference: after an HTML block inside a list item, a following under-indented line may be split into code differently from the site (content stays visible).

A line that holds only `<div>`, `<div lang="…">` or `</div>` (a language wrapper) is dropped and its content converted normally; a `div` with any other attribute (`hidden`, `style`, `class` …) is an error, so text meant to be hidden can never reach readers. Angle-bracket words that only look like tags (`<Research.example>`, `</p/100110>`) are reported with a hint to rewrite them or put them in backticks.

Everything else is **not** passed through: an unknown tag or an unknown block syntax (for example `:::note`) is recorded
as an `error` problem and the pre-send check fails, so nothing half-converted can be sent. So are an unclosed `<!--` comment
(`unclosed_comment`, wherever it starts — on a website it hides everything after it) and an unclosed code fence (`unclosed_fence`, which turns the rest of the container into code); the text after them is kept in the output.
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

Two layouts (`layout`):

- `'card'` (default, unchanged): the content sits on a bordered card over a background band. On phones the side padding
  shrinks to 16 px only where the mail app honours media queries.
- `'full'`: one background colour (the theme's `card` colour) for the whole mail, no card and no border. The content table
  is `width:100%; max-width:<theme.width>px` and the side padding is 16 px inline, so the text fills a phone screen even
  where media queries are stripped (for example the Gmail app with a non-Gmail account); on a desktop it stays centred at
  the theme width. Outlook for Windows keeps a fixed-width table through a conditional comment. The "view in browser" link
  gets its own line above the logo, the footer is separated by a thin top rule, and the unsubscribe line is 14 px.

Logo size: give `logoWidth` and `logoHeight` together (display size in px, not wider than the theme width) and serve the
image at twice that size for sharp screens; the `<img>` then gets `width`/`height` attributes and `max-width:100%`. Without
them the logo is 36 px tall, as before. Mail apps do not show SVG reliably: use PNG (or JPEG). If the logo must stay legible
in dark mode, bake its own background and clear space into the image: mail apps do not invert images.

Article images: Outlook for Windows ignores `max-width` and shows an image at its file width unless the `<img>` has a
`width` attribute. Set `theme.imageWidth` (px, at most the content width minus the side padding: 568 for `full`, 536 for
`card` at the default 600) and every article image gets that `width` attribute, still with `max-width:100%` for phones.
Only images that stand on their own line get it (images inside a line of text keep their own size). Those images are scaled to exactly that width, so set it only when your article images are at least that wide (serve them at
about twice the width for sharp screens). Without it nothing changes.
