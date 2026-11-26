// 電子報的郵差介面＋內建假郵差。
//
// 郵差只做兩件事：送一封（回結果）、報上限（每秒、每天、健康狀態）。換郵差＝換一個實作這個介面的物件；
// 引擎不做自動切換（一個郵差出事多半是名單或內容的問題，自動換只會把問題帶到第二個帳號）。
//
// 送一封的結果一定要分清楚「確定沒寄出」與「不知道」：
// - temporary／permanent／throttled／account_paused＝郵差明確說沒收下（引擎可以安全地再試或停下）。
// - 丟例外＝不知道有沒有寄出 → 引擎把那一位記成 uncertain、絕不自動重寄（寧可漏一封也不寄兩封）。

export type EventType = 'send' | 'delivery' | 'bounce' | 'complaint' | 'reject' | 'delay' | 'open' | 'click' | 'unsubscribe';
export const EVENT_TYPES: readonly EventType[] = ['send', 'delivery', 'bounce', 'complaint', 'reject', 'delay', 'open', 'click', 'unsubscribe'];

export interface PostmanMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** 帶回事件用：事件回來時靠它對到期別與收件人（SES 的 EmailTags、其他郵差的 metadata）。 */
  tags: { campaign: string; contact: string };
  /** 同一封信的固定識別（站名/去重鍵）；支援冪等鍵的郵差拿它防重寄。 */
  idempotencyKey: string;
}

export type PostmanOutcome =
  | { ok: true; providerId: string }
  | { ok: false; kind: 'temporary' | 'permanent' | 'throttled' | 'account_paused'; error: string };

export interface PostmanLimits {
  /** 每秒最多幾封。 */
  perSecond: number;
  /** 24 小時最多幾封。 */
  perDay: number;
  /** 郵差說最近 24 小時已用幾封（沒有就不填）。 */
  sentLast24h?: number;
  /** 帳號健康狀態；不是 HEALTHY 就踩煞車。 */
  enforcement: string;
}

export interface Postman {
  readonly name: string;
  send(mail: PostmanMail): Promise<PostmanOutcome>;
  limits(): Promise<PostmanLimits>;
}

/** 郵差的事後回報，正規化之後的樣子（SES 的 SNS 事件、假郵差都轉成這個再交給 ingestEvent）。 */
export interface ProviderEvent {
  provider: string;
  /** 同一則事件重送時不變（SES 用 SNS MessageId；假郵差自己編）。 */
  providerEventId: string;
  /** 郵差那邊的信件 id（對到 messages.provider_id）。 */
  providerMessageId?: string | null;
  type: EventType;
  /** bounce 用：Permanent／Transient／Undetermined。 */
  subtype?: string | null;
  at: string;
  email?: string | null;
  campaign?: string | null;
  contact?: string | null;
  detail?: Record<string, unknown> | null;
}

// ---------- 假郵差 ----------

export type FakeOutcome =
  | 'success' // 送出＋送達
  | 'hard_bounce' // 送出＋永久退信
  | 'soft_bounce' // 送出＋暫時退信
  | 'complaint' // 送出＋送達＋檢舉
  | 'delay' // 送出＋延遲＋（之後）送達
  | 'suppressed' // 送出＋永久退信（郵差自己的拒收名單）
  | 'temporary' // 郵差回暫時失敗（沒收下）
  | 'permanent' // 郵差回永久失敗（沒收下）
  | 'throttle' // 郵差回限流（沒收下）
  | 'account_paused' // 郵差說帳號被停（沒收下）
  | 'crash'; // 郵差丟例外（不知道有沒有寄出）

export interface FakeRule {
  /** 比對收件地址：字串＝@ 前面那段完全相同（不分大小寫）或以「字串+」開頭；正規式＝整個地址。 */
  match: string | RegExp;
  outcome: FakeOutcome;
  /** 只套用前幾次（例：前 2 次限流，之後照下一條規則）。 */
  times?: number;
}

export interface FakePostmanOptions {
  rules?: FakeRule[];
  limits?: Partial<PostmanLimits>;
  /** 事件交給誰（Worker：丟進 Queue 延遲送回；測試：收進陣列）。delayMs＝模擬幾秒後才回來。 */
  emit?: (event: ProviderEvent, delayMs: number) => void | Promise<void>;
  /** 每種事件延遲幾毫秒（模擬「退信幾分鐘內回來、檢舉晚很多」）。 */
  delays?: Partial<Record<EventType, number>>;
  now?: () => Date;
  name?: string;
}

