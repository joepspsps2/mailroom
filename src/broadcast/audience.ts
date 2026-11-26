// 「這期現在開寄會寄給誰」的預估（唯讀，不凍結、不寫任何東西）：依收件群與暖機梯子，列出每波每群多少人、被擋多少。
// 算法與 freeze.ts 一致：訂閱中的人 → 全域拒收的擋下 → 不在收件群的記「暖機沒輪到」→ 超過 maxCount 的（後面的波先）記「暖機沒輪到」。

import type { ListDb } from '../lists.ts';
import { checkAudience, getCampaign } from './campaigns.ts';
import { currentStep, planBlocked } from './warmup.ts';

export interface AudiencePlan {
  plan: string | null;
  step: number | null;
  /** 暖機梯子被鎖住或收件群設定有問題時的原因（這期現在開不了寄）。 */
  blocked: string | null;
  subscribed: number;
  willSend: number;
  skipped: { suppressed: number; warmup: number };
  waves: { wave: number; count: number; segments: { name: string; count: number }[] }[];
}

export async function audiencePlan(db: ListDb, campaignId: string): Promise<AudiencePlan | null> {
  const c = await getCampaign(db, campaignId);
  if (!c) return null;
  let a = null;
  try {
    a = checkAudience(JSON.parse(c.audience));
  } catch {
    /* 下面當設定有問題 */
  }
  const empty = (blocked: string): AudiencePlan => ({ plan: null, step: null, blocked, subscribed: 0, willSend: 0, skipped: { suppressed: 0, warmup: 0 }, waves: [] });
  if (!a) return empty('bad_audience');
  let waves: string[][];
  let maxCount: number | null;
  let plan: string | null = null;
  let step: number | null = null;
  let blocked: string | null = null;
  if ('plan' in a) {
    const b = await planBlocked(db, a.plan);
    const s = await currentStep(db, a.plan);
    if (!s) return empty('unknown_plan');
    if (b) blocked = `warmup_blocked: ${b}`;
    waves = JSON.parse(s.segments);
    maxCount = s.max_count;
    plan = a.plan;
    step = s.step;
  } else {
    waves = a.waves;
    maxCount = a.maxCount ?? null;
  }
  const rows = (
    await db
      .prepare(
        `SELECT m.segment AS seg, CASE WHEN c.email IN (SELECT email FROM suppressions WHERE reason IN ('hard_bounce', 'complaint', 'unsubscribe')) THEN 1 ELSE 0 END AS sup, COUNT(*) AS n
           FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND m.status = 'subscribed' GROUP BY seg, sup`,
      )
      .bind(c.list_id)
      .all<{ seg: string | null; sup: number; n: number }>()
  ).results;
  // 群 → (第幾波、波內順位)；「*」＝其他所有人。
  const slot = new Map<string, { wave: number; rank: number }>();
  let star: { wave: number; rank: number } | null = null;
  waves.forEach((segs, wi) => segs.forEach((s, si) => (s === '*' ? (star = { wave: wi + 1, rank: si }) : slot.set(s, { wave: wi + 1, rank: si }))));
  const perSeg = new Map<string, { wave: number; rank: number; count: number }>();
  let subscribed = 0;
  let suppressed = 0;
  let warmup = 0;
  for (const r of rows) {
    const n = Number(r.n);
    subscribed += n;
    const sl = (r.seg !== null ? slot.get(r.seg) : undefined) ?? star;
    if (r.sup) suppressed += n;
    else if (!sl) warmup += n;
    else {
      const key = r.seg ?? '';
      const cur = perSeg.get(key) ?? { wave: sl.wave, rank: sl.rank, count: 0 };
      cur.count += n;
      perSeg.set(key, cur);
    }
  }
  // 依波次、順位排好；超過 maxCount 的記成暖機沒輪到。
  const ordered = [...perSeg.entries()].sort((x, y) => x[1].wave - y[1].wave || x[1].rank - y[1].rank);
  let left = maxCount ?? Number.POSITIVE_INFINITY;
  const byWave = new Map<number, { name: string; count: number }[]>();
  let willSend = 0;
  for (const [name, v] of ordered) {
    const take = Math.min(v.count, left);
    left -= take;
    warmup += v.count - take;
    if (take > 0) {
      willSend += take;
      byWave.set(v.wave, [...(byWave.get(v.wave) ?? []), { name: name || '(none)', count: take }]);
    }
  }
  return {
    plan, step, blocked, subscribed, willSend, skipped: { suppressed, warmup },
    waves: [...byWave.entries()].sort((x, y) => x[0] - y[0]).map(([wave, segments]) => ({ wave, count: segments.reduce((s, x) => s + x.count, 0), segments })),
  };
}
