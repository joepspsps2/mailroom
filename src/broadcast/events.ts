// 郵差事件進來的唯一入口：正規化後的 ProviderEvent → events 表＋帳本 last_event＋（可注入的）退信／檢舉處理。
// 假郵差、之後的 SES（SNS 驗簽後）都呼叫 ingestEvent。同一則事件（provider_event_id）重送只處理一次。

import type { Db } from '../core.ts';
import { applyFeedback, type FeedbackEvent } from '../feedback.ts';
import { listUnsubscribe } from '../lists.ts';
import { EVENT_TYPES, type ProviderEvent } from './postman.ts';

/** 交給「退信／檢舉怎麼進拒收」那一層的事件（＝退訂模組 feedback.ts 的 FeedbackEvent）。 */
export type FeedbackInput = FeedbackEvent;

export interface IngestOptions {
  /** 退信／檢舉／送達的後續處理。沒給＝預設 applyFeedback（永久退信與檢舉進拒收、檢舉者全部名單退訂、連續暫時退信升級）。 */
  feedback?: (fb: FeedbackInput) => Promise<unknown>;
  now?: () => Date;
}

export type IngestOutcome = 'recorded' | 'repeat' | 'rejected';

const LAST_EVENT: Partial<Record<string, string>> = { delivery: 'delivered', bounce: 'bounced', complaint: 'complained', reject: 'failed', delay: 'delayed' };
const ID = /^[\x21-\x7e]{1,200}$/;

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
  // 事件自己有說是哪個地址、卻跟帳本列的收件人不同 → 那一列不是這則事件的（不能把別人的退信算到這位讀者頭上）。
  const evEmail = typeof ev.email === 'string' ? ev.email.trim().toLowerCase() : '';
  if (msg && evEmail && msg.to_email.trim().toLowerCase() !== evEmail) {
    msg = null;
    campaign = null;
    contact = null;
  }
  const email = (msg?.to_email ?? evEmail).trim().toLowerCase();
  const subtype = typeof ev.subtype === 'string' ? ev.subtype.slice(0, 64) : null;

  // 1. 帳本列的最後狀態（送達之後的開信、點擊不覆蓋）。
  const last = LAST_EVENT[ev.type];
  if (last && msg) await db.prepare('UPDATE messages SET last_event = ?, updated_at = ? WHERE id = ?').bind(last, now.toISOString(), msg.id).run();

  // 2. 退信／檢舉／送達的後續處理（進拒收名單等）。
  // 測試信（tags.contact＝test）：事件照記，但不進拒收名單、不退訂任何人（測試信箱被標垃圾信不該影響名單）；統計只算凍結名單裡的人，本來就不含它。
  const isTest = ev.contact === 'test';
  if (!isTest && email && !ev.skipFeedback && (ev.type === 'bounce' || ev.type === 'complaint' || ev.type === 'delivery')) {
    const source = `${ev.provider}-event`;
    const detail = ev.detail && typeof ev.detail === 'object' ? JSON.stringify(ev.detail).slice(0, 300) : null;
    const fb: FeedbackInput =
      ev.type === 'bounce'
        ? isPermanentBounce(subtype)
          ? { type: 'bounce', kind: 'permanent', email, source, detail: [subtype, detail].filter(Boolean).join(' ') || null }
          : {
              type: 'bounce', kind: 'transient', email, campaign, source, detail: [subtype, detail].filter(Boolean).join(' ') || null,
              // 只有郵差層明說是信箱層級（mailbox）或內容（content）才帶；其他（一般性、無法判定）不帶＝不累計。
              ...(ev.cause === 'mailbox' || ev.cause === 'content' ? { cause: ev.cause } : {}),
            }
        : ev.type === 'complaint'
          ? { type: 'complaint', email, source, detail }
          : { type: 'delivery', email };
    if (opts.feedback) await opts.feedback(fb);
    else await applyFeedback(db, fb, { now: () => now });
  }

  // 3. 郵差那邊回報的退訂（例：信箱商的退訂按鈕經郵差轉來）：退這一期所屬的名單。對不到期別就只記事件。
  if (!isTest && email && ev.type === 'unsubscribe' && campaign) {
    const c = await db.prepare('SELECT list_id FROM campaigns WHERE id = ?').bind(campaign).first<{ list_id: string }>();
    if (c) await listUnsubscribe(db, { list: c.list_id, email, source: 'api' }, () => now);
  }

  // 4. 最後才記這則事件（provider_event_id 唯一：同時兩則一樣的只會留一列）。
  await db
    .prepare(
      `INSERT INTO events (provider, provider_event_id, message_id, provider_message_id, campaign_id, contact_id, type, subtype, at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider_event_id) DO NOTHING`,
    )
    .bind(ev.provider, ev.providerEventId, msg?.id ?? null, ev.providerMessageId ? String(ev.providerMessageId).slice(0, 200) : null, campaign, contact, ev.type, subtype, at, ev.detail ? JSON.stringify(ev.detail).slice(0, 2000) : null)
    .run();
  return 'recorded';
}
