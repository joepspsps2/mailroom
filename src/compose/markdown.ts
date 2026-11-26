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
  /** 行首結構（縮排、> 後、清單記號後）用了 tab 的第一行（判不準，最後記 error）。 */
  tab: string;
  /** 合格的腳註定義標籤（小寫，依出現順序，重複的也留著）。 */
  defs: string[];
  /** 正文裡真正的腳註引用標籤（小寫；不含定義那幾行裡的）。 */
  refs: Set<string>;
  inDef: boolean;
  inLink: number;
  /** 正在轉的強調緊接在裸網址後面（網站會把整串吞進網址，裡面的腳註引用不算）。 */
  urlCtx: number;
  /** 最近一段合格腳註定義結束在哪一行（只在最外層用）：之後空行＋縮排的行＝網站上可能屬於腳註的續段，判不準。 */
  lastDefEnd: number;
}
const newCtx = (): Ctx => ({ problems: [], hidden: 0, inCode: 0, tab: '', defs: [], refs: new Set(), inDef: false, inLink: 0, urlCtx: 0, lastDefEnd: -1 });
const scratch = newCtx;
/** 行首空白裡有 tab。 */
const tabLead = (l: string) => /^[ \t]*\t/.test(l.startsWith(LAZY) ? l.slice(1) : l);
const noteTab = (ctx: Ctx, l: string) => {
  if (!ctx.tab) ctx.tab = l;
};
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
    // 偽註解（<?…?>、<!X…>、<![CDATA[…]]>）在網站上也是一整塊原始 HTML，不能從中間切開（例如吞掉連結的 ](網址)）
    const close = s.startsWith('<![CDATA[', i) ? ']]>' : s.startsWith('<?', i) ? '?>' : /^<![A-Za-z]/.test(s.slice(i, i + 3)) ? '>' : '';
    if (close) {
      const e = s.indexOf(close, i + 2);
      if (e >= 0) return e + close.length;
    }
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
    // 網址前面緊接英文字母或數字（例：abchttps://…）：網站不做成連結，照字面留著
    if (at > 0 && /[A-Za-z0-9]/.test(text[at - 1])) continue;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }], bare: true });
    last = at + url.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out.map((n) => (n.t === 'text' ? { t: 'text', v: decodeEntities(n.v) } : n));
}

/** 網站會自動連結的網址（http、https、www.、email）出現在一串不含空白的字裡。 */
const URL_TAIL = /(?:https?:\/\/|www\.|[\w.+-]+@[\w-]+\.)/i;
/** 腳註標籤比對：不分大小寫，照 Unicode 的大小寫折疊（ß＝ss、ς＝σ）。 */
const EMAIL_TAIL = /[\w.+-]+@[\w-]+\./;
/** 原稿這一串（不含空白）裡有裸網址：網站的自動連結會從網址一路吞到下一個空白（中間的 [..](..)、**、反引號都吞），只有 ](網址) 或 <網址> 裡的不算。 */
function bareUrlBefore(srcTail: string): boolean {
  const u = srcTail.search(/https?:\/\/|www\./i);
  return u >= 0 && !/(?:\]\(|<)$/.test(srcTail.slice(0, u));
}
const fnLabel = (l: string) => l.toLowerCase().toUpperCase().toLowerCase();

/**
 * 緊貼寫法的總檢查（判不準就擋）：一串不含空白的字裡，
 * ① 裸網址（http(s)://、www.）後面還緊貼著 [ * ` 這類記號（或前面緊貼實體字）：網站會把它們全吞進網址，信裡卻當成語法；
 * ② 出現 ![^：網站不當腳註引用；
 * ③ 腳註引用前面有巢狀中括號：網站的切法判不準。
 * 程式碼片段的內容先遮掉不看。
 */
