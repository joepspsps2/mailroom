// Worker 端的接線：從環境變數組出群發要的東西（郵差、Queue、設定、個人化）。index.ts 只呼叫這裡的三個函式。

import { personalize } from '../compose/personalize.ts';
import { unsubscribeLinks, unsubSecrets } from '../unsub.ts';
import type { ListDb } from '../lists.ts';
import type { CampaignRow } from './campaigns.ts';
import { consumeBatch, tick, type BroadcastDeps, type BroadcastMessage, type QueueMessageLike, type RecipientRow, type RenderResult } from './dispatch.ts';
import type { IngestOptions } from './events.ts';
import { FakePostman, type FakeRule, type Postman } from './postman.ts';
import { parseAllowed, type TestSendDeps } from './test-send.ts';
import { SesPostman } from './ses.ts';

export interface BroadcastEnv {
  DB: D1Database;
  /** 電子報的寄件網域（例 mail.example.com）。沒設＝群發整個關閉。 */
  MARKETING_DOMAIN?: string;
  /** 群發 Queue 的 producer 綁定。 */
  BROADCAST?: Queue<BroadcastMessage>;
  /** 群發 Queue 的名字（consumer 收到的 batch.queue），預設 mailroom-broadcast。 */
  BROADCAST_QUEUE_NAME?: string;
  /** 群發設定（JSON，只寫想改的欄位，見 docs/broadcast.md）。 */
  BROADCAST_CONFIG?: string | Record<string, unknown>;
  /** 自己的每日上限（覆寫 BROADCAST_CONFIG 的 maxPerDay）。 */
  NEWSLETTER_MAX_PER_DAY?: string | number;
  /** 電子報的郵差："ses"（Amazon SES）或 "fake"（開發與演習用，不真的寄）。沒設＝群發關閉。 */
  NEWSLETTER_POSTMAN?: string;
  /** SES 地區（例 us-east-1）。郵差與事件入口共用。 */
  SES_REGION?: string;
  /** SES 寄信鑰匙（Secret）：IAM 只給 ses:SendEmail 與 ses:GetAccount。 */
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  /** SES 設定組（事件發布到 SNS）。 */
  SES_CONFIGURATION_SET?: string;
  /** 假郵差設定（JSON）：{ "rules": [{ "match": "bounce", "outcome": "hard_bounce" }], "limits": { "perSecond": 1, "perDay": 200 } }。 */
  FAKE_POSTMAN?: string | Record<string, unknown>;
  /** 退訂券（與退訂模組共用）：每封信的退訂連結與一鍵退訂標頭靠它們產生；沒設＝每期都會因 render_error 暫停。 */
  UNSUB_TOKEN_SECRET?: string;
  UNSUB_TOKEN_SECRET_PREVIOUS?: string;
  UNSUB_BASE_URL?: string;
  UNSUB_MAILTO?: string;
  /** 允許收測試信的內部信箱（JSON 陣列或逗號分隔）。沒設＝測試信功能關閉。 */
  TEST_RECIPIENTS?: string | string[];
}

export const DEFAULT_BROADCAST_QUEUE = 'mailroom-broadcast';

function jsonObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const p = JSON.parse(v);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    console.error('bad broadcast json var');
    return {};
  }
}

function postmanFor(env: BroadcastEnv): Postman | null {
  if (env.NEWSLETTER_POSTMAN === 'fake') {
    const cfg = jsonObject(env.FAKE_POSTMAN);
    const rules = Array.isArray(cfg.rules) ? (cfg.rules as FakeRule[]).filter((r) => r && typeof r.match === 'string' && typeof r.outcome === 'string') : [];
    return new FakePostman({
      rules,
      limits: jsonObject(cfg.limits) as never,
      // 假事件丟回同一個 Queue，延遲幾秒回來（模擬郵差的事後回報）。
      emit: async (event, delayMs) => {
        await env.BROADCAST?.send({ kind: 'event', event }, { delaySeconds: Math.max(1, Math.min(43_200, Math.ceil(delayMs / 1000))) });
      },
    });
  }
  if (env.NEWSLETTER_POSTMAN === 'ses') {
    if (!env.SES_REGION || !env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY || !env.SES_CONFIGURATION_SET) {
      console.error('ses postman needs SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_CONFIGURATION_SET; broadcasting disabled');
      return null;
    }
    try {
      return new SesPostman({
        region: env.SES_REGION,
        credentials: { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY },
        configurationSet: env.SES_CONFIGURATION_SET,
      });
    } catch (e) {
      console.error('ses postman config error, broadcasting disabled', e instanceof Error ? e.message : 'unknown');
      return null;
    }
  }
  if (env.NEWSLETTER_POSTMAN) console.error('unknown NEWSLETTER_POSTMAN, broadcasting disabled');
  return null;
}

type Links = { unsubscribe_url: string; unsubscribe_mailto?: string | null };

