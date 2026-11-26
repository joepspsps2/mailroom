// 告警出口：讀者要求退訂卻沒退成時，把「誰、哪張券」送給人工。通用 webhook（POST JSON），不綁任何服務；網址與口令由設定注入。
// 不 import cloudflare:*。沒設網址時照樣把內容寫進 log（Worker 的 log 只有帳號擁有者看得到；完整券不進 log），並在啟動時警告。

export type AlertEvent = 'unsub_mail_no_token' | 'unsub_token_invalid' | 'unsub_write_failed' | 'unsub_alerts_suppressed';

export interface AlertConfig {
  /** 收告警的 webhook 網址（https）。沒設＝只寫 log。 */
  url?: string;
  /** 選填：以 `Authorization: Bearer …` 帶上，給需要口令的接收端。 */
  token?: string;
  fetch?: typeof fetch;
}

/** 收件端（人、聊天頻道）看到的欄位：去掉控制字元（含換行）、截長，免得外人寄來的字串在告警裡搞出假內容。 */
const clean = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, max) : undefined;

/** 同一個 isolate 一分鐘最多送幾則告警（超過只寫 log）：沒有人能靠亂打網址把告警頻道灌爆。 */
const MAX_ALERTS_PER_MIN = 20;
/** 網頁亂打（任何人都能送）與信件（要寄信、較難灌）各有自己的額度，網頁灌爆不會擠掉真正的退訂信告警。 */
/** suppressed＝這個時間窗被額度壓掉幾則（窗結束時補送一則彙總，人才知道中間漏看了多少）。 */
const budgets: Record<'page' | 'mail', { start: number; count: number; max: number; suppressed: number }> = {
  page: { start: 0, count: 0, max: MAX_ALERTS_PER_MIN, suppressed: 0 },
  mail: { start: 0, count: 0, max: 60, suppressed: 0 },
};
/** 寫入失敗＝有人退訂卻沒退成，不受額度限制（漏掉一則就可能寄信給已經要求退訂的人）。 */
const UNLIMITED: ReadonlySet<AlertEvent> = new Set(['unsub_write_failed']);

export interface AlertPayload {
  event: AlertEvent;
  /** 信封寄件人（收信退訂時才有）。 */
  from?: string;
  subject?: string | null;
  /** 完整退訂券（驗不過或寫入失敗時）；有了它人工才能判斷是誰。 */
  token?: string;
  /** 券裡讀得出的名單與聯絡人編號（形狀對才有）；不用完整券也足以人工處理。 */
  claims?: { list: string; contactId: number; campaign?: string | null };
  via?: 'page' | 'mailto';
  /** 彙總告警用：壓掉幾則。 */
  suppressed?: number;
}

const SUMMARY: Record<AlertEvent, string> = {
  unsub_mail_no_token: 'Unsubscribe email without a token: a person must handle it',
  unsub_token_invalid: 'Unsubscribe token failed verification: the reader may still be subscribed',
  unsub_write_failed: 'Unsubscribe email received but the database write failed: apply it by hand',
  unsub_alerts_suppressed: 'Some unsubscribe alerts were dropped by the rate limit; check the logs',
};

/** 送告警。永遠不丟錯；回傳有沒有送出。 */
export async function sendAlert(cfg: AlertConfig, payload: AlertPayload, now: () => Date = () => new Date()): Promise<boolean> {
  const at = now();
  const from = clean(payload.from, 320);
  const body = {
    event: payload.event, at: at.toISOString(), suppressed: payload.suppressed, via: payload.via, from, subject: payload.subject === null ? null : clean(payload.subject, 200),
    token: clean(payload.token, 200), claims: payload.claims, text: `${SUMMARY[payload.event]}${from ? ` (from ${from})` : ''}`, content: '',
  };
  body.content = body.text;
  // log 不放完整券（它能替那個人退訂）：只放券前 8 字與讀得出的名單／聯絡人編號，足夠人工處理；完整券只走有口令的 webhook。
  // 主旨裡通常就是那張券（有時還被編碼過），有券時 log 不放主旨。
  const short = body.token ? `${body.token.slice(0, 8)}…` : undefined;
  const redacted = { ...body, token: short, subject: body.token && body.subject ? '[subject carries the token]' : body.subject };
  console.error('unsub alert', JSON.stringify(redacted));
  if (!cfg.url) return false;
  const budget = budgets[payload.via === 'page' ? 'page' : 'mail'];
  if (at.getTime() - budget.start >= 60_000) {
    // 新的時間窗開始：上一窗有被壓掉的，先補送一則彙總。
    await flushSuppressedAlerts(cfg, () => at);
    budget.start = at.getTime();
    budget.count = 0;
  }
  if (!UNLIMITED.has(payload.event) && ++budget.count > budget.max) {
    budget.suppressed++;
    console.error('unsub alert rate limited', payload.via ?? 'mail');
    return false;
  }
  if (!/^https:\/\/[^\s]+$/i.test(cfg.url)) {
    console.error('unsub alert webhook must be https');
    return false;
  }
  try {
    const res = await (cfg.fetch ?? fetch)(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error('unsub alert webhook status', res.status);
    return res.ok;
  } catch (e) {
    console.error('unsub alert webhook failed', e instanceof Error ? e.message : 'unknown');
    return false;
  }
}

/**
 * 時間窗已過、而且上一窗有告警被額度壓掉：補送一則「壓掉 N 則」。沒有被壓掉的就什麼都不做。
 * 排程每分鐘也可以呼叫（沒有後續告警進來時，彙總才不會一直等不到下一則）。回傳補送了幾則彙總。
 */
export async function flushSuppressedAlerts(cfg: AlertConfig, now: () => Date = () => new Date()): Promise<number> {
  const at = now().getTime();
  let sent = 0;
  for (const [name, b] of Object.entries(budgets) as ['page' | 'mail', (typeof budgets)['page']][]) {
    if (b.suppressed === 0 || at - b.start < 60_000) continue;
    const n = b.suppressed;
    b.suppressed = 0;
    if (await sendAlert(cfg, { event: 'unsub_alerts_suppressed', via: name === 'page' ? 'page' : 'mailto', suppressed: n }, now)) sent++;
  }
  return sent;
}

let warned = false;
/** 沒設告警網址時警告一次（每個 isolate 一次）；回傳是否有設。 */
export function warnIfNoAlert(url: string | undefined): boolean {
  if (url) return true;
  if (!warned) {
    warned = true;
    console.warn('UNSUB_ALERT_WEBHOOK is not set: unsubscribe requests that fail will only appear in the logs');
  }
  return false;
}
/** 測試用：重置一次性警告。 */
export function resetAlertWarning(): void { warned = false; for (const b of Object.values(budgets)) { b.start = 0; b.count = 0; b.suppressed = 0; } }
