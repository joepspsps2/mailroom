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
  | { t: 'list'; ordered: boolean; /** 有序清單的起始編號（1 以外才有）。 */ start?: number; items: Block[][] }
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

// ───────────── 註解與程式碼：只在解析器裡、隨著解析掃一次就決定 ─────────────
// 沒有「先剝註解再解析」的前置步驟：區塊切好之後，行內的程式碼與註解在同一個迴圈裡由左到右認，誰先開頭誰贏
// （與 CommonMark 一樣）。所以「哪裡是程式碼、哪裡是註解」全檔只有一份判定，不會有兩套看法對不上。

/** 解析時記的帳：遇到的問題、當成註解藏起來的 <!-- 個數、落在程式碼裡的 <!-- 個數（最後拿來跟原文對帳）。 */
interface Ctx {
  problems: Problem[];
  hidden: number;
  inCode: number;
}
const scratch = (): Ctx => ({ problems: [], hidden: 0, inCode: 0 });
const marks = (s: string) => s.split('<!--').length - 1;

/** CommonMark 可用反斜線跳脫的字元（ASCII 標點）。 */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** s[i] 起是 <!--：回傳註解結束後的位置（第一個 -->；<!--> 與 <!---> 是空註解）。沒收尾回 -1。區塊與行內共用。 */
function commentEnd(s: string, i: number): number {
  const e = s.indexOf('-->', i + 2);
  return e < 0 ? -1 : e + 3;
}

/** 一段要藏起來的註解：記帳；裡面有「--!>」時瀏覽器會提早結束註解（網站藏的範圍和這裡不同），記 error。 */
function hideComment(text: string, ctx: Ctx): void {
  ctx.hidden += marks(text);
  if (text.includes('--!>')) {
    ctx.problems.push({ code: 'comment_ambiguous', severity: 'error', message: 'HTML 註解裡有「--!>」：瀏覽器會在那裡就結束註解，後面的字會被讀者看到；請拿掉這三個字元', where: clip(text) });
  }
}

const unclosedComment = (where: string): Problem => ({ code: 'unclosed_comment', severity: 'error', message: 'HTML 註解（<!--）沒有收尾：網站上它會把後面的內容藏起來，信裡則會露出來；請補上 -->', where: clip(where) });

/**
 * 行內程式碼：s[i] 是一串反引號的開頭，找下一串「剛好一樣長」的反引號當收尾。找不到＝不是程式碼（回 null，整串反引號當一般字元）。
 * s 是已經切好的一個區塊的內容（段落、標題、表格的一格），所以不會跨區塊配對。
 */
