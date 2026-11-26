// 產信第一步：把 markdown 原稿解析成「區塊＋行內」結構。純函式，不碰網路，不 import cloudflare:*。
// 只支援信件排得出來的語法；不認得的東西一律記成 problem（檢查會擋下），絕不默默吞掉或亂猜。

export type Severity = 'error' | 'warn' | 'info';
export interface Problem {
  code: string;
  severity: Severity;
  message: string;
  /** 出問題的那一段原稿（截短），方便人修。 */
  where?: string;
}

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'strong' | 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[]; bare?: boolean; idx?: number; out?: string; tu?: string }
  | { t: 'image'; src: string; alt: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'hr' }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; items: Block[][] }
  | { t: 'code'; v: string }
  | { t: 'table'; head: Inline[][]; align: (string | null)[]; rows: Inline[][][] }
  | { t: 'image'; src: string; alt: string; link?: Inline & { t: 'link' } }
  | { t: 'embed' };

export interface Parsed {
  blocks: Block[];
  problems: Problem[];
  /** frontmatter 裡的單行字串欄位（title、description…）；不是完整 YAML。 */
  frontmatter: Record<string, string>;
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

/** 嵌入類 HTML（互動圖表、影片）：信裡放不了，換成「到網站看」的連結卡。 */
const EMBED_TAG = /^\s*<\s*(iframe|video|audio|embed|object|canvas)\b/i;
const ANY_TAG = /<\/?[a-zA-Z][^>]*>/;
const BLOCK_HTML = /^\s*<\/?[a-zA-Z!]/;
/** 行內標籤開頭的行不是 HTML 區塊，當一般段落（a、b、strong、i、em、br）。 */
const INLINE_START = /^\s*<\s*(a|b|strong|i|em|br)\b|^\s*<https?:\/\//i;
/** 原稿裡寫的 \{ 先換成這個私用字元，輸出時才變成真的「{」，避免被當成佔位。 */
export const LBRACE = '\uE000';
const protectBraces = (v: string) => v.replace(/\{\{/g, LBRACE + LBRACE);
const NAMED: Record<string, string> = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** 原稿文字裡的 HTML 實體（&nbsp; &amp; &#39; …）還原成字元；輸出時再統一跳脫一次。 */
export function decodeEntities(t: string): string {
  return t.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** 常見的 HTML 標籤名；不在這張表裡的「<…>」多半只是文字（例如 <Research.example>）。 */
const HTML_TAG_NAMES = new Set('a abbr b blockquote body br button canvas center code dd del details div dl dt em embed figure font footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins kbd label li link main mark meta nav object ol p picture pre q s samp script section small source span strike strong style sub summary sup svg table tbody td tfoot th thead title tr u ul var video audio'.split(' '));
function tagProblem(tag: string, inline: boolean): { message: string; where: string } {
  const name = tag.match(/^<\/?\s*([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase() ?? '';
  const where = clip(tag);
  const wellFormed = /^<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>$/.test(tag.trim()); // </p/100110> 這種名字像標籤、寫法不是標籤的不算
  if (HTML_TAG_NAMES.has(name) && wellFormed) return { message: inline ? '原稿有信件排不出來的行內 HTML 標籤' : '原稿有信件排不出來的 HTML 區塊', where };
  return { message: '原稿有看起來像 HTML 標籤的文字（角括號包著的字），引擎會當成標籤而排不出來；如果它不是標籤，請改寫（拿掉角括號，或用反引號包起來）', where };
}

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

function splitFrontmatter(src: string): { body: string; fm: Record<string, string> } {
  const text = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { body: text, fm: {} };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '' || v.startsWith('[') || v.startsWith('{') || v === '|' || v === '>') continue; // 清單／巢狀／多行不收
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      const q = v[0];
      v = v.slice(1, -1);
      v = q === '"' ? v.replace(/\\(["\\])/g, '$1') : v.replace(/''/g, "'");
    }
    fm[kv[1]] = v;
  }
  return { body: text.slice(m[0].length), fm };
}

// ───────────── 行內 ─────────────

/** 從 s[start]（必須是 '('）讀一個括號平衡的網址，回傳 [網址, 下一個位置]；讀不到回 null。 */
function readParenUrl(s: string, start: number): [string, number] | null {
  if (s[start] !== '(') return null;
  let depth = 0;
  let i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') return null;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const inner = s.slice(start + 1, i).trim();
  // 去掉可選的 "title"
  const m = inner.match(/^(\S+)(?:\s+(?:"[^"]*"|'[^']*'))?$/);
  if (!m) return null;
  let url = m[1];
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
  return [url, i + 1];
}

/** 從 s[start]（必須是 '['）找對應的 ']'（可巢狀），回傳位置。 */
function matchBracket(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function trimUrlTail(u: string): string {
  // 網址尾巴的標點不算網址
  let end = u.length;
  while (end > 0 && /[.,;:!?'*]/.test(u[end - 1])) end--;
  // 不成對的右括號也不算
  while (end > 0 && u[end - 1] === ')') {
    const sub = u.slice(0, end);
    if ((sub.match(/\(/g) ?? []).length < (sub.match(/\)/g) ?? []).length) end--;
    else break;
  }
  return u.slice(0, end);
}

function autolink(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const url = trimUrlTail(raw);
    const at = m.index ?? 0;
    if (url.length < 9) continue;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }], bare: true });
    last = at + url.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out.map((n) => (n.t === 'text' ? { t: 'text', v: decodeEntities(n.v) } : n));
}

/**
 * 行內程式碼的唯一判定（解析器與註解剝除共用，兩邊不會對「哪裡是程式碼」有不同看法）。
 * s[i] 是一串反引號的開頭：找下一串「剛好一樣長」的反引號當收尾；空白行（段落分隔）擋住，不能跨段。
 * 找不到＝不是程式碼（回 null，反引號當一般字元）。
 */
export function codeSpanAt(s: string, i: number): { open: number; close: number; end: number } | null {
  let n = 0;
  while (s[i + n] === '`') n++;
  let j = i + n;
  while (j < s.length) {
    if (s[j] === '\n' && /^[ \t]*\n/.test(s.slice(j + 1))) return null; // 空白行＝段落結束
    if (s[j] === '`') {
      let m = 0;
      while (s[j + m] === '`') m++;
      if (m === n) return { open: n, close: j, end: j + m };
      j += m;
      continue;
    }
    j++;
  }
  return null;
}

export function parseInline(s: string, problems: Problem[], depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(...autolink(buf));
      buf = '';
    }
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|<>~]/.test(s[i + 1])) {
      buf += s[i + 1] === '{' ? LBRACE : s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      buf = buf.replace(/[ \t]+$/, '');
      flush();
      out.push({ t: 'br' });
      i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      continue;
    }
    if (ch === '`') {
      const span = codeSpanAt(s, i);
      if (span) {
        flush();
        out.push({ t: 'code', v: protectBraces(s.slice(i + span.open, span.close)) });
        i = span.end;
        continue;
      }
      // 沒配對的反引號：整串當一般字元
      let n = 0;
      while (s[i + n] === '`') n++;
      buf += '`'.repeat(n);
      i += n;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const close = matchBracket(s, i + 1);
      if (close > 0 && s[close + 1] === '(') {
        const u = readParenUrl(s, close + 1);
        if (u) {
          flush();
          out.push({ t: 'image', src: u[0], alt: s.slice(i + 2, close).replace(/\\(.)/g, '$1') });
          i = u[1];
          continue;
        }
      }
    }
    if (ch === '[' && depth < 3) {
      const close = matchBracket(s, i);
      if (close > 0 && s[close + 1] === '(') {
        const u = readParenUrl(s, close + 1);
        if (u) {
          flush();
          out.push({ t: 'link', href: u[0], c: parseInline(s.slice(i + 1, close), problems, depth + 1) });
          i = u[1];
          continue;
        }
      }
    }
    if (ch === '<') {
      const br = s.slice(i).match(/^<br\s*\/?>/i);
      if (br) {
        flush();
        out.push({ t: 'br' });
        i += br[0].length;
        continue;
      }
      const auto = s.slice(i).match(/^<(https?:\/\/[^\s<>]+)>/i);
      if (auto) {
        flush();
        out.push({ t: 'link', href: auto[1], c: [{ t: 'text', v: auto[1] }], bare: true });
        i += auto[0].length;
        continue;
      }
      // <a href="…">文字</a>：只取 href 當一般連結，其他屬性丟掉
      const a = s.slice(i).match(/^<a\s+([^>]*)>/i);
      if (a) {
        const href = a[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const closeAt = s.toLowerCase().indexOf('</a>', i + a[0].length);
        if (href && closeAt > 0) {
          flush();
          out.push({ t: 'link', href: decodeEntities(href[1] ?? href[2] ?? ''), c: parseInline(s.slice(i + a[0].length, closeAt), problems, depth + 1) });
          i = closeAt + 4;
          continue;
        }
      }
      // <b>／<strong>／<i>／<em> 成對才收
      const fmt = s.slice(i).match(/^<(b|strong|i|em)>/i);
      if (fmt) {
        const name = fmt[1].toLowerCase();
        const closeAt = s.toLowerCase().indexOf(`</${name}>`, i + fmt[0].length);
        if (closeAt > 0) {
          flush();
          out.push({ t: name === 'b' || name === 'strong' ? 'strong' : 'em', c: parseInline(s.slice(i + fmt[0].length, closeAt), problems, depth + 1) });
          i = closeAt + name.length + 3;
          continue;
        }
      }
      const tag = s.slice(i).match(/^<\/?[a-zA-Z][^>]*>/);
      if (tag) {
        flush();
        problems.push({ code: 'unsupported_html', severity: 'error', ...tagProblem(tag[0], true) });
        i += tag[0].length;
        continue;
      }
    }
    if (ch === '*' && depth < 4) {
      const strong = s[i + 1] === '*';
      const mark = strong ? '**' : '*';
      const end = s.indexOf(mark, i + mark.length);
      if (end > i + mark.length && !/^\s/.test(s[i + mark.length]) && !/\s$/.test(s.slice(i + mark.length, end))) {
        flush();
        out.push({ t: strong ? 'strong' : 'em', c: parseInline(s.slice(i + mark.length, end), problems, depth + 1) });
        i = end + mark.length;
        continue;
      }
    }
    if (ch === '_' && depth < 4) {
      const prev = s[i - 1] ?? ' ';
      const end = s.indexOf('_', i + 1);
      if (end > i + 1 && !/[A-Za-z0-9]/.test(prev) && !/\s/.test(s[i + 1]) && !/[A-Za-z0-9]/.test(s[end + 1] ?? ' ') && !/\s/.test(s[end - 1])) {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, end), problems, depth + 1) });
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ───────────── 區塊 ─────────────

const FENCE = /^\s{0,3}(```|~~~)/;
const LOOSE_FENCE = /^[\s>]*(```|~~~)/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const QUOTE = /^\s{0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HR.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && line.trim() !== '');
}

function parseBlocks(lines: string[], problems: Problem[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    // 圍欄程式碼
    const fence = line.match(FENCE);
    if (fence) {
      const mark = fence[1];
      const lang = line.trim().slice(mark.length).trim().toLowerCase();
      const body: string[] = [];
      const start = line;
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(mark)) body.push(lines[i++]);
      if (i >= lines.length) {
        // 沒收尾的程式碼框：不猜，後面的內容會被整段吃掉，所以直接記 error
        problems.push({ code: 'unclosed_fence', severity: 'error', message: '程式碼框（```）沒有收尾，後面的內容會被吃掉', where: clip(start) });
      }
      i++;
      // 圖表（mermaid）信裡畫不出來：換成「到網站看」連結卡
      if (lang === 'mermaid') blocks.push({ t: 'embed' });
      else blocks.push({ t: 'code', v: protectBraces(body.join('\n')) });
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      blocks.push({ t: 'h', level: h[1].length, c: parseInline(h[2], problems) });
      i++;
      continue;
    }
    // 只有 <div> 、<div lang="…"> 或 </div> 的行（語言標記的外框；帶 hidden／style 等其他屬性的 div 不收）：外框丟掉，裡面的內容照常轉
    if (/^\s*(?:<div(?:\s+lang\s*=\s*(?:"[A-Za-z-]*"|'[A-Za-z-]*'))?\s*>|<\/div\s*>)\s*$/i.test(line)) {
      i++;
      continue;
    }
    // 自訂區塊語法（:::note 之類）
    if (line.trim().startsWith(':::')) {
      const start = line;
      while (i < lines.length && lines[i].trim() !== '') i++;
      problems.push({ code: 'unsupported_syntax', severity: 'error', message: '原稿有信件轉不了的區塊語法', where: clip(start) });
      continue;
    }
    // 區塊 HTML
    if (BLOCK_HTML.test(line) && ANY_TAG.test(line) && !INLINE_START.test(line)) {
      const start = line;
      const chunk: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') chunk.push(lines[i++]);
      if (EMBED_TAG.test(start)) {
        blocks.push({ t: 'embed' });
      } else {
        problems.push({ code: 'unsupported_html', severity: 'error', ...tagProblem(start.trim().match(/^<\/?[a-zA-Z!][^>]*>?/)?.[0] ?? start, false) });
      }
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() !== '' && inner.length > 0 && !isBlockStart(lines[i], lines[i + 1])))) {
        inner.push(lines[i].replace(/^\s{0,3}> ?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseBlocks(inner, problems) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        const cells = splitRow(lines[i++]);
        while (cells.length < head.length) cells.push('');
        rows.push(cells.slice(0, head.length).map((c) => parseInline(c, problems)));
      }
      blocks.push({ t: 'table', head: head.map((c) => parseInline(c, problems)), align, rows });
      continue;
    }
    const li = line.match(LIST_ITEM);
    if (li) {
      const base = li[1].length;
      const ordered = /\d/.test(li[2][0]);
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM);
        if (!m || m[1].length !== base || /\d/.test(m[2][0]) !== ordered) break;
        const itemLines: string[] = [m[3]];
        i++;
        const contentIndent = base + m[2].length + 1;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === '') {
            // 空行後若仍是縮排內容，屬於本項
            let j = i;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length && /^\s+\S/.test(lines[j]) && lines[j].search(/\S/) > base) {
              for (; i < j; i++) itemLines.push('');
              continue;
            }
            break;
          }
          const sub = l.match(LIST_ITEM);
          if (sub && sub[1].length <= base) break;
          if (sub || /^\s+\S/.test(l)) {
            itemLines.push(l.slice(Math.min(contentIndent, l.search(/\S/))));
            i++;
          } else if (!isBlockStart(l, lines[i + 1])) {
            itemLines.push(l); // 懶惰續行
            i++;
          } else break;
        }
        items.push(parseBlocks(itemLines, problems));
        // 項目之間的空行
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && lines[j].match(LIST_ITEM)?.[1].length === base) i = j;
        else break;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    // 段落
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !isBlockStart(lines[i], lines[i + 1])) && !(para.length > 0 && BLOCK_HTML.test(lines[i]) && EMBED_TAG.test(lines[i]))) {
      para.push(lines[i++]);
    }
    const inline = parseInline(para.join('\n').trim(), problems);
    // 整段只有一張圖（或一個包著圖的連結）＝圖片區塊
    if (inline.length === 1 && inline[0].t === 'image') blocks.push({ t: 'image', src: inline[0].src, alt: inline[0].alt });
    else if (inline.length === 1 && inline[0].t === 'link' && inline[0].c.length === 1 && inline[0].c[0].t === 'image') {
      const img = inline[0].c[0];
      blocks.push({ t: 'image', src: img.src, alt: img.alt, link: inline[0] });
    } else blocks.push({ t: 'p', c: inline });
  }
  return blocks;
}

