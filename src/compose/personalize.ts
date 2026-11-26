// 個人化：把一期信的 HTML／純文字／標頭裡的佔位換成這一位收件人的值。純函式。
// 第一版只開四個欄位：name（沒有就整段省略）、email、unsubscribe_url、web_url；另有追蹤簽章 {{c:N}}、{{o}}。
// 一次掃完（單趟替換）：收件人的值裡就算寫了 {{email}}，也不會被再展開。

export interface RecipientVars {
  name?: string | null;
  email: string;
  unsubscribe_url: string;
  web_url: string;
}

export interface PersonalizeOptions {
  /** 產生追蹤簽章：kind 'c'＝第 index 個連結、'o'＝開信圖。寄出時由簽章函式提供；預覽可傳固定字串。 */
  track?: (kind: 'c' | 'o', index?: number) => string;
}

export class PersonalizeError extends Error {
  readonly code: 'missing_field' | 'bad_url' | 'unknown_placeholder' | 'unbalanced_section' | 'missing_track';
  constructor(code: PersonalizeError['code'], message: string) {
    super(message);
    this.name = 'PersonalizeError';
    this.code = code;
  }
}

const SECTION_KEYS = ['name', 'email'] as const;
const VALUE_KEYS = ['name', 'email', 'unsubscribe_url', 'web_url'] as const;
const TOKEN = /\{\{\s*([#/]?)\s*([a-z_]+)(?::(\d+))?\s*\}\}/g;

export function escapeHtmlValue(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 名字：去掉控制字元與換行、壓縮空白、最多 60 字；空字串＝沒有名字。 */
export function cleanName(v: string | null | undefined): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 60).join('');
}

export function checkVars(v: RecipientVars): { name: string; email: string; unsubscribe_url: string; web_url: string } {
  const name = cleanName(v.name);
  const email = typeof v.email === 'string' ? v.email.trim() : '';
  if (!email || /[\s<>"]/.test(email)) throw new PersonalizeError('missing_field', 'email 缺或格式不對');
  for (const k of ['unsubscribe_url', 'web_url'] as const) {
    const u = typeof v[k] === 'string' ? v[k].trim() : '';
    if (!u) throw new PersonalizeError('missing_field', `${k} 不能是空的`);
    if (!/^https:\/\/[^\s<>"]+$/i.test(u)) throw new PersonalizeError('bad_url', `${k} 必須是 https 網址`);
  }
  return { name, email, unsubscribe_url: v.unsubscribe_url.trim(), web_url: v.web_url.trim() };
}

/** 展開一段內容。mode 'html' 會跳脫值；'text' 與 'header' 原樣放入（header 另外擋掉換行）。 */
export function fill(template: string, vars: RecipientVars, mode: 'html' | 'text' | 'header', opts: PersonalizeOptions = {}): string {
  const v = checkVars(vars);
  // 第一趟：區段。沒有該欄位的值，整段（含標籤）一起拿掉。
  let out = template;
  for (const key of SECTION_KEYS) {
    const re = new RegExp(`\\{\\{\\s*#\\s*${key}\\s*\\}\\}([\\s\\S]*?)\\{\\{\\s*/\\s*${key}\\s*\\}\\}`, 'g');
    out = out.replace(re, (_m, inner: string) => (v[key] ? inner : ''));
  }
  // 第二趟：單趟替換所有佔位；不認得的、沒配對的區段一律拋錯（不准寄出殘留）。
  const enc = (s: string) => (mode === 'html' ? escapeHtmlValue(s) : s);
  out = out.replace(TOKEN, (_m, mark: string, key: string, n: string | undefined) => {
    if (mark) throw new PersonalizeError('unbalanced_section', `區段標記 ${mark}${key} 沒有配對`);
    if (key === 'c' && n !== undefined) return needTrack(opts)('c', Number(n));
    if (key === 'o' && n === undefined) return needTrack(opts)('o');
    if ((VALUE_KEYS as readonly string[]).includes(key) && n === undefined) return enc(v[key as (typeof VALUE_KEYS)[number]]);
    throw new PersonalizeError('unknown_placeholder', `不認得的佔位 {{${key}}}`);
  });
  if (mode === 'header' && /[\r\n]/.test(out)) throw new PersonalizeError('bad_url', '標頭值不能含換行');
  return out;
}

function needTrack(opts: PersonalizeOptions): NonNullable<PersonalizeOptions['track']> {
  if (!opts.track) throw new PersonalizeError('missing_track', '內容含追蹤佔位，但沒有提供簽章函式');
  return opts.track;
}

export function personalize(
  content: { html: string; text: string; headers?: Record<string, string> },
  vars: RecipientVars,
  opts: PersonalizeOptions = {},
): { html: string; text: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const [k, val] of Object.entries(content.headers ?? {})) headers[k] = fill(val, vars, 'header', opts);
  return { html: fill(content.html, vars, 'html', opts), text: fill(content.text, vars, 'text', opts), headers };
}

/** 列出一段內容用到的佔位，找出不在白名單的與沒配對的區段（寄前檢查用）。 */
export function scanPlaceholders(s: string): { unknown: string[]; unbalanced: string[]; used: Set<string> } {
  const unknown: string[] = [];
  const used = new Set<string>();
  const open: Record<string, number> = {};
  const close: Record<string, number> = {};
  for (const m of s.matchAll(TOKEN)) {
    const [raw, mark, key, n] = m;
    if (mark === '#' || mark === '/') {
      if ((SECTION_KEYS as readonly string[]).includes(key) && n === undefined) {
        (mark === '#' ? open : close)[key] = ((mark === '#' ? open : close)[key] ?? 0) + 1;
        continue;
      }
      unknown.push(raw);
    } else if (key === 'c' && n !== undefined) used.add('c');
    else if (key === 'o' && n === undefined) used.add('o');
    else if ((VALUE_KEYS as readonly string[]).includes(key) && n === undefined) used.add(key);
    else unknown.push(raw);
  }
  const unbalanced = SECTION_KEYS.filter((k) => (open[k] ?? 0) !== (close[k] ?? 0)).map((k) => k as string);
  // 沒被 TOKEN 吃掉但長得像佔位的殘渣（例如 {{ foo bar }}、{{name}）
  const stripped = s.replace(TOKEN, '');
  for (const m of stripped.matchAll(/\{\{[^}]{0,40}\}?\}?/g)) unknown.push(m[0]);
  return { unknown, unbalanced, used };
}