function codeSpanAt(s: string, i: number): { open: number; close: number; end: number } | null {
  let n = 0;
  while (s[i + n] === '`') n++;
  let j = i + n;
  while (j < s.length) {
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

const RAW_TAG = /^<\/?[a-zA-Z][^>]*>/;
const AUTOLINK = /^<(https?:\/\/[^\s<>]+)>/i;

/**
 * s[i] 起若是一個「不可切開」的行內單位（反斜線跳脫、行內程式碼或一串沒配對的反引號、註解、自動連結、HTML 標籤），回傳它結束的位置；不是回 -1。
 * 找連結的 ]、強調的收尾記號、</a> 時都跳過這些單位，所以強調或連結不會把程式碼或註解切成兩半（CommonMark 的優先順序）。
 */
function atomEnd(s: string, i: number): number {
  const ch = s[i];
  if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) return i + 2;
  if (ch === '`') {
    const span = codeSpanAt(s, i);
    if (span) return span.end;
    let n = 0;
    while (s[i + n] === '`') n++;
    return i + n;
  }
  if (ch === '<') {
    if (s.startsWith('<!--', i)) return commentEnd(s, i);
    const m = s.slice(i).match(AUTOLINK) ?? s.slice(i).match(RAW_TAG);
    if (m) return i + m[0].length;
  }
  return -1;
}

/** 從 from 起找 mark（大小寫不分），跳過不可切開的單位；找不到回 -1。 */
function findMark(s: string, from: number, mark: string): number {
  const lower = mark.toLowerCase();
  for (let i = from; i < s.length; ) {
    if (s.slice(i, i + mark.length).toLowerCase() === lower) return i;
    const a = atomEnd(s, i);
    i = a > i ? a : i + 1;
  }
  return -1;
}

/** 從 s[start]（必須是 '['）找對應的 ']'（可巢狀，跳過程式碼、註解、跳脫），回傳位置。 */
function matchBracket(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; ) {
    const a = i === start ? -1 : atomEnd(s, i);
    if (a > i) {
      i = a;
      continue;
    }
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

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

function parseInline(s: string, ctx: Ctx, depth = 0): Inline[] {
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
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
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
        const raw = s.slice(i + span.open, span.close);
        ctx.inCode += marks(raw);
        // CommonMark：換行當空白；頭尾各有一個空白（且不全是空白）就各去掉一個
        let v = raw.replace(/\n/g, ' ');
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim() !== '') v = v.slice(1, -1);
        out.push({ t: 'code', v: protectBraces(v) });
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
    if (ch === '<' && s.startsWith('<!--', i)) {
      const e = commentEnd(s, i);
      if (e < 0) {
        // 網站上這是字面文字；信裡也照原樣留著，但記 error 擋下（作者多半是忘了收尾）
        ctx.problems.push(unclosedComment(s.slice(i)));
        buf += '<!--';
        i += 4;
        continue;
      }
      hideComment(s.slice(i, e), ctx);
      i = e;
      continue;
    }
    if (ch === '<' && PSEUDO_COMMENT.test(s.slice(i, i + 9))) {
      flush();
      ctx.problems.push({ code: 'unsupported_html', severity: 'error', message: '原稿有 <? 、<!X 或 <![CDATA[ 開頭的寫法，網站上會被當成註解藏起來，信裡做不到；請拿掉', where: clip(s.slice(i)) });
      const close = s.indexOf('>', i);
      const end = close < 0 ? s.length : close + 1;
      ctx.hidden += marks(s.slice(i, end));
      i = end;
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
          out.push({ t: 'link', href: u[0], c: parseInline(s.slice(i + 1, close), ctx, depth + 1) });
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
      const auto = s.slice(i).match(AUTOLINK);
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
        const closeAt = findMark(s, i + a[0].length, '</a>');
        if (href && closeAt > 0) {
          flush();
          out.push({ t: 'link', href: decodeEntities(href[1] ?? href[2] ?? ''), c: parseInline(s.slice(i + a[0].length, closeAt), ctx, depth + 1) });
          i = closeAt + 4;
          continue;
        }
      }
      // <b>／<strong>／<i>／<em> 成對才收
      const fmt = s.slice(i).match(/^<(b|strong|i|em)>/i);
      if (fmt) {
        const name = fmt[1].toLowerCase();
        const closeAt = findMark(s, i + fmt[0].length, `</${name}>`);
        if (closeAt > 0) {
          flush();
          out.push({ t: name === 'b' || name === 'strong' ? 'strong' : 'em', c: parseInline(s.slice(i + fmt[0].length, closeAt), ctx, depth + 1) });
          i = closeAt + name.length + 3;
          continue;
        }
      }
      const tag = s.slice(i).match(RAW_TAG);
      if (tag) {
        flush();
        ctx.problems.push({ code: 'unsupported_html', severity: 'error', ...tagProblem(tag[0], true) });
        ctx.hidden += marks(tag[0]);
        i += tag[0].length;
        continue;
      }
    }
    if (ch === '*' && depth < 4) {
      const strong = s[i + 1] === '*';
      const mark = strong ? '**' : '*';
      const end = findMark(s, i + mark.length, mark);
      if (end > i + mark.length && !/^\s/.test(s[i + mark.length]) && !/\s$/.test(s.slice(i + mark.length, end))) {
        flush();
        out.push({ t: strong ? 'strong' : 'em', c: parseInline(s.slice(i + mark.length, end), ctx, depth + 1) });
        i = end + mark.length;
        continue;
      }
    }
    if (ch === '_' && depth < 4) {
      const prev = s[i - 1] ?? ' ';
      const end = findMark(s, i + 1, '_');
      if (end > i + 1 && !/[A-Za-z0-9]/.test(prev) && !/\s/.test(s[i + 1]) && !/[A-Za-z0-9]/.test(s[end + 1] ?? ' ') && !/\s/.test(s[end - 1])) {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, end), ctx, depth + 1) });
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
// 照 CommonMark 的區塊規則切：先決定每一行屬於哪個區塊（程式碼框、註解區塊、段落…），區塊內容才交給行內解析。

