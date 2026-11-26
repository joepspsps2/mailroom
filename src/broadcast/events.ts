// 郵差事件進來的唯一入口：正規化後的 ProviderEvent → events 表＋帳本 last_event＋（可注入的）退信／檢舉處理。
// 假郵差、之後的 SES（SNS 驗簽後）都呼叫 ingestEvent。同一則事件（provider_event_id）重送只處理一次。

import { addSuppression, type Db } from '../core.ts';
import { EVENT_TYPES, type ProviderEvent } from './postman.ts';

/** 交給「退信／檢舉怎麼進拒收」那一層的事件（形狀跟退訂模組的回報處理對得上）。 */
export type FeedbackInput =
  | { type: 'bounce'; kind: 'permanent' | 'transient'; email: string; campaign?: string | null; source: string; detail?: string | null }
  | { type: 'complaint'; email: string; source: string; detail?: string | null }
  | { type: 'delivery'; email: string };

export interface IngestOptions {
  /** 退信／檢舉／送達的後續處理。沒給＝預設：永久退信進 hard_bounce、檢舉進 complaint（跟 Resend webhook 一樣）。 */
  feedback?: (fb: FeedbackInput) => Promise<unknown>;
  now?: () => Date;
}

export type IngestOutcome = 'recorded' | 'repeat' | 'rejected';

const LAST_EVENT: Partial<Record<string, string>> = { delivery: 'delivered', bounce: 'bounced', complaint: 'complained', reject: 'failed', delay: 'delayed' };
const ID = /^[\x21-\x7e]{1,200}$/;

async function defaultFeedback(db: Db, fb: FeedbackInput, now: Date): Promise<void> {
  if (fb.type === 'bounce' && fb.kind === 'permanent') await addSuppression(db, fb.email, 'hard_bounce', fb.source, fb.detail ?? null, now);
  else if (fb.type === 'complaint') await addSuppression(db, fb.email, 'complaint', fb.source, fb.detail ?? null, now);
}

/** bounce 的 subtype 只看開頭：Permanent → 永久；其他（Transient、Undetermined）→ 暫時。 */
export function isPermanentBounce(subtype: string | null | undefined): boolean {
  return typeof subtype === 'string' && /^permanent/i.test(subtype);
}

export async function ingestEvent(db: Db, ev: ProviderEvent, opts: IngestOptions = {}): Promise<IngestOutcome> {
  if (!ev || typeof ev !== 'object' || !EVENT_TYPES.includes(ev.type)) return 'rejected';
  if (typeof ev.provider !== 'string' || !/^[a-z0-9-]{1,40}$/.test(ev.provider) || typeof ev.providerEventId !== 'string' || !ID.test(ev.providerEventId)) return 'rejected';
  const now = (opts.now ?? (() => new Date()))();
  const at = typeof ev.at === 'string' && !Number.isNaN(Date.parse(ev.at)) ? new Date(ev.at).toISOString() : now.toISOString();

  // 先查有沒有處理過；處理完才記（中途出錯時重送會再處理一次，下面每一步都可重複執行）。
  const seen = await db.prepare('SELECT id FROM events WHERE provider_event_id = ?').bind(ev.providerEventId).first();
  if (seen) return 'repeat';

  // 對到帳本列與期別／收件人：優先用郵差的信件 id，其次用事件帶的標籤。
  let msg = ev.providerMessageId
    ? await db.prepare('SELECT id, to_email FROM messages WHERE provider_id = ? LIMIT 1').bind(String(ev.providerMessageId)).first<{ id: number; to_email: string }>()
    : null;
  let campaign = typeof ev.campaign === 'string' && ev.campaign ? ev.campaign.slice(0, 64) : null;
  let contact = ev.contact !== undefined && ev.contact !== null && /^\d{1,15}$/.test(String(ev.contact)) ? Number(ev.contact) : null;
  // 事件可能比「帳本記下郵差 id」更早回來；帳本列在交郵差前就建好了，用去重鍵找得到。
  if (!msg && campaign && contact !== null) {
    msg = await db.prepare("SELECT id, to_email FROM messages WHERE dedupe_key = ? AND stream = 'marketing' LIMIT 1").bind(`c:${campaign}:${contact}`).first<{ id: number; to_email: string }>();
  }
  if (msg && (campaign === null || contact === null)) {
    const r = await db.prepare('SELECT campaign_id, contact_id FROM campaign_recipients WHERE message_id = ? LIMIT 1').bind(msg.id).first<{ campaign_id: string; contact_id: number }>();
    if (r) {
      campaign ??= r.campaign_id;
      contact ??= Number(r.contact_id);
    }
  }
  const email = (msg?.to_email ?? (typeof ev.email === 'string' ? ev.email : '')).trim().toLowerCase();
  const subtype = typeof ev.subtype === 'string' ? ev.subtype.slice(0, 64) : null;

  // 1. 帳本列的最後狀態（送達之後的開信、點擊不覆蓋）。
  const last = LAST_EVENT[ev.type];
  if (last && msg) await db.prepare('UPDATE messages SET last_event = ?, updated_at = ? WHERE id = ?').bind(last, now.toISOString(), msg.id).run();

  // 2. 退信／檢舉／送達的後續處理（進拒收名單等）。
  if (email && (ev.type === 'bounce' || ev.type === 'complaint' || ev.type === 'delivery')) {
    const source = `${ev.provider}-event`;
    const detail = ev.detail && typeof ev.detail === 'object' ? JSON.stringify(ev.detail).slice(0, 300) : null;
    const fb: FeedbackInput =
      ev.type === 'bounce'
        ? { type: 'bounce', kind: isPermanentBounce(subtype) ? 'permanent' : 'transient', email, campaign, source, detail: [subtype, detail].filter(Boolean).join(' ') || null }
        : ev.type === 'complaint'
          ? { type: 'complaint', email, source, detail }
          : { type: 'delivery', email };
    if (opts.feedback) await opts.feedback(fb);
    else await defaultFeedback(db, fb, now);
  }

  // 3. 最後才記這則事件（provider_event_id 唯一：同時兩則一樣的只會留一列）。
  await db
    .prepare(
      `INSERT INTO events (provider, provider_event_id, message_id, provider_message_id, campaign_id, contact_id, type, subtype, at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider_event_id) DO NOTHING`,
    )
    .bind(ev.provider, ev.providerEventId, msg?.id ?? null, ev.providerMessageId ? String(ev.providerMessageId).slice(0, 200) : null, campaign, contact, ev.type, subtype, at, ev.detail ? JSON.stringify(ev.detail).slice(0, 2000) : null)
    .run();
  return 'recorded';
}
