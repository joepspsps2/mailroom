import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose, createTemplate, parseMarkdown, personalize, preflight, buildPreview, scanPlaceholders, PersonalizeError, type ComposeOptions, type PreflightOptions } from '../src/compose/index.ts';

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
const pf = (c: ReturnType<typeof compose>, over: Partial<PreflightOptions> = {}) => preflight(c, { template, fetch: okFetch, ...over });
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
  // 網址後面緊貼的全形句號不算網址
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
  const good = await pf(compose(base()), { webUrl: 'https://example.com/p/100' });
  assert.deepEqual(codes(good), []);
  assert.ok(good.ok);
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
  const run = async (tpl: ReturnType<typeof t>) => codes(await preflight(compose(base({ template: tpl })), { template: tpl, fetch: okFetch }));
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
  // 離線模式：不打網路，記一條警告
  const off = await pf(c, { checkLinks: false, fetch: async () => { throw new Error('should not be called'); } });
  assert.ok(off.ok && codes(off, 'warn').includes('links_unchecked'));
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
  assert.deepEqual(codes(await preflight(c, { template: tpl, fetch: okFetch })), []);
});
