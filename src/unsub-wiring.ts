// 把設定（Env）接到退訂模組：端點設定、收信退訂的處理。不 import cloudflare:*，測試可以直接呼叫。

import { type Db } from './core.ts';
import { sendAlert, warnIfNoAlert, type AlertConfig } from './alert.ts';
import { handleUnsubMail, pageText, unsubSecrets, unsubTokenShape, type UnsubHandlerConfig, type UnsubMailOutcome } from './unsub.ts';

export interface UnsubEnv {
  UNSUB_TOKEN_SECRET?: string;
  UNSUB_TOKEN_SECRET_PREVIOUS?: string;
  UNSUB_PAGE?: string | Record<string, unknown>;
  /** 告警 webhook（https，POST JSON）。沒設＝只寫 log，並在啟動時警告。 */
  UNSUB_ALERT_WEBHOOK?: string;
  /** 選填：告警 webhook 的 Bearer 口令（Secret）。 */
  UNSUB_ALERT_TOKEN?: string;
}

export function unsubConfig(env: UnsubEnv, fetchFn?: typeof fetch): UnsubHandlerConfig {
  warnIfNoAlert(env.UNSUB_ALERT_WEBHOOK);
  const alert: AlertConfig = { url: env.UNSUB_ALERT_WEBHOOK, token: env.UNSUB_ALERT_TOKEN, fetch: fetchFn };
  return {
    secrets: unsubSecrets(env.UNSUB_TOKEN_SECRET, env.UNSUB_TOKEN_SECRET_PREVIOUS),
    text: pageText(env.UNSUB_PAGE as string | undefined),
    // 券驗不過：讀者想退訂卻沒成，送完整券給人工。
    // 網頁上亂打的網址（形狀就不對）不告警，只留 log；形狀對但簽章不對、或是收信退訂（人刻意寄的）才送。
    onInvalidToken: async (token, via, ctx) => {
      const shape = unsubTokenShape(token);
      if (via === 'page' && !shape) return void console.warn('unsub page token malformed', token.slice(0, 8));
      await sendAlert(alert, { event: 'unsub_token_invalid', token, via, from: ctx?.from, subject: ctx?.subject, claims: shape ? { list: shape.list, contactId: shape.contactId, campaign: shape.campaign } : undefined });
    },
    onWriteFailed: async ({ token, claims, from }) => void (await sendAlert(alert, { event: 'unsub_write_failed', token, from, via: 'mailto', claims })),
  };
}

/** Cloudflare email() 收進來的信的最小形狀。 */
export interface InboundMail {
  from: string;
  headers: { get(name: string): string | null };
  setReject(reason: string): void;
}

export const WRITE_FAILED_REJECT = 'Temporary problem: your unsubscribe request was not processed. Please use the unsubscribe link in the email instead.';

/**
 * 收退訂信：主旨帶券就退訂。三種沒退成的情況都通知人工（告警 webhook，沒設就只有 log）：
 * 沒帶券、券驗不過、資料庫寫入失敗。寫入失敗時另外退信給寄件人（setReject，永久性 SMTP 拒收），讓讀者知道沒成功、改用連結。
 * 為什麼是 setReject 不是 throw：官方文件只明寫 setReject 是永久性 SMTP 拒收，沒寫 email() 丟錯時寄件端看到什麼，所以選有文件依據的做法。
 */
export async function handleEmailMessage(db: Db, env: UnsubEnv, message: InboundMail, fetchFn?: typeof fetch): Promise<UnsubMailOutcome> {
  const cfg = unsubConfig(env, fetchFn);
  const alert: AlertConfig = { url: env.UNSUB_ALERT_WEBHOOK, token: env.UNSUB_ALERT_TOKEN, fetch: fetchFn };
  const outcome = await handleUnsubMail(
    db,
    { ...cfg, onNoToken: async (m) => void (await sendAlert(alert, { event: 'unsub_mail_no_token', from: m.from, subject: m.subject ?? null, via: 'mailto' })) },
    { from: message.from, subject: message.headers.get('subject') },
  );
  if (outcome === 'failed') message.setReject(WRITE_FAILED_REJECT);
  console.log('unsubscribe mail', outcome);
  return outcome;
}