const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}>/;
/** HTML 註解區塊（CommonMark HTML 區塊第 2 型）：行首（最多縮 3 格）是 <!--，到含 --> 的那一行結束；可以打斷段落。 */
const COMMENT_START = /^ {0,3}<!--/;
/** 會打斷段落的其他 HTML 區塊開頭（CommonMark 第 1、3～6 型）。 */
const HTML_INTERRUPT = /^ {0,3}(?:<(?:script|pre|style|textarea)(?:[\s>]|$)|<\?|<![A-Za-z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s>]|\/>|$))/i;
const BLOCK_HTML = /^ {0,3}<\/?[a-zA-Z!]/;
/** 一行只有一個完整標籤（CommonMark HTML 區塊第 7 型）：網站原樣輸出到空行為止，不轉 markdown；不能打斷段落，但會切斷懶惰續行。 */
const LONE_TAG = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;
/** 瀏覽器當成註解藏起來的另外三種寫法（<?…>、<!X…>、<![CDATA[…]]>）：信裡沒法照做，一律記 error。 */
const PSEUDO_COMMENT = /<(?:\?|![A-Za-z]|!\[CDATA\[)/;
/** 參照式連結定義（[名稱]: 網址）：網站上不顯示，信裡不支援，記 error（不然網站看不到的字會寄出去）。 */
const LINK_REF_DEF = /^ {0,3}\[(?!\^)[^\]]+\]:/;
const DIV_WRAPPER = /^ {0,3}(?:<div(?:\s+lang\s*=\s*(?:"[A-Za-z-]*"|'[A-Za-z-]*'))?\s*>|<\/div\s*>)\s*$/i;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** 懶惰續行的記號：引言或清單收進來的「沒縮排、接在段落後面」的行，在內層一律當段落續行（不能變成表頭或標題底線）。 */
const LAZY = '\uE002';

/** 行首縮排的欄數（tab 跳到 4 的倍數）。 */
function indentCols(line: string): number {
  let c = 0;
  for (const ch of line) {
    if (ch === ' ') c++;
    else if (ch === '\t') c += 4 - (c % 4);
    else break;
  }
  return c;
}

/** 去掉行首最多 n 欄的空白（tab 只拿掉需要的部分）。 */
function stripCols(line: string, n: number): string {
  let c = 0;
  let i = 0;
  while (i < line.length && c < n) {
    if (line[i] === ' ') {
      c++;
      i++;
    } else if (line[i] === '\t') {
      const w = 4 - (c % 4);
      if (c + w > n) return ' '.repeat(c + w - n) + line.slice(i + 1);
      c += w;
      i++;
    } else break;
  }
  return line.slice(i);
}

interface Fence {
  indent: number;
  ch: string;
  len: number;
  info: string;
}
/** 程式碼框開頭：最多縮 3 格、3 個以上 ` 或 ~；反引號框的說明文字裡不能有反引號（不然那是行內程式碼）。 */
function fenceOpen(line: string): Fence | null {
  const m = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return null;
  return { indent: m[1].length, ch: m[2][0], len: m[2].length, info: m[3].trim() };
}
/** 程式碼框收尾：同一種記號、至少一樣長、最多縮 3 格、後面只能有空白。 */
function fenceCloses(line: string, f: Fence): boolean {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return !!m && m[1][0] === f.ch && m[1].length >= f.len;
}

interface Marker {
  ordered: boolean;
  kind: string;
  start: number;
  /** 項目內容的縮排欄數（後續行要縮到這裡才屬於本項）。 */
  content: number;
  first: string;
  empty: boolean;
}
function listMarker(line: string): Marker | null {
  if (HR.test(line)) return null;
  const m = line.match(/^( {0,3})([-*+]|(\d{1,9})([.)]))(?=[ \t]|$)([ \t]*)(.*)$/);
  if (!m) return null;
  const ordered = m[3] !== undefined;
  const at = m[1].length + m[2].length;
  let spaces = 0;
  for (const ch of m[5]) spaces += ch === '\t' ? 4 - ((at + spaces) % 4) : 1;
  const empty = m[6].trim() === '';
  const base = { ordered, kind: ordered ? m[4] : m[2], start: ordered ? Number(m[3]) : 0, empty };
  if (empty) return { ...base, content: at + 1, first: '' };
  if (spaces >= 5) return { ...base, content: at + 1, first: ' '.repeat(spaces - 1) + m[6] };
  return { ...base, content: at + spaces, first: m[6] };
}

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

