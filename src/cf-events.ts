// Cloudflare 寄信的事後回報：Cloudflare 把寄件網域的送達／退信／檢舉事件放進 Queue
// （官方 event-subscriptions，來源 Email Sending，每個寄件網域一份訂閱），郵務室當消費者讀進來。
// 跟 Resend 的 webhook 進同一份拒收名單、同一張帳本（messages.provider_id＝Cloudflare 回的 messageId）。
// 文件：https://developers.cloudflare.com/email-service/reference/event-subscriptions/（2026-11-04 查）

import { type Db } from './core.ts';
import { applyFeedback } from './feedback.ts';

interface CfEmailEvent {
  type?: string;
  source?: { type?: string; domain?: string };
  payload?: {
    eventId?: string;
    messageId?: string;
    recipient?: string;
    terminal?: boolean;
    delivery?: { status?: string; smtpStatusCode?: string; smtpResponse?: string };
    bounce?: { type?: string; classification?: string; reason?: string };
    failure?: { reason?: string };
    rejection?: { reason?: string; party?: string; detail?: string };
    complaint?: { type?: string };
  };
  metadata?: { eventTimestamp?: string };
}

const PREFIX = 'cf.email.sending.message.';
/** 事件 → 帳本 last_event（跟 Resend 那邊同一套字）。 */
const LAST_EVENT: Record<string, string> = {
  delivered: 'delivered',
  deferred: 'delayed',
  bounced: 'bounced',
  failed: 'failed',
  rejected: 'rejected',
  complained: 'complained',
};

/** 處理一則 Cloudflare 寄信事件；回傳做了什麼（給 log／測試看）。同一則事件（eventId）只處理一次。 */
export async function handleCfEvent(db: Db, raw: unknown, now = new Date()): Promise<string> {
  const ev = (typeof raw === 'string' ? safeParse(raw) : raw) as CfEmailEvent | null;
  if (!ev || typeof ev !== 'object') return 'bad_event';
  const type = String(ev.type ?? '');
  if (ev.source?.type !== 'email.sending' || !type.startsWith(PREFIX)) return 'ignored';
  const name = type.slice(PREFIX.length);
  const p = ev.payload ?? {};
  const eventKey = `cf:${p.eventId || `${p.messageId ?? '-'}:${name}:${ev.metadata?.eventTimestamp ?? ''}`}`;
  // 先查有沒有處理過；處理完才記「已處理」（中途出錯時郵差重送還會再處理一次）。下面每一步都可重複執行不出錯。
  const seen = await db.prepare('SELECT 1 AS x FROM webhook_events WHERE id = ?').bind(eventKey).first();
  if (seen) return 'repeat';
  const outcome = await applyEvent(db, ev, name, now);
  await db.prepare('INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(eventKey, type, now.toISOString()).run();
  return outcome;
}

async function applyEvent(db: Db, ev: CfEmailEvent, name: string, now: Date): Promise<string> {
  const p = ev.payload ?? {};

  const last = LAST_EVENT[name];
  if (last && p.messageId) {
    await db.prepare("UPDATE messages SET last_event = ?, updated_at = ? WHERE provider_id = ? AND route = 'cloudflare'").bind(last, now.toISOString(), p.messageId).run();
  }
  const email = String(p.recipient ?? '').trim().toLowerCase();

  if (name === 'bounced') {
    // 只有硬退信（信箱不存在、網域收不到）才進拒收名單；暫時性重試用完的 soft 不擋。
    if (p.bounce?.type !== 'hard' || !email) return `bounce_${String(p.bounce?.type ?? 'unknown').toLowerCase()}`;
    const detail = [p.bounce.classification, p.bounce.reason, p.delivery?.smtpStatusCode].filter(Boolean).join(': ');
    await applyFeedback(db, { type: 'bounce', kind: 'permanent', email, source: 'cloudflare-event', detail: detail || null }, { now: () => now });
    return 'hard_bounce:1';
  }
  if (name === 'complained') {
    if (!email) return 'complaint:0';
    await applyFeedback(db, { type: 'complaint', email, source: 'cloudflare-event', detail: p.complaint?.type ?? null }, { now: () => now });
    return 'complaint:1';
  }
  return last ? `event:${last}` : 'ignored';
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