/**
 * 預設的個人化：compose 的 personalize（{{name}} {{email}} {{unsubscribe_url}} {{unsubscribe_mailto}} {{web_url}}，標頭一起填）。
 * 退訂連結由 links 提供；拿不到＝丟例外（這期會被暫停，不寄出沒有退訂連結的信）。
 */
export function personalizeRender(links?: (c: CampaignRow, r: RecipientRow) => Links | null | Promise<Links | null>, track?: Parameters<typeof personalize>[2]) {
  return async (c: CampaignRow, r: RecipientRow & { name: string | null }): Promise<RenderResult> => {
    const l = await links?.(c, r);
    if (!l) throw new Error('unsubscribe links not configured');
    if (!c.web_url) throw new Error('campaign has no web_url');
    let headers: Record<string, string> = {};
    try {
      headers = c.headers ? (JSON.parse(c.headers) as Record<string, string>) : {};
    } catch {
      throw new Error('bad campaign headers');
    }
    return personalize({ html: c.html, text: c.text, headers }, { name: r.name, email: r.email, web_url: c.web_url, ...l }, track);
  };
}

/** 退訂券產生的連結（每位收件人一張券，綁名單、聯絡人、期別）。 */
export function unsubLinksFromEnv(env: BroadcastEnv) {
  return async (c: CampaignRow, r: RecipientRow): Promise<Links | null> => {
    const secrets = unsubSecrets(env.UNSUB_TOKEN_SECRET, env.UNSUB_TOKEN_SECRET_PREVIOUS);
    if (!secrets.length || !env.UNSUB_BASE_URL) return null;
    const l = await unsubscribeLinks(secrets, { baseUrl: env.UNSUB_BASE_URL, mailtoAddress: env.UNSUB_MAILTO }, { list: c.list_id, contactId: r.contact_id, campaign: c.id });
    return { unsubscribe_url: l.url, unsubscribe_mailto: l.mailto };
  };
}

export interface BroadcastWiring {
  render?: BroadcastDeps['render'];
  feedback?: IngestOptions['feedback'];
  alert?: BroadcastDeps['alert'];
}

export function broadcastDeps(env: BroadcastEnv, wiring: BroadcastWiring = {}): BroadcastDeps | null {
  if (!env.MARKETING_DOMAIN || !env.BROADCAST) return null;
  const postman = postmanFor(env);
  if (!postman) return null;
  const config = jsonObject(env.BROADCAST_CONFIG);
  if (env.NEWSLETTER_MAX_PER_DAY !== undefined && env.NEWSLETTER_MAX_PER_DAY !== '') config.maxPerDay = env.NEWSLETTER_MAX_PER_DAY;
  return {
    db: env.DB as unknown as ListDb,
    postman,
    domain: env.MARKETING_DOMAIN.toLowerCase(),
    queue: env.BROADCAST as unknown as BroadcastDeps['queue'],
    config,
    render: wiring.render ?? personalizeRender(unsubLinksFromEnv(env)),
    feedback: wiring.feedback,
    alert: wiring.alert ?? ((a) => (a.level === 'info' ? console.log : console.warn)('broadcast', a.level, a.code, a.campaign ?? '-', a.message)),
  };
}

/** 管理入口的測試信設定（郵差、個人化、白名單）。群發沒開＝undefined。 */
export function testSendDeps(env: BroadcastEnv, wiring: BroadcastWiring = {}): Omit<TestSendDeps, 'domain' | 'now'> | undefined {
  const d = broadcastDeps(env, wiring);
  return d ? { postman: d.postman, render: d.render, allowed: parseAllowed(env.TEST_RECIPIENTS) } : undefined;
}

/** 排程每分鐘呼叫。沒設定群發就什麼都不做。 */
export async function broadcastTick(env: BroadcastEnv, wiring?: BroadcastWiring): Promise<void> {
  const deps = broadcastDeps(env, wiring);
  if (!deps) return;
  const r = await tick(deps);
  const released = Object.values(r.released).reduce((a, b) => a + b, 0);
  if (released || r.started.length || r.paused.length || r.finished.length) {
    console.log('broadcast tick', JSON.stringify({ started: r.started, released, paused: r.paused, finished: r.finished }));
  }
}

/** 這一批是不是群發 Queue 的。 */
export function isBroadcastBatch(env: BroadcastEnv, queueName: string): boolean {
  return queueName === (env.BROADCAST_QUEUE_NAME || DEFAULT_BROADCAST_QUEUE);
}

export async function broadcastQueue(env: BroadcastEnv, messages: readonly QueueMessageLike[], wiring?: BroadcastWiring): Promise<void> {
  const deps = broadcastDeps(env, wiring);
  if (!deps) {
    // 群發關掉了：訊息留著（重送），不要默默丟掉。
    for (const m of messages) m.retry({ delaySeconds: 300 });
    return;
  }
  await consumeBatch(deps, messages);
}
