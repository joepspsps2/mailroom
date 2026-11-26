// 分析匯出：把事件、期別、凍結名單、名單成員用 NDJSON 一頁一頁交給外面的分析管線（帶管理口令）。見 docs/export.md。
//
//   GET  /v1/export/events?cursor=&limit=              事件（依 id 遞增；cursor＝上一頁回的 x-export-next-cursor）
//   POST /v1/export/events/ack    { through }          分析端「已經安全存好」到哪個事件 id：標 exported_at（可重複執行）
//   GET  /v1/export/campaigns?cursor=&limit=           每期一列（寄送時間、狀態）
//   GET  /v1/export/recipients?campaign=&cursor=&limit=  某一期的凍結名單（寄的當下每人的分群；不含信箱）
//   GET  /v1/export/members?list=&cursor=&limit=       某份名單目前所有成員（含信箱，每週快照用）
//
// 設計重點：
// - 讀取本身不改任何東西：同一個 cursor 重拉一定拿到同一批（除了新進來的）。中途失敗的人只要從上次存好的 cursor 再來，不會漏也不會重。
// - 「分析端存好了」才呼叫 ack；ack 只是標記（exported_at），不影響下一次從哪裡拉，拉到哪由分析端自己記 cursor。
// - 事件只帶 contact_id，不帶信箱（記事件時與匯出時都會把 detail 裡信箱形狀的字串遮掉）；要對到信箱用 members 快照。
// - D1 的寫入是一筆一筆依序提交，AUTOINCREMENT 的 id 看得到 N+1 就代表 N 已提交，依 id 往後拉不會跳過。
// - 自己一組速度上限（_export），不跟其他管理入口搶額度。

import { takeRate, type Db } from './core.ts';
import { bearer, json, notFound, sameToken } from './http.ts';

export const EXPORT_LIMITS = { perMinute: 60, perDay: 1000 };
export const EXPORT_DEFAULT_PAGE = 2000;
export const EXPORT_MAX_PAGE = 5000;

const PATH = /^\/v1\/export\/(events|campaigns|recipients|members)$/;
const ACK_PATH = '/v1/export/events/ack';
const LIST_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** 事件的 detail 不該帶信箱；已存的舊資料也在這裡把信箱形狀的字串遮成 [email]（@頻道 這類不算信箱，原樣保留）。 */
export function scrubEmails(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const text = JSON.stringify(value);
  return text.includes('@') ? JSON.parse(text.replace(EMAIL, '[email]')) : value;
}

const ndjson = (rows: unknown[], next: string | null): Response =>
  new Response(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-export-count': String(rows.length),
      'x-export-has-more': next === null ? '0' : '1',
      'x-export-next-cursor': next ?? '',
    },
  });

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _unparsed: String(text).slice(0, 500) };
  }
}

function pageLimit(raw: string | null): number {
  const n = Math.trunc(Number(raw));
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : EXPORT_DEFAULT_PAGE, 1), EXPORT_MAX_PAGE);
}

