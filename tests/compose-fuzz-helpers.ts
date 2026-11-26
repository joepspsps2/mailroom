// 隨機探測：註解 × 程式碼寫法 × 區塊，拿 CommonMark 參照渲染器（satteri，只在 devDependencies）當「網站上讀者看到什麼」的標準答案，
// 檢查產信的三條不變式（任何輸入都要成立；記了 error＝寧可擋下，算合格）：
//   I1 網站上藏起來的（註解裡的字），不得出現在信件 HTML 或純文字版
//   I2 網站上看得到的（正文、程式碼），不得從信件 HTML 或純文字版消失
//   I3 程式碼裡的 <!--、--> 字樣原樣保留
// 測試本體在 compose-fuzz.test.ts；這裡是產生器與比對。
import { markdownToHtml } from 'satteri';
import { compose, createTemplate } from '../src/compose/index.ts';
import { LBRACE, parseMarkdown, type Block, type Inline } from '../src/compose/markdown.ts';

const template = createTemplate({
  brandName: 'Example Weekly',
  postalAddress: '1 Example Street',
  labels: { viewInBrowser: 'v', unsubscribe: 'u', sentTo: 's {email}', embedCard: 'e', image: (a) => `[img:${a}]` },
});
const FM = '---\ntitle: T\ndescription: D\n---\n';

// ───────── 參照：照瀏覽器的規則讀 HTML，標出每個記號是在註解裡、程式碼裡，還是正文 ─────────
type Where = 'comment' | 'code' | 'text';
const TOKEN = /(?:BODY|CMT|CODE)\d+X/g;
function classify(html: string): Map<string, Where[]> {
  const out = new Map<string, Where[]>();
  let inComment = false;
  let code = 0;
  for (let i = 0; i < html.length; ) {
    if (inComment) {
      const a = html.indexOf('-->', i);
      const b = html.indexOf('--!>', i);
      const e = a < 0 ? b : b < 0 ? a : Math.min(a, b);
      const seg = e < 0 ? html.slice(i) : html.slice(i, e);
      for (const m of seg.matchAll(TOKEN)) (out.get(m[0]) ?? out.set(m[0], []).get(m[0])!).push('comment');
      if (e < 0) break;
      inComment = false;
      i = e + (e === b ? 4 : 3);
      continue;
    }
    if (html.startsWith('<!--', i)) {
      // <!--> 與 <!---> 是空註解
      if (html.startsWith('<!-->', i)) i += 5;
      else if (html.startsWith('<!--->', i)) i += 6;
      else {
        inComment = true;
        i += 4;
      }
      continue;
    }
    if (html[i] === '<' && /[A-Za-z/!?]/.test(html[i + 1] ?? '')) {
      // 標籤結尾的 >：屬性值引號裡的 > 不算（替代文字裡可能有 </em> 之類）
      let end = -1;
      for (let k = i + 1, q = ''; k < html.length; k++) {
        const ch = html[k];
        if (q) {
          if (ch === q) q = '';
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '>') {
          end = k;
          break;
        }
      }
      if (end < 0) break; // 沒有收尾的 <：後面不會再有正文（不然會無限迴圈）
      const tag = html.slice(i, end + 1);
      // 圖片的替代文字：網站上是圖片說明（不是藏起來的內容），信裡也會印出來，算「看得到」
      if (/^<img\b/i.test(tag)) for (const m of (tag.match(/\balt="([^"]*)"/)?.[1] ?? '').matchAll(TOKEN)) (out.get(m[0]) ?? out.set(m[0], []).get(m[0])!).push('text');
      if (/^<code\b/i.test(tag)) code++;
      else if (/^<\/code>/i.test(tag)) code = Math.max(0, code - 1);
      i = end + 1;
      continue;
    }
    const next = html.indexOf('<', html[i] === '<' ? i + 1 : i); // 不是標籤的 < 當一般字
    const seg = next < 0 ? html.slice(i) : html.slice(i, next);
    for (const m of seg.matchAll(TOKEN)) (out.get(m[0]) ?? out.set(m[0], []).get(m[0])!).push(code ? 'code' : 'text');
    i = next < 0 ? html.length : next;
  }
  return out;
}

/** 參照 HTML 裡、在 <code> 之內的 <!--…、…--> 字樣（跳脫過的），信裡的純文字版要原樣找得到。 */
function codeMarks(html: string): string[] {
  const want: string[] = [];
  for (const m of html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)) {
    for (const x of m[1].matchAll(/&lt;!-- ((?:BODY|CMT|CODE)\d+X)/g)) want.push(`<!-- ${x[1]}`);
    for (const x of m[1].matchAll(/((?:BODY|CMT|CODE)\d+X) --&gt;/g)) want.push(`${x[1]} -->`);
  }
  return want;
}

