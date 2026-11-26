// 寄完對帳：凍結名單 ＝ 寄出 ＋ 擋下（逐類）＋ 失敗 ＋ 不確定 ＋ 還沒寄。
// 再對帳本（每個寄出的人都有一列 sent 的帳本、帳本 sent 數＝寄出數）與郵差事件（送出事件不能比寄出多、同一人不能有兩封）。
// 任何一條對不上，problems 就不是空的——派送端據此擋下「完成」狀態。
// 「事件還沒回來」（例：送出了、送達還沒回報）不算對不上，另列 awaiting。

import type { Db } from '../core.ts';
import type { BroadcastConfig } from './config.ts';

export interface ReconcileReport {
  campaign: string;
  ok: boolean;
  frozen: number;
  sent: number;
  skipped: Record<string, number>;
  skippedTotal: number;
  failed: number;
  uncertain: number;
  pending: number;
  ledger: { sent: number; doneWithoutLedger: number };
  events: { sends: number; delivered: number; hardBounced: number; softBounced: number; complained: number; awaiting: number; duplicateSends: number };
  problems: string[];
}

const KNOWN_STATES = ['planned', 'enqueued', 'done', 'skipped', 'failed', 'uncertain'];
const KNOWN_SKIPS = ['suppressed', 'unsubscribed', 'warmup', 'cancelled'];

export async function reconcileCampaign(db: Db, campaignId: string, cfg: Pick<BroadcastConfig, 'site'>): Promise<ReconcileReport> {
  const problems: string[] = [];
  const rows = (
    await db.prepare('SELECT state, skip_reason, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY state, skip_reason').bind(campaignId).all<{ state: string; skip_reason: string | null; n: number }>()
  ).results;
  let frozen = 0, sent = 0, failed = 0, uncertain = 0, pending = 0, skippedTotal = 0;
  const skipped: Record<string, number> = {};
  for (const r of rows) {
    const n = Number(r.n);
    frozen += n;
    if (!KNOWN_STATES.includes(r.state)) problems.push(`unknown_state:${r.state}`);
    if (r.state === 'done') sent += n;
    else if (r.state === 'failed') failed += n;
    else if (r.state === 'uncertain') uncertain += n;
    else if (r.state === 'planned' || r.state === 'enqueued') pending += n;
    else if (r.state === 'skipped') {
      const why = r.skip_reason ?? 'unknown';
      if (!KNOWN_SKIPS.includes(why)) problems.push(`unknown_skip_reason:${why}`);
      skipped[why] = (skipped[why] ?? 0) + n;
      skippedTotal += n;
    }
  }
  if (frozen === 0) problems.push('nothing_frozen');
  if (frozen !== sent + skippedTotal + failed + uncertain + pending) problems.push('counts_do_not_add_up');
  // 凍結當下記下的人數：之後有人憑空多出來或消失，這裡會對不上。
  const stored = await db.prepare("SELECT json_extract(counts, '$.frozen') AS n FROM campaigns WHERE id = ?").bind(campaignId).first<{ n: number | null }>();
  if (stored?.n === null || stored?.n === undefined) problems.push('frozen_count_missing');
  else if (Number(stored.n) !== frozen) problems.push(`frozen_${stored.n}_now_${frozen}`);
  if (pending > 0) problems.push(`pending:${pending}`);
  if (uncertain > 0) problems.push(`uncertain:${uncertain}`);

  // 帳本：這期的去重鍵是 c:{期號}:…（用範圍比較，不用 LIKE）。
  const lo = `c:${campaignId}:`;
  const hi = `c:${campaignId};`;
  const ledger = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE site = ? AND dedupe_key >= ? AND dedupe_key < ? AND status = 'sent'")
    .bind(cfg.site, lo, hi)
    .first<{ n: number }>();
  const ledgerSent = Number(ledger?.n ?? 0);
  if (ledgerSent !== sent) problems.push(`ledger_sent_${ledgerSent}_vs_done_${sent}`);
  const orphan = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM campaign_recipients r LEFT JOIN messages m ON m.id = r.message_id
        WHERE r.campaign_id = ? AND r.state = 'done'
          AND (m.id IS NULL OR m.status != 'sent' OR m.site != ? OR m.dedupe_key != 'c:' || r.campaign_id || ':' || r.contact_id)`,
    )
    .bind(campaignId, cfg.site)
    .first<{ n: number }>();
  const doneWithoutLedger = Number(orphan?.n ?? 0);
  if (doneWithoutLedger > 0) problems.push(`done_without_ledger:${doneWithoutLedger}`);

  // 郵差事件（以人計）。
  const ev = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN type = 'send' THEN contact_id END) AS sends,
         COUNT(DISTINCT CASE WHEN type = 'delivery' THEN contact_id END) AS delivered,
         COUNT(DISTINCT CASE WHEN type = 'bounce' AND subtype LIKE 'Permanent%' THEN contact_id END) AS hard,
         COUNT(DISTINCT CASE WHEN type = 'bounce' AND (subtype IS NULL OR subtype NOT LIKE 'Permanent%') THEN contact_id END) AS soft,
         COUNT(DISTINCT CASE WHEN type = 'complaint' THEN contact_id END) AS complained,
         COUNT(DISTINCT CASE WHEN type IN ('delivery', 'bounce') THEN contact_id END) AS outcome
       FROM events WHERE campaign_id = ?`,
    )
    .bind(campaignId)
    .first<{ sends: number; delivered: number; hard: number; soft: number; complained: number; outcome: number }>();
  const dup = await db
    .prepare("SELECT COUNT(*) AS n FROM (SELECT contact_id FROM events WHERE campaign_id = ? AND type = 'send' GROUP BY contact_id HAVING COUNT(DISTINCT COALESCE(provider_message_id, provider_event_id)) > 1)")
    .bind(campaignId)
    .first<{ n: number }>();
  const sends = Number(ev?.sends ?? 0);
  const outcome = Number(ev?.outcome ?? 0);
  const duplicateSends = Number(dup?.n ?? 0);
  if (sends > sent) problems.push(`send_events_${sends}_exceed_sent_${sent}`);
  if (duplicateSends > 0) problems.push(`duplicate_send_events:${duplicateSends}`);
  // 有送出事件的郵差：送達＋退信不能比送出多。
  if (sends > 0 && outcome > sends) problems.push(`outcomes_${outcome}_exceed_send_events_${sends}`);

  return {
    campaign: campaignId,
    ok: problems.length === 0,
    frozen, sent, skipped, skippedTotal, failed, uncertain, pending,
    ledger: { sent: ledgerSent, doneWithoutLedger },
    events: {
      sends,
      delivered: Number(ev?.delivered ?? 0),
      hardBounced: Number(ev?.hard ?? 0),
      softBounced: Number(ev?.soft ?? 0),
      complained: Number(ev?.complained ?? 0),
      awaiting: Math.max(0, (sends > 0 ? sends : sent) - outcome),
      duplicateSends,
    },
    problems,
  };
}
