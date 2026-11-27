// 區塊結構 → 信件安全的 HTML（內嵌樣式、表格友善）與純文字。純函式。
import type { Block, Inline } from './markdown.ts';
import { escapeHtml, type Labels, type Theme } from './template.ts';

interface Ctx {
  theme: Theme;
  labels: Labels;
}

const T = (c: Ctx) => `font-family:${c.theme.font};color:${c.theme.text}`;

function linkHtml(l: Inline & { t: 'link' }, c: Ctx): string {
  const inner = l.c.map((n) => inlineHtml(n, c)).join('');
  const href = l.out ?? l.href;
  if (href === '') return inner; // 不安全的連結已被改成純文字
  return `<a class="mr-link" href="${escapeHtml(href)}" style="color:${c.theme.link};text-decoration:underline;word-break:break-word;overflow-wrap:anywhere">${inner}</a>`;
}

function imgHtml(src: string, alt: string, c: Ctx): string {
  // imageWidth：給 Outlook for Windows 一個 width 屬性（它不吃 max-width，否則照原圖寬度顯示）；其他信箱仍以 max-width:100% 縮到螢幕寬。
  const w = c.theme.imageWidth;
  if (w) return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${w}" style="display:block;border:0;width:${w}px;max-width:100%;height:auto">`;
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="display:block;border:0;max-width:100%;height:auto">`;
}

function inlineHtml(n: Inline, c: Ctx): string {
  switch (n.t) {
    case 'text':
      return escapeHtml(n.v);
    case 'code':
      return `<code class="mr-code" style="background:${c.theme.codeBg};padding:1px 5px;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:0.9em">${escapeHtml(n.v)}</code>`;
    case 'br':
      return '<br>';
    case 'strong':
      return `<strong>${n.c.map((x) => inlineHtml(x, c)).join('')}</strong>`;
    case 'em':
      return `<em>${n.c.map((x) => inlineHtml(x, c)).join('')}</em>`;
    case 'link':
      return linkHtml(n, c);
    case 'image':
      return imgHtml(n.src, n.alt, c).replace('display:block;', 'display:inline-block;');
  }
}

const inlines = (ns: Inline[], c: Ctx) => ns.map((n) => inlineHtml(n, c)).join('');

function listItemHtml(blocks: Block[], c: Ctx): string {
  // 只有一個段落的項目不要段落邊距
  if (blocks.length === 1 && blocks[0].t === 'p') return inlines(blocks[0].c, c);
  return blocks.map((b, i) => blockHtml(b, c, i === blocks.length - 1)).join('');
}

function blockHtml(b: Block, c: Ctx, last = false): string {
  const mb = last ? '0' : '18px';
  switch (b.t) {
    case 'p':
      return `<p class="mr-text" style="margin:0 0 ${mb};font-size:16px;line-height:1.8;${T(c)}">${inlines(b.c, c)}</p>`;
    case 'h': {
      const size = [0, 26, 22, 19, 17, 16, 16][b.level];
      const lv = Math.min(b.level, 6);
      return `<h${lv} class="mr-text" style="margin:${b.level <= 2 ? '28px' : '22px'} 0 12px;font-size:${size}px;line-height:1.4;font-weight:700;${T(c)}">${inlines(b.c, c)}</h${lv}>`;
    }
    case 'hr':
      return `<hr class="mr-bd" style="border:0;border-top:1px solid ${c.theme.border};margin:24px 0">`;
    case 'quote':
      return `<blockquote class="mr-bd mr-muted" style="margin:0 0 ${mb};padding:2px 0 2px 14px;border-left:3px solid ${c.theme.border};color:${c.theme.muted}">${b.c.map((x, i) => blockHtml(x, c, i === b.c.length - 1)).join('')}</blockquote>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items.map((it) => `<li class="mr-text" style="margin:0 0 8px;font-size:16px;line-height:1.8;${T(c)}">${listItemHtml(it, c)}</li>`).join('');
      const start = b.ordered && b.start !== undefined ? ` start="${b.start}"` : '';
      return `<${tag}${start} style="margin:0 0 ${mb};padding-left:24px">${items}</${tag}>`;
    }
    case 'code':
      return `<pre class="mr-code mr-text" style="margin:0 0 ${mb};padding:12px 14px;background:${c.theme.codeBg};font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;color:${c.theme.text}">${escapeHtml(b.v)}</pre>`;
    case 'table': {
      const cell = (tag: 'th' | 'td', cellIn: Inline[], align: string | null) =>
        `<${tag} class="mr-bd mr-text" style="border:1px solid ${c.theme.border};padding:8px 10px;font-size:14px;line-height:1.6;text-align:${align ?? 'left'};vertical-align:top;${tag === 'th' ? 'font-weight:700;' : ''}${T(c)}">${inlines(cellIn, c)}</${tag}>`;
      const head = `<tr>${b.head.map((h, i) => cell('th', h, b.align[i] ?? null)).join('')}</tr>`;
      const rows = b.rows.map((r) => `<tr>${r.map((x, i) => cell('td', x, b.align[i] ?? null)).join('')}</tr>`).join('');
      return `<div style="margin:0 0 ${mb};overflow-x:auto"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">${head}${rows}</table></div>`;
    }
    case 'image': {
      const img = imgHtml(b.src, b.alt, c);
      const inner = b.link && (b.link.out ?? b.link.href) !== '' ? `<a href="${escapeHtml(b.link.out ?? b.link.href)}" style="text-decoration:none">${img}</a>` : img;
      return `<div style="margin:0 0 ${mb};line-height:0">${inner}</div>`;
    }
    case 'embed':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${mb}"><tr><td class="mr-code mr-bd" style="background:${c.theme.codeBg};border:1px solid ${c.theme.border};padding:14px 16px;font-size:15px;${T(c)}"><a class="mr-link" href="{{web_url}}" style="color:${c.theme.link}">${escapeHtml(c.labels.embedCard)}</a></td></tr></table>`;
  }
}