function isTableStart(line: string, next: string | undefined): boolean {
  return line.trim() !== '' && next !== undefined && TABLE_SEP.test(next) && next.includes('|') && splitRow(line).length === splitRow(next).length;
}

/** 這一行能不能打斷同一層正在進行的段落（CommonMark 的規則：有序清單要從 1 開始、空項目不行、縮 4 格以上不行）。 */
function interrupts(line: string, next: string | undefined, tables = true): boolean {
  if (indentCols(line) >= 4) return false;
  if (fenceOpen(line) || HR.test(line) || ATX.test(line) || QUOTE.test(line) || COMMENT_START.test(line) || HTML_INTERRUPT.test(line)) return true;
  const lm = listMarker(line);
  if (lm && !lm.empty && (!lm.ordered || lm.start === 1)) return true;
  return tables && isTableStart(line, next);
}

/** 懶惰續行（引言、清單裡沒縮排的下一行）：只有「內層最後是一個還開著的段落」才接得上；任何清單項目、區塊開頭都會斷開（表格不會：那時表頭只是段落續行）。 */
function lazyBreaks(line: string): boolean {
  if (indentCols(line) >= 4) return false;
  return !!fenceOpen(line) || HR.test(line) || ATX.test(line) || QUOTE.test(line) || COMMENT_START.test(line) || HTML_INTERRUPT.test(line) || LONE_TAG.test(line) || listMarker(line) !== null;
}

/** 註解區塊收尾那一行，--> 後面剩下的字（網站上原樣當 HTML 顯示）：再藏掉裡面的註解，其他照字面留著。 */
function rawTail(rest: string, ctx: Ctx): Block | null {
  let out = '';
  let pos = 0;
  while (pos < rest.length) {
    const c = rest.indexOf('<!--', pos);
    if (c < 0) {
      out += rest.slice(pos);
      break;
    }
    out += rest.slice(pos, c);
    const e = commentEnd(rest, c);
    if (e < 0) {
      ctx.problems.push(unclosedComment(rest.slice(c)));
      out += rest.slice(c);
      break;
    }
    hideComment(rest.slice(c, e), ctx);
    pos = e;
  }
  const tag = out.match(/<\/?[a-zA-Z][^>]*>/);
  if (tag) ctx.problems.push({ code: 'unsupported_html', severity: 'error', ...tagProblem(tag[0], false) });
  const v = decodeEntities(out.trim());
  return v ? { t: 'p', c: [{ t: 'text', v }] } : null;
}

