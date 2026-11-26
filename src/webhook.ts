// Resend 的事後回報（webhook）：退信、檢舉、送達。驗簽章（Svix／Standard Webhooks）後才處理。
// Resend 的 webhook 是整個帳號一份：同一個 Resend 帳號下其他程式寄的信也會回報到這裡，所以拒收名單是共用的一份。

import { type Db } from './core.ts';
import { applyFeedback } from './feedback.ts';

/** 簽章時間跟現在差超過 5 分鐘就不收（防重播）。 */
const TOLERANCE_S = 5 * 60;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** secret 是 Resend 給的 `whsec_<base64>`；header 是 svix-id／svix-timestamp／svix-signature（`v1,<b64> v1,<b64>`）。 */
export async function verifySignature(secret: string, id: string, timestamp: string, signature: string, body: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > TOLERANCE_S) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = b64ToBytes(secret.trim().replace(/^whsec_/, ''));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  for (const part of signature.split(' ').filter(Boolean)) {
    const [ver, sig] = part.split(',');
    if (ver !== 'v1' || !sig) continue;
    try {
      if (equal(b64ToBytes(sig), expected)) return true;
    } catch {
      /* 壞掉的那組跳過 */
    }
  }
  return false;
}

interface ResendEvent {
  type?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string; subType?: string; message?: string } };
}

const LAST_EVENT: Record<string, string> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.delivery_delayed': 'delayed',
};

/** 處理一則已驗過簽章的事件；回傳做了什麼（給 log／測試看）。 */
export async function handleEvent(db: Db, eventId: string, raw: string, now = new Date()): Promise<string> {
  let ev: ResendEvent;
  try {
    ev = JSON.parse(raw) as ResendEvent;
  } catch {
    return 'bad_json';
  }
  const type = String(ev.type ?? '');
  // 先查有沒有處理過；處理完才記「已處理」（中途出錯時郵差重送還會再處理一次）。下面每一步都可重複執行不出錯。
  const seen = await db.prepare('SELECT 1 AS x FROM webhook_events WHERE id = ?').bind(eventId).first();
  if (seen) return 'repeat';
  const outcome = await applyEvent(db, ev, now);
  await db.prepare('INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(eventId, type, now.toISOString()).run();
  return outcome;
}

async function applyEvent(db: Db, ev: ResendEvent, now: Date): Promise<string> {
  const type = String(ev.type ?? '');
  const data = ev.data ?? {};
  const recipients = (Array.isArray(data.to) ? data.to : data.to ? [data.to] : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const last = LAST_EVENT[type];
  if (last && data.email_id) {
    await db.prepare('UPDATE messages SET last_event = ?, updated_at = ? WHERE provider_id = ?').bind(last, now.toISOString(), data.email_id).run();
  }

  if (type === 'email.bounced') {
    // 只有永久退信（信箱不存在、網域收不到信）才進拒收名單；信箱滿了這類暫時性的不擋。
    if (data.bounce?.type !== 'Permanent') return `bounce_${String(data.bounce?.type ?? 'unknown').toLowerCase()}`;
    const detail = [data.bounce.subType, data.bounce.message].filter(Boolean).join(': ');
    for (const email of recipients) await applyFeedback(db, { type: 'bounce', kind: 'permanent', email, source: 'resend-webhook', detail: detail || null }, { now: () => now });
    return `hard_bounce:${recipients.length}`;
  }
  if (type === 'email.complained') {
    // 經過 applyFeedback：除了進拒收名單，也把這個人從所有電子報名單退訂。
    for (const email of recipients) await applyFeedback(db, { type: 'complaint', email, source: 'resend-webhook' }, { now: () => now });
    return `complaint:${recipients.length}`;
  }
  return last ? `event:${last}` : 'ignored';
}
