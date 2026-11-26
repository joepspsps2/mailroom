// 暖機梯子：每一步寫「這期寄給哪幾群（分波）、最多幾人、過關條件」。
// 目前這一步＝已放行的最高一步（第一步不用放行）。上一期過關才放行下一步；不過關＝下一期維持同一步；
// 連續 gateMaxFails 期不過關＝這條梯子鎖住，開寄時直接擋下，要明確解鎖（寫原因）才繼續。
// 過關比的是「同一批人」在換郵差前的開信率基準（由分析端算好傳進來），不比全名單。

import type { Db } from '../core.ts';
import { checkWaves, CAMPAIGN_ID, getCampaign } from './campaigns.ts';
import type { BroadcastConfig } from './config.ts';
import { campaignRates } from './stats.ts';

export interface WarmupStepRow {
  plan_id: string; step: number; segments: string; max_count: number | null; gate: string | null;
  released_at: string | null; blocked_reason: string | null; fails: number; last_eval: string | null;
}

export interface GateOverrides { bounceRate?: number; complaintRate?: number; openDrop?: number; waitHours?: number }

export interface StepInput { plan: string; step: number; waves: string[][]; maxCount?: number | null; gate?: GateOverrides }

const nowIso = (now?: () => Date) => (now ?? (() => new Date()))().toISOString();

export async function upsertWarmupStep(db: Db, input: StepInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!input || typeof input.plan !== 'string' || !CAMPAIGN_ID.test(input.plan)) return { ok: false, reason: 'bad_plan' };
  if (!Number.isInteger(input.step) || input.step < 1 || input.step > 100) return { ok: false, reason: 'bad_step' };
  const waves = checkWaves(input.waves);
  if (!waves) return { ok: false, reason: 'bad_waves' };
  if (input.maxCount !== undefined && input.maxCount !== null && !(Number.isInteger(input.maxCount) && input.maxCount > 0)) return { ok: false, reason: 'bad_max_count' };
  let gate: string | null = null;
  if (input.gate !== undefined) {
    const g: GateOverrides = {};
    for (const k of ['bounceRate', 'complaintRate', 'openDrop'] as const) {
      const v = input.gate[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !(v >= 0 && v <= 1)) return { ok: false, reason: 'bad_gate' };
      g[k] = v;
    }
    if (input.gate.waitHours !== undefined) {
      if (typeof input.gate.waitHours !== 'number' || !(input.gate.waitHours > 0)) return { ok: false, reason: 'bad_gate' };
      g.waitHours = input.gate.waitHours;
    }
    gate = JSON.stringify(g);
  }
  // 已放行／已鎖住的狀態不因改設定而清掉。
  await db
    .prepare(
      `INSERT INTO warmup_steps (plan_id, step, segments, max_count, gate) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (plan_id, step) DO UPDATE SET segments = excluded.segments, max_count = excluded.max_count, gate = excluded.gate`,
    )
    .bind(input.plan, input.step, JSON.stringify(waves), input.maxCount ?? null, gate)
    .run();
  return { ok: true };
}

export async function planSteps(db: Db, plan: string): Promise<WarmupStepRow[]> {
  return (await db.prepare('SELECT * FROM warmup_steps WHERE plan_id = ? ORDER BY step').bind(plan).all<WarmupStepRow>()).results;
}

/** 目前這一步：已放行的最高一步；都沒放行就是最低那一步。 */
export async function currentStep(db: Db, plan: string): Promise<WarmupStepRow | null> {
  const steps = await planSteps(db, plan);
  if (steps.length === 0) return null;
  const released = steps.filter((s) => s.released_at !== null);
  return released.length ? released[released.length - 1] : steps[0];
}

/** 這條梯子有沒有被鎖住（任何一步有 blocked_reason）。 */
export async function planBlocked(db: Db, plan: string): Promise<string | null> {
  const row = await db.prepare('SELECT blocked_reason FROM warmup_steps WHERE plan_id = ? AND blocked_reason IS NOT NULL LIMIT 1').bind(plan).first<{ blocked_reason: string }>();
  return row?.blocked_reason ?? null;
}

export type GateResult =
  | { result: 'pass'; step: number; advancedTo: number | null; rates: Record<string, number> }
  | { result: 'fail'; step: number; reasons: string[]; fails: number; blocked: boolean; rates: Record<string, number> }
  | { result: 'not_ready'; reasons: string[] }
  | { result: 'already_evaluated'; last: unknown };

/**
 * 評一期信能不能讓梯子往上一步（上一期滿 waitHours 小時後評）。
 * baselineOpenRate＝這期收件的那幾群，在換郵差前 4 期的平均開信率（0～1，由分析端提供）；沒給＝不評（不放量）。
 * 同一期只算一次（重複呼叫回 already_evaluated，不會重複累計不過關次數）。
 */