/**
 * 拿掉 HTML 註解（<!-- … -->）：行首、段落下一行、清單項目裡、行內、跨行，位置都一樣處理（CommonMark 的註解可以打斷段落）。
 * 程式碼框（``` 或 ~~~）裡的不動。找不到結尾的註解＝記 error，且保留原文（不能把後面整段吃掉）。
 */
const MARK = '\uE001';

/**
 * 拿掉 HTML 註解（<!-- … -->）：行首、段落下一行、清單項目裡、行內、跨行，位置都一樣處理（CommonMark 的註解可以打斷段落）。
 * 「程式碼」的判定：程式碼框（``` 或 ~~~，頂格、清單內、引言內都算；開頭與收尾用同一套前綴規則）與行內程式碼（共用 codeSpanAt，
 * 含跨行、不同長度的反引號；反斜線跳脫的反引號不開頭）。程式碼裡的 <!-- 不動。
 * 找不到結尾的註解＝記 error，且保留原文（不能把後面整段吃掉）。
 */
export function stripComments(lines: string[], problems: Problem[]): string[] {
  const fenceLead = (l: string) => l.replace(/^[\s>]*/, '');
  // 切成「程式碼框」與「文字」兩種區段
  const segs: { code: boolean; lines: string[] }[] = [];
  let i = 0;
  while (i < lines.length) {
    const f = lines[i].match(LOOSE_FENCE);
    if (f) {
      const mark = f[1];
      const seg = [lines[i++]];
      while (i < lines.length) {
        const l = lines[i++];
        seg.push(l);
        if (fenceLead(l).startsWith(mark)) break;
      }
      segs.push({ code: true, lines: seg });
    } else {
      const seg: string[] = [];
      while (i < lines.length && !LOOSE_FENCE.test(lines[i])) seg.push(lines[i++]);
      segs.push({ code: false, lines: seg });
    }
  }
  const out: string[] = [];
  for (const seg of segs) {
    if (seg.code) {
      out.push(...seg.lines);
      continue;
    }
    const text = seg.lines.join('\n');
    let res = '';
    let pos = 0;
    let unclosedAt = -1;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '\\' && (text[pos + 1] === '`' || text[pos + 1] === '<')) {
        res += ch + text[pos + 1]; // 反斜線跳脫的反引號不開程式碼、跳脫的 < 不開註解（與解析器一致）
        pos += 2;
        continue;
      }
      if (ch === '`') {
        const span = codeSpanAt(text, pos);
        if (span) {
          res += text.slice(pos, span.end);
          pos = span.end;
        } else {
          let n = 0;
          while (text[pos + n] === '`') n++;
          res += text.slice(pos, pos + n);
          pos += n;
        }
        continue;
      }
      if (text.startsWith('<!--', pos)) {
        const e = text.indexOf('-->', pos + 4);
        if (e < 0) {
          unclosedAt = pos;
          res += text.slice(pos);
          pos = text.length;
          break;
        }
        res += MARK;
        pos = e + 3;
        continue;
      }
      res += ch;
      pos++;
    }
    if (unclosedAt >= 0) {
      const startLine = text.slice(0, unclosedAt).split('\n').length - 1;
      problems.push({ code: 'unclosed_comment', severity: 'error', message: 'HTML 註解（<!--）沒有收尾，後面的內容會被吃掉', where: clip(seg.lines[startLine] ?? '') });
    }
    // 整行只剩註解＝空行；行內註解＝直接拿掉
    for (const l of res.split('\n')) out.push(l.includes(MARK) && l.split(MARK).join('').trim() === '' ? '' : l.split(MARK).join(''));
  }
  return out;
}

