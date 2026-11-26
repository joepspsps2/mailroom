// Worker 端的接線：從環境變數組出群發要的東西（郵差、Queue、設定、個人化）。index.ts 只呼叫這裡的三個函式。

import { personalize } from '../compose/personalize.ts';
import type { ListDb } from '../lists.ts';
import type { CampaignRow } from './campaigns.ts';
import { consumeBatch, tick, type BroadcastDeps, type BroadcastMessage, type QueueMessageLike, type RecipientRow, type RenderResult } from './dispatch.ts';
import type { IngestOptions } from './events.ts';
import { FakePostman, type FakeRule, type Postman } from './postman.ts';

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
  /** 電子報的郵差：目前只有 "fake"（開發與演習用，不真的寄）。沒設＝群發關閉。 */
  NEWSLETTER_POSTMAN?: string;
  /** 假郵差設定（JSON）：{ "rules": [{ "match": "bounce", "outcome": "hard_bounce" }], "limits": { "perSecond": 1, "perDay": 200 } }。 */
  FAKE_POSTMAN?: string | Record<string, unknown>;
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
  if (env.NEWSLETTER_POSTMAN) console.error('unknown NEWSLETTER_POSTMAN, broadcasting disabled');
  return null;
}

/**
 * 預設的個人化：compose 的 personalize。退訂連結由 links 提供；沒提供＝丟例外（這期會被暫停，不寄出沒有退訂連結的信）。
 */
export function personalizeRender(links?: (c: CampaignRow, r: RecipientRow) => { unsubscribe_url: string; web_url: string; unsubscribe_mailto?: string | null } | null, track?: Parameters<typeof personalize>[2]) {
  return (c: CampaignRow, r: RecipientRow & { name: string | null }): RenderResult => {
    const l = links?.(c, r);
    if (!l) throw new Error('unsubscribe links not configured');
    let headers: Record<string, string> = {};
    try {
      headers = c.headers ? (JSON.parse(c.headers) as Record<string, string>) : {};
    } catch {
      throw new Error('bad campaign headers');
    }
    return personalize({ html: c.html, text: c.text, headers }, { name: r.name, email: r.email, ...l }, track);
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
    render: wiring.render ?? personalizeRender(),
    feedback: wiring.feedback,
    alert: wiring.alert ?? ((a) => (a.level === 'info' ? console.log : console.warn)('broadcast', a.level, a.code, a.campaign ?? '-', a.message)),
  };
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
