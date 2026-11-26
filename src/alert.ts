// 告警出口：讀者要求退訂卻沒退成時，把「誰、哪張券」送給人工。通用 webhook（POST JSON），不綁任何服務；網址與口令由設定注入。
// 不 import cloudflare:*。沒設網址時照樣把完整內容寫進 log（Worker 的 log 只有帳號擁有者看得到），並在啟動時警告。

export type AlertEvent = 'unsub_mail_no_token' | 'unsub_token_invalid' | 'unsub_write_failed';

export interface AlertConfig {
  /** 收告警的 webhook 網址（https）。沒設＝只寫 log。 */
  url?: string;
  /** 選填：以 `Authorization: Bearer …` 帶上，給需要口令的接收端。 */
  token?: string;
  fetch?: typeof fetch;
}

export interface AlertPayload {
  event: AlertEvent;
  /** 信封寄件人（收信退訂時才有）。 */
  from?: string;
  subject?: string | null;
  /** 完整退訂券（驗不過或寫入失敗時）；有了它人工才能判斷是誰。 */
  token?: string;
  via?: 'page' | 'mailto';
}

const SUMMARY: Record<AlertEvent, string> = {
  unsub_mail_no_token: 'Unsubscribe email without a token: a person must handle it',
  unsub_token_invalid: 'Unsubscribe token failed verification: the reader may still be subscribed',
  unsub_write_failed: 'Unsubscribe email received but the database write failed: apply it by hand',
};

/** 送告警。永遠不丟錯；回傳有沒有送出。 */
export async function sendAlert(cfg: AlertConfig, payload: AlertPayload, now: () => Date = () => new Date()): Promise<boolean> {
  const body = { ...payload, at: now().toISOString(), text: `${SUMMARY[payload.event]}${payload.from ? ` (from ${payload.from})` : ''}`, content: '' };
  body.content = body.text;
  // 完整內容一律進 log，不管 webhook 有沒有設／成不成功。
  console.error('unsub alert', JSON.stringify(body));
  if (!cfg.url) return false;
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
export function resetAlertWarning(): void { warned = false; }