/** 保險：解析完之後，程式碼以外的文字節點若還有 <!--，代表註解剝除與解析器對「程式碼在哪」的看法不一致 → 記 error，不放行。 */
function leakedComments(blocks: Block[], problems: Problem[]): void {
  const inl = (ns: Inline[]) => {
    for (const n of ns) {
      if (n.t === 'text' && n.v.includes('<!--')) {
        problems.push({ code: 'comment_leaked', severity: 'error', message: '有 HTML 註解沒被剝掉，會原樣出現在信裡（疑似程式碼寫法被誤判）；請檢查附近的反引號與程式碼框', where: clip(n.v.slice(Math.max(0, n.v.indexOf('<!--') - 10))) });
      } else if (n.t === 'strong' || n.t === 'em' || n.t === 'link') inl(n.c);
      else if (n.t === 'image' && n.alt.includes('<!--')) problems.push({ code: 'comment_leaked', severity: 'error', message: '圖片替代文字裡有未剝掉的 HTML 註解', where: clip(n.alt) });
    }
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === 'p' || b.t === 'h') inl(b.c);
      else if (b.t === 'quote') walk(b.c);
      else if (b.t === 'list') for (const it of b.items) walk(it);
      else if (b.t === 'table') {
        for (const c of b.head) inl(c);
        for (const r of b.rows) for (const c of r) inl(c);
      } else if (b.t === 'image' && b.alt.includes('<!--')) problems.push({ code: 'comment_leaked', severity: 'error', message: '圖片替代文字裡有未剝掉的 HTML 註解', where: clip(b.alt) });
    }
  };
  walk(blocks);
}

export function parseMarkdown(source: string): Parsed {
  const { body, fm } = splitFrontmatter(source);
  const problems: Problem[] = [];
  const blocks = parseBlocks(stripComments(body.split('\n'), problems), problems);
  if (!problems.some((p) => p.code === 'unclosed_comment')) leakedComments(blocks, problems);
  return { blocks, problems, frontmatter: fm };
}