export async function evaluateWarmup(
  db: Db,
  plan: string,
  campaignId: string,
  baselineOpenRate: number | null | undefined,
  cfg: BroadcastConfig,
  now?: () => Date,
): Promise<GateResult> {
  const step = await currentStep(db, plan);
  if (!step) return { result: 'not_ready', reasons: ['unknown_plan'] };
  if (step.last_eval) {
    try {
      const last = JSON.parse(step.last_eval) as { campaign?: string };
      if (last.campaign === campaignId) return { result: 'already_evaluated', last };
    } catch {
      /* 壞掉的紀錄當沒評過 */
    }
  }
  const c = await getCampaign(db, campaignId);
  if (!c) return { result: 'not_ready', reasons: ['unknown_campaign'] };
  let resolved: { plan?: string; step?: number } = {};
  try {
    resolved = JSON.parse(c.audience_resolved ?? '{}');
  } catch {
    /* 下面擋 */
  }
  if (resolved.plan !== plan || resolved.step !== step.step) return { result: 'not_ready', reasons: ['campaign_not_on_current_step'] };
  if (c.status !== 'done' || !c.finished_at) return { result: 'not_ready', reasons: ['campaign_not_done'] };
  const gate: GateOverrides = step.gate ? JSON.parse(step.gate) : {};
  const waitHours = gate.waitHours ?? cfg.gateWaitHours;
  const t = (now ?? (() => new Date()))();
  if (t.getTime() - Date.parse(c.finished_at) < waitHours * 3_600_000) return { result: 'not_ready', reasons: [`wait_${waitHours}h`] };
  if (typeof baselineOpenRate !== 'number' || !(baselineOpenRate >= 0 && baselineOpenRate <= 1)) return { result: 'not_ready', reasons: ['baseline_missing'] };

  const r = await campaignRates(db, campaignId);
  const rates = { sent: r.sent, hardBounceRate: r.hardBounceRate, complaintRate: r.complaintRate, openRate: r.openRate, baselineOpenRate };
  const reasons: string[] = [];
  if (r.sent === 0) reasons.push('nothing_sent');
  if (r.hardBounceRate > (gate.bounceRate ?? cfg.gateBounceRate)) reasons.push('bounce_rate');
  if (r.complaintRate > (gate.complaintRate ?? cfg.gateComplaintRate)) reasons.push('complaint_rate');
  if (r.openRate < baselineOpenRate - (gate.openDrop ?? cfg.gateOpenDrop)) reasons.push('open_rate_below_baseline');
  // 對帳對不上也不放下一步。
  const counts = c.counts ? (JSON.parse(c.counts) as { reconcileOk?: boolean }) : {};
  if (counts.reconcileOk !== true) reasons.push('reconcile_not_ok');

  const at = nowIso(now);
  if (reasons.length === 0) {
    const steps = await planSteps(db, plan);
    const next = steps.find((s) => s.step > step.step) ?? null;
    await db.prepare('UPDATE warmup_steps SET fails = 0, last_eval = ? WHERE plan_id = ? AND step = ?').bind(JSON.stringify({ campaign: campaignId, result: 'pass', at, rates }), plan, step.step).run();
    if (next) await db.prepare('UPDATE warmup_steps SET released_at = ? WHERE plan_id = ? AND step = ? AND released_at IS NULL').bind(at, plan, next.step).run();
    return { result: 'pass', step: step.step, advancedTo: next?.step ?? null, rates };
  }
  const fails = step.fails + 1;
  const blocked = fails >= cfg.gateMaxFails;
  await db
    .prepare('UPDATE warmup_steps SET fails = ?, last_eval = ?, blocked_reason = CASE WHEN ? THEN COALESCE(blocked_reason, ?) ELSE blocked_reason END WHERE plan_id = ? AND step = ?')
    .bind(fails, JSON.stringify({ campaign: campaignId, result: 'fail', at, reasons, rates }), blocked ? 1 : 0, `failed ${fails} gates in a row: ${reasons.join(',')}`, plan, step.step)
    .run();
  return { result: 'fail', step: step.step, reasons, fails, blocked, rates };
}

/** 解鎖：要寫查過什麼。清掉鎖與連續不過關次數，梯子停在原本那一步。 */
export async function unblockWarmup(db: Db, plan: string, note: string): Promise<{ ok: true; cleared: number } | { ok: false; reason: string }> {
  if (typeof note !== 'string' || !note.trim()) return { ok: false, reason: 'note_required' };
  const r = await db.prepare('UPDATE warmup_steps SET blocked_reason = NULL, fails = 0, last_eval = json_set(COALESCE(last_eval, \'{}\'), \'$.unblockNote\', ?) WHERE plan_id = ? AND blocked_reason IS NOT NULL').bind(note.trim().slice(0, 300), plan).run();
  return { ok: true, cleared: r.meta.changes ?? 0 };
}
