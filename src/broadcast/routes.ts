// 群發的管理入口（HTTP，帶管理口令；口令與速度上限由 index.ts 先檢查過才進來）。
// 指令（AI 用的 campaign create／approve／schedule／pause／resume…）背後打的就是這些路徑。
//
//   GET  /v1/throttle                         今天額度、已用、網域停寄、各期狀態
//   PUT  /v1/campaigns/{id}                   存草稿（內容改了就退回 draft）
//   GET  /v1/campaigns/{id}                   進度
//   POST /v1/campaigns/{id}/{action}          preflight／approve／schedule／unschedule／pause／resume／cancel／
//                                             retry-failed／resolve／reconcile
//   POST /v1/broadcast/release-hold           解除寄件網域停寄 { note }
//   PUT  /v1/warmup/{plan}/{step}             設定一步 { waves, maxCount?, gate? }
//   GET  /v1/warmup/{plan}                    列出這條梯子
//   POST /v1/warmup/{plan}/evaluate           評過關 { campaign, baselineOpenRate }
//   POST /v1/warmup/{plan}/unblock            解鎖 { note }

import type { ListDb } from '../lists.ts';
import {
  approveCampaign, cancelCampaign, getCampaign, pauseCampaign, recordPreflight, resumeCampaign, saveDraft, scheduleCampaign, unscheduleCampaign,
  type CampaignInput,
} from './campaigns.ts';
import { resolveConfig, type BroadcastConfig } from './config.ts';
import { releaseHold, resolveUncertain, retryFailed } from './dispatch.ts';
import { reconcileCampaign } from './reconcile.ts';
import { campaignStatus, throttleStatus } from './status.ts';
import { evaluateWarmup, planSteps, unblockWarmup, upsertWarmupStep } from './warmup.ts';

export interface RouteDeps { db: ListDb; domain: string; config?: Partial<BroadcastConfig> | string; now?: () => Date }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const CAMPAIGN_PATH = /^\/v1\/campaigns\/([a-z0-9][a-z0-9-]{0,39})(?:\/([a-z-]{3,20}))?$/;
const WARMUP_PATH = /^\/v1\/warmup\/([a-z0-9][a-z0-9-]{0,39})(?:\/(\d{1,3}|evaluate|unblock))?$/;

/** 這個路徑歸不歸群發管（index.ts 用來決定要不要先驗口令）。 */
export function isBroadcastPath(pathname: string): boolean {
  return pathname === '/v1/throttle' || pathname === '/v1/broadcast/release-hold' || CAMPAIGN_PATH.test(pathname) || WARMUP_PATH.test(pathname);
}

/** 失敗的結果對應狀態碼：找不到 404、狀態不對 409、其他 400。 */
function outcome(r: { ok: boolean; reason?: string }): Response {
  if (r.ok) return json(r);
  const status = r.reason === 'not_found' ? 404 : ['illegal_transition', 'locked', 'changed_meanwhile', 'conflict', 'domain_held', 'illegal_state', 'not_uncertain'].includes(r.reason ?? '') ? 409 : 400;
  return json(r, status);
}

export async function handleBroadcastRequest(request: Request, url: URL, deps: RouteDeps): Promise<Response | null> {
  const { db, domain } = deps;
  const now = deps.now ?? (() => new Date());
  const cfg = resolveConfig(deps.config);
  const m = request.method;
  const body = async (): Promise<Record<string, unknown> | null> => {
    if (m === 'GET') return {};
    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  };

  if (url.pathname === '/v1/throttle') {
    if (m !== 'GET') return null;
    return json(await throttleStatus(db, domain, deps.config, now()));
  }
  if (url.pathname === '/v1/broadcast/release-hold') {
    if (m !== 'POST') return null;
    const b = await body();
    if (!b) return json({ ok: false, reason: 'bad_json' }, 400);
    return outcome(await releaseHold(db, domain, String(b.note ?? ''), now()));
  }

  const cp = CAMPAIGN_PATH.exec(url.pathname);
  if (cp) {
    const [, id, action] = cp;
    if (!action) {
      if (m === 'GET') {
        const s = await campaignStatus(db, id);
        return s ? json(s) : json({ ok: false, reason: 'not_found' }, 404);
      }
      if (m !== 'PUT') return null;
      const b = await body();
      if (!b) return json({ ok: false, reason: 'bad_json' }, 400);
      return outcome(await saveDraft(db, { ...(b as unknown as CampaignInput), id }, { marketingDomain: domain, now }));
    }
    if (m !== 'POST') return null;
    const b = await body();
    if (!b) return json({ ok: false, reason: 'bad_json' }, 400);
    switch (action) {
      case 'preflight':
        return outcome(await recordPreflight(db, id, b as never, now));
      case 'approve':
        return outcome(await approveCampaign(db, id, String(b.note ?? ''), now));
      case 'schedule':
        return outcome(await scheduleCampaign(db, id, String(b.at ?? ''), now));
      case 'unschedule':
        return outcome(await unscheduleCampaign(db, id, now));
      case 'pause':
        return outcome(await pauseCampaign(db, id, String(b.reason ?? ''), now));
      case 'resume':
        return outcome(await resumeCampaign(db, id, String(b.note ?? ''), { marketingDomain: domain, now }));
      case 'cancel':
        return outcome(await cancelCampaign(db, id, String(b.reason ?? ''), now));
      case 'retry-failed':
        return outcome(await retryFailed(db, id));
      case 'resolve':
        return outcome(await resolveUncertain(db, id, Number(b.contact), b.as as 'sent' | 'failed', String(b.note ?? ''), now()));
      case 'reconcile': {
        if (!(await getCampaign(db, id))) return json({ ok: false, reason: 'not_found' }, 404);
        return json(await reconcileCampaign(db, id, cfg));
      }
      default:
        return null;
    }
  }

  const wp = WARMUP_PATH.exec(url.pathname);
  if (wp) {
    const [, plan, sub] = wp;
    if (!sub) return m === 'GET' ? json({ plan, steps: await planSteps(db, plan) }) : null;
    const b = await body();
    if (!b) return json({ ok: false, reason: 'bad_json' }, 400);
    if (/^\d+$/.test(sub)) {
      if (m !== 'PUT') return null;
      return outcome(await upsertWarmupStep(db, { plan, step: Number(sub), waves: b.waves as string[][], maxCount: b.maxCount as number | undefined, gate: b.gate as never }));
    }
    if (m !== 'POST') return null;
    if (sub === 'unblock') return outcome(await unblockWarmup(db, plan, String(b.note ?? '')));
    const r = await evaluateWarmup(db, plan, String(b.campaign ?? ''), b.baselineOpenRate as number, cfg, now);
    return json(r);
  }
  return null;
}
