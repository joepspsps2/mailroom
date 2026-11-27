import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose, createTemplate, parseMarkdown, personalize, preflight, buildPreview, scanPlaceholders, detectScannerClicks, PersonalizeError, type ComposeOptions, type PreflightOptions } from '../src/compose/index.ts';

const sample = readFileSync(new URL('./fixtures/sample-issue.md', import.meta.url), 'utf8');

export const template = createTemplate({
  brandName: 'Example Weekly',
  tagline: 'A weekly note',
  lang: 'zh-Hant',
  greeting: '親愛的 {{name}}',
  footerLines: ['你收到這封信，是因為你訂閱了 Example Weekly。', { text: 'Example 官網', href: 'https://example.com/' }],
  postalAddress: '1 Example Street, Sample City 00000',
  labels: { viewInBrowser: '在瀏覽器開啟', unsubscribe: '取消訂閱', sentTo: '這封信寄給 {email}', embedCard: '這個內容請到網站觀看 →', image: (alt) => `[圖片：${alt}]` },
});

const base = (over: Partial<ComposeOptions> = {}): ComposeOptions => ({ source: sample, template, issue: '2026-01-05', trackBase: 'https://t.example.com', siteBase: 'https://example.com', ...over });
const vars = { name: '小明', email: 'reader@example.com', unsubscribe_url: 'https://u.example.com/x?t=1&a=2', web_url: 'https://example.com/p/100' };
const track = (k: 'c' | 'o', i?: number) => (k === 'c' ? `SIG${i}` : 'SIGO');
const okFetch: PreflightOptions['fetch'] = async () => ({ status: 200 });
const WEB = 'https://example.com/p/100';
const pf = (c: ReturnType<typeof compose>, over: Partial<PreflightOptions> = {}) => preflight(c, { template, fetch: okFetch, webUrl: WEB, ...over });
const codes = (r: { issues: { code: string; severity: string }[] }, sev = 'error') => r.issues.filter((i) => i.severity === sev).map((i) => i.code);

test('產信：吃原稿、吐 HTML＋純文字＋連結表，標題與預覽文字來自 frontmatter', () => {
  const c = compose(base());
  assert.equal(c.subject, '範例週報｜每週一點：2026/01/05');
  assert.match(c.preheader, /虛構的範例原稿/);
  assert.equal(c.problems.filter((p) => p.severity === 'error').length, 0);
  assert.match(c.html, /<h2[^>]*>第一件：中文標點與換行<\/h2>/);
  assert.match(c.html, /<table[^>]*>/); // 原稿的表格
  assert.match(c.html, /text-align:right/); // 對齊
  assert.match(c.html, /<blockquote/);
  assert.match(c.html, /<ol /);
  assert.match(c.html, /<pre /);
  assert.match(c.html, /<code /);
  assert.match(c.html, /<hr /);
  assert.match(c.html, /<br>/); // 單一換行
  assert.match(c.html, /lang="zh-Hant"/);
  assert.match(c.html, /prefers-color-scheme:dark/);
  assert.match(c.html, /<!--\[if mso\]>/);
  assert.ok(!c.html.includes('slug:'), 'frontmatter 不會跑進信裡');
});

test('連結改寫：每個連結換成追蹤轉址＋補 utm；佔位與 mailto 不改寫；網頁版與退訂不被追蹤', () => {
  const c = compose(base({ source: `${sample}\n\n[寫信給我](mailto:hi@example.com) [退訂]({{unsubscribe_url}})` }));
  // 原稿裡的連結：範例網站、長連結、詳細版（共 3 個）
  assert.equal(c.links.length, 3);
  assert.deepEqual(c.links.map((l) => l.index), [1, 2, 3]);
  assert.match(c.html, /href="https:\/\/t\.example\.com\/c\/\{\{c:1\}\}"/);
  assert.match(c.html, /href="https:\/\/t\.example\.com\/c\/\{\{c:3\}\}"/);
  assert.match(c.html, /href="mailto:hi@example\.com"/);
  const first = new URL(c.links[0].url);
  assert.equal(first.searchParams.get('utm_source'), 'newsletter');
  assert.equal(first.searchParams.get('utm_medium'), 'email');
  assert.equal(first.searchParams.get('utm_campaign'), '2026-01-05');
  assert.equal(first.searchParams.get('x'), '1'); // 原本的參數保留
  assert.equal(first.searchParams.get('y'), '2');
  // 長連結：原稿已有的 utm_source 不被蓋掉
  assert.equal(new URL(c.links[1].url).searchParams.get('utm_source'), 'old');
  assert.equal(new URL(c.links[1].url).searchParams.get('utm_campaign'), '2026-01-05');
  assert.equal(c.links[2].original, 'https://example.com/p/100');
  // 樣板的網頁版／退訂連結是佔位，不追蹤
  assert.match(c.html, /href="\{\{web_url\}\}"/);
  assert.match(c.html, /href="\{\{unsubscribe_url\}\}"/);
});