// ───────── 產生器 ─────────
function makeGen(seed: number) {
  let s = seed >>> 0;
  const r = () => {
    s = (Math.imul(s, 0x41c64e6d) + 12345) >>> 0;
    return (s >>> 8) / 0x1000000;
  };
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
  let k = 0;
  const B = () => `BODY${++k}X`;
  const C = () => `CMT${++k}X`;
  const D = () => `CODE${++k}X`;
  const comment = (): string =>
    pick([
      () => `<!-- ${C()} -->`,
      () => `<!--${C()}-->`,
      () => `<!-- ${C()} \` x -->`,
      () => `<!-- ${C()} \`\`\` -->`,
      () => `<!--\n${C()}\n-->`,
      () => `<!-- ${C()} --><!-- ${C()} -->`,
      () => `<!-- ${C()}`,
      () => `<!--\n${C()}\n\n${C()}\n-->`,
      () => `<!-- ${C()} -->${B()}`,
      () => `<!-- ${C()} -- ${C()} -->`,
      () => `<!---->${B()}`,
      () => `<!-- \`${C()} -->\` ${B()}`,
    ])();
  const inline = (): string =>
    pick([
      B, B, B, comment, comment,
      () => `\`${D()}\``,
      () => `\`<!-- ${D()} -->\``,
      () => `\`\`${D()} \` <!-- ${D()} -->\`\``,
      () => `\`${D()}\n<!-- ${D()} --> ${D()}\``,
      () => `\`${D()}\nmid <!-- ${D()} --> ${D()}\``,
      () => `\`<!--\` ${B()} \`-->\``,
      () => `\\\`${B()}\\\``,
      () => `\\\\\`${D()}\``,
      () => `\\\\\\\`${B()}\``,
      () => `\` ${B()}`,
      () => '`',
      () => '``',
      () => `**${B()}**`,
      () => `*${B()} \`${D()}\`*`,
      () => `[${B()}](https://example.com/a)`,
      () => `[${B()} \`${D()}\`](https://example.com/b)`,
      () => `\\<!-- ${B()} -->`,
      () => `${B()} <!-- ${C()} \`${C()}\` -->`,
    ])();
  const inl = (n = 1 + Math.floor(r() * 4), seps = [' ', ' ', '\n']) => Array.from({ length: n }, inline).join(pick(seps));
  const cell = () => Array.from({ length: 1 + Math.floor(r() * 2) }, () => inline().replace(/\n/g, ' ')).join(' ').replace(/\|/g, '');
  const fenceBody = () =>
    Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick([() => D(), () => `<!-- ${D()} -->`, () => `\` ${D()}`, () => `<!--\n${D()}`, () => `${D()} -->`, () => '```', () => ''])()).join('\n');
  const fence = (ind = '') => {
    const m = pick(['```', '~~~', '````', '~~~~']);
    const info = pick(['', '', 'js']);
    const open = r() < 0.12;
    const body = fenceBody()
      .split('\n')
      .filter((l) => !(m.startsWith('`') && /^`{3,}$/.test(l) && l.length >= m.length))
      .map((l) => (l ? ind + l : l))
      .join('\n');
    return `${ind}${m}${info}\n${body}${open ? '' : `\n${ind}${m}`}`;
  };
  const pre = (t: string, p: string) => t.split('\n').map((l) => p + l).join('\n');
  const block = (): string =>
    pick([
      () => inl(),
      () => inl(),
      () => `${pick(['#', '##', '###'])} ${inl(2, [' '])}`,
      () => `- ${inl(2)}\n- ${inl(2)}`,
      () => `- ${inl(1)}\n  - ${inl(2)}`,
      () => `1. ${inl(2)}\n2. ${inl(1)}`,
      () => pre(inl(2), '> '),
      () => `> ${inl(1)}\n${inl(1)}`,
      () => `| ${cell()} | ${cell()} |\n|---|---|\n| ${cell()} | ${cell()} |`,
      () => fence(),
      () => fence(),
      () => `- item ${B()}\n\n${fence('  ')}`,
      () => `- ${B()}\n  - ${B()}\n\n${fence('    ')}`,
      () => pre(fence(), '> '),
      () => `- ${fence().replace(/\n/g, '\n  ')}`,
      () => `    ${D()}\n    <!-- ${D()} -->`,
      comment,
      () => `${inl(1)}\n${pick(['===', '---'])}`,
      // tab 與結構前綴、單獨一行的標籤、沒有 | 的表頭、偽註解（後兩類多半會被擋，所以合成一個分支、出現少一點）
      () => `${pick(['>\t', '>  \t', '> - \t', '-\t', '\t', '  \t'])}${pick([comment, inline, () => `<!-- ${D()} -->`])()}`,
      () => `${B()}\n${pick(['| --- |', ':-- |', '---|---'])}\n${pick([() => `    ${D()} <!-- ${D()} -->`, cell])()}`,
      () =>
        pick([
          () => `${pick(['<em>', '<br>', '<span>', '</div>', '<a href="https://example.com/c">'])}\n${inl(1)}`,
          () => `${pick(['- ', '> ', ''])}${inl(1)}\n${pick(['<span>', '<br>', '<b>'])}\n${inl(1)}`,
          () => pick([() => `${B()} <?x ${C()} ?> ${B()}`, () => `<!X ${C()}>`, () => `<![CDATA[\n${C()}\n]]>`])(),
        ])(),
    ])();
  return () => {
    k = 0;
    return Array.from({ length: 1 + Math.floor(r() * 4) }, block).join(pick(['\n\n', '\n\n', '\n']));
  };
}

export interface FuzzStats {
  n: number;
  errored: number;
  i1: { src: string; info: string }[];
  i2: { src: string; info: string }[];
  i3: { src: string; info: string }[];
}

/** 一份原稿：跟參照比對三條不變式。errored＝記了 error（寧可擋下，算合格，violations 一定是空的）。 */
// 程式碼內容逐字比對：參照渲染器的 <code> 內容 vs 解析樹的程式碼節點（只看帶 CODE 記號的，tab、空白都要一樣）
const unesc = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const refCode = (html: string) => [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => unesc(m[1]).replace(/\n$/, ''));
function astCode(bs: Block[], out: string[] = []): string[] {
  const inl = (ns: Inline[]) => {
    for (const x of ns) if (x.t === 'code') out.push(x.v);
    else if ('c' in x && Array.isArray(x.c)) inl(x.c as Inline[]);
  };
  for (const b of bs) {
    if (b.t === 'code') out.push(b.v);
    else if (b.t === 'p' || b.t === 'h') inl(b.c);
    else if (b.t === 'quote') astCode(b.c, out);
    else if (b.t === 'list') for (const it of b.items) astCode(it, out);
    else if (b.t === 'table') for (const c of [...b.head, ...b.rows.flat()]) inl(c);
  }
  return out;
}
// 逐行比（網站的引擎偶爾把一段縮排程式碼切成兩個框，內容一樣就算一樣）
const codeLines = (xs: string[]) => JSON.stringify(xs.join('\n').split('\n').filter((x) => /CODE/.test(x)).sort());
const sameCode = (body: string, html: string) =>
  codeLines(refCode(html)) === codeLines(astCode(parseMarkdown(FM + body).blocks).map((x) => x.split(LBRACE).join('{')));

export function checkOne(body: string): { errored: boolean; errors: string[]; violations: { kind: 'I1' | 'I2' | 'I3'; info: string }[] } {
  const ref = markdownToHtml(body).html;
  const where = classify(ref);
  const c = compose({ source: FM + body, template, issue: 'x1', trackBase: 'https://t.example.com', siteBase: 'https://example.com' });
  const errors = c.problems.filter((p) => p.severity === 'error').map((p) => p.code);
  if (errors.length) return { errored: true, errors, violations: [] };
  const violations: { kind: 'I1' | 'I2' | 'I3'; info: string }[] = [];
  for (const tok of new Set(body.match(TOKEN) ?? [])) {
    const w = where.get(tok) ?? [];
    const shown = w.some((x) => x !== 'comment');
    const inH = c.html.includes(tok);
    const inT = c.text.includes(tok);
    if (!shown && (inH || inT)) violations.push({ kind: 'I1', info: `${tok} 網站上藏起來，信裡出現了` });
    if (shown && !(inH && inT)) violations.push({ kind: 'I2', info: `${tok} 網站上看得到，信裡${inH ? '純文字版' : inT ? 'HTML' : '兩版都'}不見了` });
  }
  for (const m of codeMarks(ref)) if (!c.text.includes(m)) violations.push({ kind: 'I3', info: `程式碼裡的「${m}」沒有原樣保留` });
  if (!violations.length && !sameCode(body, ref)) violations.push({ kind: 'I3', info: '程式碼內容跟網站不一樣（例如 tab 被換成空白）' });
  return { errored: false, errors, violations };
}

export function runFuzz(n: number, seed: number): FuzzStats {
  const gen = makeGen(seed);
  const st: FuzzStats = { n, errored: 0, i1: [], i2: [], i3: [] };
  for (let t = 0; t < n; t++) {
    const body = gen();
    const r = checkOne(body);
    if (r.errored) st.errored++;
    for (const v of r.violations) (v.kind === 'I1' ? st.i1 : v.kind === 'I2' ? st.i2 : st.i3).push({ src: body, info: v.info });
  }
  return st;
}
