// 派送：每分鐘一次的排程（tick）負責「開寄、放水、踩煞車、寄完對帳」；Queue 消費端（consume）負責「一封一封交郵差」。
//
// 不重寄的四道保險：
// 1. 同一期同一人一把去重鍵 c:{期號}:{聯絡人}；帳本已經是 sent 的，再來幾次都只回 duplicate。
// 2. 帳本列在交郵差「之前」就建好（status='sending'）。電子報的 sending 列不像掛號信那樣放久了可以重搶：
//    交郵差途中 Worker 被砍、郵差丟例外＝不知道有沒有寄出 → 那一位記成 uncertain，等事件或人工確認，絕不自動重寄。
// 3. Queue 重送、同一人被重複放水：消費端先看 campaign_recipients.state 是不是 enqueued，不是就直接略過。
// 4. 期的狀態不是 sending（暫停、取消）時一封都不交郵差。

import { localDay, parseAddress, suppressedReason } from '../core.ts';
import type { ListDb } from '../lists.ts';
import { checkAudience, EXTRA_HEADER, getCampaign, type Audience, type CampaignRow } from './campaigns.ts';
import { resolveConfig, type BroadcastConfig } from './config.ts';
import { ingestEvent, type IngestOptions } from './events.ts';
import { freezeRecipients, type FrozenAudience } from './freeze.ts';
import type { Postman, PostmanMail, ProviderEvent } from './postman.ts';
import { reconcileCampaign } from './reconcile.ts';
import { campaignRates, domainRates } from './stats.ts';
import { currentStep, planBlocked } from './warmup.ts';

export interface RecipientRow {
  campaign_id: string; contact_id: number; email: string; segment: string | null; wave: number | null; rank: number;
  state: 'planned' | 'enqueued' | 'done' | 'skipped' | 'failed' | 'uncertain'; skip_reason: string | null; attempts: number;
  message_id: number | null; error: string | null; enqueued_at: string | null; done_at: string | null;
}

export interface RenderResult { html: string; text: string; headers?: Record<string, string> }
/** 產生這一位收件人的信（個人化、退訂連結、追蹤簽章）。丟例外＝這期暫停（不能寄出沒有退訂連結的信）。 */
export type Render = (campaign: CampaignRow, recipient: RecipientRow & { name: string | null }) => RenderResult | Promise<RenderResult>;

export type BroadcastMessage = { kind: 'send'; campaign: string; contact: number } | { kind: 'event'; event: ProviderEvent };
export interface BroadcastQueue { sendBatch(messages: { body: BroadcastMessage; delaySeconds?: number }[]): Promise<unknown> }

export interface Alert { level: 'red' | 'yellow' | 'info'; code: string; campaign?: string; message: string }

