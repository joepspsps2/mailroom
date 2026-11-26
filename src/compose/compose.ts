// 產信：原稿（markdown）＋樣板 → 一期信件的 HTML、純文字、連結表、標頭。
// 這一側只「產生」：轉址服務與事件記錄是別的零件。輸出裡帶著要在寄出時才填的佔位（見 personalize.ts）：
//   {{name}} {{email}} {{unsubscribe_url}} {{web_url}}、{{c:N}}（第 N 個連結的簽章）、{{o}}（開信圖的簽章）。
import { parseMarkdown, type Block, type Inline, type Problem } from './markdown.ts';
import { renderBodyHtml, renderBodyText } from './render.ts';
import type { EmailTemplate } from './template.ts';

export interface ComposeOptions {
  /** 原稿（含 frontmatter 的 markdown）。 */
  source: string;
  template: EmailTemplate;
  /** 期號：進 utm_campaign。只收英數、連字號、底線、點。 */
  issue: string;
  /** 主旨；沒給就用 frontmatter 的 title。 */
  subject?: string;
  /** 預覽文字；沒給就用 frontmatter 的 description。 */
  preheader?: string;
  /** 追蹤轉址的根網址（https，例 https://t.example.com）。沒給＝不改寫連結、不放開信圖。 */
  trackBase?: string;
  /** 原稿裡的相對圖片網址（/x.png）用這個補成絕對網址。 */
  assetBase?: string;
  /** 原稿裡的相對連結用這個補成絕對網址。 */
  siteBase?: string;
  utmSource?: string;
  utmMedium?: string;
  /** 純文字版的連結是否也走追蹤轉址（預設是）。 */
  trackInText?: boolean;
  /** 退訂標頭要不要多帶 mailto（`<{{unsubscribe_url}}>, <{{unsubscribe_mailto}}>`）。開了之後，personalize 的收件人資料必須帶 unsubscribe_mailto。 */
  unsubscribeMailto?: boolean;
}

export interface LinkRecord {
  /** 1 起算，對應 {{c:N}}。 */
  index: number;
  /** 補完 utm 之後、要轉去的最終網址。 */
  url: string;
  /** 原稿裡的網址（補成絕對之後、加 utm 之前）。 */
  original: string;
  text: string;
}

export interface ImageRecord {
  src: string;
  alt: string;
}

export interface ComposeResult {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /** 兩個退訂標頭（含 {{unsubscribe_url}} 佔位，寄出時一起填）。 */
  headers: Record<string, string>;
  links: LinkRecord[];
  images: ImageRecord[];
  problems: Problem[];
  /** 原稿 frontmatter 的單行欄位。 */
  frontmatter: Record<string, string>;
  /** html 的位元組數（UTF-8）。 */
  htmlBytes: number;
}

const PLACEHOLDER_HREF = /^\{\{(web_url|unsubscribe_url)\}\}$/;
const ISSUE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function absolutize(u: string, base: string | undefined): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  if (!base) return null;
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}

/** 補 utm：直接接在原本網址後面，不重組查詢字串（帶簽章的網址、逗號、斜線都原樣保留）；已有的 utm_* 不蓋。 */
function addUtm(u: string, p: { source: string; medium: string; campaign: string }): string {
  const hashAt = u.indexOf('#');
  const frag = hashAt >= 0 ? u.slice(hashAt) : '';
  let base = hashAt >= 0 ? u.slice(0, hashAt) : u;
  const add: string[] = [];
  for (const [k, v] of [['utm_source', p.source], ['utm_medium', p.medium], ['utm_campaign', p.campaign]] as const) {
    if (!new RegExp(`[?&]${k}=`).test(base)) add.push(`${k}=${encodeURIComponent(v)}`);
  }
  if (add.length === 0) return u;
  base += base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?';
  return base + add.join('&') + frag;
}

const plain = (ns: Inline[]): string =>
  ns
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'strong' || n.t === 'em' || n.t === 'link' ? plain(n.c) : n.t === 'image' ? n.alt : ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/** 走一遍所有區塊，處理連結（補絕對、加 utm、編號、改寫）與圖片（補絕對、記下來）。 */
function walk(blocks: Block[], visit: (n: Inline) => void): void {
  const inl = (ns: Inline[]) => {
    for (const n of ns) {
      visit(n);
      if (n.t === 'strong' || n.t === 'em') inl(n.c);
      else if (n.t === 'link') inl(n.c);
    }
  };
  for (const b of blocks) {
    if (b.t === 'p' || b.t === 'h') inl(b.c);
    else if (b.t === 'quote') walk(b.c, visit);
    else if (b.t === 'list') for (const it of b.items) walk(it, visit);
    else if (b.t === 'table') {
      for (const c of b.head) inl(c);
      for (const r of b.rows) for (const c of r) inl(c);
    } else if (b.t === 'image') {
      if (b.link) {
        visit(b.link);
        inl(b.link.c);
      } else visit({ t: 'image', src: b.src, alt: b.alt });
    }
  }
}

