// 測試信與預覽：測試信走真郵差、帶真標頭，但只寄給「設定檔白名單」裡的內部信箱，不進凍結名單、不進暖機、不算統計。
// 預覽：把一期信用範例收件人填好（不需要郵差），給預覽頁與指令看。

import { personalize } from '../compose/personalize.ts';
import type { ListDb } from '../lists.ts';
import { getCampaign, type CampaignRow, type Fail, type Ok } from './campaigns.ts';
import { activeHold, type Render } from './dispatch.ts';
import type { Postman } from './postman.ts';

export const MAX_TEST_RECIPIENTS = 10;
const DEFAULT_PREFIX = '[Test] ';
const SAMPLE = { email: 'reader@example.com', unsubscribe_url: 'https://example.com/unsubscribe/preview', unsubscribe_mailto: 'mailto:unsubscribe@example.com?subject=preview' };

export interface TestSendDeps {
  postman: Postman;
  render: Render;
  /** 允許收測試信的內部信箱（全部小寫）。空＝測試信功能關閉。 */
  allowed: readonly string[];
  domain: string;
  now?: () => Date;
}

const ctl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

/** 白名單從環境變數來：JSON 陣列或逗號分隔字串。 */
export function parseAllowed(v: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      list = Array.isArray(p) ? p : v.split(',');
    } catch {
      list = v.split(',');
    }
  }
  return [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^\s@<>",]+@[^\s@<>",]+$/.test(x)))];
}

export async function sendTest(db: ListDb, id: string, input: { to?: unknown; subjectPrefix?: unknown }, deps: TestSendDeps): Promise<Ok<{ results: { to: string; ok: boolean; error?: string }[] }> | Fail> {
  if (!deps.allowed.length) return { ok: false, reason: 'test_recipients_not_configured' };
  const c = await getCampaign(db, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status === 'cancelled' || c.status === 'done') return { ok: false, reason: 'illegal_state', status: c.status };
  if (!Array.isArray(input.to) || input.to.length === 0 || input.to.length > MAX_TEST_RECIPIENTS) return { ok: false, reason: 'bad_recipients' };
  const to = [...new Set(input.to.map((x) => String(x).trim().toLowerCase()))];
  if (to.some((a) => !deps.allowed.includes(a))) return { ok: false, reason: 'recipient_not_allowed' };
  const prefix = input.subjectPrefix === undefined ? DEFAULT_PREFIX : typeof input.subjectPrefix === 'string' && input.subjectPrefix.length <= 20 && !ctl(input.subjectPrefix) ? input.subjectPrefix : null;
  if (prefix === null) return { ok: false, reason: 'bad_prefix' };
  if (await activeHold(db, deps.domain)) return { ok: false, reason: 'domain_held' };
  const now = (deps.now ?? (() => new Date()))();
  const results: { to: string; ok: boolean; error?: string }[] = [];
  for (const [i, addr] of to.entries()) {
    try {
      // contact 0＝不存在的收件人：退訂連結照樣產生，但點了查無此人（測試信不該真的讓誰退訂）。
      const mail = await deps.render(c, { campaign_id: c.id, contact_id: 0, email: addr, segment: null, wave: null, rank: 0, state: 'planned', skip_reason: null, attempts: 0, message_id: null, error: null, enqueued_at: null, done_at: null, name: null });
      const out = await deps.postman.send({
        from: c.from_addr, to: addr, subject: `${prefix}${c.subject}`.slice(0, 320), html: mail.html, text: mail.text, replyTo: c.reply_to ?? undefined,
        headers: { ...(mail.headers ?? {}) }, tags: { campaign: c.id, contact: 'test' }, idempotencyKey: `test:${c.id}:${now.getTime()}:${i}`,
      });
      results.push(out.ok ? { to: addr, ok: true } : { to: addr, ok: false, error: `${out.kind} ${out.error}`.slice(0, 200) });
    } catch (e) {
      // 丟例外＝不知道有沒有寄出：照實回報，不自動重寄。
      results.push({ to: addr, ok: false, error: `unknown_outcome ${e instanceof Error ? e.message.slice(0, 150) : ''}`.trim() });
    }
  }
  return { ok: true, results };
}

/** 預覽內容：用範例收件人填好個人化欄位與追蹤簽章（簽章是假的，連結不會真的記點擊）。 */
export function previewContent(c: CampaignRow): { html: string; text: string; htmlNoName: string; textNoName: string; headers: Record<string, string> } | { error: string } {
  try {
    let headers: Record<string, string> = {};
    try {
      headers = c.headers ? (JSON.parse(c.headers) as Record<string, string>) : {};
    } catch {
      return { error: 'bad_headers' };
    }
    if (!c.web_url) return { error: 'web_url_required' };
    const track = (kind: 'c' | 'o', index?: number) => (kind === 'c' ? `preview-${index}` : 'preview');
    const vars = { ...SAMPLE, web_url: c.web_url };
    const a = personalize({ html: c.html, text: c.text, headers }, { ...vars, name: 'Sample Reader' }, { track });
    const b = personalize({ html: c.html, text: c.text, headers }, { ...vars, name: null }, { track });
    return { html: a.html, text: a.text, htmlNoName: b.html, textNoName: b.text, headers: a.headers ?? headers };
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : 'preview_failed' };
  }
}