/** 段落：從 lines[start] 收到空行或能打斷段落的行為止；下一行是 === 或 --- ＝標題（setext）。回傳下一個要看的行。 */
function paragraph(lines: string[], start: number, ctx: Ctx, blocks: Block[]): number {
  const n = lines.length;
  const unlazy = (l: string) => (l.startsWith(LAZY) ? l.slice(1) : l);
  const para: string[] = [unlazy(lines[start])];
  let i = start + 1;
  let setext = 0;
  while (i < n) {
    const l = lines[i];
    if (l.trim() === '') break;
    if (!l.startsWith(LAZY)) {
      const sx = indentCols(l) < 4 ? l.match(SETEXT) : null;
      if (sx) {
        setext = sx[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(l, lines[i + 1]) || (BLOCK_HTML.test(l) && EMBED_TAG.test(l))) break;
    }
    para.push(unlazy(l));
    i++;
  }
  const inline = parseInline(para.join('\n').trim(), ctx);
  if (setext) blocks.push({ t: 'h', level: setext, c: inline });
  // 整段只有一張圖（或一個包著圖的連結）＝圖片區塊
  else if (inline.length === 1 && inline[0].t === 'image') blocks.push({ t: 'image', src: inline[0].src, alt: inline[0].alt });
  else if (inline.length === 1 && inline[0].t === 'link' && inline[0].c.length === 1 && inline[0].c[0].t === 'image') {
    const img = inline[0].c[0];
    blocks.push({ t: 'image', src: img.src, alt: img.alt, link: inline[0] });
  } else blocks.push({ t: 'p', c: inline });
  return i;
}

/** 把一個容器（整份原稿、引言內層、清單項目）的行切成區塊。open＝最後一個區塊是還開著的段落（給懶惰續行判斷）。 */
function parseBlocks(lines: string[], ctx: Ctx): { blocks: Block[]; open: boolean } {
  const blocks: Block[] = [];
  const n = lines.length;
  let open = false;
  // 沒收尾的註解區塊：CommonMark 裡它一路延伸到容器結尾，所以容器最後不是「開著的段落」，懶惰續行接不上
  let unclosedHtml = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    open = false;
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith(LAZY)) {
      i = paragraph(lines, i, ctx, blocks);
      open = i >= n;
      continue;
    }
    // 縮排 4 格以上＝程式碼（段落中間的縮排行不算，那是段落續行）
    if (indentCols(line) >= 4) {
      const body: string[] = [];
      while (i < n && (lines[i].trim() === '' || indentCols(lines[i]) >= 4)) body.push(stripCols(lines[i++], 4));
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      const v = body.join('\n');
      ctx.inCode += marks(v);
      blocks.push({ t: 'code', v: protectBraces(v) });
      continue;
    }
    // 圍欄程式碼
    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < n) {
        if (fenceCloses(lines[i], fence)) {
          closed = true;
          i++;
          break;
        }
        body.push(stripCols(lines[i++], fence.indent));
      }
      // 沒收尾的程式碼框：網站上它會把後面整段都變成程式碼，所以記 error
      if (!closed) ctx.problems.push({ code: 'unclosed_fence', severity: 'error', message: '程式碼框（```）沒有收尾，後面的內容會被吃掉', where: clip(line) });
      const v = body.join('\n');
      ctx.inCode += marks(v);
      // 圖表（mermaid）信裡畫不出來：換成「到網站看」連結卡
      if (fence.info.split(/\s+/)[0].toLowerCase() === 'mermaid') blocks.push({ t: 'embed' });
      else blocks.push({ t: 'code', v: protectBraces(v) });
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    const h = line.match(ATX);
    if (h) {
      blocks.push({ t: 'h', level: h[1].length, c: parseInline(h[2] ?? '', ctx) });
      i++;
      continue;
    }
    // HTML 註解區塊：到含 --> 的那一行為止整段藏起來（中間的空行也算在內）
    if (COMMENT_START.test(line)) {
      const col = line.indexOf('<!--');
      let j = i;
      let close = line.indexOf('-->', col + 2);
      while (close < 0 && j + 1 < n) close = lines[++j].indexOf('-->');
      if (close < 0) {
        // 沒收尾：只拿掉開頭這一行，後面照常轉（內容不能被吃掉），並記 error 擋下
        ctx.problems.push(unclosedComment(line));
        unclosedHtml = true;
        i++;
        continue;
      }
      const text = j === i ? line.slice(col, close + 3) : [line.slice(col), ...lines.slice(i + 1, j), lines[j].slice(0, close + 3)].join('\n');
      hideComment(text, ctx);
      const tail = rawTail(lines[j].slice(close + 3), ctx);
      if (tail) blocks.push(tail);
      i = j + 1;
      continue;
    }
    // 只有 <div> 、<div lang="…"> 或 </div> 的行（語言標記的外框；帶 hidden／style 等其他屬性的 div 不收），而且下一行是空行：
    // 外框丟掉，裡面的內容照常轉。下一行不是空行時，網站會把接著的幾行當原始 HTML（不轉 markdown），所以走下面的 HTML 區塊。
    if (DIV_WRAPPER.test(line) && (i + 1 >= n || lines[i + 1].trim() === '')) {
      i++;
      continue;
    }
    if (LINK_REF_DEF.test(line)) {
      const start = line;
      while (i < n && lines[i].trim() !== '') ctx.hidden += marks(lines[i++]);
      ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '原稿有參照式連結定義（[名稱]: 網址），網站上不顯示、信裡不支援；請改成一般的 [文字](網址)', where: clip(start) });
      continue;
    }
    // 自訂區塊語法（:::note 之類）
    if (line.trim().startsWith(':::')) {
      const start = line;
      while (i < n && lines[i].trim() !== '') ctx.hidden += marks(lines[i++]);
      ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '原稿有信件轉不了的區塊語法', where: clip(start) });
      continue;
    }
    // 區塊 HTML
    if ((BLOCK_HTML.test(line) && ANY_TAG.test(line) && !INLINE_START.test(line)) || LONE_TAG.test(line) || /^ {0,3}<(?:\?|![A-Za-z]|!\[CDATA\[)/.test(line)) {
      const start = line;
      while (i < n && lines[i].trim() !== '') ctx.hidden += marks(lines[i++]);
      if (EMBED_TAG.test(start)) {
        blocks.push({ t: 'embed' });
      } else {
        ctx.problems.push({ code: 'unsupported_html', severity: 'error', ...tagProblem(start.trim().match(/^<\/?[a-zA-Z!][^>]*>?/)?.[0] ?? start, false) });
      }
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < n) {
        const l = lines[i];
        if (QUOTE.test(l)) {
          inner.push(l.replace(/^ {0,3}> ?/, ''));
          i++;
          continue;
        }
        if (l.trim() !== '' && inner.length > 0 && !lazyBreaks(l) && parseBlocks(inner, scratch()).open) {
          inner.push(l.startsWith(LAZY) ? l : LAZY + l);
          i++;
          continue;
        }
        break;
      }
      const r = parseBlocks(inner, ctx);
      blocks.push({ t: 'quote', c: r.blocks });
      open = r.open && i >= n;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < n && lines[i].trim() !== '' && indentCols(lines[i]) < 4 && !lines[i].startsWith(LAZY) && !interrupts(lines[i], lines[i + 1], false)) {
        const cells = splitRow(lines[i++]);
        while (cells.length < head.length) cells.push('');
        for (const extra of cells.slice(head.length)) ctx.hidden += marks(extra); // 多出來的格子網站上也不顯示（表格裡再出現像表頭的兩行，也只是一般的列）
        rows.push(cells.slice(0, head.length).map((c) => parseInline(c, ctx)));
      }
      blocks.push({ t: 'table', head: head.map((c) => parseInline(c, ctx)), align, rows });
      continue;
    }
    const first = listMarker(line);
    if (first) {
      const items: Block[][] = [];
      let cur = first;
      while (true) {
        const itemLines: string[] = [cur.first];
        i++;
        while (i < n) {
          const l = lines[i];
          if (l.trim() === '') {
            // 空行之後若還有縮排到項目內容的行，屬於本項（項目最多只能以一個空行開頭）
            let j = i;
            while (j < n && lines[j].trim() === '') j++;
            const startsBlank = itemLines.length === 1 && itemLines[0] === '';
            if (j < n && indentCols(lines[j]) >= cur.content && !startsBlank) {
              for (; i < j; i++) itemLines.push('');
              continue;
            }
            break;
          }
          if (indentCols(l) >= cur.content) {
            itemLines.push(stripCols(l, cur.content));
            i++;
            continue;
          }
          if (!lazyBreaks(l) && parseBlocks(itemLines, scratch()).open) {
            itemLines.push(l.startsWith(LAZY) ? l : LAZY + l); // 懶惰續行
            i++;
            continue;
          }
          break;
        }
        const r = parseBlocks(itemLines, ctx);
        items.push(r.blocks);
        open = r.open && i >= n;
        // 下一個同類的清單記號＝同一張清單的下一項（中間可以有空行）
        let j = i;
        while (j < n && lines[j].trim() === '') j++;
        const next = j < n ? listMarker(lines[j]) : null;
        if (next && next.ordered === first.ordered && next.kind === first.kind) {
          i = j;
          cur = next;
          open = false;
          continue;
        }
        break;
      }
      blocks.push(first.ordered && first.start !== 1 ? { t: 'list', ordered: true, start: first.start, items } : { t: 'list', ordered: first.ordered, items });
      continue;
    }
    // 段落
    i = paragraph(lines, i, ctx, blocks);
    open = i >= n && blocks[blocks.length - 1]?.t !== 'h';
  }
  return { blocks, open: open && !unclosedHtml };
}