test('開信圖與標頭：有追蹤網址才放；退訂兩個標頭帶佔位', () => {
  const c = compose(base());
  assert.match(c.html, /<img src="https:\/\/t\.example\.com\/o\/\{\{o\}\}\.gif" width="1" height="1" alt=""/);
  assert.equal(c.headers['List-Unsubscribe'], '<{{unsubscribe_url}}>');
  assert.equal(c.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const n = compose(base({ trackBase: undefined }));
  assert.ok(!n.html.includes('/o/'));
  assert.ok(n.links[0].url === n.html.match(/href="(https:\/\/example\.com\/a[^"]*)"/)?.[1].replace(/&amp;/g, '&'));
});

test('追蹤網址不是 https、期號亂寫、相對連結沒有 siteBase：都記成 error', () => {
  assert.ok(compose(base({ trackBase: 'http://t.example.com' })).problems.some((p) => p.code === 'track_base_invalid'));
  assert.ok(compose(base({ issue: 'a b/c' })).problems.some((p) => p.code === 'issue_invalid'));
  const rel = compose(base({ source: '---\ntitle: t\n---\n\n[x](/p/1)', siteBase: undefined }));
  assert.ok(rel.problems.some((p) => p.code === 'link_not_absolute'));
  const abs = compose(base({ source: '---\ntitle: t\n---\n\n[x](/p/1)' }));
  assert.equal(abs.links[0].original, 'https://example.com/p/1');
});

test('危險連結（javascript:、data:）不會變成連結，並記 error', () => {
  const c = compose(base({ source: '---\ntitle: t\n---\n\n[點我](javascript:alert(1)) 與 [圖](data:text/html;base64,AAAA)' }));
  assert.equal(c.problems.filter((p) => p.code === 'unsafe_link').length, 2);
  assert.ok(!/javascript:/.test(c.html));
  assert.ok(!/data:text/.test(c.html));
});

test('HTML 跳脫：原稿裡的 <script>、引號、& 不會變成可執行的標籤', () => {
  const c = compose(base({ source: '---\ntitle: "a<b"\ndescription: "d"\n---\n\n標題 "引號" & 符號 <script>alert(1)</script>\n\n<div onclick="x">raw</div>' }));
  assert.ok(!c.html.includes('<script>'));
  assert.ok(!c.html.includes('onclick'));
  assert.ok(c.problems.filter((p) => p.code === 'unsupported_html').length >= 2);
  assert.match(c.html, /&quot;引號&quot; &amp; 符號/);
});

test('不認得的區塊語法（:::note）與行內 HTML 標籤：記 error，列出是哪一段', () => {
  const c = compose(base({ source: '---\ntitle: t\n---\n\n:::note\n內容\n:::\n\n正常段落 <span>x</span>' }));
  const p = c.problems.filter((x) => x.severity === 'error');
  assert.ok(p.some((x) => x.code === 'unsupported_syntax' && x.where?.startsWith(':::note')));
  assert.ok(p.some((x) => x.code === 'unsupported_html'));
});

test('嵌入內容（iframe、video）換成「到網站看」連結卡，並記 info；不是 error', () => {
  const c = compose(base({ source: '---\ntitle: t\ndescription: d\n---\n\n<iframe src="https://example.com/chart"></iframe>\n\n後面文字' }));
  assert.ok(c.problems.some((p) => p.code === 'embed_replaced' && p.severity === 'info'));
  assert.ok(!c.html.includes('<iframe'));
  assert.match(c.html, /href="\{\{web_url\}\}"[^>]*>這個內容請到網站觀看 →/);
  assert.match(c.text, /這個內容請到網站觀看: \{\{web_url\}\}/);
});

test('圖片：絕對網址照用；相對網址用 assetBase 補；補不了＝error；alt 記在圖片表', () => {
  const c = compose(base());
  assert.deepEqual(c.images, [{ src: 'https://img.example.com/2026-01/sample/hero.png', alt: '範例圖片的替代文字' }]);
  assert.match(c.html, /<img src="https:\/\/img\.example\.com[^"]*" alt="範例圖片的替代文字"/);
  const rel = compose(base({ source: '---\ntitle: t\n---\n\n![a](/img/x.png)', assetBase: 'https://cdn.example.com' }));
  assert.equal(rel.images[0].src, 'https://cdn.example.com/img/x.png');
  const bad = compose(base({ source: '---\ntitle: t\n---\n\n![a](/img/x.png)' }));
  assert.ok(bad.problems.some((p) => p.code === 'image_not_absolute'));
  // 包著連結的圖片：圖進圖片表一次、連結進連結表
  const linked = compose(base({ source: '---\ntitle: t\n---\n\n[![圖](https://img.example.com/a.png)](https://example.com/z)' }));
  assert.equal(linked.images.length, 1);
  assert.equal(linked.links.length, 1);
});

test('純文字版：連結展開成網址、圖片換成標記、清單與引言保留、有退訂連結', () => {
  const c = compose(base());
  assert.match(c.text, /範例網站 \(https:\/\/t\.example\.com\/c\/\{\{c:1\}\}\)/);
  assert.match(c.text, /^- 第一項/m);
  assert.match(c.text, /^ {2}- 子項目 A/m);
  assert.match(c.text, /^1\. 先做這個/m);
  assert.match(c.text, /^> 這是一段引言。/m);
  assert.match(c.text, /\[圖片：範例圖片的替代文字\]/);
  assert.match(c.text, /甲國 \| 2,300 \| 示意/);
  assert.match(c.text, /取消訂閱: \{\{unsubscribe_url\}\}/);
  assert.match(c.text, /1 Example Street/);
  assert.ok(!/<[a-z]+[ >]/.test(c.text), '純文字不含標籤');
  const noTrack = compose(base({ trackInText: false }));
  assert.match(noTrack.text, /範例網站 \(https:\/\/example\.com\/a\?x=1&y=2&utm_source=newsletter/);
});

test('個人化：四個欄位＋簽章；HTML 會跳脫；有名字才有問候；沒名字整段省略', () => {
  const c = compose(base());
  const a = personalize(c, vars, { track });
  assert.match(a.html, /親愛的 小明/);
  assert.match(a.html, /這封信寄給 reader@example\.com/);
  assert.match(a.html, /href="https:\/\/u\.example\.com\/x\?t=1&amp;a=2"/);
  assert.match(a.html, /href="https:\/\/example\.com\/p\/100"/);
  assert.match(a.html, /https:\/\/t\.example\.com\/c\/SIG1"/);
  assert.match(a.html, /https:\/\/t\.example\.com\/o\/SIGO\.gif/);
  assert.match(a.text, /親愛的 小明/);
  assert.match(a.text, /取消訂閱: https:\/\/u\.example\.com\/x\?t=1&a=2/);
  assert.equal(a.headers['List-Unsubscribe'], '<https://u.example.com/x?t=1&a=2>');
  assert.ok(!scanPlaceholders(a.html).unknown.length && !/\{\{/.test(a.html) && !/\{\{/.test(a.text));
  for (const name of [null, undefined, '', '   ']) {
    const b = personalize(c, { ...vars, name }, { track });
    assert.ok(!b.html.includes('親愛的'), '不出現問候');
    assert.ok(!/親愛的/.test(b.html + b.text));
    assert.ok(!/\{\{/.test(b.html) && !/\{\{/.test(b.text));
  }
});

test('個人化缺值與壞值：email、退訂網址、網頁版網址缺或不是 https 一律拋錯，不寄出殘留', () => {
  const c = compose(base());
  const fail = (v: object, code: string) => assert.throws(() => personalize(c, v as never, { track }), (e: unknown) => e instanceof PersonalizeError && e.code === code);
  fail({ ...vars, email: '' }, 'missing_field');
  fail({ ...vars, unsubscribe_url: '' }, 'missing_field');
  fail({ ...vars, web_url: undefined }, 'missing_field');
  fail({ ...vars, unsubscribe_url: 'http://u.example.com/x' }, 'bad_url');
  fail({ ...vars, web_url: 'javascript:alert(1)' }, 'bad_url');
  assert.throws(() => personalize(c, vars), (e: unknown) => e instanceof PersonalizeError && e.code === 'missing_track');
  assert.throws(() => personalize({ html: '{{foo}}', text: '' }, vars), (e: unknown) => e instanceof PersonalizeError && e.code === 'unknown_placeholder');
  assert.throws(() => personalize({ html: '{{#name}}x', text: '' }, vars), (e: unknown) => e instanceof PersonalizeError && e.code === 'unbalanced_section');
});

test('個人化：名字裡的 HTML／佔位文字不會被展開或執行；換行被壓平；過長被截', () => {
  const c = compose(base());
  const a = personalize(c, { ...vars, name: '<b>x</b> {{email}}\nline2' }, { track });
  assert.ok(!a.html.includes('<b>x</b>'));
  assert.match(a.html, /&lt;b&gt;x&lt;\/b&gt; \{\{email\}\} line2/);
  const long = personalize(c, { ...vars, name: '名'.repeat(200) }, { track });
  assert.ok(!long.html.includes('名'.repeat(61)));
});

test('寄前檢查：正常的一期通過；每一條失敗都有對應的測試', async () => {
  const good = await pf(compose(base()));
  assert.deepEqual(codes(good), []);
  assert.ok(good.ok && good.linksChecked && good.webChecked);
  assert.ok(good.linkStatuses.length >= 4); // 3 連結＋1 圖＋網頁版
});

test('寄前檢查 1：HTML 太大擋下', async () => {
  const big = compose(base({ source: `---\ntitle: t\ndescription: d\n---\n\n${'很長的一段文字。\n\n'.repeat(4000)}` }));
  assert.ok(big.htmlBytes > 90_000);
  assert.ok(codes(await pf(big)).includes('html_too_large'));
  assert.ok(codes(await pf(compose(base()), { maxHtmlBytes: 100 })).includes('html_too_large'));
});

test('寄前檢查 2：純文字版缺（模擬）擋下', async () => {
  const c = compose(base());
  assert.ok(codes(await pf({ ...c, text: '  ' })).includes('text_missing'));
});

test('寄前檢查 3：退訂連結、純文字退訂、兩個標頭缺任何一個擋下', async () => {
  const c = compose(base());
  assert.ok(codes(await pf({ ...c, html: c.html.replace('href="{{unsubscribe_url}}"', 'href="https://example.com/"') })).includes('unsubscribe_link_missing'));
  assert.ok(codes(await pf({ ...c, text: c.text.replace('{{unsubscribe_url}}', '') })).includes('unsubscribe_text_missing'));
  assert.ok(codes(await pf({ ...c, headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } })).includes('unsubscribe_header_missing'));
  assert.ok(codes(await pf({ ...c, headers: { 'List-Unsubscribe': '<{{unsubscribe_url}}>' } })).includes('unsubscribe_post_header_missing'));
});

test('寄前檢查 4：實體地址缺、是待補標記、沒進內容、頁尾有待補標記，都擋下', async () => {
  const c = compose(base());
  const t = (addr: string, extra: string[] = []) => createTemplate({ brandName: 'B', postalAddress: addr, footerLines: extra });
  const run = async (tpl: ReturnType<typeof t>) => codes(await preflight(compose(base({ template: tpl })), { template: tpl, fetch: okFetch, webUrl: WEB }));
  assert.ok((await run(t(''))).includes('address_missing'));
  assert.ok((await run(t('[[TODO: 補地址]]'))).includes('address_todo'));
  assert.ok((await run(t('1 Example Street', ['【待補：官網網址】']))).includes('todo_marker'));
  assert.deepEqual(await run(t('1 Example Street & Co <Unit 2>')), []);
  assert.ok(codes(await pf({ ...c, html: c.html.replace('1 Example Street', 'x') })).includes('address_not_in_html'));
  assert.ok(codes(await pf({ ...c, text: c.text.replace('1 Example Street', 'x') })).includes('address_not_in_text'));
});

test('寄前檢查 5：圖片沒有替代文字擋下；http 圖片只警告', async () => {
  const c = compose(base({ source: '---\ntitle: t\ndescription: d\n---\n\n![](https://img.example.com/a.png)\n\n![ok](http://img.example.com/b.png)' }));
  const r = await pf(c);
  assert.ok(codes(r).includes('image_alt_missing'));
  assert.ok(codes(r, 'warn').includes('image_insecure'));
});

test('寄前檢查 6：主旨太長、沒主旨、含換行、沒預覽文字都擋下', async () => {
  const c = compose(base());
  assert.ok(codes(await pf({ ...c, subject: '字'.repeat(81) })).includes('subject_too_long'));
  assert.ok(!codes(await pf({ ...c, subject: '字'.repeat(80) })).includes('subject_too_long'));
  assert.ok(!codes(await pf({ ...c, subject: '😀'.repeat(80) })).includes('subject_too_long'), '用字數不用位元組');
  assert.ok(codes(await pf({ ...c, subject: '' })).includes('subject_missing'));
  assert.ok(codes(await pf({ ...c, subject: 'a\nBcc: x@example.com' })).includes('subject_invalid'));
  assert.ok(codes(await pf({ ...c, preheader: ' ' })).includes('preheader_missing'));
});

test('寄前檢查 7：殘留的 {{…}} 與沒配對的區段擋下（正文、純文字、標頭）', async () => {
  const c = compose(base({ source: '---\ntitle: t\ndescription: d\n---\n\n你好 {{nmae}}，{{#name}}沒關' }));
  const r = await pf(c);
  assert.ok(codes(r).includes('unknown_placeholder'));
  assert.ok(codes(r).includes('unbalanced_section'));
  assert.ok(codes(await pf({ ...compose(base()), headers: { ...compose(base()).headers, 'X-A': '{{zzz}}' } })).includes('unknown_placeholder'));
  assert.ok(codes(await pf({ ...compose(base()), html: compose(base()).html + '{{ half' })).includes('unknown_placeholder'));
});

test('寄前檢查 8：只有 404／410 算壞連結；逾時、連不上、其他狀態只警告；圖片壞掉擋下；內網位址擋下', async () => {
  const c = compose(base());
  const status = (m: Record<string, number | 'throw'>): PreflightOptions['fetch'] => async (url) => {
    const v = Object.entries(m).find(([k]) => url.includes(k))?.[1] ?? 200;
    if (v === 'throw') throw new Error('net');
    return { status: v };
  };
  const r404 = await pf(c, { fetch: status({ '/a?': 404 }) });
  assert.ok(codes(r404).includes('link_broken'));
  assert.ok(codes(await pf(c, { fetch: status({ '/a?': 410 }) })).includes('link_broken'));
  for (const s of [500, 403, 429, 503]) {
    const r = await pf(c, { fetch: status({ '/a?': s }) });
    assert.ok(r.ok && codes(r, 'warn').includes('link_status'), `HTTP ${s} 只警告`);
  }
  const rt = await pf(c, { fetch: status({ '/a?': 'throw' }) });
  assert.ok(rt.ok && codes(rt, 'warn').includes('link_unverified'));
  assert.ok(codes(await pf(c, { fetch: status({ 'hero.png': 404 }) })).includes('image_broken'));
  assert.ok(codes(await pf(c, { webUrl: 'https://example.com/p/100', fetch: status({ '/p/100': 404 }) })).includes('link_broken'));
  const priv = compose(base({ source: '---\ntitle: t\ndescription: d\n---\n\n[x](http://127.0.0.1/a) [y](http://192.168.1.5/) [z](http://localhost:8080/)' }));
  assert.equal(codes(await pf(priv)).filter((x) => x === 'link_private_host').length, 3);
  // HEAD 不支援 → 改用 GET
  const methods: string[] = [];
  await pf(c, { fetch: async (_u, init) => { methods.push(init?.method ?? ''); return { status: init?.method === 'HEAD' ? 405 : 200 }; } });
  assert.ok(methods.includes('GET'));
  // 離線模式：不打網路，但沒查過連結就不准排程
  const off = await pf(c, { checkLinks: false, fetch: async () => { throw new Error('should not be called'); } });
  assert.ok(!off.ok && codes(off).includes('links_unchecked') && !off.linksChecked);
});

test('寄前檢查：原稿轉不出來的問題會一路帶進檢查結果（不准帶錯寄）', async () => {
  const c = compose(base({ source: '---\ntitle: t\ndescription: d\n---\n\n:::weird\nx\n:::' }));
  const r = await pf(c);
  assert.ok(!r.ok);
  assert.ok(codes(r).includes('unsupported_syntax'));
});

test('預覽輸出：產出信件、純文字、檢查報告、預覽頁；沒名字版另存', async () => {
  const c = compose(base());
  const r = await pf(c);
  const p = buildPreview(c, r, { withoutName: true });
  assert.deepEqual(Object.keys(p.files).sort(), ['check.json', 'email-no-name.html', 'email-no-name.txt', 'email.html', 'email.txt', 'index.html', 'links.json']);
  assert.match(p.files['index.html'], /Checks passed/);
  assert.match(p.files['index.html'], /srcdoc="/);
  assert.ok(!p.files['index.html'].includes('<iframe sandbox="" style="width:375px;height:900px;border:1px solid #bbb;background:#fff" srcdoc="<'), 'srcdoc 內容有跳脫');
  assert.ok(!/\{\{/.test(p.files['email.html']));
  const bad = buildPreview({ ...c, subject: '' }, await pf({ ...c, subject: '' }));
  assert.match(bad.files['index.html'], /FAILED/);
});

test('markdown 解析：frontmatter 欄位、表格、巢狀清單、腳註不崩', () => {
  const p = parseMarkdown(sample);
  assert.equal(p.frontmatter.title, '範例週報｜每週一點：2026/01/05');
  assert.equal(p.frontmatter.draft, 'false');
  assert.ok(!('tags' in p.frontmatter), '清單欄位不收');
  assert.ok(p.blocks.some((b) => b.t === 'table'));
  const list = p.blocks.find((b) => b.t === 'list');
  assert.ok(list && list.t === 'list' && list.items.length === 3);
  assert.doesNotThrow(() => parseMarkdown('文字[^1]\n\n[^1]: 註'));
  assert.doesNotThrow(() => parseMarkdown(''));
  assert.doesNotThrow(() => parseMarkdown('**未關閉 [未關閉](http://x'));
});

test('樣板：自訂頁尾區塊與退訂引導句進 HTML 與純文字；退訂連結仍在最底部', async () => {
  const tpl = createTemplate({
    brandName: 'B',
    postalAddress: '1 Example Street',
    footerHtml: '<p>Custom block <a href="https://example.com/about">About</a></p>',
    footerText: 'Custom block: https://example.com/about',
    unsubscribeLead: 'No longer interested?',
    labels: { unsubscribe: 'Unsubscribe' },
  });
  const c = compose(base({ template: tpl }));
  assert.match(c.html, /Custom block <a href="https:\/\/example\.com\/about">About<\/a>/);
  assert.match(c.html, /No longer interested\? <a [^>]*href="\{\{unsubscribe_url\}\}"/);
  assert.ok(c.html.indexOf('Custom block') < c.html.indexOf('unsubscribe_url}}"'));
  assert.match(c.text, /Custom block: https:\/\/example\.com\/about/);
  assert.match(c.text, /No longer interested\? Unsubscribe: \{\{unsubscribe_url\}\}\n$/);
  assert.deepEqual(codes(await preflight(c, { template: tpl, fetch: okFetch, webUrl: WEB })), []);
});

test('寄前檢查：轉址每一跳都重查內網；內網各種寫法（IPv6、對映、十進位、100.64）都擋；轉到壞頁照 404 算', async () => {
  const c = compose(base({ source: '---\ntitle: t\ndescription: d\n---\n\n[x](https://example.com/r)' }));
  const redirectTo = (to: string): PreflightOptions['fetch'] => async (url) => (url === 'https://example.com/r' ? { status: 302, headers: { get: (n) => (n.toLowerCase() === 'location' ? to : null) } } : { status: 200 });
  for (const to of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0x7f000001/', 'http://0x7f.1/', 'http://100.64.0.1/', 'http://metadata.internal/', 'http://[fd00::1]/']) {
    assert.ok(codes(await pf(c, { fetch: redirectTo(to) })).includes('link_redirect_private'), `轉到 ${to} 要擋`);
  }
  assert.ok(codes(await pf(c, { fetch: redirectTo('javascript:alert(1)') })).includes('link_redirect_bad'));
  assert.ok(codes(await pf(c, { fetch: async (url) => ({ status: 302, headers: { get: () => `${url}x` } }) })).includes('link_redirect_bad'), '轉不完＝擋');
  // 轉去正常頁面：通過；轉去 404：壞連結
  assert.deepEqual(codes(await pf(c, { fetch: redirectTo('https://example.org/ok') })), []);
  const to404: PreflightOptions['fetch'] = async (url) => (url === 'https://example.com/r' ? { status: 301, headers: { get: () => 'https://example.org/gone' } } : { status: url.includes('gone') ? 404 : 200 });
  assert.ok(codes(await pf(c, { fetch: to404 })).includes('link_broken'));
  // 直接寫在原稿裡的內網寫法
  const direct = compose(base({ source: '---\ntitle: t\ndescription: d\n---\n\n[a](http://[::ffff:7f00:1]/) [b](http://100.64.1.1/) [c](http://0x7f000001/)' }));
  assert.equal(codes(await pf(direct)).filter((x) => x === 'link_private_host').length, 3);
});

const FM = '---\ntitle: t\ndescription: d\n---\n\n';

test('沒收尾的註解與程式碼框：記 error，後面的內容不能被默默吃掉', async () => {
  const c1 = compose(base({ source: `${FM}para1\n\n<!-- note\n\npara2 還在` }));
  assert.ok(c1.problems.some((p) => p.code === 'unclosed_comment' && p.severity === 'error'));
  assert.match(c1.text, /para2 還在/, '註解沒收尾時，後面的段落仍保留');
  assert.ok(!(await pf(c1)).ok);
  const c2 = compose(base({ source: `${FM}para1\n\n\`\`\`\ncode\n\npara2` }));
  assert.ok(c2.problems.some((p) => p.code === 'unclosed_fence' && p.severity === 'error'));
  assert.ok(!(await pf(c2)).ok);
  // 有收尾的照常
  const ok = compose(base({ source: `${FM}a\n\n<!-- 註解 -->\n\n\`\`\`\ncode\n\`\`\`\n\nb` }));
  assert.deepEqual(ok.problems.filter((p) => p.severity === 'error'), []);
  assert.doesNotMatch(ok.text, /註解/);
});

test('<網址> 自動連結、<a href>、<b>／<i>：認得；<a> 只留 href 與文字；圖表（mermaid）換成連結卡', () => {
  const c = compose(base({ source: `${FM}看這篇 <https://example.com/a> 與 <a href="https://example.com/b" target="_blank" rel="nofollow" onclick="x()">B 站</a>，<b>粗</b><i>斜</i>\n\n圖片來源：<a href='https://example.com/c'>C</a>\n\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`` }));
  assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), []);
  assert.deepEqual(c.links.map((l) => l.original), ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
  assert.ok(!/onclick|nofollow|_blank/.test(c.html));
  assert.match(c.html, /<strong>粗<\/strong><em>斜<\/em>/);
  assert.match(c.html, />B 站<\/a>/);
  assert.match(c.html, /href="\{\{web_url\}\}"[^>]*>這個內容請到網站觀看/);
  assert.ok(c.problems.some((p) => p.code === 'embed_replaced'));
  // 不成對或不認得的標籤仍是 error
  assert.ok(compose(base({ source: `${FM}<span style="x">a</span>` })).problems.some((p) => p.code === 'unsupported_html'));
  assert.ok(compose(base({ source: `${FM}<a name="x">沒有 href</a>` })).problems.some((p) => p.code === 'unsupported_html'));
});

test('utm 直接接在原網址後面：原本的查詢字串、逗號、斜線、無值參數、錨點都原樣保留', () => {
  const urls = ['https://example.com/p?sig=a/b,c%2Fd&t&x=1#frag', 'https://example.com/plain', 'https://example.com/q?', 'https://example.com/r?utm_campaign=mine'];
  const c = compose(base({ source: `${FM}${urls.map((u, i) => `[l${i}](${u})`).join(' ')}` }));
  assert.equal(c.links[0].url, 'https://example.com/p?sig=a/b,c%2Fd&t&x=1&utm_source=newsletter&utm_medium=email&utm_campaign=2026-01-05#frag');
  assert.equal(c.links[1].url, 'https://example.com/plain?utm_source=newsletter&utm_medium=email&utm_campaign=2026-01-05');
  assert.equal(c.links[2].url, 'https://example.com/q?utm_source=newsletter&utm_medium=email&utm_campaign=2026-01-05');
  assert.equal(c.links[3].url, 'https://example.com/r?utm_campaign=mine&utm_source=newsletter&utm_medium=email');
});

test('離線模式與沒給網頁版網址：都不准排程，並回報有沒有真的查過', async () => {
  const c = compose(base());
  const off = await preflight(c, { template, checkLinks: false, webUrl: WEB });
  assert.ok(!off.ok && !off.linksChecked && !off.webChecked && codes(off).includes('links_unchecked'));
  const noWeb = await preflight(c, { template, fetch: okFetch });
  assert.ok(!noWeb.ok && !noWeb.webChecked && codes(noWeb).includes('web_url_unchecked'));
  const full = await pf(c);
  assert.ok(full.ok && full.linksChecked && full.webChecked);
  const webDown = await pf(c, { fetch: async (u) => { if (u === WEB) throw new Error('net'); return { status: 200 }; } });
  assert.ok(!webDown.webChecked && codes(webDown, 'warn').includes('web_url_unverified'));
});

test('頁尾（樣板）裡的圖與連結也檢查：壞連結、壞圖、缺替代文字、待補標記網址都擋下', async () => {
  const mk = (footerHtml: string) => createTemplate({ brandName: 'B', postalAddress: '1 Example Street', footerHtml });
  const run = async (footerHtml: string, fetch: PreflightOptions['fetch'] = okFetch) => {
    const tpl = mk(footerHtml);
    return preflight(compose(base({ template: tpl })), { template: tpl, fetch, webUrl: WEB });
  };
  const gone = (needle: string): PreflightOptions['fetch'] => async (u) => ({ status: u.includes(needle) ? 404 : 200 });
  assert.ok(codes(await run('<img src="https://cdn.example.com/logo.png" alt="logo">', gone('logo.png'))).includes('image_broken'));
  assert.ok(codes(await run('<a href="https://example.com/about">x</a>', gone('/about'))).includes('link_broken'));
  assert.ok(codes(await run('<img src="https://cdn.example.com/logo.png">')).includes('image_alt_missing'));
  const todo = await run('<img src="[[TODO: 自家圖床網址]]" alt="logo">');
  assert.ok(codes(todo).includes('todo_marker') && codes(todo).includes('link_invalid'));
  assert.deepEqual(codes(await run('<img src="https://cdn.example.com/logo.png" alt="logo"><a href="mailto:a@example.com">m</a><a href="tel:+100">t</a>')), []);
});

test('錨點與 tel：#錨點拿掉連結只警告、tel 原樣保留不追蹤', () => {
  const c = compose(base({ source: `${FM}[跳](#sec) [打電話](tel:+886000000000)` }));
  assert.ok(c.problems.some((p) => p.code === 'anchor_link' && p.severity === 'warn'));
  assert.match(c.html, /href="tel:\+886000000000"/);
  assert.equal(c.links.length, 0);
  assert.ok(!c.html.includes('href="#sec"'));
});

test('退訂標頭：可帶 mailto 兩段；兩種寫法 preflight 都接受；少填或亂填 mailto 拋錯；網址夾換行拋錯', async () => {
  const c = compose(base({ unsubscribeMailto: true }));
  assert.equal(c.headers['List-Unsubscribe'], '<{{unsubscribe_url}}>, <{{unsubscribe_mailto}}>');
  assert.deepEqual(codes(await pf(c)), []);
  assert.deepEqual(codes(await pf(compose(base()))), []);
  const v = { ...vars, unsubscribe_mailto: 'mailto:unsub@example.com?subject=abc123' };
  const p = personalize(c, v, { track });
  assert.equal(p.headers['List-Unsubscribe'], '<https://u.example.com/x?t=1&a=2>, <mailto:unsub@example.com?subject=abc123>');
  assert.throws(() => personalize(c, vars, { track }), (e: unknown) => e instanceof PersonalizeError && e.code === 'missing_field');
  for (const bad of ['unsub@example.com', 'mailto:a b@example.com', 'mailto:a@example.com,b@example.com', 'mailto:<x>@example.com']) {
    assert.throws(() => personalize(c, { ...vars, unsubscribe_mailto: bad }, { track }), (e: unknown) => e instanceof PersonalizeError && e.code === 'bad_url', bad);
  }
  assert.throws(() => personalize(c, { ...v, unsubscribe_url: 'https://u.example.com/x\r\nBcc: a@example.com' }, { track }), (e: unknown) => e instanceof PersonalizeError && e.code === 'bad_url');
  assert.throws(() => personalize(c, { ...v, web_url: 'https://example.com/\n' + 'x' }, { track }), (e: unknown) => e instanceof PersonalizeError);
  // 內容裡有 mailto 佔位但標頭只有一段、或標頭寫錯格式 → 擋
  assert.ok(codes(await pf({ ...c, headers: { ...c.headers, 'List-Unsubscribe': '<{{unsubscribe_mailto}}>' } })).includes('unsubscribe_header_missing'));
});

test('假點擊標記：寄出後 60 秒內同一封信點了 3 個以上不同連結＝標記；邊界與不同信互不影響', () => {
  const t0 = 1_000_000;
  const sent = new Map([['m1', t0], ['m2', t0], ['m3', t0]]);
  const ck = (id: string, m: string, l: number, dt: number) => ({ id, messageId: m, linkIndex: l, at: t0 + dt });
  const flagged = detectScannerClicks([
    ck('a1', 'm1', 1, 2_000), ck('a2', 'm1', 2, 2_100), ck('a3', 'm1', 3, 2_200), ck('a4', 'm1', 1, 50_000), // m1：窗內 3 個不同連結 → 全標（含窗內重複點）
    ck('b1', 'm2', 1, 1_000), ck('b2', 'm2', 2, 1_100), ck('b3', 'm2', 2, 1_200), // m2：只 2 個不同連結 → 不標
    ck('c1', 'm3', 1, 1_000), ck('c2', 'm3', 2, 1_100), ck('c3', 'm3', 3, 60_001), // m3：第 3 個超過 60 秒 → 不標
    ck('d1', 'nope', 1, 1), ck('d2', 'nope', 2, 2), ck('d3', 'nope', 3, 3), // 查不到寄出時間 → 不標
    ck('e1', 'm1', 4, 120_000), // 窗外 → 不標
  ], sent);
  assert.deepEqual([...flagged].sort(), ['a1', 'a2', 'a3', 'a4']);
  const exact = detectScannerClicks([ck('x1', 'm1', 1, 0), ck('x2', 'm1', 2, 30_000), ck('x3', 'm1', 3, 60_000)], { m1: t0 });
  assert.equal(exact.size, 3, '剛好 60 秒算在窗內');
  assert.equal(detectScannerClicks([ck('y1', 'm1', 1, -5), ck('y2', 'm1', 2, 1), ck('y3', 'm1', 3, 2)], sent).size, 0, '寄出前的點擊不算');
  assert.equal(detectScannerClicks([ck('z1', 'm1', 1, 1), ck('z2', 'm1', 2, 2)], sent, { minDistinctLinks: 2 }).size, 2, '門檻可調');
});

test('小問題：&nbsp; 不重複跳脫；{{ 可用 \\{\\{ 跳脫成字面；沒名字的純文字沒有連續空行；行內圖不寫死寬度；HEAD 回 404 再用 GET 確認', async () => {
  const c = compose(base({ source: `${FM}a&nbsp;b &amp; c &lt;x&gt; &#39;q&#39;\n\n範例語法：\\{\\{name}} 與 \`{{code}}\`\n\n文字![行內](https://img.example.com/i.png)後` }));
  assert.ok(!c.html.includes('&amp;nbsp;') && !c.html.includes('&amp;amp;'));
  assert.match(c.html, /a b &amp; c &lt;x&gt; &#39;q&#39;/);
  assert.deepEqual(codes(await pf(c)), []);
  const p = personalize(c, vars, { track });
  assert.match(p.text, /範例語法：\{\{name\}\} 與 \{\{code\}\}/);
  assert.match(p.html, /&#123;&#123;name\}\}/);
  assert.ok(!/width="\d+"[^>]*i\.png|i\.png[^>]*width="\d+"/.test(c.html));
  const nn = personalize(compose(base()), { ...vars, name: null }, { track });
  assert.ok(!/\n{3,}/.test(nn.text));
  const methods: string[] = [];
  const r = await pf(compose(base()), { fetch: async (_u, init) => { methods.push(init?.method ?? ''); return { status: init?.method === 'HEAD' ? 404 : 200 }; } });
  assert.ok(r.ok && methods.includes('GET'), 'HEAD 404 但 GET 200 不算壞連結');
  const real404 = await pf(compose(base()), { fetch: async () => ({ status: 404 }) });
  assert.ok(codes(real404).includes('link_broken'));
});

test('註解不論在哪都藏起來：段落下一行、清單項目裡、行內、跨行、連續兩個；程式碼框裡的註解不動', async () => {
  const src = `${FM}段落一\n<!-- 備註甲 -->\n段落尾\n\n- 項目\n  <!-- 備註乙 -->\n- 項目二\n\n文字 <!-- 備註丙 --> 文字\n\n前\n<!-- 備註丁\n第二行\n-->\n後\n\n<!-- 戊 --><!-- 己 -->結尾字\n\n\`\`\`\n<!-- 程式碼框裡的註解要留 -->\n\`\`\``;
  const c = compose(base({ source: src }));
  assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), []);
  for (const hidden of ['備註甲', '備註乙', '備註丙', '備註丁', '第二行', '戊', '己']) {
    assert.ok(!c.html.includes(hidden) && !c.text.includes(hidden), `${hidden} 不該出現在信裡`);
  }
  for (const shown of ['段落一', '段落尾', '項目二', '文字', '前', '後', '結尾字']) assert.ok(c.text.includes(shown), `${shown} 應保留`);
  assert.match(c.html, /&lt;!-- 程式碼框裡的註解要留 --&gt;/);
  assert.deepEqual(codes(await pf(c)), []);
});

test('沒收尾的註解（行首、段落下一行、清單項目裡、行內）都記 error，且後面的文字不被吃掉', async () => {
  for (const [name, src] of [
    ['行首', `${FM}前面\n\n<!-- 沒收尾\n\n後面段落`],
    ['段落下一行', `${FM}前面\n<!-- 沒收尾\n\n後面段落`],
    ['清單項目裡', `${FM}- 項目\n  <!-- 沒收尾\n\n後面段落`],
    ['行內', `${FM}前面 <!-- 沒收尾\n\n後面段落`],
  ] as const) {
    const c = compose(base({ source: src }));
    assert.ok(c.problems.some((p) => p.code === 'unclosed_comment' && p.severity === 'error'), `${name}：要記 unclosed_comment`);
    assert.match(c.text, /後面段落/, `${name}：後面段落要保留`);
    assert.ok(!(await pf(c)).ok, `${name}：不准排程`);
  }
});

test('行首單獨一個 <https://…> 自動連結：是連結，不是 HTML 區塊；後面的圖與段落都在', async () => {
  const c = compose(base({ source: `${FM}前言\n\n<https://example.com/alone>\n\n![後面的圖](https://img.example.com/after.png)\n\n<https://example.com/two> 行首接文字\n\n結尾段落` }));
  assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), []);
  assert.deepEqual(c.links.map((l) => l.original), ['https://example.com/alone', 'https://example.com/two']);
  assert.equal(c.images.length, 1);
  assert.match(c.text, /結尾段落/);
  assert.deepEqual(codes(await pf(c)), []);
});

test('頁尾用單引號的連結與圖也檢查；沒有追蹤網址時同一個網址不打兩次', async () => {
  const tpl = createTemplate({ brandName: 'B', postalAddress: '1 Example Street', footerHtml: "<a href='https://example.com/single'>x</a><img src='https://cdn.example.com/s.png' alt='s'>" });
  const asked: string[] = [];
  const gone: PreflightOptions['fetch'] = async (u) => { asked.push(u); return { status: u.includes('single') || u.includes('s.png') ? 404 : 200 }; };
  const r = await preflight(compose(base({ template: tpl })), { template: tpl, fetch: gone, webUrl: WEB });
  assert.ok(codes(r).includes('link_broken') && codes(r).includes('image_broken'));
  const asked2: string[] = [];
  const c = compose(base({ trackBase: undefined, source: `${FM}[a](https://example.com/one) [b](https://example.com/two)` }));
  await pf(c, { fetch: async (u, init) => { if (init?.method === 'HEAD') asked2.push(u); return { status: 200 }; } });
  assert.equal(asked2.filter((u) => u.includes('/one')).length, 1);
  assert.equal(asked2.filter((u) => u.includes('/two')).length, 1);
});

test('只有 <div …> 或 </div> 的外框行（語言標記等）：外框丟掉、裡面的引言與段落照常轉', () => {
  const c = compose(base({ source: `${FM}前\n\n<div lang="zh-Hans">\n\n> 引言內容\n\n</div>\n\n後` }));
  assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), []);
  assert.match(c.html, /<blockquote/);
  assert.ok(!c.html.includes('<div lang'));
  // 帶別的內容的 div 仍然不收
  assert.ok(compose(base({ source: `${FM}<div class="x">夾帶文字</div>` })).problems.some((p) => p.code === 'unsupported_html'));
});

test('行內程式碼裡的 <!-- 與 --> 不是註解：兩者之間的正文不會消失；同段、不同段落都一樣；沒有對應 --> 也不誤報', () => {
  const same = compose(base({ source: `${FM}寫 \`<!--\` 開頭，中間這段正文要留，再寫 \`-->\` 收尾\n\n後面段落` }));
  assert.deepEqual(same.problems.filter((p) => p.severity === 'error'), []);
  assert.match(same.text, /中間這段正文要留/);
  assert.match(same.html, /<code[^>]*>&lt;!--<\/code>/);
  const apart = compose(base({ source: `${FM}第一段 \`<!--\` 在這\n\n中間段落甲\n\n中間段落乙\n\n第四段 \`-->\` 在這` }));
  assert.deepEqual(apart.problems.filter((p) => p.severity === 'error'), []);
  assert.match(apart.text, /中間段落甲[\s\S]*中間段落乙/);
  const lone = compose(base({ source: `${FM}只有開頭 \`<!--\` 沒有收尾\n\n後面段落` }));
  assert.deepEqual(lone.problems.filter((p) => p.severity === 'error'), [], '行內程式碼裡的 <!-- 不誤報');
  // 行內程式碼之後的真註解照樣被剝掉；雙反引號與沒配對的反引號
  const mixed = compose(base({ source: `${FM}看 \`<!--\` 範例 <!-- 真註解 --> 與 \`\`含 \` 的碼 <!--\`\` 結尾\n\n又一個沒配對的 \` 反引號 <!-- 藏起來 --> 之後` }));
  assert.deepEqual(mixed.problems.filter((p) => p.severity === 'error'), []);
  assert.ok(!mixed.text.includes('真註解') && !mixed.text.includes('藏起來'));
  assert.match(mixed.text, /之後/);
});

test('清單與引言裡縮排的程式碼框：裡面的註解原樣保留（與解析器一致）', () => {
  const c = compose(base({ source: `${FM}- 項目\n\n    \`\`\`\n    <!-- 框內註解 -->\n    \`\`\`\n\n> \`\`\`\n> <!-- 引言框內 -->\n> \`\`\`\n\n尾段` }));
  assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), []);
  assert.match(c.html, /框內註解/);
  assert.match(c.html, /引言框內/);
  assert.match(c.text, /尾段/);
});

test('div 外框只收沒屬性或只有 lang 的；hidden／style 等一律 error（不然要藏的字會寄出去）', () => {
  for (const tag of ['<div hidden>', '<div style="display:none">', '<div lang="zh" hidden>', '<div class="x">']) {
    const c = compose(base({ source: `${FM}${tag}\n\n藏的字\n\n</div>` }));
    assert.ok(c.problems.some((p) => p.code === 'unsupported_html' && p.severity === 'error'), tag);
  }
  for (const tag of ['<div>', '<div lang="zh-Hans">', "<div lang='en'>"]) {
    const c = compose(base({ source: `${FM}${tag}\n\n看得到的字\n\n</div>` }));
    assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), [], tag);
    assert.match(c.text, /看得到的字/);
  }
});

test('看起來像標籤的字：訊息告訴作者怎麼改寫，不是「信件排不出來的 HTML」', () => {
  for (const src of [`${FM}參考 <Research.example> 的做法`, `${FM}詳細閱讀：</p/100110>`, `${FM}<Research.example> 在行首`]) {
    const c = compose(base({ source: src }));
    const p = c.problems.find((x) => x.code === 'unsupported_html');
    assert.ok(p && p.severity === 'error' && /看起來像 HTML 標籤/.test(p.message) && /改寫/.test(p.message), src);
  }
  const real = compose(base({ source: `${FM}字<span>x</span>` })).problems.find((x) => x.code === 'unsupported_html');
  assert.match(real?.message ?? '', /排不出來的行內 HTML 標籤/);
});

// ───────── 註解 × 各種程式碼寫法：兩兩組合的對抗測試 ─────────
// 原則：每一種組合，不是正確處理（真註解不外露、程式碼裡的註解與正文都在），就是記 error；
// 絕不「註解外露卻零 error」，也絕不「內容消失卻零 error」。
const CODE_CONTEXTS: { name: string; incode: boolean; make: (c: string) => string }[] = [
  { name: '頂格程式碼框', incode: true, make: (c) => `\`\`\`\n${c}\n\`\`\`` },
  { name: '波浪線程式碼框', incode: true, make: (c) => `~~~\n${c}\n~~~` },
  { name: '清單內程式碼框', incode: true, make: (c) => `- 項目\n\n    \`\`\`\n    ${c}\n    \`\`\`` },
  { name: '引言內程式碼框', incode: true, make: (c) => `> \`\`\`\n> ${c}\n> \`\`\`` },
  { name: '單反引號', incode: true, make: (c) => `文字 \`${c}\` 文字` },
  { name: '雙反引號', incode: true, make: (c) => `文字 \`\`${c} \` x\`\` 文字` },
  // 已裁定：跨行行內程式碼遇到「以 <!-- 開頭的行」，照 CommonMark 那一行是註解區塊（會打斷段落），不是程式碼
  { name: '跨行行內程式碼（註解在行首）', incode: false, make: (c) => `文字 \`前\n${c} 後\` 文字` },
  { name: '跨行行內程式碼（註解不在行首）', incode: true, make: (c) => `文字 \`前\n中 ${c} 後\` 文字` },
  { name: '反斜線跳脫的反引號', incode: false, make: (c) => `文字 \\\`${c}\\\` 文字` },
  { name: '不成對的反引號', incode: false, make: (c) => `文字 \` ${c} 文字` },
  { name: '沒收尾的程式碼框', incode: true, make: (c) => `\`\`\`\n${c}` },
];
const TAILS: { name: string; make: (s: string) => string }[] = [
  { name: '後面行內註解', make: (s) => `${s}\n\nKEEP後文 <!-- SECRET甲 --> 之後` },
  { name: '後面跨行草稿註解', make: (s) => `${s}\n\nKEEP後文\n\n<!--\nSECRET乙\n\n還有一段 SECRET丙\n-->\n\n尾段` },
  { name: '註解在前面', make: (s) => `<!-- SECRET丁 -->\n\nKEEP前文\n\n${s}\n\n尾段` },
  { name: '後面接另一個程式碼框與註解', make: (s) => `${s}\n\nKEEP後文\n\n\`\`\`\n<!-- INCODE2 -->\n\`\`\`\n\n<!-- SECRET戊 -->` },
];

test('對抗測試：註解 × 程式碼寫法 兩兩組合，不是正確處理就是記 error', () => {
  let ran = 0;
  for (const ctx of CODE_CONTEXTS) {
    for (const tail of TAILS) {
      const src = `${FM}${tail.make(ctx.make('<!--INCODE-->'))}`;
      const c = compose(base({ source: src }));
      const errors = c.problems.filter((p) => p.severity === 'error');
      const out = `${c.html}\n${c.text}`;
      const label = `${ctx.name}／${tail.name}`;
      ran++;
      if (errors.length) continue; // 記了 error＝寧可擋下，合格
      assert.ok(!/SECRET/.test(out), `${label}：真註解外露了卻沒有 error`);
      if (tail.name !== '註解在前面') assert.ok(out.includes('KEEP後文'), `${label}：正文消失了卻沒有 error`);
      else assert.ok(out.includes('KEEP前文'), `${label}：正文消失了卻沒有 error`);
      assert.ok(out.includes('尾段') || tail.name.startsWith('後面行內') || tail.name.startsWith('後面接'), `${label}：尾段消失了卻沒有 error`);
      if (ctx.incode) assert.ok(/INCODE(?!2)/.test(out), `${label}：程式碼裡的註解內容消失了卻沒有 error`);
      else assert.ok(!/INCODE(?!2)/.test(out), `${label}：不是程式碼的註解外露了卻沒有 error`);
      if (tail.name.startsWith('後面接')) assert.ok(out.includes('INCODE2'), `${label}：後面程式碼框的內容消失了卻沒有 error`);
    }
  }
  assert.equal(ran, CODE_CONTEXTS.length * TAILS.length);
});

test('引言／清單裡的程式碼框後面接註解：註解被剝掉，不連累後文；保險能接住漏網的註解', () => {
  const q = compose(base({ source: `${FM}> \`\`\`\n> code\n> \`\`\`\n\n正文 <!-- 內部筆記 --> 之後\n\n<!--\n草稿註解\n-->\n\n尾段` }));
  assert.deepEqual(q.problems.filter((p) => p.severity === 'error'), []);
  assert.ok(!/內部筆記|草稿註解/.test(q.html + q.text));
  assert.match(q.text, /尾段/);
  const l = compose(base({ source: `${FM}- 項\n\n    \`\`\`\n    code\n    \`\`\`\n\n正文 <!-- 內部筆記 --> 之後` }));
  assert.deepEqual(l.problems.filter((p) => p.severity === 'error'), []);
  assert.ok(!/內部筆記/.test(l.html + l.text));
});

test('保險：程式碼以外若還留著 <!--（例如作者用反斜線跳脫了它），一定記 comment_leaked error 並擋下排程', async () => {
  assert.equal(parseMarkdown(`${FM}普通文字`).problems.length, 0);
  // 構造一個剝除器看不到、解析器卻當文字的寫法：反斜線後面接 < 的跳脫會在解析時還原成文字 "<!--"
  const sneaky = compose(base({ source: `${FM}前 \\<!-- 夾帶 --> 後` }));
  assert.ok(sneaky.problems.some((p) => p.code === 'comment_leaked' && p.severity === 'error'), '漏網的註解要被保險接住');
  assert.ok(!(await pf(sneaky)).ok);
});

test('保險二：最終 HTML／純文字在程式碼以外出現 <!--（例如原稿寫 &lt;!--）也擋下；樣板自己的 Outlook 條件註解不算', async () => {
  const ent = compose(base({ source: `${FM}前 &lt;!-- 夾帶 --&gt; 後` }));
  assert.ok(ent.problems.some((p) => p.code === 'comment_leaked' && p.severity === 'error'));
  assert.ok(!(await pf(ent)).ok);
  const fine = compose(base({ source: `${FM}一般段落\n\n\`<!-- 程式碼裡的 -->\`` }));
  assert.match(fine.html, /<!--\[if mso\]>/);
  assert.deepEqual(fine.problems.filter((p) => p.severity === 'error'), []);
});

test('有序清單的起始編號照原稿（網站顯示 2. 開頭，信裡也是）', () => {
  const c = compose(base({ source: `${FM}2. 第二\n3. 第三` }));
  assert.match(c.html, /<ol start="2"/);
  assert.match(c.text, /^2\. 第二$/m);
  assert.match(c.text, /^3\. 第三$/m);
});

test('裸網址後面緊貼的字（中文常見）：跟網站一樣算進連結，純文字版照「連結文字 (網址)」印，一個字都不少', () => {
  const errs = (c: ReturnType<typeof compose>) => c.problems.filter((p) => p.severity === 'error').map((p) => p.code);
  const c = compose(base({ source: `${FM}詳見https://example.com/a這篇文章\n\nhttps://example.com/p/1看完再說` }));
  assert.deepEqual(errs(c), []);
  // HTML：網站上整串都是連結文字，信裡也是
  assert.match(c.html, /<a class="mr-link" href="https:\/\/t\.example\.com\/c\/\{\{c:1\}\}"[^>]*>https:\/\/example\.com\/a這篇文章<\/a>/);
  assert.match(c.html, />https:\/\/example\.com\/p\/1看完再說<\/a>/);
  // 目的地跟網站一樣，非 ASCII 字轉成 %XX
  assert.equal(c.links[0].original, 'https://example.com/a%E9%80%99%E7%AF%87%E6%96%87%E7%AB%A0');
  // 純文字版：緊貼的字沒有消失
  assert.match(c.text, /詳見https:\/\/example\.com\/a這篇文章 \(https:\/\/t\.example\.com\/c\/\{\{c:1\}\}\)/);
  assert.match(c.text, /https:\/\/example\.com\/p\/1看完再說 \(https:\/\/t\.example\.com\/c\/\{\{c:2\}\}\)/);
});

test('非 ASCII 路徑的網址（維基條目、中文商品頁）整串連過去；空白（含全形空白）才結束網址', () => {
  const c = compose(base({ source: `${FM}參考：https://ja.wikipedia.org/wiki/写真 （查詢日）\n\nhttps://example.com/a　全形空白之後` }));
  assert.deepEqual(c.links.map((l) => l.original), ['https://ja.wikipedia.org/wiki/%E5%86%99%E7%9C%9F', 'https://example.com/a']);
  assert.match(c.html, />https:\/\/ja\.wikipedia\.org\/wiki\/写真<\/a> （查詢日）/);
  assert.match(c.text, /https:\/\/example\.com\/a \(https:\/\/t\.example\.com\/c\/\{\{c:2\}\}\)　全形空白之後/);
});

test('網址最後緊貼全形標點：照網站算進連結，另記 warn 提醒加空格（不擋）', () => {
  const c = compose(base({ source: `${FM}來源（https://example.com/a）。` }));
  assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), []);
  assert.ok(c.problems.some((p) => p.code === 'url_glued_text' && p.severity === 'warn'));
  // 網站：）和。都在連結裡（全形標點不算網址尾巴的標點）
  assert.match(c.html, />https:\/\/example\.com\/a）。<\/a>/);
  assert.match(c.text, /來源（https:\/\/example\.com\/a）。 \(https:\/\/t\.example\.com\/c\/\{\{c:1\}\}\)/);
});

test('純文字版的連結：看得到的連結文字一定印出來；只有它就是印出來的網址時才省略', () => {
  const tracked = compose(base({ source: `${FM}A https://example.com/x B\n\n[https://example.com/y](https://example.com/y)\n\n[信箱](mailto:hi@example.com) [a@example.com](mailto:a@example.com)` }));
  assert.match(tracked.text, /A https:\/\/example\.com\/x \(https:\/\/t\.example\.com\/c\/\{\{c:1\}\}\) B/);
  // [網址](網址)：網站的連結文字不再自動連結，信裡也只有一個連結
  assert.equal(tracked.links.length, 2);
  assert.match(tracked.text, /^https:\/\/example\.com\/y \(https:\/\/t\.example\.com\/c\/\{\{c:2\}\}\)$/m);
  assert.match(tracked.text, /信箱 \(mailto:hi@example\.com\) a@example\.com \(mailto:a@example\.com\)/);
  // 沒有追蹤：印出來的網址本身就含整串網址文字（後面多了 utm），不重複
  const plain = compose(base({ source: `${FM}A https://example.com/x B`, trackBase: undefined }));
  assert.match(plain.text, /^A https:\/\/example\.com\/x\?utm_source=newsletter&utm_medium=email&utm_campaign=2026-01-05 B$/m);
});

test('腳註引用緊貼在包著裸網址的括號、強調記號後面：網站把它吞進網址、不顯示腳註，信裡一律記 error', () => {
  const blocked = [
    'A (www.example.com**[^1]***) B',
    'A **https://example.com**[^1] B',
    '![圖](https://example.com/i.png)x(www.example.com**[^1]***) B',
    '<https://example.com/q>_https://example.com/p**[^1]** B',
    '[A](https://example.com)[_[B](https://example.com)*](https://example.com)[^1] C',
    // 同一個腳註另有正常的引用，被吞掉的那個也要擋
    'A[^1] **https://example.com**[^1] B',
  ];
  for (const body of blocked) {
    const c = compose(base({ source: `${FM}${body}\n\n[^1]: 說明` }));
    assert.ok(c.problems.some((p) => p.code === 'unsupported_syntax' && p.severity === 'error'), `應該擋下：${body}`);
  }
  for (const body of ['A **[B](https://example.com/a)**[^1] C', 'A [B](https://example.com)[^1] ![圖](https://example.com/i.png)[^1] <https://example.com/q>[^1]']) {
    const c = compose(base({ source: `${FM}${body}\n\n[^1]: 說明` }));
    assert.deepEqual(c.problems.filter((p) => p.severity === 'error'), [], `不該擋：${body}`);
  }
});

test('a link inside link text is blocked (the site shows the outer brackets and URL literally)', () => {
  const r = compose({ source: '前 [[內](https://example.com/x) 外](https://example.com/y) 後\n', template: createTemplate({ brandName: 'X', postalAddress: '1 Example Street' }), issue: 't-1' });
  assert.ok(r.problems.some((p) => p.severity === 'error' && p.code === 'unsupported_syntax' && /連結文字裡又有一個連結/.test(p.message)));
});

const fullCfg = {
  brandName: 'Example Weekly',
  lang: 'zh-Hant',
  footerLines: ['你收到這封信，是因為你訂閱了 Example Weekly。'],
  postalAddress: '1 Example Street, Sample City 00000',
  logoUrl: 'https://example.com/logo-2x.png',
  logoWidth: 232,
  logoHeight: 125,
  layout: 'full' as const,
};

test('版面 full：沒有灰底與卡片邊框；寬度預設 100%、最多 600；左右 16 px 寫在行內（不靠媒體查詢）', () => {
  const full = createTemplate(fullCfg);
  const html = compose(base({ template: full })).html;
  assert.ok(!html.includes('#f3f3f3'), '沒有灰底');
  assert.ok(!html.includes('mr-card mr-bd'), '沒有卡片外框');
  assert.match(html, /class="mr-wrap" width="100%"[^>]*style="width:100%;max-width:600px"/);
  assert.match(html, /<td class="mr-pad mr-text" style="[^"]*padding-left:16px;padding-right:16px/);
  assert.match(html, /<!--\[if mso\]><table role="presentation" width="600"/, 'Outlook 桌機仍固定 600');
  assert.match(html, /<body class="mr-card" style="margin:0;padding:0;background:#ffffff/);
});

test('版面 full：退訂連結、地址、網頁版連結、開信圖、預覽文字都還在，寄前檢查照樣通過', async () => {
  const full = createTemplate(fullCfg);
  const c = compose(base({ template: full }));
  for (const s of ['{{unsubscribe_url}}', '{{web_url}}', '1 Example Street', 'https://t.example.com/o/{{o}}.gif']) assert.ok(c.html.includes(s), s);
  assert.equal(c.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const r = await preflight(c, { template: full, fetch: okFetch, webUrl: WEB });
  assert.deepEqual(codes(r), []);
  assert.equal(c.text, compose(base({ template: createTemplate({ ...fullCfg, layout: 'card' }) })).text, '純文字版跟版面無關');
});

test('頁首圖示：給寬高就寫 width／height 屬性＋max-width:100%；沒給維持 36 px 高；寬高不完整或太寬就拋錯', () => {
  const html = createTemplate(fullCfg).renderHtml({ subject: 's', preheader: 'p', bodyHtml: '', bodyText: '' });
  assert.match(html, /<img src="https:\/\/example\.com\/logo-2x\.png" alt="Example Weekly" width="232" height="125" style="display:block;border:0;width:232px;max-width:100%;height:auto">/);
  const old = createTemplate({ ...fullCfg, logoWidth: undefined, logoHeight: undefined, layout: undefined }).renderHtml({ subject: 's', preheader: 'p', bodyHtml: '', bodyText: '' });
  assert.match(old, /height="36" style="display:block;border:0;height:36px;width:auto"/);
  assert.throws(() => createTemplate({ ...fullCfg, logoHeight: undefined }), /together/);
  assert.throws(() => createTemplate({ ...fullCfg, logoWidth: 0 }), /positive whole/);
  assert.throws(() => createTemplate({ ...fullCfg, logoWidth: 601 }), /wider than the content width/);
  assert.throws(() => createTemplate({ ...fullCfg, layout: 'wide' as never }), /layout must be/);
});

test('版面預設仍是 card：沒給 layout 與 layout: card 產出一字不差', () => {
  const cfg = { ...fullCfg, layout: undefined };
  const a = compose(base({ template: createTemplate(cfg) })).html;
  const b = compose(base({ template: createTemplate({ ...cfg, layout: 'card' }) })).html;
  assert.ok(a.includes('#f3f3f3') && a.includes('mr-card mr-bd'));
  assert.equal(a, b);
});

test('正文圖片寬度 imageWidth：給了才寫 width 屬性（Outlook 用），仍保留 max-width:100%；沒給維持舊寫法；超過內容寬度就拋錯', () => {
  const withW = compose(base({ template: createTemplate({ ...fullCfg, theme: { imageWidth: 568 } }) })).html;
  assert.match(withW, /<img src="https:\/\/img\.example\.com\/[^"]*" alt="[^"]*" width="568" style="display:block;border:0;width:568px;max-width:100%;height:auto">/);
  const without = compose(base({ template: createTemplate(fullCfg) })).html;
  assert.ok(!/<img [^>]*width="568"/.test(without));
  assert.match(without, /style="display:block;border:0;max-width:100%;height:auto"/);
  assert.throws(() => createTemplate({ ...fullCfg, theme: { imageWidth: 569 } }), /at most 568/);
  assert.throws(() => createTemplate({ ...fullCfg, layout: 'card', theme: { imageWidth: 537 } }), /at most 536/);
  assert.throws(() => createTemplate({ ...fullCfg, theme: { imageWidth: 0 } }), /positive whole/);
});

test('imageWidth 只套在自成一行的圖片；文中的小圖不套', () => {
  const t = createTemplate({ ...fullCfg, theme: { imageWidth: 568 } });
  const c = compose(base({ template: t, source: '---\ntitle: T\ndescription: D\n---\n\n![大圖](https://img.example.com/a.png)\n\n文字 ![小圖](https://img.example.com/b.png) 文字\n' }));
  assert.match(c.html, /alt="大圖" width="568"/);
  assert.match(c.html, /alt="小圖" style="display:inline-block;border:0;max-width:100%;height:auto"/);
});
