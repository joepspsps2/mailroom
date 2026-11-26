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
  return out;
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
      buf += s[i + 1];
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
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
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
      const tag = s.slice(i).match(/^<\/?[a-zA-Z][^>]*>/);
      if (tag) {
        flush();
        problems.push({ code: 'unsupported_html', severity: 'error', message: '原稿有信件排不出來的行內 HTML 標籤', where: clip(tag[0]) });
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
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(mark)) body.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', v: body.join('\n') });
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
    // HTML 註解：整段略過
    if (line.trim().startsWith('<!--')) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
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
    if (BLOCK_HTML.test(line) && ANY_TAG.test(line)) {
      const start = line;
      const chunk: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') chunk.push(lines[i++]);
      if (EMBED_TAG.test(start)) {
        blocks.push({ t: 'embed' });
      } else {
        problems.push({ code: 'unsupported_html', severity: 'error', message: '原稿有信件排不出來的 HTML 區塊', where: clip(start) });
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

export function parseMarkdown(source: string): Parsed {
  const { body, fm } = splitFrontmatter(source);
  const problems: Problem[] = [];
  const blocks = parseBlocks(body.split('\n'), problems);
  return { blocks, problems, frontmatter: fm };
}
