// 進度與節流狀態（唯讀）：給指令與報表看。不回信件內文、不回收件人地址。

import { localDay } from '../core.ts';
import type { ListDb } from '../lists.ts';
import { getCampaign } from './campaigns.ts';
import { resolveConfig, type BroadcastConfig } from './config.ts';
import { activeHold } from './dispatch.ts';
import { campaignRates } from './stats.ts';

export async function campaignStatus(db: ListDb, id: string) {
  const c = await getCampaign(db, id);
  if (!c) return null;
  const states = (await db.prepare('SELECT state, skip_reason, wave, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY state, skip_reason, wave ORDER BY wave').bind(id).all()).results;
  const rates = await campaignRates(db, id);
  let counts: unknown = null;
  try {
    counts = c.counts ? JSON.parse(c.counts) : null;
  } catch {
    /* 留 null */
  }
  const parse = (s: string | null) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  return {
    id: c.id, list: c.list_id, subject: c.subject, status: c.status, pauseReason: c.pause_reason,
    audience: parse(c.audience), audienceResolved: parse(c.audience_resolved),
    approved: c.approved_hash !== null && c.approved_hash === c.content_hash, approvedAt: c.approved_at, approvedNote: c.approved_note,
    preflight: parse(c.preflight), scheduledAt: c.scheduled_at, startedAt: c.started_at, frozenAt: c.frozen_at,
    lastReleaseAt: c.last_release_at, lastProgressAt: c.last_progress_at, finishedAt: c.finished_at,
    recipients: states, rates, counts,
  };
}

export async function throttleStatus(db: ListDb, domain: string, config?: Partial<BroadcastConfig> | string, now = new Date()) {
  const cfg = resolveConfig(config);
  const day = localDay(now, cfg.utcOffsetHours);
  const today = await db.prepare('SELECT * FROM throttle_days WHERE domain = ? AND day = ?').bind(domain, day).first();
  const hold = await activeHold(db, domain);
  const campaigns = (await db.prepare("SELECT id, status, pause_reason, started_at, last_release_at, last_progress_at, counts FROM campaigns WHERE status IN ('scheduled', 'sending', 'paused') ORDER BY id").all<Record<string, unknown>>()).results.map((r) => {
    let counts: unknown = null;
    try {
      counts = r.counts ? JSON.parse(String(r.counts)) : null;
    } catch {
      /* 留 null */
    }
    return { ...r, counts };
  });
  return { domain, day, today, hold, config: cfg, campaigns };
}
