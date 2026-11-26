// 凍結名單：開寄那一刻，把這份名單上「訂閱中」的每個人寫進 campaign_recipients。
// - 在全域拒收名單（硬退信／檢舉／全部不要）→ skipped／suppressed
// - 不在這期的收件群（暖機還沒輪到）→ skipped／warmup
// - 其他 → planned，照收件群的分波與群的順序排好（wave、rank）
// 之後名單怎麼變都不影響這一期的名單；凍結後才退訂或被拒收的人，派送當下會再查一次並跳過。
//
// 整段用幾條「整批」SQL 完成（2,000 人也只有十來條），能用 D1 batch 就一次交、整批成功或整批失敗；
// 最後一條把 frozen_at 填上——派送端只認 frozen_at 有值的期。中途斷掉重跑也安全（插入遇重複略過、更新可重複）。

import type { Stmt } from '../core.ts';
import type { ListDb } from '../lists.ts';
import type { CampaignRow } from './campaigns.ts';

export interface FrozenAudience { waves: string[][]; maxCount: number | null; plan?: string; step?: number }

async function runBatch(db: ListDb, stmts: Stmt[]): Promise<void> {
  if (db.batch) {
    await db.batch(stmts);
    return;
  }
  for (const s of stmts) await s.run();
}

/** 這期每個群在第幾波、波內第幾順位的 CASE 運算式（值都用綁定參數，不拼字串）。 */
function caseFor(waves: string[][], pick: 'wave' | 'rank'): { sql: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  let star: { wave: number; rank: number } | null = null;
  waves.forEach((segs, wi) =>
    segs.forEach((seg, si) => {
      if (seg === '*') {
        star = { wave: wi + 1, rank: si };
        return;
      }
      parts.push('WHEN ? THEN ?');
      binds.push(seg, pick === 'wave' ? wi + 1 : si);
    }),
  );
  const s = star as { wave: number; rank: number } | null;
  const fallback = s ? (pick === 'wave' ? s.wave : s.rank) : null;
  binds.push(fallback);
  return { sql: parts.length ? `CASE m.segment ${parts.join(' ')} ELSE ? END` : '?', binds };
}

export async function freezeRecipients(db: ListDb, c: CampaignRow, aud: FrozenAudience, now: Date): Promise<void> {
  const t = now.toISOString();
  const wave = caseFor(aud.waves, 'wave');
  const rank = caseFor(aud.waves, 'rank');
  const stmts: Stmt[] = [
    db
      .prepare(
        `INSERT INTO campaign_recipients (campaign_id, contact_id, email, segment, wave, rank, state, skip_reason)
         SELECT ?, c.id, c.email, m.segment, ${wave.sql}, COALESCE(${rank.sql}, 0), 'planned', NULL
           FROM list_members m JOIN contacts c ON c.id = m.contact_id
          WHERE m.list_id = ? AND m.status = 'subscribed'
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      )
      .bind(c.id, ...wave.binds, ...rank.binds, c.list_id),
    // 不在這期收件群的人：暖機還沒輪到。
    db.prepare("UPDATE campaign_recipients SET state = 'skipped', skip_reason = 'warmup' WHERE campaign_id = ? AND state = 'planned' AND wave IS NULL").bind(c.id),
    // 全域拒收（電子報會擋的三種原因）。拒收優先於「沒輪到」，對帳時看得出被擋的真正原因。
    db
      .prepare(
        `UPDATE campaign_recipients SET state = 'skipped', skip_reason = 'suppressed'
          WHERE campaign_id = ? AND state IN ('planned', 'skipped') AND COALESCE(skip_reason, '') IN ('', 'warmup')
            AND email IN (SELECT email FROM suppressions WHERE reason IN ('hard_bounce', 'complaint', 'unsubscribe'))`,
      )
      .bind(c.id),
  ];
  if (aud.maxCount !== null) {
    // 這一步最多寄幾人：照波次、順位排，超過的人記成「暖機沒輪到」。
    stmts.push(
      db
        .prepare(
          `UPDATE campaign_recipients SET state = 'skipped', skip_reason = 'warmup'
            WHERE campaign_id = ? AND state = 'planned' AND contact_id IN (
              SELECT contact_id FROM campaign_recipients WHERE campaign_id = ? AND state = 'planned'
               ORDER BY wave, rank, contact_id LIMIT -1 OFFSET ?)`,
        )
        .bind(c.id, c.id, aud.maxCount),
    );
  }
  stmts.push(
    db
      .prepare("UPDATE campaigns SET frozen_at = ?, audience_resolved = ?, last_progress_at = ?, updated_at = ? WHERE id = ? AND frozen_at IS NULL")
      .bind(t, JSON.stringify(aud), t, t, c.id),
  );
  await runBatch(db, stmts);
}