export function compose(opts: ComposeOptions): ComposeResult {
  const parsed = parseMarkdown(opts.source);
  const problems: Problem[] = [...parsed.problems];
  const fm = parsed.frontmatter;
  if (!ISSUE_RE.test(opts.issue)) problems.push({ code: 'issue_invalid', severity: 'error', message: '期號只能用英數、連字號、底線、點（1–64 字）', where: opts.issue });

  let trackBase: string | undefined;
  if (opts.trackBase) {
    try {
      const u = new URL(opts.trackBase);
      if (u.protocol !== 'https:') throw new Error('not https');
      trackBase = `${u.origin}`;
    } catch {
      problems.push({ code: 'track_base_invalid', severity: 'error', message: '追蹤網址必須是 https 的根網址', where: opts.trackBase });
    }
  }

  const utm = { source: opts.utmSource ?? 'newsletter', medium: opts.utmMedium ?? 'email', campaign: opts.issue };
  const links: LinkRecord[] = [];
  const images: ImageRecord[] = [];
  const trackInText = opts.trackInText ?? true;

  // 圖片區塊與行內圖片都要補絕對網址：先就地改 src
  const fixImage = (img: { src: string; alt: string }) => {
    const abs = absolutize(img.src, opts.assetBase);
    if (abs === null || !/^https?:\/\//i.test(abs)) {
      problems.push({ code: 'image_not_absolute', severity: 'error', message: '圖片網址不是完整的 http(s) 網址（信裡的圖一定要用絕對網址）', where: img.src.slice(0, 80) });
      return;
    }
    img.src = abs;
  };
  const seenImg = new Set<object>();
  const seenKey = new Set<string>();
  const markImage = (img: { src: string; alt: string }) => {
    if (seenImg.has(img)) return;
    seenImg.add(img);
    fixImage(img);
    const key = `${img.src}\u0000${img.alt}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    images.push({ src: img.src, alt: img.alt });
  };
  for (const b of parsed.blocks) walkImageBlocks(b, markImage);

  walk(parsed.blocks, (n) => {
    if (n.t === 'image') {
      if (!seenImg.has(n)) markImage(n);
      return;
    }
    if (n.t !== 'link' || n.idx !== undefined || n.out !== undefined) return;
    const href = n.href.trim();
    if (PLACEHOLDER_HREF.test(href)) {
      n.out = href;
      n.tu = href;
      return;
    }
    if (/^(mailto:|tel:)/i.test(href)) {
      n.out = href;
      n.tu = href;
      return;
    }
    if (href.startsWith('#')) {
      n.out = '';
      n.tu = '';
      problems.push({ code: 'anchor_link', severity: 'warn', message: '頁內錨點連結在信裡沒有意義，已拿掉連結只留文字', where: href.slice(0, 60) });
      return;
    }
    const abs = absolutize(href, opts.siteBase);
    if (abs === null || !/^https?:\/\//i.test(abs)) {
      n.out = '';
      n.tu = '';
      problems.push({
        code: abs === null ? 'link_not_absolute' : 'unsafe_link',
        severity: 'error',
        message: abs === null ? '連結不是完整網址，也沒有 siteBase 可以補' : '連結用了不允許的網址協定（只收 http／https／mailto／tel）',
        where: href.slice(0, 80),
      });
      return;
    }
    const finalUrl = addUtm(abs, utm);
    const index = links.length + 1;
    links.push({ index, url: finalUrl, original: abs, text: plain(n.c).slice(0, 120) });
    n.idx = index;
    if (trackBase) {
      n.out = `${trackBase}/c/{{c:${index}}}`;
      n.tu = trackInText ? n.out : finalUrl;
    } else {
      n.out = finalUrl;
      n.tu = finalUrl;
    }
  });
  for (const b of flatBlocks(parsed.blocks)) if (b.t === 'embed') problems.push({ code: 'embed_replaced', severity: 'info', message: '嵌入內容（影片、互動圖表）已換成「到網站看」的連結卡' });

  const subject = (opts.subject ?? fm.title ?? '').trim();
  const preheader = (opts.preheader ?? fm.description ?? '').trim();
  const t = opts.template;
  const bodyHtml = renderBodyHtml(parsed.blocks, t.theme, t.labels);
  const bodyText = renderBodyText(parsed.blocks, t.labels);
  const pixelUrl = trackBase ? `${trackBase}/o/{{o}}.gif` : undefined;
  const parts = { subject, preheader, bodyHtml, bodyText, pixelUrl };
  const html = t.renderHtml(parts);
  const text = t.renderText(parts);
  checkOutputForComments(parsed.blocks, parts, t, problems);

  return {
    subject,
    preheader,
    html,
    text,
    headers: {
      'List-Unsubscribe': opts.unsubscribeMailto ? '<{{unsubscribe_url}}>, <{{unsubscribe_mailto}}>' : '<{{unsubscribe_url}}>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    links,
    images,
    problems,
    frontmatter: fm,
    htmlBytes: new TextEncoder().encode(html).length,
  };
}

function walkImageBlocks(b: Block, f: (img: { src: string; alt: string }) => void): void {
  if (b.t === 'image') f(b);
  else if (b.t === 'quote') for (const x of b.c) walkImageBlocks(x, f);
  else if (b.t === 'list') for (const it of b.items) for (const x of it) walkImageBlocks(x, f);
}

function flatBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    out.push(b);
    if (b.t === 'quote') out.push(...flatBlocks(b.c));
    else if (b.t === 'list') for (const it of b.items) out.push(...flatBlocks(it));
  }
  return out;
}

/** 數 <!--（含跳脫成 &lt;!-- 的）出現幾次。 */
const commentMarks = (s: string) => s.split('<!--').length - 1 + (s.split('&lt;!--').length - 1);

/**
 * 最後一道保險：看「最終」HTML 與純文字版（不是解析樹）。把程式碼的內容遮掉重排一次，跟「只有樣板、沒有正文」的版本比：
 * 程式碼以外多出任何一個 <!--，就代表有註解字樣會寄到讀者眼前（解析或排版哪裡出了錯），記 error 擋下。
 * 樣板自己的 Outlook 條件註解（<!--[if mso]>）在兩邊一樣多，所以不會誤報。
 */
function checkOutputForComments(blocks: Block[], parts: { subject: string; preheader: string; bodyHtml: string; bodyText: string; pixelUrl?: string }, t: EmailTemplate, problems: Problem[]): void {
  if (problems.some((p) => p.code === 'comment_leaked' || p.code === 'unclosed_comment')) return; // 已經擋下，不重複報
  const masked = structuredClone(blocks);
  const mask = (bs: Block[]): void => {
    const inl = (ns: Inline[]) => {
      for (const n of ns) {
        if (n.t === 'code') n.v = '';
        else if (n.t === 'strong' || n.t === 'em' || n.t === 'link') inl(n.c);
      }
    };
    for (const b of bs) {
      if (b.t === 'code') b.v = '';
      else if (b.t === 'p' || b.t === 'h') inl(b.c);
      else if (b.t === 'quote') mask(b.c);
      else if (b.t === 'list') for (const it of b.items) mask(it);
      else if (b.t === 'table') {
        for (const c of b.head) inl(c);
        for (const r of b.rows) for (const c of r) inl(c);
      } else if (b.t === 'image' && b.link) inl(b.link.c);
    }
  };
  mask(masked);
  const withBody = { ...parts, bodyHtml: renderBodyHtml(masked, t.theme, t.labels), bodyText: renderBodyText(masked, t.labels) };
  const empty = { ...parts, bodyHtml: '', bodyText: '' };
  const extraHtml = commentMarks(t.renderHtml(withBody)) - commentMarks(t.renderHtml(empty));
  const extraText = commentMarks(t.renderText(withBody)) - commentMarks(t.renderText(empty));
  if (extraHtml > 0 || extraText > 0) {
    problems.push({ code: 'comment_leaked', severity: 'error', message: `信件${extraHtml > 0 ? ' HTML' : ''}${extraText > 0 ? ' 純文字版' : ''}在程式碼以外含有 <!-- 字樣，會原樣寄到讀者眼前；請檢查原稿裡的註解寫法` });
  }
}
