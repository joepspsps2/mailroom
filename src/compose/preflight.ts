// 寄前檢查：任何一條 error 沒過，就不准排程。純函式＋一個可注入 fetch 的連結檢查。
// 規則：HTTP 404／410 才算壞連結；逾時、連不上、其他狀態碼照實記成 warn，不擋。
import type { Problem } from './markdown.ts';
import type { ComposeResult } from './compose.ts';
import type { EmailTemplate } from './template.ts';
import { scanPlaceholders } from './personalize.ts';

export interface PreflightOptions {
  template: EmailTemplate;
  /** HTML 大小上限（位元組）；預設 90,000（Gmail 超過約 102KB 會折疊，留餘裕）。檢查時會把每個追蹤簽章與頁尾替換的長度估進去。 */
  maxHtmlBytes?: number;
  maxSubjectChars?: number;
  /** 網頁版網址（要檢查它打不打得開）；沒給就略過這一項。 */
  webUrl?: string;
  /** 要不要實際打網路檢查連結與圖片（預設要）。給 false＝只做離線檢查，並記一條 warn。 */
  checkLinks?: boolean;
  /** 可注入的 fetch（測試用假的）。 */
  fetch?: (url: string, init?: { method?: string; signal?: AbortSignal; redirect?: 'follow' }) => Promise<{ status: number }>;
  timeoutMs?: number;
  concurrency?: number;
}

export interface PreflightResult {
  ok: boolean;
  issues: Problem[];
  /** 每個檢查過的網址的結果（HTTP 狀態碼；0＝連不上）。 */
  linkStatuses: { url: string; status: number; kind: 'link' | 'image' | 'web' }[];
}

/** 樣板裡「這裡還沒填」的標記格式：[[TODO: 要補什麼]]（或【待補：…】）。看到就不准寄。 */
export const TODO_MARKER = /\[\[TODO[^\]]*\]\]|【待補[^】]*】/;
/** 寄出時每個追蹤簽章與頁尾替換最多比佔位多出的位元組（保守估計）。 */
const PER_TOKEN_EXTRA = 64;
const PER_MESSAGE_EXTRA = 400;

function cp(s: string): number {
  return Array.from(s).length;
}