function gluedProblem(s: string): string | null {
  let masked = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '`') {
      const span = codeSpanAt(s, i);
      if (span) {
        masked += '`' + ' '.repeat(Math.max(0, span.end - i - 2)).replace(/ /g, '\u0001') + '`';
        i = span.end;
        continue;
      }
    }
    masked += s[i++];
  }
  for (const tok of masked.split(/\s+/)) {
    if (!tok) continue;
    if (tok.includes('![^')) return tok;
    const u = tok.search(/https?:\/\/|www\./i);
    // ](網址)、<網址>、[網址](…)（網址當連結文字）、href="網址"（HTML 屬性）裡的網址不是裸網址
    if (u >= 0 && !/(?:\]\(|<|\[|=["'])$/.test(tok.slice(0, u)) && GLUE_AFTER_URL.test(tok.slice(u))) return tok;
    // 實體字（&amp; 等）緊接網址：網站解碼後的切法跟信裡不同
    if (u > 0 && /&[A-Za-z0-9#]+;$/.test(tok.slice(0, u))) return tok;
    const f = tok.search(/\[\^[^\]\s]+\]/);
    if (f > 0) {
      let d = 0;
      for (const ch of tok.slice(0, f)) {
        if (ch === '[') d++;
        else if (ch === ']') d = Math.max(0, d - 1);
        if (d >= 2) return tok;
      }
    }
  }
  return null;
}
// 網址本身常有 _ & ~ !（查詢字串、維基檔名），不算；只看會被信裡當成語法的 [ * `
const GLUE_AFTER_URL = /[[*`]/;

function parseInline(s: string, ctx: Ctx, depth = 0): Inline[] {
  if (depth === 0 && !ctx.inLink) {
    const g = gluedProblem(s);
    if (g) ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '網址、腳註引用、強調記號沒有空格緊貼在一起，網站上的切法判不準；請在網址前後加空格', where: clip(g) });
  }
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(...autolink(buf));
      buf = '';
    }
  };
  let i = 0;
  // 強調的內層：前面緊接裸網址時，網站把整串吞進網址，內層的腳註引用不算
  const inner = (sub: string): Inline[] => {
    const u = bareUrlBefore(s.slice(0, i).match(/\S*$/)![0]) || URL_TAIL.test(buf.match(/\S*$/)![0]);
    if (u) ctx.urlCtx++;
    const r = parseInline(sub, ctx, depth + 1);
    if (u) ctx.urlCtx--;
    return r;
  };
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
      // 網址後面緊接反引號：網站會把反引號收進自動連結，程式碼的切法就跟信裡不同，判不準
      if (URL_TAIL.test(buf.match(/\S*$/)![0]) || bareUrlBefore(s.slice(0, i).match(/\S*$/)![0])) ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '網址後面緊接反引號，網站會把反引號當成網址的一部分；請在網址和反引號之間加空格', where: clip(buf.match(/\S*$/)![0] + s.slice(i, i + 20)) });
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
      flush(); // 註解把前後的字隔開：網址到這裡就結束，不能跟註解後面的字黏成一個網址
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
    // 腳註引用 [^名稱]：記下來（判斷定義有沒有被引用）；字面照留。連結文字裡的引用網站不做連結，判不準，記 error
    if (ch === '[') {
      const fn = s.slice(i).match(/^\[\^([^\]\s\\]+)\]/);
      // 接在網址後面（https://…[^1]、(www.…)[^1]）的不算：網站會把整串變成自動連結（只看還沒處理的字，連結的 ](網址) 不算）
      // 原稿這一串（例：*www.e.com*[^1]）裡有網址、又不是 [文字](網址) 或 <網址> 收好的，也不算
      const srcTail = s.slice(0, i).match(/\S*$/)![0];
      const inUrl = URL_TAIL.test(buf.match(/\S*$/)![0]) || bareUrlBefore(srcTail) || (EMAIL_TAIL.test(srcTail) && !srcTail.includes('](') && !srcTail.endsWith('>'));
      if (fn && !inUrl && !ctx.urlCtx && s[i + fn[0].length] !== '(' && s[i + fn[0].length] !== ':') {
        if (!ctx.inDef) ctx.refs.add(fnLabel(fn[1]));
        if (ctx.inLink) ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '連結文字裡有腳註引用，網站上不會做成連結；請把腳註移到連結外面', where: clip(fn[0]) });
      }
    }
    if (ch === '[' && depth < 3) {
      const close = matchBracket(s, i);
      if (close > 0 && s[close + 1] === '(') {
        const u = readParenUrl(s, close + 1);
        if (u) {
          flush();
          ctx.inLink++;
          const c = parseInline(s.slice(i + 1, close), ctx, depth + 1);
          ctx.inLink--;
          out.push({ t: 'link', href: u[0], c });
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
          ctx.inLink++;
          const c = parseInline(s.slice(i + a[0].length, closeAt), ctx, depth + 1);
          ctx.inLink--;
          out.push({ t: 'link', href: decodeEntities(href[1] ?? href[2] ?? ''), c });
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
          out.push({ t: name === 'b' || name === 'strong' ? 'strong' : 'em', c: inner(s.slice(i + fmt[0].length, closeAt)) });
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
        out.push({ t: strong ? 'strong' : 'em', c: inner(s.slice(i + mark.length, end)) });
        i = end + mark.length;
        continue;
      }
    }
    if (ch === '_' && depth < 4) {
      const prev = s[i - 1] ?? ' ';
      const end = findMark(s, i + 1, '_');
      if (end > i + 1 && !/[A-Za-z0-9]/.test(prev) && !/\s/.test(s[i + 1]) && !/[A-Za-z0-9]/.test(s[end + 1] ?? ' ') && !/\s/.test(s[end - 1])) {
        flush();
        out.push({ t: 'em', c: inner(s.slice(i + 1, end)) });
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
const LINK_REF_DEF = /^ {0,3}\[(?!\^[^\]\s]+\]:)[^\]]+\]:/;
const DIV_WRAPPER = /^ {0,3}(?:<div(?:\s+lang\s*=\s*(?:"[A-Za-z-]*"|'[A-Za-z-]*'))?\s*>|<\/div\s*>)\s*$/i;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** 懶惰續行的記號：引言或清單收進來的「沒縮排、接在段落後面」的行，在內層一律當段落續行（不能變成表頭或標題底線）。 */
const LAZY = '\uE002';

/*
 * tab 的欄位：CommonMark 的 tab 是跳到「絕對欄位」4 的倍數。引言、清單裡的行拿掉外層記號後，行首不再是第 0 欄，
 * 所以下面幾個函式都帶 col＝這一行在原稿裡從第幾欄開始。只在判斷「縮了幾格、是什麼區塊」時換算；
 * 程式碼內容一律從原行切出來，裡面的 tab 原樣保留（不然 Go、Makefile 的 tab 會被悄悄換成空白）。
 */
/** 行首縮排的欄數。 */
function indentCols(line: string, col = 0): number {
  let c = col;
  for (const ch of line) {
    if (ch === ' ') c++;
    else if (ch === '\t') c += 4 - (c % 4);
    else break;
  }
  return c - col;
}

/** 去掉行首最多 n 欄的空白（tab 跨過界線時，剩下的欄數補成空白）。 */
function stripCols(line: string, n: number, col = 0): string {
  let c = col;
  let i = 0;
  while (i < line.length && c < col + n) {
    if (line[i] === ' ') {
      c++;
      i++;
    } else if (line[i] === '\t') {
      const w = 4 - (c % 4);
      if (c + w > col + n) return ' '.repeat(c + w - col - n) + line.slice(i + 1);
      c += w;
      i++;
    } else break;
  }
  return line.slice(i);
}

/** 拿掉行首 n 欄時，拿掉的部分有沒有碰到 tab（剩下的 tab 屬於內容，不算）。 */
function consumedHasTab(line: string, n: number, col = 0): boolean {
  if (line.startsWith(LAZY)) line = line.slice(1);
  let c = col;
  for (let i = 0; i < line.length && c < col + n; i++) {
    if (line[i] === ' ') c++;
    else if (line[i] === '\t') return true;
    else break;
  }
  return false;
}

/** 縮排不到 4 欄（不是程式碼）的行：行首空白換成等寬的空格，給只認空格的區塊判斷用。 */
function normLead(line: string, col: number): string {
  if (line.startsWith(LAZY)) return line;
  const lead = line.match(/^[ \t]*/)![0];
  if (!lead.includes('\t')) return line;
  const k = indentCols(line, col);
  return k >= 4 ? line : ' '.repeat(k) + line.slice(lead.length);
}

/** 拿掉一行引言記號 >（和它後面可省略的一格；後面是 tab 時只吃掉一欄）。qcol＝引言內層的起始欄（第一行的）；p＝這一行自己的。 */
function stripQuote(line: string, col: number, qcol: number): { rest: string; p: number; ambiguous: boolean } {
  const m = line.match(/^( {0,3})>/)!;
  let rest = line.slice(m[0].length);
  let p = col + m[1].length + 1;
  if (rest[0] === ' ') {
    rest = rest.slice(1);
    p++;
  } else if (rest[0] === '\t') {
    rest = ' '.repeat(3 - (p % 4)) + rest.slice(1);
    p++;
  }
  // 這一行內層起點跟其他行不同（> 前面縮排不一樣）而行首還有 tab：照它自己的欄位換成空格，免得對不齊
  if (p !== qcol && /^[ ]*\t/.test(rest)) {
    const lead = rest.match(/^[ \t]*/)![0];
    rest = ' '.repeat(indentCols(rest, p)) + rest.slice(lead.length);
  }
  // 起點不同、而結構前綴（清單記號、> 之後）裡還有 tab：欄位換算判不準，交給呼叫端記 error
  // > 後面是 tab、換算後縮到 4 欄以上又像表格分隔列：網站的引擎會把 tab 整個吃掉照樣排表格，也判不準
  const tabSep = line.slice(m[0].length).startsWith('\t') && indentCols(rest, p) >= 4 && TABLE_SEP.test(rest.trim()) && rest.includes('|');
  const ambiguous = tabSep || (p !== qcol && /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$))*[ \t]*/.exec(rest)![0].includes('\t'));
  return { rest, p, ambiguous };
}

/** 表格分隔列前面是 tab、換算後剛好縮到 4 欄以上：網站的引擎在引言裡會把 tab 吃掉照樣排表格，排法判不準，記 error。 */
function tabTableAmbiguous(line: string, next: string | undefined, col: number): boolean {
  if (next === undefined || line.trim() === '' || next.startsWith(LAZY) || line.startsWith(LAZY)) return false;
  const lead = next.match(/^[ \t]*/)![0];
  if (!lead.includes('\t') || indentCols(next, col) < 4) return false;
  const t = next.trim();
  return TABLE_SEP.test(t) && t.includes('|') && splitRow(line).length === splitRow(t).length;
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
function listMarker(line: string, col = 0): Marker | null {
  if (HR.test(line)) return null;
  const m = line.match(/^( {0,3})([-*+]|(\d{1,9})([.)]))(?=[ \t]|$)([ \t]*)(.*)$/);
  if (!m) return null;
  const ordered = m[3] !== undefined;
  const at = m[1].length + m[2].length;
  let spaces = 0;
  for (const ch of m[5]) spaces += ch === '\t' ? 4 - ((col + at + spaces) % 4) : 1;
  const empty = m[6].trim() === '';
  const base = { ordered, kind: ordered ? m[4] : m[2], start: ordered ? Number(m[3]) : 0, empty };
  if (empty) return { ...base, content: at + 1, first: '' };
  // 記號後空 5 欄以上＝內容是縮排程式碼：只拿掉一欄，剩下的空白（含 tab）原樣留給程式碼
  if (spaces >= 5) return { ...base, content: at + 1, first: stripCols(m[5] + m[6], 1, col + at) };
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

/** 表格開頭：這一行＋下一行是分隔列（要有 |、格數相同）。兩行都不能縮 4 欄以上，也不能本身是清單項目、標題、引言（那些先成立）。 */
function isTableStart(line: string, next: string | undefined, col = 0): boolean {
  if (next === undefined || line.trim() === '' || next.startsWith(LAZY)) return false;
  line = normLead(line, col);
  next = normLead(next, col);
  if (indentCols(line) >= 4 || indentCols(next) >= 4) return false;
  if (listMarker(line, col) || listMarker(next, col) || ATX.test(line) || QUOTE.test(line) || QUOTE.test(next) || fenceOpen(line)) return false;
  return TABLE_SEP.test(next) && next.includes('|') && splitRow(line).length === splitRow(next).length;
}

/** 這一行能不能打斷同一層正在進行的段落（CommonMark 的規則：有序清單要從 1 開始、空項目不行、縮 4 格以上不行）。 */
function interrupts(line: string, next: string | undefined, tables = true, col = 0): boolean {
  if (indentCols(line, col) >= 4) return false;
  line = normLead(line, col);
  if (fenceOpen(line) || HR.test(line) || ATX.test(line) || QUOTE.test(line) || COMMENT_START.test(line) || HTML_INTERRUPT.test(line)) return true;
  const lm = listMarker(line, col);
  if (lm && !lm.empty && (!lm.ordered || lm.start === 1)) return true;
  return tables && isTableStart(line, next, col);
}

/** 懶惰續行（引言、清單裡沒縮排的下一行）：只有「內層最後是一個還開著的段落」才接得上；任何清單項目、區塊開頭都會斷開（表格不會：那時表頭只是段落續行）。 */
function lazyBreaks(line: string, col = 0): boolean {
  if (indentCols(line, col) >= 4) return false;
  line = normLead(line, col);
  return !!fenceOpen(line) || HR.test(line) || ATX.test(line) || QUOTE.test(line) || COMMENT_START.test(line) || HTML_INTERRUPT.test(line) || LONE_TAG.test(line) || listMarker(line, col) !== null;
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
  if (PSEUDO_COMMENT.test(out)) ctx.problems.push({ code: 'unsupported_html', severity: 'error', ...tagProblem(out.match(PSEUDO_COMMENT)![0], false) });
  const tag = out.match(/<\/?[a-zA-Z][^>]*>/) ?? out.match(/<[A-Za-z/!?][^\s>]*/); // 沒收尾的 <字母 也算：瀏覽器會把後面整段吞成標籤
  if (tag) ctx.problems.push({ code: 'unsupported_html', severity: 'error', ...tagProblem(tag[0], false) });
  const v = decodeEntities(out.trim());
  return v ? { t: 'p', c: [{ t: 'text', v }] } : null;
}

/** 腳註定義（合格的單行寫法、任何寫法、內容是區塊寫法）。 */
const FN_DEF = /^\[\^([^\]\s\\]+)\]:/;
const FN_DEF_ANY = /^ {0,3}\[\^[^\]]*\]:/;
const FN_DEF_BLOCK = /^(?:\s{4,}\S|\s*<|\s*\[[^\]]*\]:|\s*(?:>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|`{3,}|~{3,}|#{1,6}(?:\s|$)|\|))/;

/** 段落：從 lines[start] 收到空行或能打斷段落的行為止；下一行是 === 或 --- ＝標題（setext）。回傳下一個要看的行。 */
function paragraph(lines: string[], start: number, ctx: Ctx, blocks: Block[], col: number): number {
  const n = lines.length;
  const unlazy = (l: string) => (l.startsWith(LAZY) ? l.slice(1) : l);
  const para: string[] = [unlazy(lines[start])];
  const raw: string[] = [lines[start]];
  let i = start + 1;
  let setext = 0;
  let tabTable = false;
  while (i < n) {
    const l = lines[i];
    if (l.trim() === '') break;
    if (tabLead(l)) noteTab(ctx, l);
    if (tabTableAmbiguous(lines[i - 1], l, col)) tabTable = true;
    if (!l.startsWith(LAZY)) {
      const sx = indentCols(l, col) < 4 ? normLead(l, col).match(SETEXT) : null;
      if (sx) {
        setext = sx[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(l, lines[i + 1], true, col) || (BLOCK_HTML.test(normLead(l, col)) && EMBED_TAG.test(l))) break;
    }
    para.push(unlazy(l));
    raw.push(l);
    i++;
  }
  if (tabTable) ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '表格分隔列前面用 tab 縮排，網站上的排法判不準；請改用空格或不縮排', where: clip(para[0]) });
  // 腳註定義：只有「最外層、從第 0 欄寫起、整段每一行都是單行定義、內容不是區塊寫法、不是標題」判得準
  const isDef = (l: string) => FN_DEF.test(l) && !FN_DEF_BLOCK.test(l.replace(FN_DEF, ''));
  const defLike = para.some((l) => FN_DEF_ANY.test(l));
  let def = false;
  if (defLike) {
    // 後面要接空行或文末：被別的區塊（表格、清單…）打斷時，網站會把那個區塊也收進腳註
    if (col === 0 && !setext && (i >= n || lines[i].trim() === '') && raw.every((l) => !l.startsWith(LAZY) && isDef(l))) {
      def = true;
      for (const l of raw) ctx.defs.push(fnLabel(l.match(FN_DEF)![1]));
    } else ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '腳註定義要從行首寫起、前面空一行、一則一行（不能縮排、不能放在引言或清單裡、不能接在段落後面或變成標題，內容不能是清單、引言、程式碼）；不然網站上的顯示判不準', where: clip(para.find((l) => FN_DEF_ANY.test(l))!) });
  }
  ctx.inDef = def;
  // 連續的腳註定義在網站上是各自獨立的一則：一行一行分開轉（行內程式碼不能跨到下一則）
  const inline: Inline[] = def ? para.flatMap((l, k) => [...(k ? [{ t: 'br' } as Inline] : []), ...parseInline(l.trim(), ctx)]) : parseInline(para.join('\n').trim(), ctx);
  ctx.inDef = false;
  if (def) ctx.lastDefEnd = i;
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
/**
 * restrictFirst＝第一行是「打斷段落的那一行」開出來的內層（例：段落下一行的「- 2. …」）：
 * 網站的規則是打斷段落時，不是從 1 開始的有序清單、空的清單項目都不成立，這個限制要一路帶進同一行開的內層容器。
 */
function parseBlocks(lines: string[], ctx: Ctx, col = 0, restrictFirst = false): { blocks: Block[]; open: boolean } {
  const blocks: Block[] = [];
  const n = lines.length;
  let open = false;
  // 沒收尾的註解區塊：CommonMark 裡它一路延伸到容器結尾，所以容器最後不是「開著的段落」，懶惰續行接不上
  let unclosedHtml = false;
  // 上一個區塊是縮排程式碼：網站的引擎在它後面不認「不是從 1 開始的有序清單」，當成段落（照網站做）
  let afterIndentedCode = false;
  // 上一個段落結束在哪一行（那一行若開了清單或引言＝打斷段落）
  let paraEnd = -1;
  let i = 0;
  while (i < n) {
    const line = normLead(lines[i], col);
    open = false;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const prevIndentedCode = afterIndentedCode;
    afterIndentedCode = false;
    // 行首結構用 tab：縮排程式碼只看拿掉的那 4 欄，其他行看整段行首空白
    if (indentCols(lines[i], col) >= 4 ? consumedHasTab(lines[i], 4, col) : tabLead(lines[i])) noteTab(ctx, lines[i]);
    // 腳註定義後面空行、再接縮 4 欄的行：網站上那是腳註的續段（多段腳註），判不準
    if (col === 0 && ctx.lastDefEnd >= 0 && i > ctx.lastDefEnd && lines.slice(ctx.lastDefEnd, i).every((l) => l.trim() === '') && indentCols(lines[i]) >= 1) {
      ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '腳註定義後面接了縮排的行（可能是多段腳註），網站上的顯示判不準；請把腳註寫成一則一行、後面的段落不要縮排', where: clip(lines[i]) });
    }
    if (line.startsWith(LAZY)) {
      i = paragraph(lines, i, ctx, blocks, col);
      if (blocks[blocks.length - 1]?.t === 'p') paraEnd = i;
      open = i >= n;
      continue;
    }
    const interrupting = i === paraEnd || (restrictFirst && i === 0);
    // 縮排 4 格以上＝程式碼（段落中間的縮排行不算，那是段落續行）
    if (indentCols(lines[i], col) >= 4) {
      const body: string[] = [];
      while (i < n && (lines[i].trim() === '' || indentCols(lines[i], col) >= 4)) {
        if (consumedHasTab(lines[i], 4, col)) noteTab(ctx, lines[i]);
        body.push(stripCols(lines[i++], 4, col));
      }
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      const v = body.join('\n');
      ctx.inCode += marks(v);
      blocks.push({ t: 'code', v: protectBraces(v) });
      afterIndentedCode = true;
      continue;
    }
    // 圍欄程式碼
    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < n) {
        if (fenceCloses(normLead(lines[i], col), fence)) {
          closed = true;
          i++;
          break;
        }
        body.push(stripCols(lines[i++], fence.indent, col));
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
      const tail = rawTail((j === i ? line : lines[j]).slice(close + 3), ctx); // 同一行收尾時用換算過 tab 的那一行，位置才對得上
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
      const qcol = stripQuote(line, col, -1).p;
      let ambiguous = false;
      while (i < n) {
        const l = normLead(lines[i], col);
        if (QUOTE.test(l)) {
          if (tabLead(lines[i]) || /^ {0,3}>\t/.test(l)) noteTab(ctx, lines[i]);
          const q = stripQuote(l, col, qcol);
          if (q.rest.trim() === '' && l.includes('\t')) noteTab(ctx, lines[i]); // 只有空白的引言行裡有 tab
          if (q.ambiguous) ambiguous = true;
          inner.push(q.rest);
          i++;
          continue;
        }
        if (l.trim() !== '' && inner.length > 0 && !lazyBreaks(l, col) && parseBlocks(inner, scratch(), qcol, interrupting).open) {
          if (tabLead(lines[i])) noteTab(ctx, lines[i]);
          inner.push(l.startsWith(LAZY) ? l : LAZY + l);
          i++;
          continue;
        }
        break;
      }
      if (ambiguous) ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '引言裡 > 後面用 tab 縮排（或有的接空格、有的沒有），網站上的排法判不準；請統一寫成「> 」並改用空格', where: clip(line) });
      const r = parseBlocks(inner, ctx, qcol, interrupting);
      blocks.push({ t: 'quote', c: r.blocks });
      open = r.open && i >= n;
      continue;
    }
    if (isTableStart(line, lines[i + 1], col)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      // 表格不是段落：任何清單項目（不從 1 開始、空項目也算）都會結束表格
      while (i < n && lines[i].trim() !== '' && indentCols(lines[i], col) < 4 && !lines[i].startsWith(LAZY) && !interrupts(lines[i], lines[i + 1], false, col) && !listMarker(normLead(lines[i], col), col)) {
        if (tabLead(lines[i])) noteTab(ctx, lines[i]);
        if (FN_DEF_ANY.test(normLead(lines[i], col))) ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message: '表格裡有腳註定義，網站上的顯示判不準', where: clip(lines[i]) });
        const cells = splitRow(lines[i++]);
        while (cells.length < head.length) cells.push('');
        for (const extra of cells.slice(head.length)) ctx.hidden += marks(extra); // 多出來的格子網站上也不顯示（表格裡再出現像表頭的兩行，也只是一般的列）
        rows.push(cells.slice(0, head.length).map((c) => parseInline(c, ctx)));
      }
      blocks.push({ t: 'table', head: head.map((c) => parseInline(c, ctx)), align, rows });
      continue;
    }
    const lm = listMarker(line, col);
    const restricted = prevIndentedCode || interrupting;
    const first = lm && !(restricted && ((lm.ordered && lm.start !== 1) || lm.empty)) ? lm : null;
    if (first) {
      const items: Block[][] = [];
      let cur = first;
      while (true) {
        // 清單記號後面用 tab
        if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ ]*\t/.test(normLead(lines[i], col))) noteTab(ctx, lines[i]);
        const itemLines: string[] = [cur.first];
        i++;
        while (i < n) {
          const l = lines[i];
          if (l.trim() === '') {
            // 空行之後若還有縮排到項目內容的行，屬於本項（項目最多只能以一個空行開頭）
            let j = i;
            while (j < n && lines[j].trim() === '') j++;
            const startsBlank = itemLines.length === 1 && itemLines[0] === '';
            if (j < n && indentCols(lines[j], col) >= cur.content && !startsBlank) {
              for (; i < j; i++) itemLines.push('');
              continue;
            }
            break;
          }
          if (indentCols(l, col) >= cur.content) {
            if (consumedHasTab(l, cur.content, col)) noteTab(ctx, l);
            itemLines.push(stripCols(l, cur.content, col));
            i++;
            continue;
          }
          if (!lazyBreaks(l, col) && parseBlocks(itemLines, scratch(), col + cur.content, interrupting && items.length === 0).open) {
            if (tabLead(l)) noteTab(ctx, l);
            itemLines.push(l.startsWith(LAZY) ? l : LAZY + l); // 懶惰續行
            i++;
            continue;
          }
          break;
        }
        const r = parseBlocks(itemLines, ctx, col + cur.content, interrupting && items.length === 0);
        items.push(r.blocks);
        open = r.open && i >= n;
        // 下一個同類的清單記號＝同一張清單的下一項（中間可以有空行）
        let j = i;
        while (j < n && lines[j].trim() === '') j++;
        const next = j < n ? listMarker(normLead(lines[j], col), col) : null;
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
    i = paragraph(lines, i, ctx, blocks, col);
    if (blocks[blocks.length - 1]?.t === 'p') paraEnd = i;
    open = i >= n && blocks[blocks.length - 1]?.t !== 'h';
  }
  return { blocks, open: open && !unclosedHtml };
}