/**
 * 行首的結構前綴（空白、tab、引言 >、清單記號）裡的 tab，照「絕對欄位」換成空白（CommonMark 的 tab 是跳到 4 的倍數）。
 * 這樣拿掉 > 或清單記號之後，剩下的縮排欄數才不會算錯（例：「>\t<!--」是引言裡的註解，不是縮排程式碼）。
 */
function expandPrefixTabs(line: string): string {
  const m = line.match(/^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$))*[ \t]*/);
  const pre = m ? m[0] : '';
  if (!pre.includes('\t')) return line;
  let out = '';
  for (const ch of pre) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out + line.slice(pre.length);
}

export function parseMarkdown(source: string): Parsed {
  const { body, fm } = splitFrontmatter(source);
  const ctx: Ctx = { problems: [], hidden: 0, inCode: 0 };
  const { blocks } = parseBlocks(body.split('\n').map(expandPrefixTabs), ctx);
  // 對帳：原文每一個 <!--，不是被當成註解藏起來，就是落在程式碼裡；對不上＝有一個註解符號跑進了正文（或內容不見了），擋下。
  const total = marks(body);
  if (total !== ctx.hidden + ctx.inCode && !ctx.problems.some((p) => p.code === 'unclosed_comment')) {
    ctx.problems.push({ code: 'comment_leaked', severity: 'error', message: `原稿有 ${total} 個 <!--，其中 ${ctx.hidden} 個當註解藏起來、${ctx.inCode} 個在程式碼裡，剩下的會以文字出現在信裡（例如反斜線跳脫的 \\<!--、圖片替代文字或網址裡的 <!--）；請改寫或用反引號包起來`, where: clip(body.slice(Math.max(0, body.indexOf('<!--') - 10))) });
  }
  return { blocks, problems: ctx.problems, frontmatter: fm };
}