export interface BroadcastDeps {
  db: ListDb;
  postman: Postman;
  /** 電子報的寄件網域（例 mail.example.com）。寄件地址必須在這個網域下。 */
  domain: string;
  render: Render;
  queue?: BroadcastQueue;
  config?: Partial<BroadcastConfig> | string;
  /** 煞車、暫停、寄完等通知交給誰（告警出口由部署端決定，引擎不自己發）。 */
  alert?: (a: Alert) => void | Promise<void>;
  feedback?: IngestOptions['feedback'];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface TickReport { started: string[]; released: Record<string, number>; paused: { campaign: string; reason: string }[]; finished: string[]; alerts: Alert[] }

/** 「正在寄」超過這麼久沒結果，就當作交郵差途中斷掉（記 uncertain，不重寄）。 */
const STALE_SENDING_MS = 2 * 60_000;
const QUEUE_CHUNK = 100;

interface Ctx { deps: BroadcastDeps; cfg: BroadcastConfig; now: Date; iso: string; report: TickReport }

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString();

async function emitAlert(ctx: Pick<Ctx, 'deps' | 'report'>, a: Alert): Promise<void> {
  ctx.report.alerts.push(a);
  try {
    await ctx.deps.alert?.(a);
  } catch (e) {
    console.error('broadcast alert hook failed', e instanceof Error ? e.message : 'unknown');
  }
}

/** 寄送中的期 → 暫停（煞車、錯誤）。回 true＝這次真的由 sending 改成 paused。 */
async function brake(ctx: Pick<Ctx, 'deps' | 'report' | 'iso'>, campaignId: string, reason: string, level: Alert['level'] = 'red'): Promise<boolean> {
  const r = await ctx.deps.db
    .prepare("UPDATE campaigns SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
    .bind(reason, ctx.iso, campaignId)
    .run();
  if ((r.meta.changes ?? 0) !== 1) return false;
  ctx.report.paused.push({ campaign: campaignId, reason });
  await emitAlert(ctx, { level, code: reason.split(':')[0] === 'brake' ? reason.split(':')[1] ?? reason : reason, campaign: campaignId, message: `campaign ${campaignId} paused: ${reason}` });
  return true;
}

export async function activeHold(db: ListDb, domain: string): Promise<{ id: number; reason: string; created_at: string } | null> {
  return db.prepare('SELECT id, reason, created_at FROM domain_holds WHERE domain = ? AND released_at IS NULL ORDER BY id LIMIT 1').bind(domain).first();
}

/** 解除寄件網域停寄（要寫查過什麼）。暫停中的期不會自動續寄，要各自 resume。 */
export async function releaseHold(db: ListDb, domain: string, note: string, now = new Date()): Promise<{ ok: true; released: number } | { ok: false; reason: string }> {
  if (typeof note !== 'string' || !note.trim()) return { ok: false, reason: 'note_required' };
  const r = await db.prepare('UPDATE domain_holds SET released_at = ?, released_note = ? WHERE domain = ? AND released_at IS NULL').bind(now.toISOString(), note.trim().slice(0, 300), domain).run();
  return { ok: true, released: r.meta.changes ?? 0 };
}

interface ThrottleRow { domain: string; day: string; sent: number; limit: number; per_second: number; provider_per_day: number | null; enforcement: string | null; refreshed_at: string | null; last_throttled_at: string | null }

/** 今天的計數列；沒有或太久沒更新就向郵差讀上限（每秒、每天、健康狀態）。讀不到時今天額度＝0（不寄）。 */
async function todayRow(ctx: Ctx): Promise<ThrottleRow> {
  const { db, postman, domain } = ctx.deps;
  const day = localDay(ctx.now, ctx.cfg.utcOffsetHours);
  let row = await db.prepare('SELECT * FROM throttle_days WHERE domain = ? AND day = ?').bind(domain, day).first<ThrottleRow>();
  if (!row || !row.refreshed_at || row.refreshed_at < minutesAgo(ctx.now, ctx.cfg.limitsRefreshMinutes)) {
    try {
      const l = await postman.limits();
      const perDay = Number.isFinite(l.perDay) && l.perDay > 0 ? Math.floor(l.perDay) : 0;
      const perSecond = Number.isFinite(l.perSecond) && l.perSecond > 0 ? l.perSecond : 0;
      // 郵差的 24 小時上限是「滾動」的：昨天晚上寄的也佔今天的額度。有報已用量時，今天最多再寄
      //「今天已寄＋郵差那邊剩下的」（今天已寄本來就含在已用量裡）。
      let cap = Math.min(ctx.cfg.maxPerDay, perDay);
      if (typeof l.sentLast24h === 'number' && Number.isFinite(l.sentLast24h) && l.sentLast24h >= 0) {
        cap = Math.min(cap, (row?.sent ?? 0) + Math.max(0, perDay - Math.ceil(l.sentLast24h)));
      }
      await db
        .prepare(
          `INSERT INTO throttle_days (domain, day, sent, "limit", per_second, provider_per_day, enforcement, refreshed_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
           ON CONFLICT (domain, day) DO UPDATE SET "limit" = excluded."limit", per_second = excluded.per_second, provider_per_day = excluded.provider_per_day,
             enforcement = excluded.enforcement, refreshed_at = excluded.refreshed_at`,
        )
        .bind(domain, day, cap, perSecond, perDay, String(l.enforcement ?? 'UNKNOWN').slice(0, 40), ctx.iso)
        .run();
    } catch (e) {
      console.error('postman limits failed', e instanceof Error ? e.message : 'unknown');
      if (!row) {
        await db.prepare(`INSERT INTO throttle_days (domain, day, sent, "limit", per_second, enforcement) VALUES (?, ?, 0, 0, 0, 'UNKNOWN') ON CONFLICT (domain, day) DO NOTHING`).bind(domain, day).run();
      }
    }
    row = (await db.prepare('SELECT * FROM throttle_days WHERE domain = ? AND day = ?').bind(domain, day).first<ThrottleRow>())!;
  }
  return row;
}

/** 開寄時把收件群定下來：照暖機梯子目前這一步，或照這期自己寫的分波。 */
async function resolveAudience(db: ListDb, c: CampaignRow): Promise<FrozenAudience | { blocked: string }> {
  let a: Audience | null = null;
  try {
    a = checkAudience(JSON.parse(c.audience));
  } catch {
    /* 下面擋 */
  }
  if (!a) return { blocked: 'bad_audience' };
  if ('plan' in a) {
    const blocked = await planBlocked(db, a.plan);
    if (blocked) return { blocked: `warmup_blocked: ${blocked}` };
    const step = await currentStep(db, a.plan);
    if (!step) return { blocked: 'unknown_plan' };
    return { waves: JSON.parse(step.segments), maxCount: step.max_count, plan: a.plan, step: step.step };
  }
  return { waves: a.waves, maxCount: a.maxCount ?? null };
}

function approvedForSending(c: CampaignRow): boolean {
  if (c.approved_hash !== c.content_hash || !c.preflight) return false;
  try {
    const p = JSON.parse(c.preflight) as { ok?: unknown; hash?: unknown };
    return p.ok === true && p.hash === c.content_hash;
  } catch {
    return false;
  }
}

/** 開寄被擋：同一期同一個原因只通知一次（每分鐘都擋，不要每分鐘洗版）。 */
async function startBlocked(ctx: Ctx, c: CampaignRow, code: string, level: Alert['level'], message: string): Promise<void> {
  let last: string | undefined;
  try {
    last = (JSON.parse(c.counts ?? '{}') as { startBlocked?: string }).startBlocked;
  } catch {
    /* 當沒記過 */
  }
  if (last === code) return;
  await setCounts(ctx.deps.db, c.id, 'startBlocked', code, ctx.iso);
  await emitAlert(ctx, { level, code, campaign: c.id, message });
}

async function startDue(ctx: Ctx, blocked: string | null): Promise<void> {
  const { db } = ctx.deps;
  const due = (await db.prepare("SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at, id").bind(ctx.iso).all<CampaignRow>()).results;
  for (const c of due) {
    // 過了原定時間太久（等了很久才輪到開寄）：不自動開寄，退回已核准，由人確認現在寄還適不適合再重排。
    if (Date.parse(c.scheduled_at ?? '') < ctx.now.getTime() - ctx.cfg.startGraceMinutes * 60_000) {
      const back = await db.prepare("UPDATE campaigns SET status = 'approved', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(ctx.iso, c.id).run();
      if ((back.meta.changes ?? 0) === 1) await emitAlert(ctx, { level: 'yellow', code: 'start_stale', campaign: c.id, message: `campaign ${c.id} was due at ${c.scheduled_at} and could not start within ${ctx.cfg.startGraceMinutes} minutes: moved back to approved, schedule it again after checking` });
      continue;
    }
    if (blocked) {
      await startBlocked(ctx, c, `start_blocked_${blocked}`, 'yellow', `campaign ${c.id} not started: ${blocked}`);
      continue;
    }
    if (!approvedForSending(c)) {
      // 不應該發生（內容一改就退回 draft）；保險起見退回 approved、不開寄。
      await db.prepare("UPDATE campaigns SET status = 'approved', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(ctx.iso, c.id).run();
      await emitAlert(ctx, { level: 'red', code: 'start_blocked_not_approved', campaign: c.id, message: `campaign ${c.id} not started: approval or pre-send check does not match content` });
      continue;
    }
    const aud = await resolveAudience(db, c);
    if ('blocked' in aud) {
      await startBlocked(ctx, c, 'start_blocked', 'red', `campaign ${c.id} not started: ${aud.blocked}`);
      continue;
    }
    const claimed = await db
      .prepare("UPDATE campaigns SET status = 'sending', started_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .bind(ctx.iso, ctx.iso, ctx.iso, c.id)
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    await freezeRecipients(db, c, aud, ctx.now);
    ctx.report.started.push(c.id);
    await emitAlert(ctx, { level: 'info', code: 'started', campaign: c.id, message: `campaign ${c.id} started` });
  }
}

type StateCounts = Record<'planned' | 'enqueued' | 'done' | 'skipped' | 'failed' | 'uncertain', number>;

async function stateCounts(db: ListDb, campaignId: string): Promise<StateCounts> {
  const rows = (await db.prepare('SELECT state, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY state').bind(campaignId).all<{ state: keyof StateCounts; n: number }>()).results;
  const out: StateCounts = { planned: 0, enqueued: 0, done: 0, skipped: 0, failed: 0, uncertain: 0 };
  for (const r of rows) out[r.state] = Number(r.n);
  return out;
}

/** uncertain 的人：事件說郵差確實收下了（send／delivery／bounce／complaint）→ 改成 done，帳本列也改成 sent。 */
async function settleUncertain(ctx: Ctx, campaignId: string): Promise<void> {
  const { db } = ctx.deps;
  const rows = (
    await db
      .prepare(
        `SELECT r.contact_id, r.message_id FROM campaign_recipients r
          WHERE r.campaign_id = ? AND r.state = 'uncertain'
            AND EXISTS (SELECT 1 FROM events e WHERE e.campaign_id = r.campaign_id AND e.contact_id = r.contact_id AND e.type IN ('send', 'delivery', 'bounce', 'complaint'))
          LIMIT 500`,
      )
      .bind(campaignId)
      .all<{ contact_id: number; message_id: number | null }>()
  ).results;
  for (const r of rows) {
    await db.prepare("UPDATE campaign_recipients SET state = 'done', done_at = ?, error = NULL WHERE campaign_id = ? AND contact_id = ? AND state = 'uncertain'").bind(ctx.iso, campaignId, r.contact_id).run();
    if (r.message_id) await db.prepare("UPDATE messages SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ? AND status = 'sending'").bind(ctx.iso, ctx.iso, r.message_id).run();
  }
}

/** 人工判定 uncertain 的那一位：as='sent'（確定收到了）或 'failed'（確定沒寄出；之後可用 retryFailed 重送）。 */
export async function resolveUncertain(db: ListDb, campaignId: string, contactId: number, as: 'sent' | 'failed', note: string, now = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (as !== 'sent' && as !== 'failed') return { ok: false, reason: 'bad_as' };
  if (typeof note !== 'string' || !note.trim()) return { ok: false, reason: 'note_required' };
  const r = await db.prepare("SELECT message_id FROM campaign_recipients WHERE campaign_id = ? AND contact_id = ? AND state = 'uncertain'").bind(campaignId, contactId).first<{ message_id: number | null }>();
  if (!r) return { ok: false, reason: 'not_uncertain' };
  const iso = now.toISOString();
  const err = `resolved:${note.trim().slice(0, 200)}`;
  await db.prepare('UPDATE campaign_recipients SET state = ?, done_at = ?, error = ? WHERE campaign_id = ? AND contact_id = ? AND state = \'uncertain\'').bind(as === 'sent' ? 'done' : 'failed', iso, err, campaignId, contactId).run();
  if (r.message_id) {
    await db.prepare("UPDATE messages SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END, error = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(as, as, iso, as === 'failed' ? err : null, iso, r.message_id).run();
  }
  return { ok: true };
}

/** 失敗的人再送一次（同一把去重鍵）。期要在寄送中或暫停中；寄完（done）就結束了。 */
export async function retryFailed(db: ListDb, campaignId: string): Promise<{ ok: true; requeued: number } | { ok: false; reason: string }> {
  const c = await getCampaign(db, campaignId);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status !== 'sending' && c.status !== 'paused') return { ok: false, reason: 'illegal_state' };
  const r = await db.prepare("UPDATE campaign_recipients SET state = 'planned', attempts = 0, enqueued_at = NULL WHERE campaign_id = ? AND state = 'failed'").bind(campaignId).run();
  return { ok: true, requeued: r.meta.changes ?? 0 };
}

async function setCounts(db: ListDb, campaignId: string, key: string, value: unknown, iso: string): Promise<void> {
  await db.prepare("UPDATE campaigns SET counts = json_set(COALESCE(counts, '{}'), ?, json(?)), updated_at = ? WHERE id = ?").bind(`$.${key}`, JSON.stringify(value), iso, campaignId).run();
}

interface Budget { minute: number; day: number }

async function processSending(ctx: Ctx, c: CampaignRow, budget: Budget, throttle: ThrottleRow): Promise<void> {
  const { db } = ctx.deps;
  const cfg = ctx.cfg;
  if (!c.frozen_at) {
    // 開寄後、凍結完成前被砍：重跑凍結（可重複執行）。
    const aud = await resolveAudience(db, c);
    if ('blocked' in aud) {
      await brake(ctx, c.id, `brake:freeze_blocked:${aud.blocked}`);
      return;
    }
    await freezeRecipients(db, c, aud, ctx.now);
    c = (await getCampaign(db, c.id))!;
  }

  let counts = await stateCounts(db, c.id);
  // Queue 壞了：有交出去的工作，卻很久沒有任何一封有結果。
  const stallBefore = minutesAgo(ctx.now, cfg.stallMinutes);
  if (counts.enqueued > 0 && (c.last_progress_at ?? c.started_at ?? ctx.iso) < stallBefore && (c.waiting_since ?? c.started_at ?? ctx.iso) < stallBefore) {
    await brake(ctx, c.id, 'brake:queue_stalled');
    return;
  }
  // 交出去太久沒結果：退回待放水（去重鍵保證不重寄）。
  await db
    .prepare("UPDATE campaign_recipients SET state = 'planned', enqueued_at = NULL WHERE campaign_id = ? AND state = 'enqueued' AND enqueued_at < ?")
    .bind(c.id, minutesAgo(ctx.now, cfg.stuckMinutes))
    .run();
  if (counts.uncertain > 0) await settleUncertain(ctx, c.id);

  // 🔴 寄到一半停：本期（續寄過就從續寄起算）已寄夠多封才算比率。
  // 續寄時人工放行過的那一道煞車，從續寄起算；其他煞車照全期算。
  const ack = (() => {
    try {
      const o = JSON.parse(c.counts ?? '{}') as { ackBrake?: string | null; brakeSince?: string | null };
      return { brake: o.ackBrake ?? null, since: o.brakeSince ?? null };
    } catch {
      return { brake: null, since: null };
    }
  })();
  const sinceFor = (b: string) => (ack.brake === b ? ack.since : null);
  const bounce = await campaignRates(db, c.id, undefined, sinceFor('hard_bounce_rate'));
  if (bounce.sent >= cfg.brakeMinSent && bounce.hardBounceRate >= cfg.brakeHardBounceRate) {
    await brake(ctx, c.id, `brake:hard_bounce_rate:${bounce.hardBounces}/${bounce.sent}`);
    return;
  }
  // 檢舉：件數本身就是下限（≥3 件），不另設寄出封數下限。
  const complaint = await campaignRates(db, c.id, undefined, sinceFor('complaint_rate'));
  if (complaint.complaints >= cfg.brakeComplaintCount && complaint.complaintRate >= cfg.brakeComplaintRate) {
    await brake(ctx, c.id, `brake:complaint_rate:${complaint.complaints}/${complaint.sent}`);
    return;
  }

  counts = await stateCounts(db, c.id);
  await setCounts(db, c.id, 'states', counts, ctx.iso);
  if (counts.planned + counts.enqueued === 0) {
    // 沒有要寄的了：對帳，對得上才算寄完。
    const rec = await reconcileCampaign(db, c.id, cfg);
    await setCounts(db, c.id, 'reconcile', rec, ctx.iso);
    await setCounts(db, c.id, 'reconcileOk', rec.ok, ctx.iso);
    if (rec.ok) {
      const r = await db.prepare("UPDATE campaigns SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(ctx.iso, ctx.iso, c.id).run();
      if ((r.meta.changes ?? 0) === 1) {
        ctx.report.finished.push(c.id);
        await emitAlert(ctx, { level: rec.failed > 0 ? 'yellow' : 'info', code: 'finished', campaign: c.id, message: `campaign ${c.id} done: sent ${rec.sent}, skipped ${rec.skippedTotal}, failed ${rec.failed}` });
      }
    } else {
      await brake(ctx, c.id, `reconcile_mismatch:${rec.problems.join(',').slice(0, 150)}`);
    }
    return;
  }
  if (counts.planned === 0) return; // 只剩交出去等結果的

  // 目前這一波＝還有人沒寄完的最小波次。
  const cur = await db
    .prepare("SELECT MIN(wave) AS w FROM campaign_recipients WHERE campaign_id = ? AND state IN ('planned', 'enqueued')")
    .bind(c.id)
    .first<{ w: number | null }>();
  const wave = Number(cur?.w ?? 0);
  const started = await db
    .prepare("SELECT COUNT(*) AS n, MIN(enqueued_at) AS first FROM campaign_recipients WHERE campaign_id = ? AND wave = ? AND state IN ('enqueued', 'done', 'failed', 'uncertain')")
    .bind(c.id, wave)
    .first<{ n: number; first: string | null }>();
  const waveStarts: Record<string, string> = (() => {
    try {
      return (JSON.parse(c.counts ?? '{}') as { waveStarts?: Record<string, string> }).waveStarts ?? {};
    } catch {
      return {};
    }
  })();
  if (!waveStarts[String(wave)] && Number(started?.n ?? 0) === 0) {
    // 要開新的一波：看上一波（有實際寄出的最近一波）。
    const prev = await db
      .prepare("SELECT MAX(wave) AS w FROM campaign_recipients WHERE campaign_id = ? AND wave < ? AND state IN ('done', 'failed', 'uncertain')")
      .bind(c.id, wave)
      .first<{ w: number | null }>();
    if (prev?.w) {
      const prevStart = waveStarts[String(prev.w)] ?? c.started_at ?? ctx.iso;
      const lastDone = await db
        .prepare("SELECT MAX(done_at) AS t FROM campaign_recipients WHERE campaign_id = ? AND wave = ? AND state = 'done'")
        .bind(c.id, prev.w)
        .first<{ t: string | null }>();
      if (prevStart > minutesAgo(ctx.now, cfg.waveGapMinutes)) return;
      if (lastDone?.t && lastDone.t > minutesAgo(ctx.now, cfg.waveGateWaitMinutes)) return;
      // 只有「上一次就是被這道閘門停下、人工放行」時才從放行起算（＝放行這一波）；其他情況整波都算。
      const pr = await campaignRates(db, c.id, prev.w, sinceFor('wave_gate'));
      if (pr.sent >= cfg.waveGateMinSent && pr.hardBounceRate >= cfg.waveGateBounceRate) {
        await brake(ctx, c.id, `brake:wave_gate:wave${prev.w}:${pr.hardBounces}/${pr.sent}`);
        return;
      }
    }
  }

  // 本分鐘放幾人：郵差速度、今天剩餘額度、本波剩餘、配速，四者取小。
  const sendable = counts.planned + counts.enqueued + counts.done + counts.failed + counts.uncertain;
  const pace = Math.ceil(sendable / cfg.paceMinutes);
  const waveLeft = await db.prepare("SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? AND wave = ? AND state = 'planned'").bind(c.id, wave).first<{ n: number }>();
  const n = Math.max(0, Math.min(budget.minute, budget.day, pace, Number(waveLeft?.n ?? 0)));
  if (n === 0) {
    if (budget.day <= 0) {
      await db.prepare("UPDATE throttle_days SET paused = 1, reason = 'daily_limit' WHERE domain = ? AND day = ? AND paused = 0").bind(throttle.domain, throttle.day).run();
    }
    return;
  }
  const picked = (
    await db
      .prepare(
        `UPDATE campaign_recipients SET state = 'enqueued', enqueued_at = ?
          WHERE campaign_id = ? AND state = 'planned' AND contact_id IN (
            SELECT contact_id FROM campaign_recipients WHERE campaign_id = ? AND wave = ? AND state = 'planned' ORDER BY rank, contact_id LIMIT ?)
          RETURNING contact_id`,
      )
      .bind(ctx.iso, c.id, c.id, wave, n)
      .all<{ contact_id: number }>()
  ).results.map((r) => Number(r.contact_id));
  if (picked.length === 0) return;
  if (!ctx.deps.queue) throw new Error('broadcast queue binding missing');
  for (let i = 0; i < picked.length; i += QUEUE_CHUNK) {
    const part = picked.slice(i, i + QUEUE_CHUNK);
    try {
      await ctx.deps.queue.sendBatch(part.map((contact) => ({ body: { kind: 'send', campaign: c.id, contact } })));
    } catch (e) {
      // 沒交進 Queue 的退回待放水；下一分鐘再放。
      const rest = picked.slice(i);
      for (let j = 0; j < rest.length; j += 50) {
        const ids = rest.slice(j, j + 50);
        await db.prepare(`UPDATE campaign_recipients SET state = 'planned', enqueued_at = NULL WHERE campaign_id = ? AND state = 'enqueued' AND contact_id IN (${ids.map(() => '?').join(',')})`).bind(c.id, ...ids).run();
      }
      console.error('broadcast queue send failed', e instanceof Error ? e.message : 'unknown');
      picked.length = i;
      break;
    }
  }
  budget.minute -= picked.length;
  budget.day -= picked.length;
  ctx.report.released[c.id] = picked.length;
  await db
    .prepare('UPDATE campaigns SET last_release_at = ?, waiting_since = CASE WHEN waiting_since IS NULL OR waiting_since <= COALESCE(last_progress_at, \'\') THEN ? ELSE waiting_since END, updated_at = ? WHERE id = ?')
    .bind(ctx.iso, ctx.iso, ctx.iso, c.id)
    .run();
  if (!waveStarts[String(wave)]) {
    waveStarts[String(wave)] = ctx.iso;
    await setCounts(db, c.id, 'waveStarts', waveStarts, ctx.iso);
  }
}

/** 每分鐘一次。回這一輪做了什麼。 */
export async function tick(deps: BroadcastDeps): Promise<TickReport> {
  const cfg = resolveConfig(deps.config);
  const now = (deps.now ?? (() => new Date()))();
  const ctx: Ctx = { deps, cfg, now, iso: now.toISOString(), report: { started: [], released: {}, paused: [], finished: [], alerts: [] } };
  const { db, domain } = deps;
  if (!domain) throw new Error('broadcast domain missing');

  const throttle = await todayRow(ctx);
  const sending = () => db.prepare("SELECT * FROM campaigns WHERE status = 'sending' ORDER BY started_at, id").all<CampaignRow>().then((r) => r.results);

  // 🔴 郵差說帳號不健康：寄送中的期全部暫停。
  if (throttle.enforcement && throttle.enforcement !== 'HEALTHY' && throttle.enforcement !== 'UNKNOWN') {
    for (const c of await sending()) await brake(ctx, c.id, `brake:provider_enforcement:${throttle.enforcement}`);
  }

  // 🔴 寄件網域滾動比率過線：整個網域停寄（只算上次解除之後寄出的信，解除＝重新起算）。
  let hold = await activeHold(db, domain);
  if (!hold) {
    const lastRelease = await db.prepare('SELECT MAX(released_at) AS t FROM domain_holds WHERE domain = ?').bind(domain).first<{ t: string | null }>();
    const windowStart = new Date(now.getTime() - cfg.domainWindowDays * 86_400_000).toISOString();
    const since = lastRelease?.t && lastRelease.t > windowStart ? lastRelease.t : windowStart;
    const d = await domainRates(db, cfg.site, since);
    // 檢舉另有件數下限（domainMinComplaints，預設 1＝與原本相同）；退信沒有。
    const complaintTrips = d.complaintRate >= cfg.domainComplaintRate && d.complaints >= cfg.domainMinComplaints;
    if (d.sent >= cfg.domainMinSent && (d.hardBounceRate >= cfg.domainBounceRate || complaintTrips)) {
      const reason = d.hardBounceRate >= cfg.domainBounceRate ? `bounce_rate:${d.hardBounces}/${d.sent}` : `complaint_rate:${d.complaints}/${d.sent}`;
      await db.prepare('INSERT INTO domain_holds (domain, reason, created_at) VALUES (?, ?, ?)').bind(domain, reason, ctx.iso).run();
      hold = await activeHold(db, domain);
      await emitAlert(ctx, { level: 'red', code: 'domain_hold', message: `all newsletters on ${domain} stopped: ${reason}` });
    }
  }
  if (hold) {
    for (const c of await sending()) await brake(ctx, c.id, `brake:domain_hold:${hold.reason}`);
  }

  const unhealthy = !!throttle.enforcement && throttle.enforcement !== 'HEALTHY' && throttle.enforcement !== 'UNKNOWN';
  await startDue(ctx, hold ? `domain_hold` : unhealthy ? `provider_${throttle.enforcement}` : null);
  if (hold || unhealthy) return ctx.report;

  // 共用額度：郵差速度（每分鐘）與今天剩餘（自己的上限、郵差 24 小時上限），扣掉已交出去還沒結果的。
  const outstanding = await db
    .prepare("SELECT COUNT(*) AS n FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE c.status = 'sending' AND r.state = 'enqueued'")
    .first<{ n: number }>();
  const out = Number(outstanding?.n ?? 0);
  const sent24 = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE site = ? AND stream = 'marketing' AND ((status = 'sent' AND sent_at >= ?) OR (status = 'sending' AND created_at >= ?))")
    .bind(cfg.site, new Date(now.getTime() - 86_400_000).toISOString(), new Date(now.getTime() - 86_400_000).toISOString())
    .first<{ n: number }>();
  let perMinute = Math.floor(throttle.per_second * 60 * cfg.rateFactor);
  if (throttle.last_throttled_at && throttle.last_throttled_at >= minutesAgo(now, 1)) perMinute = Math.floor(perMinute / 2);
  const providerLeft = (throttle.provider_per_day ?? 0) - Number(sent24?.n ?? 0);
  const budget: Budget = {
    minute: Math.max(0, perMinute - out),
    day: Math.max(0, Math.min(throttle.limit - throttle.sent, providerLeft) - out),
  };
  for (const c of await sending()) {
    try {
      await processSending(ctx, c, budget, throttle);
    } catch (e) {
      console.error('broadcast tick failed for campaign', c.id, e instanceof Error ? e.message : 'unknown');
      await emitAlert(ctx, { level: 'red', code: 'tick_error', campaign: c.id, message: `campaign ${c.id} tick error: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` });
    }
  }
  return ctx.report;
}

// ---------- Queue 消費端 ----------

export type ConsumeResult = { action: 'ack'; outcome: string } | { action: 'retry'; delaySeconds: number; outcome: string };

const ack = (outcome: string): ConsumeResult => ({ action: 'ack', outcome });

type LedgerOutcome =
  | { kind: 'sent' | 'duplicate'; messageId: number }
  | { kind: 'in_flight' | 'uncertain'; messageId: number }
  | { kind: 'failed'; messageId: number; postman: 'temporary' | 'permanent' | 'throttled' | 'daily_quota' | 'account_paused'; error: string }
  | { kind: 'rejected'; error: string };

/** 記帳＋交郵差（電子報版）。帳本列先建（sending），交郵差、再回寫；不重搶放久的 sending 列。 */
async function ledgerSend(ctx: Pick<Ctx, 'deps' | 'cfg' | 'now'>, c: CampaignRow, r: RecipientRow, content: RenderResult): Promise<LedgerOutcome> {
  const { db, postman, domain } = ctx.deps;
  const from = parseAddress(c.from_addr);
  if (!from || !from.addr.endsWith(`@${domain.toLowerCase()}`)) return { kind: 'rejected', error: 'bad_from' };
  const replyTo = c.reply_to ? parseAddress(c.reply_to) : null;
  const fmt = (a: { name: string | null; addr: string }) => (a.name ? `${a.name} <${a.addr}>` : a.addr);
  const key = `c:${c.id}:${r.contact_id}`;
  const iso = ctx.now.toISOString();
  const claimed = await db
    .prepare(
      `INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, attempts, created_at, updated_at)
       VALUES ('marketing', 'marketing', ?, ?, 'newsletter', ?, ?, ?, 'sending', 1, ?, ?)
       ON CONFLICT (site, dedupe_key) DO UPDATE SET status = 'sending', last_error = COALESCE(messages.error, messages.last_error), error = NULL,
         attempts = messages.attempts + 1, updated_at = excluded.updated_at
       WHERE messages.status = 'failed'
       RETURNING id`,
    )
    .bind(ctx.cfg.site, key, r.email, fmt(from), c.subject, iso, iso)
    .first<{ id: number }>();
  if (!claimed) {
    const existing = await db.prepare('SELECT id, status, updated_at FROM messages WHERE site = ? AND dedupe_key = ?').bind(ctx.cfg.site, key).first<{ id: number; status: string; updated_at: string }>();
    if (!existing) return { kind: 'rejected', error: 'ledger_conflict' };
    if (existing.status === 'sent') return { kind: 'duplicate', messageId: existing.id };
    if (existing.status === 'sending') {
      const stale = existing.updated_at < new Date(ctx.now.getTime() - STALE_SENDING_MS).toISOString();
      return { kind: stale ? 'uncertain' : 'in_flight', messageId: existing.id };
    }
    return { kind: 'rejected', error: `ledger_${existing.status}` };
  }
  // 個人化之後再檢查一次標頭（render 是可替換的）：只放行允許的名稱、值不准換行。
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(content.headers ?? {})) {
    if (!EXTRA_HEADER.test(k) || typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 2000) {
      await db.prepare("UPDATE messages SET status = 'failed', error = 'bad_header', updated_at = ? WHERE id = ?").bind(iso, claimed.id).run();
      return { kind: 'rejected', error: 'bad_header' };
    }
    headers[k] = v;
  }
  const mail: PostmanMail = {
    from: fmt(from), to: r.email, subject: c.subject, html: content.html, text: content.text,
    ...(replyTo ? { replyTo: fmt(replyTo) } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    tags: { campaign: c.id, contact: String(r.contact_id) },
    idempotencyKey: `${ctx.cfg.site}/${key}`,
  };
  let out: Awaited<ReturnType<Postman['send']>>;
  try {
    out = await postman.send(mail);
  } catch (e) {
    // 不知道有沒有寄出：帳本列留在 sending（之後不會被重搶），收件人記 uncertain。
    console.error('postman threw', e instanceof Error ? e.message : 'unknown');
    return { kind: 'uncertain', messageId: claimed.id };
  }
  const done = (ctx.deps.now ?? (() => new Date()))().toISOString();
  if (out.ok) {
    await db.prepare("UPDATE messages SET status = 'sent', route = ?, provider_id = ?, error = NULL, updated_at = ?, sent_at = ? WHERE id = ?").bind(postman.name, out.providerId, done, done, claimed.id).run();
    return { kind: 'sent', messageId: claimed.id };
  }
  const error = `${postman.name} ${out.kind} ${out.error}`.slice(0, 200);
  await db.prepare("UPDATE messages SET status = 'failed', route = ?, error = ?, updated_at = ? WHERE id = ?").bind(postman.name, error, done, claimed.id).run();
  return { kind: 'failed', messageId: claimed.id, postman: out.kind, error };
}

/** 處理一則 Queue 訊息。回 ack（處理完、不要再送）或 retry（幾秒後再送）。 */
export async function consume(deps: BroadcastDeps, body: unknown): Promise<ConsumeResult> {
  const cfg = resolveConfig(deps.config);
  const now = (deps.now ?? (() => new Date()))();
  const iso = now.toISOString();
  const { db } = deps;
  const msg = body as BroadcastMessage;
  if (msg && typeof msg === 'object' && msg.kind === 'event') {
    const outcome = await ingestEvent(db, msg.event, { feedback: deps.feedback, now: deps.now });
    return ack(`event:${outcome}`);
  }
  if (!msg || typeof msg !== 'object' || msg.kind !== 'send' || typeof msg.campaign !== 'string' || !Number.isInteger(msg.contact)) return ack('bad_message');

  const r = await db.prepare('SELECT * FROM campaign_recipients WHERE campaign_id = ? AND contact_id = ?').bind(msg.campaign, msg.contact).first<RecipientRow>();
  if (!r || r.state !== 'enqueued') return ack('not_enqueued');
  const setState = (state: RecipientRow['state'], extra: { skip?: string; error?: string | null; messageId?: number | null; attemptsPlus?: number } = {}) =>
    db
      .prepare(
        `UPDATE campaign_recipients SET state = ?, skip_reason = ?, error = ?, message_id = COALESCE(?, message_id), attempts = attempts + ?,
           enqueued_at = CASE WHEN ? = 'enqueued' THEN ? ELSE enqueued_at END, done_at = CASE WHEN ? IN ('done', 'skipped', 'failed', 'uncertain') THEN ? ELSE done_at END
         WHERE campaign_id = ? AND contact_id = ?`,
      )
      .bind(state, extra.skip ?? null, extra.error ?? null, extra.messageId ?? null, extra.attemptsPlus ?? 0, state, iso, state, iso, r.campaign_id, r.contact_id)
      .run();
  /** 還沒交郵差就停下：退回待放水（只有還在 enqueued 時才退，避免蓋掉別的結果）。 */
  const backToPlanned = () => db.prepare("UPDATE campaign_recipients SET state = 'planned', enqueued_at = NULL WHERE campaign_id = ? AND contact_id = ? AND state = 'enqueued'").bind(r.campaign_id, r.contact_id).run();
  const progress = () => db.prepare('UPDATE campaigns SET last_progress_at = ? WHERE id = ?').bind(iso, r.campaign_id).run();
  const ctx = { deps, report: { started: [], released: {}, paused: [], finished: [], alerts: [] } as TickReport, iso };

  const c = await getCampaign(db, r.campaign_id);
  if (!c) return ack('no_campaign');
  if (c.status === 'cancelled') {
    await db.prepare("UPDATE campaign_recipients SET state = 'skipped', skip_reason = 'cancelled' WHERE campaign_id = ? AND contact_id = ? AND state = 'enqueued'").bind(r.campaign_id, r.contact_id).run();
    return ack('cancelled');
  }
  if (c.status !== 'sending') {
    await backToPlanned();
    return ack(`campaign_${c.status}`);
  }
  if (await activeHold(db, deps.domain)) {
    await backToPlanned();
    return ack('domain_hold');
  }
  const health = await db.prepare('SELECT enforcement FROM throttle_days WHERE domain = ? AND day = ?').bind(deps.domain, localDay(now, cfg.utcOffsetHours)).first<{ enforcement: string | null }>();
  if (health?.enforcement && health.enforcement !== 'HEALTHY' && health.enforcement !== 'UNKNOWN') {
    await backToPlanned();
    return ack('provider_unhealthy');
  }

  // 派送當下再查一次：凍結之後才退訂、或被拒收的人跳過。
  const member = await db.prepare('SELECT status FROM list_members WHERE list_id = ? AND contact_id = ?').bind(c.list_id, r.contact_id).first<{ status: string }>();
  if (!member || member.status !== 'subscribed') {
    await setState('skipped', { skip: 'unsubscribed' });
    await progress();
    return ack('skipped_unsubscribed');
  }
  if (await suppressedReason(db, r.email, 'marketing')) {
    await setState('skipped', { skip: 'suppressed' });
    await progress();
    return ack('skipped_suppressed');
  }

  // 今天的額度：先佔一格（原子），沒寄出再還。
  const day = localDay(now, cfg.utcOffsetHours);
  const reserved = await db
    .prepare('UPDATE throttle_days SET sent = sent + 1 WHERE domain = ? AND day = ? AND sent < "limit" RETURNING sent')
    .bind(deps.domain, day)
    .first<{ sent: number }>();
  if (!reserved) {
    await db.prepare("UPDATE throttle_days SET paused = 1, reason = 'daily_limit' WHERE domain = ? AND day = ? AND paused = 0").bind(deps.domain, day).run();
    await backToPlanned();
    return ack('daily_limit');
  }
  const refund = () => db.prepare('UPDATE throttle_days SET sent = MAX(sent - 1, 0) WHERE domain = ? AND day = ?').bind(deps.domain, day).run();

  let content: RenderResult;
  try {
    const contact = await db.prepare('SELECT name FROM contacts WHERE id = ?').bind(r.contact_id).first<{ name: string | null }>();
    content = await deps.render(c, { ...r, name: contact?.name ?? null });
    if (!content || typeof content.html !== 'string' || typeof content.text !== 'string') throw new Error('render returned nothing');
  } catch (e) {
    await refund();
    await backToPlanned();
    await brake(ctx, c.id, `render_error:${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
    return ack('render_error');
  }

  const out = await ledgerSend({ deps, cfg, now }, c, r, content);
  switch (out.kind) {
    case 'sent':
    case 'duplicate':
      if (out.kind === 'duplicate') await refund();
      await setState('done', { messageId: out.messageId });
      await progress();
      return ack(out.kind);
    case 'in_flight':
      await refund();
      return { action: 'retry', delaySeconds: 60, outcome: 'in_flight' };
    case 'uncertain':
      // 額度不還（可能真的寄出了）。
      await setState('uncertain', { messageId: out.messageId, error: 'unknown whether the provider accepted it' });
      await progress();
      await emitAlert(ctx, { level: 'yellow', code: 'uncertain', campaign: c.id, message: `campaign ${c.id}: one recipient marked uncertain (not re-sent automatically)` });
      return ack('uncertain');
    case 'rejected':
      await refund();
      await setState('failed', { error: out.error });
      await progress();
      await brake(ctx, c.id, `rejected:${out.error}`);
      return ack('rejected');
    case 'failed':
      await refund();
      if (out.postman === 'throttled') {
        await db.prepare('UPDATE throttle_days SET last_throttled_at = ? WHERE domain = ? AND day = ?').bind(iso, deps.domain, day).run();
        await setState('enqueued', { messageId: out.messageId, error: out.error });
        await progress();
        return { action: 'retry', delaySeconds: cfg.throttleRetrySeconds, outcome: 'throttled' };
      }
      if (out.postman === 'daily_quota') {
        // 郵差說今天額度用完（例：別的寄信也佔了滾動 24 小時額度、或已用量讀數落後）：今天不再放水，明天照常。
        await db.prepare("UPDATE throttle_days SET \"limit\" = MIN(\"limit\", sent), paused = 1, reason = 'daily_limit' WHERE domain = ? AND day = ?").bind(deps.domain, day).run();
        await setState('planned', { messageId: out.messageId, error: out.error });
        await progress();
        return ack('daily_limit');
      }
      if (out.postman === 'account_paused') {
        await setState('planned', { messageId: out.messageId, error: out.error });
        await brake(ctx, c.id, 'brake:provider_account_paused');
        return ack('account_paused');
      }
      if (out.postman === 'temporary' && r.attempts + 1 < cfg.maxAttempts) {
        await setState('planned', { messageId: out.messageId, error: out.error, attemptsPlus: 1 });
        await progress();
        return ack('temporary_retry_later');
      }
      await setState('failed', { messageId: out.messageId, error: out.error, attemptsPlus: 1 });
      await progress();
      if (out.postman === 'permanent') {
        // 一封接一封都被郵差永久拒收（例：寄件身分沒驗證、沙盒裡收件人沒驗證）多半是設定問題，不是讀者的問題：停下來查，不要把整份名單逐一記失敗。
        const recent = (await db.prepare("SELECT state, error FROM campaign_recipients WHERE campaign_id = ? AND state IN ('done', 'failed') ORDER BY done_at DESC LIMIT ?").bind(c.id, cfg.permanentStreak).all<{ state: string; error: string | null }>()).results;
        if (recent.length >= cfg.permanentStreak && recent.every((x) => x.state === 'failed' && / permanent /.test(` ${x.error ?? ''} `))) {
          await brake(ctx, c.id, `brake:permanent_streak:${cfg.permanentStreak}`);
        }
      }
      return ack(`failed_${out.postman}`);
  }
}

export interface QueueMessageLike { body: unknown; ack(): void; retry(opts?: { delaySeconds?: number }): void }

/** 一批 Queue 訊息：一則一則處理，交郵差之間照每秒上限隔開。 */
export async function consumeBatch(deps: BroadcastDeps, messages: readonly QueueMessageLike[]): Promise<ConsumeResult[]> {
  const cfg = resolveConfig(deps.config);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const now = (deps.now ?? (() => new Date()))();
  const row = await deps.db.prepare('SELECT per_second FROM throttle_days WHERE domain = ? AND day = ?').bind(deps.domain, localDay(now, cfg.utcOffsetHours)).first<{ per_second: number }>();
  const gap = row && row.per_second > 0 ? Math.ceil(1000 / row.per_second) : 1000;
  const results: ConsumeResult[] = [];
  let lastSend = 0;
  for (const m of messages) {
    const isSend = (m.body as BroadcastMessage | null)?.kind === 'send';
    if (isSend && lastSend) {
      const wait = gap - (Date.now() - lastSend);
      if (wait > 0) await sleep(wait);
    }
    try {
      const r = await consume(deps, m.body);
      results.push(r);
      if (isSend && /^(sent|duplicate|uncertain|failed_|throttled|temporary)/.test(r.outcome)) lastSend = Date.now();
      if (r.action === 'ack') m.ack();
      else m.retry({ delaySeconds: r.delaySeconds });
    } catch (e) {
      console.error('broadcast consume failed', e instanceof Error ? e.message : 'unknown');
      results.push({ action: 'retry', delaySeconds: 30, outcome: 'error' });
      m.retry({ delaySeconds: 30 });
    }
  }
  return results;
}