export function renderBodyHtml(blocks: Block[], theme: Theme, labels: Labels): string {
  const c = { theme, labels };
  return blocks.map((b, i) => blockHtml(b, c, i === blocks.length - 1)).join('\n');
}

// ───────────── 純文字 ─────────────

function inlineText(n: Inline, labels: Labels): string {
  switch (n.t) {
    case 'text':
      return n.v;
    case 'code':
      return n.v;
    case 'br':
      return '\n';
    case 'strong':
    case 'em':
      return n.c.map((x) => inlineText(x, labels)).join('');
    case 'image':
      return labels.image(n.alt);
    case 'link': {
      const text = n.c.map((x) => inlineText(x, labels)).join('');
      const url = n.tu ?? n.href;
      if (url === '') return text;
      // 讀者在網站上看得到的連結文字不能在純文字版消失：只有它就是印出來的網址、或是一串網址且整串出現在印出來的網址裡
      // （沒追蹤的裸網址，後面只多了 utm）才省略。裸網址也一樣——網站上它的文字就是那串網址（緊貼在後面、沒空格的字也算在內），
      // 追蹤轉址看不出來，所以照「文字 (網址)」印。
      const shown = text.trim();
      if (shown === '' || shown === url || (/^https?:\/\//i.test(shown) && url.includes(shown))) return url;
      return `${text} (${url})`;
    }
  }
}

const inlinesText = (ns: Inline[], l: Labels) => ns.map((n) => inlineText(n, l)).join('');

function blockText(b: Block, l: Labels, indent = ''): string {
  const pad = (s: string) => s.split('\n').map((x) => (x === '' ? x : indent + x)).join('\n');
  switch (b.t) {
    case 'p':
      return pad(inlinesText(b.c, l));
    case 'h':
      return pad(inlinesText(b.c, l));
    case 'hr':
      return pad('----------');
    case 'quote':
      return pad(b.c.map((x) => blockText(x, l)).join('\n\n').split('\n').map((x) => `> ${x}`.trimEnd()).join('\n'));
    case 'list':
      return b.items
        .map((it, i) => {
          const mark = b.ordered ? `${(b.start ?? 1) + i}. ` : '- ';
          const body = it.map((x) => blockText(x, l)).join('\n\n');
          const [first, ...rest] = body.split('\n');
          return pad([mark + first, ...rest.map((x) => (x === '' ? x : ' '.repeat(mark.length) + x))].join('\n'));
        })
        .join('\n');
    case 'code':
      return pad(b.v.split('\n').map((x) => `    ${x}`).join('\n'));
    case 'table':
      return pad([b.head, ...b.rows].map((r) => r.map((cell) => inlinesText(cell, l).replace(/\n/g, ' ')).join(' | ')).join('\n'));
    case 'image':
      return pad(l.image(b.alt));
    case 'embed':
      return pad(`${l.embedCard.replace(/\s*→\s*$/, '')}: {{web_url}}`);
  }
}

export function renderBodyText(blocks: Block[], labels: Labels): string {
  return blocks.map((b) => blockText(b, labels)).join('\n\n');
}