/** cursor 只收十進位整數；沒給＝從頭（0）。 */
function parseCursor(raw: string | null): number | null {
  if (raw === null || raw === '') return 0;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

export async function exportEvents(db: Db, cursor: number, limit: number): Promise<{ rows: unknown[]; next: string | null }> {
  const r = await db
    .prepare(
      `SELECT id, provider, provider_event_id, message_id, provider_message_id, campaign_id, contact_id, type, subtype, at, detail, exported_at
         FROM events WHERE id > ? ORDER BY id LIMIT ?`,
    )
    .bind(cursor, limit + 1)
    .all<Record<string, unknown> & { id: number; detail: string | null }>();
  const more = r.results.length > limit;
  const page = r.results.slice(0, limit);
  return { rows: page.map((e) => ({ ...e, detail: scrubEmails(parseJson(e.detail)) })), next: more ? String(page[page.length - 1].id) : null };
}

/** 標記 id ≤ through 的事件已匯出。through 不能超過目前最大 id（防呼叫端算錯把還沒拉的也標掉）。 */
export async function ackEvents(db: Db, through: unknown, now: Date): Promise<{ ok: true; marked: number } | { ok: false; reason: 'bad_through' | 'beyond_max' }> {
  if (typeof through !== 'number' || !Number.isInteger(through) || through < 0) return { ok: false, reason: 'bad_through' };
  const max = await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').first<{ m: number }>();
  if (through > Number(max?.m ?? 0)) return { ok: false, reason: 'beyond_max' };
  const r = await db.prepare('UPDATE events SET exported_at = ? WHERE id <= ? AND exported_at IS NULL').bind(now.toISOString(), through).run();
  return { ok: true, marked: Number(r.meta.changes ?? 0) };
}

export async function exportCampaigns(db: Db, cursor: number, limit: number): Promise<{ rows: unknown[]; next: string | null }> {
  const r = await db
    .prepare(
      `SELECT rowid AS seq, id, list_id, subject, from_addr, status, scheduled_at, started_at, finished_at, frozen_at, pause_reason, created_at, updated_at
         FROM campaigns WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .bind(cursor, limit + 1)
    .all<Record<string, unknown> & { seq: number }>();
  const more = r.results.length > limit;
  const page = r.results.slice(0, limit);
  return { rows: page, next: more ? String(page[page.length - 1].seq) : null };
}

export async function exportRecipients(db: Db, campaign: string, cursor: number, limit: number): Promise<{ rows: unknown[]; next: string | null }> {
  const r = await db
    .prepare(
      `SELECT campaign_id, contact_id, segment, wave, state, skip_reason, enqueued_at, done_at
         FROM campaign_recipients WHERE campaign_id = ? AND contact_id > ? ORDER BY contact_id LIMIT ?`,
    )
    .bind(campaign, cursor, limit + 1)
    .all<Record<string, unknown> & { contact_id: number }>();
  const more = r.results.length > limit;
  const page = r.results.slice(0, limit);
  return { rows: page, next: more ? String(page[page.length - 1].contact_id) : null };
}

export async function exportMembers(db: Db, list: string, cursor: number, limit: number): Promise<{ rows: unknown[]; next: string | null }> {
  const r = await db
    .prepare(
      `SELECT m.list_id, m.contact_id, c.email AS email, m.status, m.subscribed_at, m.unsubscribed_at, m.unsub_source, m.source,
              m.segment, m.segment_label, m.segment_at, m.imported_from, m.last_open_at, m.last_click_at, m.updated_at
         FROM list_members m JOIN contacts c ON c.id = m.contact_id
        WHERE m.list_id = ? AND m.contact_id > ? ORDER BY m.contact_id LIMIT ?`,
    )
    .bind(list, cursor, limit + 1)
    .all<Record<string, unknown> & { contact_id: number }>();
  const more = r.results.length > limit;
  const page = r.results.slice(0, limit);
  return { rows: page, next: more ? String(page[page.length - 1].contact_id) : null };
}

/** 路徑不是匯出入口＝回 null（交給後面的路由）；口令不對一律 404（不透露入口存在）。 */
export async function routeExport(request: Request, db: Db, adminToken: string | undefined, now: () => Date = () => new Date()): Promise<Response | null> {
  const url = new URL(request.url);
  const m = PATH.exec(url.pathname);
  const isAck = url.pathname === ACK_PATH;
  if (!m && !isAck) return null;
  const wanted = isAck ? 'POST' : 'GET';
  if (request.method !== wanted) return notFound();
  if (!sameToken(bearer(request), adminToken ?? '')) return notFound();
  const over = await takeRate(db, '_export', EXPORT_LIMITS, now());
  if (over) return new Response('rate limited', { status: 429, headers: { 'retry-after': over === 'day' ? '3600' : '60' } });

  if (isAck) {
    const body = (await request.json().catch(() => null)) as { through?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, reason: 'bad_json' }, 400);
    const r = await ackEvents(db, body.through, now());
    return json(r, r.ok ? 200 : 400);
  }

  const cursor = parseCursor(url.searchParams.get('cursor'));
  if (cursor === null) return json({ ok: false, reason: 'bad_cursor' }, 400);
  const limit = pageLimit(url.searchParams.get('limit'));
  switch (m![1]) {
    case 'events': {
      const r = await exportEvents(db, cursor, limit);
      return ndjson(r.rows, r.next);
    }
    case 'campaigns': {
      const r = await exportCampaigns(db, cursor, limit);
      return ndjson(r.rows, r.next);
    }
    case 'recipients': {
      const campaign = url.searchParams.get('campaign') ?? '';
      if (!CAMPAIGN_ID.test(campaign)) return json({ ok: false, reason: 'bad_campaign' }, 400);
      const r = await exportRecipients(db, campaign, cursor, limit);
      return ndjson(r.rows, r.next);
    }
    default: {
      const list = url.searchParams.get('list') ?? '';
      if (!LIST_ID.test(list)) return json({ ok: false, reason: 'bad_list' }, 400);
      const r = await exportMembers(db, list, cursor, limit);
      return ndjson(r.rows, r.next);
    }
  }
}
