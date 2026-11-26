// 退信與檢舉怎麼進拒收：吃「已經正規化的事件」。事件從哪家郵差來、簽章怎麼驗，不在這裡（由接郵差的那一層做完再呼叫）。
// 不 import cloudflare:*，測試用 Node 內建 SQLite 跑同一份 SQL。
//
// 規則：
// - 永久退信 → 全域拒收 hard_bounce（所有信都不寄，包含登入類通知信）。
// - 檢舉 → 全域拒收 complaint（同上），並把這個人在所有名單標 unsubscribed（unsub_source='complaint'）。
// - 暫時性退信（信箱滿了）→ 不擋；同一人連續 3 期（三個不同的期別、中間沒有送達）暫時性退信 → 當硬退信處理。
// - 送達 → 清掉這個人的暫時退信紀錄（連續中斷）。
// 全部可重複執行：同一則事件送兩次，結果一樣。

import { addSuppression, type Db } from './core.ts';
import { normalizeEmail } from './lists.ts';

export type FeedbackEvent =
  | { type: 'bounce'; kind: 'permanent' | 'transient'; email: string; /** 這封信屬於哪一期；暫時性退信沒有期別就不計入連續。 */ campaign?: string | null; source: string; detail?: string | null }
  | { type: 'complaint'; email: string; source: string; detail?: string | null }
  | { type: 'delivery'; email: string };

export type FeedbackOutcome =
  | 'hard_bounce'
  | 'complaint'
  | 'transient_counted'
  | 'transient_promoted'
  | 'transient_no_campaign'
  | 'delivery'
  | 'rejected';

/** 連續幾期暫時性退信就當硬退信。 */
export const TRANSIENT_LIMIT = 3;

export interface FeedbackOptions {
  now?: () => Date;
  /** 連續幾期暫時性退信算硬退信（預設 3）。 */
  transientLimit?: number;
}

const CAMPAIGN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export async function applyFeedback(db: Db, ev: FeedbackEvent, opts: FeedbackOptions = {}): Promise<FeedbackOutcome> {
  const email = normalizeEmail((ev as { email?: unknown })?.email);
  if (!email) return 'rejected';
  const now = (opts.now ?? (() => new Date()))();
  const t = now.toISOString();
  const source = 'source' in ev && typeof ev.source === 'string' && ev.source.trim() ? ev.source.trim().slice(0, 40) : 'feedback';

  if (ev.type === 'delivery') {
    await db.prepare('DELETE FROM bounce_streaks WHERE email = ?').bind(email).run();
    return 'delivery';
  }

  if (ev.type === 'complaint') {
    await addSuppression(db, email, 'complaint', source, ev.detail ?? null, now);
    // 這個人明白說了「不要」：所有名單一起退出。已經退訂的保留原本的時間與來源。
    await db
      .prepare(
        `UPDATE list_members SET
           unsubscribed_at = CASE WHEN status = 'unsubscribed' THEN unsubscribed_at ELSE ? END,
           unsub_source = CASE WHEN status = 'unsubscribed' THEN unsub_source ELSE 'complaint' END,
           updated_at = CASE WHEN status = 'unsubscribed' THEN updated_at ELSE ? END,
           status = 'unsubscribed'
         WHERE contact_id = (SELECT id FROM contacts WHERE email = ?)`,
      )
      .bind(t, t, email)
      .run();
    await db.prepare('DELETE FROM bounce_streaks WHERE email = ?').bind(email).run();
    return 'complaint';
  }

  if (ev.type === 'bounce' && ev.kind === 'permanent') {
    // 名單裡的狀態不動（不是讀者的決定）；拒收名單擋住所有寄送，人工解除拒收後就恢復。
    await addSuppression(db, email, 'hard_bounce', source, ev.detail ?? null, now);
    await db.prepare('DELETE FROM bounce_streaks WHERE email = ?').bind(email).run();
    return 'hard_bounce';
  }

  if (ev.type === 'bounce' && ev.kind === 'transient') {
    if (typeof ev.campaign !== 'string' || !CAMPAIGN.test(ev.campaign)) return 'transient_no_campaign';
    // 同一期同一人只算一次（重送的事件不會重複計數）。
    await db.prepare('INSERT INTO bounce_streaks (email, campaign_id, at) VALUES (?, ?, ?) ON CONFLICT (email, campaign_id) DO NOTHING').bind(email, ev.campaign, t).run();
    const n = await db.prepare('SELECT COUNT(*) AS n FROM bounce_streaks WHERE email = ?').bind(email).first<{ n: number }>();
    const limit = Math.max(1, Math.trunc(opts.transientLimit ?? TRANSIENT_LIMIT));
    if (Number(n?.n ?? 0) >= limit) {
      await addSuppression(db, email, 'hard_bounce', source, `transient_streak:${limit}`, now);
      await db.prepare('DELETE FROM bounce_streaks WHERE email = ?').bind(email).run();
      return 'transient_promoted';
    }
    return 'transient_counted';
  }

  return 'rejected';
}