/**
 * 模擬信箱：照 SES 信箱模擬器的地址（success@／bounce@／complaint@／ooto@／suppressionlist@ 開頭）決定結果；
 * 其他地址一律成功。另外可用 rules 指定任何地址的結果（暫時失敗、限流、帳號被停、延遲、丟例外…）。
 */
export const SIMULATOR_RULES: readonly FakeRule[] = [
  { match: 'success', outcome: 'success' },
  { match: 'bounce', outcome: 'hard_bounce' },
  { match: 'complaint', outcome: 'complaint' },
  { match: 'ooto', outcome: 'success' },
  { match: 'suppressionlist', outcome: 'suppressed' },
];

const DEFAULT_DELAYS: Record<EventType, number> = {
  send: 0, delivery: 2_000, bounce: 3_000, complaint: 5_000, reject: 0, delay: 1_000, open: 60_000, click: 90_000, unsubscribe: 0,
};

function matches(rule: FakeRule, to: string): boolean {
  if (rule.match instanceof RegExp) return rule.match.test(to);
  const local = to.split('@')[0].toLowerCase();
  const m = rule.match.toLowerCase();
  return local === m || local.startsWith(`${m}+`);
}

export class FakePostman implements Postman {
  readonly name: string;
  /** 每一次「確實收下」的信（測試用來數同一人收到幾封）。 */
  readonly accepted: PostmanMail[] = [];
  /** 每一次呼叫（含被拒的）。 */
  readonly calls: { to: string; outcome: FakeOutcome }[] = [];
  private readonly rules: FakeRule[];
  private readonly used = new Map<FakeRule, number>();
  private seq = 0;
  private limitValues: PostmanLimits;
  private readonly opts: FakePostmanOptions;

  constructor(opts: FakePostmanOptions = {}) {
    this.opts = opts;
    this.name = opts.name ?? 'fake';
    this.rules = [...(opts.rules ?? []), ...SIMULATOR_RULES];
    this.limitValues = { perSecond: 14, perDay: 50_000, enforcement: 'HEALTHY', ...opts.limits };
  }

  /** 測試中途改上限或健康狀態。 */
  setLimits(l: Partial<PostmanLimits>): void {
    this.limitValues = { ...this.limitValues, ...l };
  }

  async limits(): Promise<PostmanLimits> {
    return { ...this.limitValues, sentLast24h: this.limitValues.sentLast24h };
  }

  outcomeFor(to: string): FakeOutcome {
    for (const rule of this.rules) {
      if (!matches(rule, to)) continue;
      if (rule.times !== undefined) {
        const n = this.used.get(rule) ?? 0;
        if (n >= rule.times) continue;
        this.used.set(rule, n + 1);
      }
      return rule.outcome;
    }
    return 'success';
  }

  async send(mail: PostmanMail): Promise<PostmanOutcome> {
    const outcome = this.outcomeFor(mail.to);
    this.calls.push({ to: mail.to, outcome });
    switch (outcome) {
      case 'temporary':
        return { ok: false, kind: 'temporary', error: 'fake temporary failure' };
      case 'permanent':
        return { ok: false, kind: 'permanent', error: 'fake permanent failure' };
      case 'throttle':
        return { ok: false, kind: 'throttled', error: 'fake throttling' };
      case 'account_paused':
        return { ok: false, kind: 'account_paused', error: 'fake account paused' };
      case 'crash':
        throw new Error('fake postman crashed');
    }
    this.accepted.push(mail);
    const providerId = `${this.name}-${++this.seq}-${mail.tags.campaign}-${mail.tags.contact}`;
    const at = (this.opts.now ?? (() => new Date()))();
    const emit = async (type: EventType, subtype: string | null = null, detail: Record<string, unknown> | null = null) => {
      if (!this.opts.emit) return;
      const delay = this.opts.delays?.[type] ?? DEFAULT_DELAYS[type];
      await this.opts.emit(
        {
          provider: this.name,
          providerEventId: `${providerId}:${type}`,
          providerMessageId: providerId,
          type,
          subtype,
          at: new Date(at.getTime() + delay).toISOString(),
          email: mail.to,
          campaign: mail.tags.campaign,
          contact: mail.tags.contact,
          detail,
        },
        delay,
      );
    };
    await emit('send');
    if (outcome === 'hard_bounce' || outcome === 'suppressed') await emit('bounce', 'Permanent', { bounceSubType: outcome === 'suppressed' ? 'OnAccountSuppressionList' : 'General' });
    else if (outcome === 'soft_bounce') await emit('bounce', 'Transient');
    else {
      if (outcome === 'delay') await emit('delay');
      await emit('delivery');
      if (outcome === 'complaint') await emit('complaint');
    }
    return { ok: true, providerId };
  }
}
