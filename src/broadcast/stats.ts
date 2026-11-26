// 煞車、暖機、對帳共用的計數。分母一律是「真的寄出」（campaign_recipients.state='done'）；
// 退信、檢舉、開信都以「人」計（同一人同一期多則事件只算一次）。

import type { Db } from '../core.ts';

export interface CampaignRates {
  sent: number;
  hardBounces: number;
  complaints: number;
  opens: number;
  hardBounceRate: number;
  complaintRate: number;
  /** 開信人數 ÷（寄出 − 永久退信）。 */
  openRate: number;
}

const rate = (n: number, d: number) => (d > 0 ? n / d : 0);

/**
 * wave＝只算這一波；since＝只算這個時間之後寄出的人（續寄後重新起算：人查過、放行了，舊的比率不再拿來踩煞車）。
 */
export async function campaignRates(db: Db, campaignId: string, wave?: number, since?: string | null): Promise<CampaignRates> {
  const waveSql = (wave === undefined ? '' : ' AND r.wave = ?') + (since ? ' AND r.done_at >= ?' : '');
  const waveBind: unknown[] = [...(wave === undefined ? [] : [wave]), ...(since ? [since] : [])];
  const sent = await db.prepare(`SELECT COUNT(*) AS n FROM campaign_recipients r WHERE r.campaign_id = ? AND r.state = 'done'${waveSql}`).bind(campaignId, ...waveBind).first<{ n: number }>();
  const ev = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN e.type = 'bounce' AND e.subtype LIKE 'Permanent%' THEN e.contact_id END) AS hard,
         COUNT(DISTINCT CASE WHEN e.type = 'complaint' THEN e.contact_id END) AS complaints,
         COUNT(DISTINCT CASE WHEN e.type = 'open' THEN e.contact_id END) AS opens
       FROM events e JOIN campaign_recipients r ON r.campaign_id = e.campaign_id AND r.contact_id = e.contact_id
       WHERE e.campaign_id = ?${waveSql}`,
    )
    .bind(campaignId, ...waveBind)
    .first<{ hard: number; complaints: number; opens: number }>();
  const s = Number(sent?.n ?? 0);
  const hard = Number(ev?.hard ?? 0);
  const complaints = Number(ev?.complaints ?? 0);
  const opens = Number(ev?.opens ?? 0);
  return { sent: s, hardBounces: hard, complaints, opens, hardBounceRate: rate(hard, s), complaintRate: rate(complaints, s), openRate: rate(opens, s - hard) };
}

/** 寄件網域的滾動比率：最近 days 天寄出的電子報裡，有幾封後來永久退信／被檢舉（以信件計）。 */
export async function domainRates(db: Db, site: string, since: string): Promise<{ sent: number; hardBounces: number; complaints: number; hardBounceRate: number; complaintRate: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS sent,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'bounce' AND e.subtype LIKE 'Permanent%') THEN 1 ELSE 0 END) AS hard,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.type = 'complaint') THEN 1 ELSE 0 END) AS complaints
       FROM messages m WHERE m.site = ? AND m.stream = 'marketing' AND m.status = 'sent' AND m.sent_at >= ?`,
    )
    .bind(site, since)
    .first<{ sent: number; hard: number | null; complaints: number | null }>();
  const sent = Number(row?.sent ?? 0);
  const hard = Number(row?.hard ?? 0);
  const complaints = Number(row?.complaints ?? 0);
  return { sent, hardBounces: hard, complaints, hardBounceRate: rate(hard, sent), complaintRate: rate(complaints, sent) };
}