/** 最後的總檢查：行首結構用 tab、腳註定義有沒有被引用與重複。 */
function finalChecks(ctx: Ctx, blocks: Block[]): void {
  const fail = (message: string, where: string) => ctx.problems.push({ code: 'unsupported_syntax', severity: 'error', message, where: clip(where) });
  // 連結被拆壞的跡象：「](」後面直接接一個裸網址（例：*[**c**](https://…)字*，強調先切開了連結）。網站上那是連結，信裡變成吞掉後面字的裸網址
  let broken = '';
  const walk = (x: unknown): void => {
    if (broken || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      x.forEach((n, k) => {
        const prev = x[k - 1] as Inline | undefined;
        if (n && (n as Inline).t === 'link' && (n as { bare?: boolean }).bare && prev?.t === 'text' && prev.v.endsWith('](')) broken = (n as { href: string }).href;
      });
    }
    for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v);
  };
  walk(blocks);
  if (broken) fail('強調和連結的組合（例：*[**文字**](網址)字*）信裡排不出來，連結會被拆開；請把強調移到連結文字裡面或外面加空格', broken);
  if (ctx.tab) fail('行首的縮排、引言 > 或清單記號後面用了 tab，網站上的排法判不準；請改用空格（程式碼框裡的 tab 不受影響）', ctx.tab);
  const seen = new Set<string>();
  for (const label of ctx.defs) {
    if (seen.has(label)) fail(`腳註 [^${label}] 定義了兩次，網站只顯示第一個；請刪掉重複的`, `[^${label}]:`);
    seen.add(label);
    if (!ctx.refs.has(label)) fail(`腳註 [^${label}] 有定義但正文沒引用，網站上不顯示；請刪掉或在正文引用它`, `[^${label}]:`);
  }
}

export function parseMarkdown(source: string): Parsed {
  const { body, fm } = splitFrontmatter(source);
  const ctx = newCtx();
  const { blocks } = parseBlocks(body.split('\n'), ctx);
  finalChecks(ctx, blocks);
  // 對帳：原文每一個 <!--，不是被當成註解藏起來，就是落在程式碼裡；對不上＝有一個註解符號跑進了正文（或內容不見了），擋下。
  const total = marks(body);
  if (total !== ctx.hidden + ctx.inCode && !ctx.problems.some((p) => p.code === 'unclosed_comment')) {
    ctx.problems.push({ code: 'comment_leaked', severity: 'error', message: `原稿有 ${total} 個 <!--，其中 ${ctx.hidden} 個當註解藏起來、${ctx.inCode} 個在程式碼裡，剩下的會以文字出現在信裡（例如反斜線跳脫的 \\<!--、圖片替代文字或網址裡的 <!--）；請改寫或用反引號包起來`, where: clip(body.slice(Math.max(0, body.indexOf('<!--') - 10))) });
  }
  return { blocks, problems: ctx.problems, frontmatter: fm };
}