function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return h.includes(':');
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export async function preflight(c: ComposeResult, opts: PreflightOptions): Promise<PreflightResult> {
  const issues: Problem[] = [...c.problems];
  const add = (code: string, severity: Problem['severity'], message: string, where?: string) => issues.push({ code, severity, message, where });

  // 1. 大小
  const max = opts.maxHtmlBytes ?? 90_000;
  const estimated = c.htmlBytes + (c.links.length + 1) * PER_TOKEN_EXTRA + PER_MESSAGE_EXTRA;
  if (estimated >= max) add('html_too_large', 'error', `HTML 估計 ${estimated} 位元組，超過上限 ${max}（含寄出時簽章與個人化的估計）`);

  // 2. 純文字版
  if (c.text.trim().length === 0) add('text_missing', 'error', '沒有純文字版');

  // 3. 退訂連結與兩個標頭
  const needle = '{{unsubscribe_url}}';
  const hrefUnsub = /href="\{\{unsubscribe_url\}\}"/.test(c.html);
  if (!hrefUnsub) add('unsubscribe_link_missing', 'error', 'HTML 沒有退訂連結（href 必須是退訂佔位）');
  if (!c.text.includes(needle)) add('unsubscribe_text_missing', 'error', '純文字版沒有退訂連結');
  const lu = c.headers['List-Unsubscribe'] ?? '';
  const lup = c.headers['List-Unsubscribe-Post'] ?? '';
  if (!/^<\{\{unsubscribe_url\}\}>$/.test(lu.trim())) add('unsubscribe_header_missing', 'error', '缺 List-Unsubscribe 標頭（要指向退訂佔位）');
  if (lup.trim() !== 'List-Unsubscribe=One-Click') add('unsubscribe_post_header_missing', 'error', '缺 List-Unsubscribe-Post 標頭（一鍵退訂）');
  // 退訂連結不准被改寫成追蹤連結（href 是退訂佔位但被包過的情形）
  if (c.links.some((l) => /unsubscribe/i.test(l.original) && l.url.includes('/c/'))) add('unsubscribe_tracked', 'error', '退訂連結被改寫成追蹤連結');

  // 4. 實體地址
  const addr = opts.template.postalAddress.trim();
  if (!addr) add('address_missing', 'error', '樣板沒有實體地址');
  else {
    if (TODO_MARKER.test(addr)) add('address_todo', 'error', '實體地址還是待補標記，不能寄出');
    const esc = addr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    if (!c.html.includes(esc)) add('address_not_in_html', 'error', 'HTML 裡找不到實體地址');
    if (!c.text.includes(addr)) add('address_not_in_text', 'error', '純文字版裡找不到實體地址');
  }
  // 樣板其他地方殘留的待補標記（頁尾文字等）
  for (const [label, body] of [['HTML', c.html], ['純文字', c.text]] as const) {
    const visible = label === 'HTML' ? body.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ') : body;
    const m = visible.match(TODO_MARKER);
    if (m) add('todo_marker', 'error', `${label}裡有待補標記「${m[0]}」，補完才能寄`);
  }

  // 5. 圖片替代文字、圖片網址協定
  for (const img of c.images) {
    if (!img.alt.trim()) add('image_alt_missing', 'error', '有圖片沒有替代文字', img.src.slice(0, 80));
    if (/^http:\/\//i.test(img.src)) add('image_insecure', 'warn', '圖片用 http（建議 https）', img.src.slice(0, 80));
  }

  // 6. 主旨、預覽文字
  const maxSubject = opts.maxSubjectChars ?? 80;
  if (!c.subject.trim()) add('subject_missing', 'error', '沒有主旨');
  else {
    if (cp(c.subject) > maxSubject) add('subject_too_long', 'error', `主旨 ${cp(c.subject)} 字，超過 ${maxSubject} 字`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(c.subject)) add('subject_invalid', 'error', '主旨含換行或控制字元');
  }
  if (!c.preheader.trim()) add('preheader_missing', 'error', '沒有預覽文字');

  // 7. 殘留佔位
  for (const [label, body] of [['HTML', c.html], ['純文字', c.text]] as const) {
    const s = scanPlaceholders(body);
    if (s.unknown.length) add('unknown_placeholder', 'error', `${label}有不認得的佔位（沒有殘留 {{…}} 才能寄）：${[...new Set(s.unknown)].slice(0, 5).join(' ')}`);
    if (s.unbalanced.length) add('unbalanced_section', 'error', `${label}的區段標記沒有配對：${s.unbalanced.join('、')}`);
  }
  for (const [k, v] of Object.entries(c.headers)) {
    const s = scanPlaceholders(v);
    if (s.unknown.length) add('unknown_placeholder', 'error', `標頭 ${k} 有不認得的佔位`);
  }

  // 8. 連結與圖片打得開（404／410 才算壞）
  const linkStatuses: PreflightResult['linkStatuses'] = [];
  if (opts.checkLinks === false) {
    add('links_unchecked', 'warn', '連結與圖片沒有實際檢查（離線模式）');
  } else {
    const f = opts.fetch ?? (globalThis.fetch as unknown as NonNullable<PreflightOptions['fetch']>);
    const targets = new Map<string, 'link' | 'image' | 'web'>();
    for (const l of c.links) targets.set(l.original, 'link');
    for (const i of c.images) if (/^https?:\/\//i.test(i.src)) targets.set(i.src, 'image');
    if (opts.webUrl) targets.set(opts.webUrl, 'web');
    const list = [...targets.entries()];
    let cursor = 0;
    const timeout = opts.timeoutMs ?? 10_000;
    const worker = async () => {
      while (cursor < list.length) {
        const [url, kind] = list[cursor++];
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {
          add('link_invalid', 'error', '網址格式不對', url.slice(0, 80));
          continue;
        }
        if (privateHost(host)) {
          add('link_private_host', 'error', '連結指向內網或本機位址', url.slice(0, 80));
          continue;
        }
        const status = await probe(f, url, timeout);
        linkStatuses.push({ url, status, kind });
        const what = kind === 'image' ? '圖片' : kind === 'web' ? '網頁版' : '連結';
        if (status === 404 || status === 410) add(kind === 'image' ? 'image_broken' : 'link_broken', 'error', `${what}打不開（HTTP ${status}）`, url.slice(0, 120));
        else if (status === 0) add('link_unverified', 'warn', `${what}連不上或逾時，無法確認`, url.slice(0, 120));
        else if (status >= 400) add('link_status', 'warn', `${what}回 HTTP ${status}（不算壞連結，照實記）`, url.slice(0, 120));
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, Math.max(1, list.length)) }, worker));
    linkStatuses.sort((a, b) => a.url.localeCompare(b.url));
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues, linkStatuses };
}

/** 先 HEAD；伺服器不支援 HEAD（405／501）再 GET。回狀態碼；連不上或逾時回 0。 */
async function probe(f: NonNullable<PreflightOptions['fetch']>, url: string, timeoutMs: number): Promise<number> {
  const once = async (method: 'HEAD' | 'GET'): Promise<number> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return (await f(url, { method, signal: ctl.signal, redirect: 'follow' })).status;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
    }
  };
  const s = await once('HEAD');
  if (s === 405 || s === 501) return once('GET');
  return s;
}
