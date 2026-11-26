// 群發的管理入口（HTTP，帶管理口令；口令與速度上限由 index.ts 先檢查過才進來）。
// 指令（AI 用的 campaign create／approve／schedule／pause／resume…）背後打的就是這些路徑。
//
//   GET  /v1/throttle                         今天額度、已用、網域停寄、各期狀態
//   PUT  /v1/campaigns/{id}                   存草稿（內容改了就退回 draft）
//   GET  /v1/campaigns/{id}                   進度
//   GET  /v1/campaigns/{id}/preview           預覽內容（範例收件人填好；唯讀，不留記號）
//   GET  /v1/campaigns/{id}/audience          現在開寄會寄給誰（每波每群人數、被擋人數；唯讀，不凍結）
//   POST /v1/campaigns/{id}/preview           同上，並記下「這份內容已產生預覽」（核准的前提）
//   POST /v1/campaigns/{id}/test              寄測試信 { to: [...], subjectPrefix? }（只准白名單信箱）
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
import { audiencePlan } from './audience.ts';
import { reconcileCampaign } from './reconcile.ts';
import { previewContent, sendTest, type TestSendDeps } from './test-send.ts';
import { campaignStatus, previewedHash, throttleStatus } from './status.ts';
import { evaluateWarmup, planSteps, unblockWarmup, upsertWarmupStep } from './warmup.ts';

export interface RouteDeps {
  db: ListDb; domain: string; config?: Partial<BroadcastConfig> | string; now?: () => Date;
  /** 測試信要用的郵差、個人化與白名單；沒給＝測試信功能關閉（回 test_recipients_not_configured）。 */
  test?: Omit<TestSendDeps, 'domain' | 'now'>;
}

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
  const status = r.reason === 'not_found' ? 404 : r.reason === 'recipient_not_allowed' ? 403 : ['illegal_transition', 'locked', 'changed_meanwhile', 'conflict', 'domain_held', 'illegal_state', 'not_uncertain', 'preview_required', 'duplicate_content'].includes(r.reason ?? '') ? 409 : 400;
  return json(r, status);
}

function parseCounts(counts: string | null): unknown {
  try {
    return counts ? JSON.parse(counts) : null;
  } catch {
    return null;
  }
}

/** 預覽：POST 才會記「已預覽」（綁內容雜湊）。內容裡只有範例收件人，沒有任何真實地址。 */
async function previewResponse(db: ListDb, id: string, mark: boolean, _cfg: BroadcastConfig, now = new Date()): Promise<Response> {
  const c = await getCampaign(db, id);
  if (!c) return json({ ok: false, reason: 'not_found' }, 404);
  const p = previewContent(c);
  if ('error' in p) return json({ ok: false, reason: 'preview_failed', error: p.error }, 400);
  if (mark) {
    await db.prepare("UPDATE campaigns SET counts = json_set(COALESCE(counts, '{}'), '$.previewHash', ?, '$.previewAt', ?) WHERE id = ?").bind(c.content_hash, now.toISOString(), id).run();
  }
  let preflight: unknown = null;
  try {
    preflight = c.preflight ? JSON.parse(c.preflight) : null;
  } catch {
    /* 留 null */
  }
  const headerOnly = c.headers ? (() => { try { return JSON.parse(c.headers) as Record<string, string>; } catch { return {}; } })() : {};
  return json({
    ok: true, id: c.id, status: c.status, list: c.list_id, subject: c.subject, preheader: c.preheader, from: c.from_addr, replyTo: c.reply_to, webUrl: c.web_url, sourceRef: c.source_ref,
    htmlBytes: new TextEncoder().encode(c.html).length, html: p.html, text: p.text, htmlNoName: p.htmlNoName, textNoName: p.textNoName, headers: Object.keys(headerOnly),
    preflight, previewed: mark, contentHash: c.content_hash,
  });
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
        const s = await campaignStatus(db, id, deps.config);
        return s ? json(s) : json({ ok: false, reason: 'not_found' }, 404);
      }
      if (m !== 'PUT') return null;
      const b = await body();
      if (!b) return json({ ok: false, reason: 'bad_json' }, 400);
      return outcome(await saveDraft(db, { ...(b as unknown as CampaignInput), id }, { marketingDomain: domain, now }));
    }
    if (action === 'audience' && m === 'GET') {
      const p = await audiencePlan(db, id);
      return p ? json(p) : json({ ok: false, reason: 'not_found' }, 404);
    }
    if (action === 'preview' && m === 'GET') return previewResponse(db, id, false, cfg);
    if (m !== 'POST') return null;
    const b = await body();
    if (!b) return json({ ok: false, reason: 'bad_json' }, 400);
    switch (action) {
      case 'preview':
        return previewResponse(db, id, true, cfg, now());
      case 'test':
        return outcome(await sendTest(db, id, b, { ...(deps.test ?? { postman: null as never, render: null as never, allowed: [] }), domain, now }));
      case 'preflight':
        return outcome(await recordPreflight(db, id, b as never, now));
      case 'approve': {
        // 沒有預覽就不能核准：預覽那一刻的內容雜湊要等於現在的內容（內容改過要重新預覽）。
        const cur = await getCampaign(db, id);
        if (cur && previewedHash(parseCounts(cur.counts)) !== cur.content_hash) return json({ ok: false, reason: 'preview_required' }, 409);
        return outcome(await approveCampaign(db, id, String(b.note ?? ''), now));
      }
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
